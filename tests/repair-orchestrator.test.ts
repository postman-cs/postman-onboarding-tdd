import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderStickyComment, type GitHubPrClient, type PullRequestDetails } from '../src/github/pr-comment.js';
import { runRepairMode } from '../src/repair/orchestrator.js';
import type { ActionInputs, AgentFailureDocument } from '../src/types.js';

describe('repair orchestrator early guards', () => {
  let dir = '';
  let previousCwd = '';
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    previousWorkspace = process.env.GITHUB_WORKSPACE;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = previousWorkspace;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function createRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-repair-orchestrator-'));
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    writeFileSync(join(dir, '.postman-template', 'onboarding.yml'), `
spec:
  path: api/openapi.yaml
service:
  name: repair-test
tdd:
  enabled: true
  workspace:
    name: Repair Test
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
    allowedWritePaths:
      - src/**
`, 'utf8');
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    return dir;
  }

  function actionInputs(): ActionInputs {
    return {
      committerEmail: 'support@postman.com',
      committerName: 'Postman',
      configWriteMode: 'none',
      githubToken: 'github-token',
      mode: 'repair',
      onboardingConfigPath: '.postman-template/onboarding.yml',
      openaiApiKey: 'openai-token',
      postmanApiKey: 'postman-token',
      postmanRegion: 'us',
      postmanStack: 'prod',
      repairCommitMessage: 'Postman TDD repair',
      repairMaxAttempts: 3,
      repairModel: 'gpt-5.5',
      repairProvider: 'openai-responses'
    };
  }

  function prDetails(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
    return {
      baseRepository: 'postman-cs/pavan-test-TDD',
      headBranch: 'repair-branch',
      headRepository: 'postman-cs/pavan-test-TDD',
      headSha: 'head-sha',
      isFork: false,
      number: 123,
      ...overrides
    };
  }

  function failureBody(overrides: Partial<AgentFailureDocument> = {}): string {
    const failure: AgentFailureDocument = {
      baseUrl: 'http://127.0.0.1:4010',
      collectionName: '[TDD PR-123] [Contract] repair-test',
      commit: 'head-sha',
      failures: [{ message: 'Synthetic failure.' }],
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      immutablePaths: ['api/openapi.yaml'],
      message: 'Synthetic failure.',
      phase: 'collection_run',
      schemaVersion: 1,
      specPath: 'api/openapi.yaml',
      status: 'failed',
      successCriteria: {
        doneWhen: 'requiredCheck passes on the latest PR head commit',
        failureContextMustMatchPrHeadCommit: true,
        latestHeadOnly: true,
        requiredCheck: 'Postman TDD Preview'
      },
      ...overrides
    };
    return renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: failure,
      status: 'failed'
    });
  }

  async function runGuard(options: {
    details?: Partial<PullRequestDetails>;
    stickyBody?: string;
  }) {
    createRepo();
    let summary: unknown;
    const github = {
      findStickyComment: async () => options.stickyBody
        ? { body: options.stickyBody, id: 1 }
        : undefined,
      getPullRequest: async () => prDetails(options.details),
      upsertRepairComment: async (_prNumber: number, nextSummary: unknown) => {
        summary = nextSummary;
        return 1;
      }
    } as unknown as GitHubPrClient;

    await runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github,
      inputs: actionInputs(),
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    });
    return summary;
  }

  it('blocks fork pull requests before repair work starts', async () => {
    const summary = await runGuard({
      details: {
        headRepository: 'pavan-nelakuditi/pavan-test-TDD',
        isFork: true
      }
    });

    expect(summary).toMatchObject({
      attempts: 0,
      blockedReason: 'fork_pr',
      status: 'blocked'
    });
  });

  it('blocks stale failure context before asset or model work starts', async () => {
    const summary = await runGuard({
      stickyBody: failureBody({ commit: 'old-sha' })
    });

    expect(summary).toMatchObject({
      attempts: 0,
      blockedReason: 'stale_failure',
      status: 'blocked'
    });
  });

  it('blocks unsupported failure phases before asset or model work starts', async () => {
    const summary = await runGuard({
      stickyBody: failureBody({ phase: 'config' })
    });

    expect(summary).toMatchObject({
      attempts: 0,
      blockedReason: 'unsupported_failure_phase',
      status: 'blocked'
    });
  });
});
