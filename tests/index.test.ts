import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseAssetState,
  parseFailureDocument,
  renderStickyComment,
  type GitHubPrClient,
  type PrCommentSummary
} from '../src/github/pr-comment.js';
import { runAction } from '../src/index.js';
import type { LedgerSummary, PreviewAssetState } from '../src/types.js';

const runnerMocks = vi.hoisted(() => {
  // Scrub the GitHub event context before any module (including
  // @actions/github, which snapshots GITHUB_EVENT_PATH at import time) loads.
  // Without this, a real pull_request event payload in CI leaks its head.sha
  // into resolvePrMetadata and overrides the test's mocked GITHUB_SHA.
  delete process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_EVENT_NAME;
  return {
    ensurePostmanCli: vi.fn(),
    runCommand: vi.fn(),
    runTddCollection: vi.fn(),
    startBackgroundCommand: vi.fn(),
    waitForHealth: vi.fn()
  };
});

vi.mock('../src/runner.js', () => ({
  ensurePostmanCli: runnerMocks.ensurePostmanCli,
  runCommand: runnerMocks.runCommand,
  runTddCollection: runnerMocks.runTddCollection,
  startBackgroundCommand: runnerMocks.startBackgroundCommand,
  waitForHealth: runnerMocks.waitForHealth
}));

describe('runAction failure publishing', () => {
  const envKeys = [
    'GITHUB_OUTPUT',
    'GITHUB_REPOSITORY',
    'GITHUB_SHA',
    'GITHUB_WORKSPACE',
    'INPUT_CONFIG-WRITE-MODE',
    'INPUT_GITHUB-TOKEN',
    'INPUT_MODE',
    'INPUT_ONBOARDING-CONFIG-PATH',
    'INPUT_POSTMAN-API-KEY',
    'INPUT_PR-NUMBER'
  ];
  const previousEnv = new Map<string, string | undefined>();
  let dir = '';
  let previousCwd = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    runnerMocks.ensurePostmanCli.mockReset();
    runnerMocks.runCommand.mockReset();
    runnerMocks.runTddCollection.mockReset();
    runnerMocks.startBackgroundCommand.mockReset();
    runnerMocks.waitForHealth.mockReset();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const key of envKeys) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    previousEnv.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function setInput(name: string, value: string): void {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }

  it('publishes config validation failures to the sticky PR comment', async () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-run-action-'));
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    writeFileSync(join(dir, '.postman-template', 'onboarding.yml'), `
spec:
  path: api/openapi.yaml
service:
  name: config-failure-service
tdd:
  enabled: true
  workspace:
    name: Config Failure Preview
`, 'utf8');
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    process.env.GITHUB_REPOSITORY = 'postman-cs/config-failure-service';
    process.env.GITHUB_SHA = 'head-sha';
    const outputPath = join(dir, 'outputs.txt');
    writeFileSync(outputPath, '', 'utf8');
    process.env.GITHUB_OUTPUT = outputPath;
    setInput('mode', 'run');
    setInput('pr-number', '42');
    setInput('postman-api-key', 'postman-token');
    setInput('github-token', 'github-token');
    setInput('config-write-mode', 'none');
    setInput('onboarding-config-path', '.postman-template/onboarding.yml');

    const renderedComments: string[] = [];
    const summaries: PrCommentSummary[] = [];
    const github = {
      findStickyComment: async () => undefined,
      upsertStickyComment: async (
        _prNumber: number,
        state: PreviewAssetState,
        summary: PrCommentSummary
      ) => {
        summaries.push(summary);
        renderedComments.push(renderStickyComment(state, summary));
        return 321;
      }
    } as unknown as GitHubPrClient;
    const postmanCalls: string[] = [];
    const postman = new Proxy({}, {
      get(_target, prop) {
        return () => {
          postmanCalls.push(String(prop));
          throw new Error(`Unexpected Postman client call: ${String(prop)}`);
        };
      }
    });
    const uploads: Array<{ files: string[]; name: string; rootDirectory: string }> = [];
    const artifactClient = {
      uploadArtifact: async (name: string, files: string[], rootDirectory: string) => {
        uploads.push({ files, name, rootDirectory });
        return { digest: 'sha256:config-failure', id: 654 };
      }
    };

    await expect(runAction({
      artifactClient: artifactClient as never,
      githubClient: github,
      postmanClient: postman as never
    })).rejects.toThrow('tdd.baseUrl is required');

    expect(postmanCalls).toEqual([]);
    expect(uploads).toEqual([{
      files: [
        '.postman-tdd/agent-task.md',
        '.postman-tdd/failures.json',
        '.postman-tdd/immutable-spec-guard.mjs'
      ],
      name: 'postman-tdd-agent-context',
      rootDirectory: '.'
    }]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      failurePhase: 'config',
      status: 'failed'
    });
    const body = renderedComments[0] || '';
    expect(body).toContain('Postman TDD Preview (FAILED)');
    expect(body).toContain('**Failure phase:** config');
    expect(body).toContain('tdd.baseUrl is required when tdd.enabled=true');
    const failureDocument = parseFailureDocument(body);
    expect(failureDocument?.commit).toBeTruthy();
    expect(failureDocument).toMatchObject({
      failures: [{ message: 'tdd.baseUrl is required when tdd.enabled=true' }],
      phase: 'config',
      status: 'failed'
    });

    const outputs = readFileSync(outputPath, 'utf8');
    expect(outputs).toContain('status');
    expect(outputs).toContain('failed');
    expect(outputs).toContain('failure-phase');
    expect(outputs).toContain('config');
    expect(outputs).toContain('pr-comment-id');
    expect(outputs).toContain('321');
  });

  function setupCollectionRunRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-run-action-'));
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, '.postman-template', 'onboarding.yml'), `
spec:
  path: api/openapi.yaml
service:
  name: collection-run-service
tdd:
  enabled: true
  workspace:
    id: ws-1
    name: Collection Run Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
`, 'utf8');
    writeFileSync(join(dir, 'api', 'openapi.yaml'), `
openapi: 3.0.3
info:
  title: Test API
  version: 1.0.0
paths:
  /v1/widgets:
    get:
      operationId: getWidgets
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
`, 'utf8');
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    process.env.GITHUB_REPOSITORY = 'postman-cs/collection-run-service';
    process.env.GITHUB_SHA = 'head-sha';
    const outputPath = join(dir, 'outputs.txt');
    writeFileSync(outputPath, '', 'utf8');
    process.env.GITHUB_OUTPUT = outputPath;
    setInput('mode', 'run');
    setInput('pr-number', '42');
    setInput('postman-api-key', 'postman-token');
    setInput('github-token', 'github-token');
    setInput('config-write-mode', 'none');
    setInput('onboarding-config-path', '.postman-template/onboarding.yml');
    return dir;
  }

  function createMockPostmanClient(): unknown {
    return {
      findWorkspacesByName: async () => [],
      createWorkspace: async () => ({ id: 'ws-1' }),
      uploadSpec: async () => 'spec-1',
      updateSpec: async () => {},
      generateCollection: async () => 'temp-col-1',
      getCollection: async () => ({ info: { name: 'test' }, item: [] }),
      updateCollection: async () => {},
      deleteCollection: async () => {},
      deleteSpec: async () => {}
    };
  }

  function createMockGitHubClient(
    renderedComments: string[],
    summaries: PrCommentSummary[]
  ): GitHubPrClient {
    return {
      findStickyComment: async () => undefined,
      upsertStickyComment: async (
        _prNumber: number,
        state: PreviewAssetState,
        summary: PrCommentSummary
      ) => {
        summaries.push(summary);
        renderedComments.push(renderStickyComment(state, summary));
        return 321;
      }
    } as unknown as GitHubPrClient;
  }

  it('writes ledger.json and threads ledger counts into the marker on collection-run failure', async () => {
    setupCollectionRunRepo();
    runnerMocks.ensurePostmanCli.mockResolvedValue(undefined);
    runnerMocks.startBackgroundCommand.mockReturnValue({ kill: () => {}, pid: 12345 });
    runnerMocks.waitForHealth.mockResolvedValue({ ok: true, phase: 'health_check' });
    runnerMocks.runTddCollection.mockResolvedValue({
      exitCode: 1,
      logExcerpt: [
        '[Postman TDD] getWidgets GET /v1/widgets :: status code is defined by OpenAPI',
        'AssertionError: Expected status code 200 but received 404'
      ].join('\n')
    });

    const renderedComments: string[] = [];
    const summaries: PrCommentSummary[] = [];
    const github = createMockGitHubClient(renderedComments, summaries);
    const artifactClient = {
      uploadArtifact: async () => ({ digest: 'sha256:abc', id: 123 })
    };

    await expect(runAction({
      artifactClient: artifactClient as never,
      githubClient: github,
      postmanClient: createMockPostmanClient() as never
    })).rejects.toThrow('Postman TDD collection failed');

    const ledgerPath = join(dir, '.postman-tdd', 'ledger.json');
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.packets).toHaveLength(1);
    expect(ledger.packets[0].key).toBe('getWidgets');
    expect(ledger.packets[0].passes).toBe(false);
    expect(ledger.packets[0].attempts).toBe(1);
    expect(ledger.packets[0].lastFailureFingerprint).toBeTruthy();

    const body = renderedComments[0] || '';
    const markerState = parseAssetState(body);
    expect(markerState?.ledger).toMatchObject({
      total: 1,
      passing: 0,
      failing: 1
    });
    expect(markerState?.ledger?.packets[0]?.key).toBe('getWidgets');
    expect(markerState?.ledger?.packets[0]?.passes).toBe(false);
  });

  it('flips packets to passes:true on a passing collection run', async () => {
    setupCollectionRunRepo();
    runnerMocks.ensurePostmanCli.mockResolvedValue(undefined);
    runnerMocks.startBackgroundCommand.mockReturnValue({ kill: () => {}, pid: 12345 });
    runnerMocks.waitForHealth.mockResolvedValue({ ok: true, phase: 'health_check' });
    runnerMocks.runTddCollection.mockResolvedValue({ exitCode: 0, logExcerpt: '' });

    const renderedComments: string[] = [];
    const summaries: PrCommentSummary[] = [];
    const github = createMockGitHubClient(renderedComments, summaries);
    const artifactClient = {
      uploadArtifact: async () => ({ digest: 'sha256:abc', id: 123 })
    };

    await runAction({
      artifactClient: artifactClient as never,
      githubClient: github,
      postmanClient: createMockPostmanClient() as never
    });

    const ledgerPath = join(dir, '.postman-tdd', 'ledger.json');
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(ledger.packets).toHaveLength(1);
    expect(ledger.packets[0].key).toBe('getWidgets');
    expect(ledger.packets[0].passes).toBe(true);
    expect(ledger.packets[0].lastVerifiedCommit).toBe('head-sha');

    const body = renderedComments[0] || '';
    const markerState = parseAssetState(body);
    expect(markerState?.ledger).toMatchObject({
      total: 1,
      passing: 1,
      failing: 0
    });
    expect(markerState?.ledger?.packets[0]?.passes).toBe(true);
  });

  function setupRatchetRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-ratchet-'));
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, '.postman-template', 'onboarding.yml'), `
spec:
  path: api/openapi.yaml
service:
  name: ratchet-service
tdd:
  enabled: true
  workspace:
    id: ws-1
    name: Ratchet Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
`, 'utf8');
    writeFileSync(join(dir, 'api', 'openapi.yaml'), `
openapi: 3.0.3
info:
  title: Test API
  version: 1.0.0
paths:
  /v1/widgets:
    get:
      operationId: getWidgets
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
`, 'utf8');
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    process.env.GITHUB_REPOSITORY = 'postman-cs/ratchet-service';
    process.env.GITHUB_SHA = 'head-sha';
    const outputPath = join(dir, 'outputs.txt');
    writeFileSync(outputPath, '', 'utf8');
    process.env.GITHUB_OUTPUT = outputPath;
    setInput('mode', 'run');
    setInput('pr-number', '42');
    setInput('postman-api-key', 'postman-token');
    setInput('github-token', 'github-token');
    setInput('config-write-mode', 'none');
    setInput('onboarding-config-path', '.postman-template/onboarding.yml');
    return dir;
  }

  const previousLedger: LedgerSummary = {
    failing: 0,
    packets: [{ key: 'oldOp', passes: true, title: 'oldOp' }],
    passing: 1,
    total: 1
  };

  function createRatchetGithubClient(labels: string[], summaries: PrCommentSummary[]): GitHubPrClient {
    return {
      findStickyComment: async () => ({
        assetState: { prNumber: 42, schemaVersion: 1, ledger: previousLedger },
        body: '',
        id: 100
      }),
      getPullRequest: async () => ({
        baseRepository: 'postman-cs/ratchet-service',
        headBranch: 'feature',
        headRepository: 'postman-cs/ratchet-service',
        headSha: 'head-sha',
        isFork: false,
        labels,
        number: 42
      }),
      upsertStickyComment: async (
        _prNumber: number,
        state: PreviewAssetState,
        summary: PrCommentSummary
      ) => {
        summaries.push(summary);
        return 200;
      }
    } as unknown as GitHubPrClient;
  }

  it('publishes test_ratchet failure when a previously-passing packet is removed without the escape-hatch label', async () => {
    setupRatchetRepo();
    runnerMocks.ensurePostmanCli.mockResolvedValue(undefined);
    runnerMocks.startBackgroundCommand.mockReturnValue({ kill: () => {}, pid: 12345 });
    runnerMocks.waitForHealth.mockResolvedValue({ ok: true, phase: 'health_check' });
    runnerMocks.runTddCollection.mockResolvedValue({
      exitCode: 1,
      logExcerpt: '[Postman TDD] getWidgets GET /v1/widgets :: status code is defined by OpenAPI\nAssertionError: Expected 200'
    });

    const summaries: PrCommentSummary[] = [];
    const github = createRatchetGithubClient([], summaries);
    const artifactClient = {
      uploadArtifact: async () => ({ digest: 'sha256:abc', id: 123 })
    };

    await expect(runAction({
      artifactClient: artifactClient as never,
      githubClient: github,
      postmanClient: createMockPostmanClient() as never
    })).rejects.toThrow('Previously-passing contract assertions');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.failurePhase).toBe('test_ratchet');
    expect(summaries[0]?.failureDocument?.phase).toBe('test_ratchet');
    expect(summaries[0]?.failureDocument?.failures[0]?.message).toContain('oldOp');
  });

  it('drops the removed packet and falls through to collection_run when the escape-hatch label is present', async () => {
    setupRatchetRepo();
    runnerMocks.ensurePostmanCli.mockResolvedValue(undefined);
    runnerMocks.startBackgroundCommand.mockReturnValue({ kill: () => {}, pid: 12345 });
    runnerMocks.waitForHealth.mockResolvedValue({ ok: true, phase: 'health_check' });
    runnerMocks.runTddCollection.mockResolvedValue({
      exitCode: 1,
      logExcerpt: '[Postman TDD] getWidgets GET /v1/widgets :: status code is defined by OpenAPI\nAssertionError: Expected 200'
    });

    const summaries: PrCommentSummary[] = [];
    const github = createRatchetGithubClient(['postman-tdd-allow-ratchet-removal'], summaries);
    const artifactClient = {
      uploadArtifact: async () => ({ digest: 'sha256:abc', id: 123 })
    };

    await expect(runAction({
      artifactClient: artifactClient as never,
      githubClient: github,
      postmanClient: createMockPostmanClient() as never
    })).rejects.toThrow('Postman TDD collection failed');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.failurePhase).toBe('collection_run');

    const ledger = JSON.parse(readFileSync(join(dir, '.postman-tdd', 'ledger.json'), 'utf8'));
    const keys = ledger.packets.map((p: { key: string }) => p.key);
    expect(keys).not.toContain('oldOp');
    expect(keys).toContain('getWidgets');
  });
});
