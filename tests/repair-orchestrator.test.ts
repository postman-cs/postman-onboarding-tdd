import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type GitHubPrClient, type PullRequestDetails } from '../src/github/pr-comment.js';
import { runRepairMode } from '../src/repair/orchestrator.js';
import { signRepairCheckpoint } from '../src/repair/checkpoint.js';
import type { ActionInputs, AgentFailureDocument, RepairCheckpointPayload, SignedRepairCheckpoint } from '../src/types.js';

// Partial mocks that preserve real helper functions while stubbing the
// side-effectful seams (provider turn, preview assets, runner, git hashing).
// Guard tests block before reaching any of these, so the mocks are inert there.
const repairMocks = vi.hoisted(() => ({
  commitAndPushRepair: vi.fn(),
  ensurePostmanCli: vi.fn(),
  hashPaths: vi.fn(),
  resolveTddWorkspace: vi.fn(),
  runCommand: vi.fn(),
  runRepairProviderTurn: vi.fn(),
  runTddCollection: vi.fn(),
  startBackgroundCommand: vi.fn(),
  upsertPreviewAssets: vi.fn(),
  verifyChangedPaths: vi.fn(),
  verifyPathHashes: vi.fn(),
  waitForHealth: vi.fn()
}));

vi.mock('../src/repair/provider-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repair/provider-dispatcher.js')>();
  return { ...actual, runRepairProviderTurn: repairMocks.runRepairProviderTurn };
});

vi.mock('../src/preview-assets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/preview-assets.js')>();
  return {
    ...actual,
    resolveTddWorkspace: repairMocks.resolveTddWorkspace,
    upsertPreviewAssets: repairMocks.upsertPreviewAssets
  };
});

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>();
  return {
    ...actual,
    ensurePostmanCli: repairMocks.ensurePostmanCli,
    runCommand: repairMocks.runCommand,
    runTddCollection: repairMocks.runTddCollection,
    startBackgroundCommand: repairMocks.startBackgroundCommand,
    waitForHealth: repairMocks.waitForHealth
  };
});

vi.mock('../src/repair/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repair/git.js')>();
  return {
    ...actual,
    commitAndPushRepair: repairMocks.commitAndPushRepair,
    hashPaths: repairMocks.hashPaths,
    verifyChangedPaths: repairMocks.verifyChangedPaths,
    verifyPathHashes: repairMocks.verifyPathHashes
  };
});

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

  function createRepo(provider = 'openai-responses'): string {
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
    provider: ${provider}
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
      repairMaxToolRounds: 12,
      repairBreakerThreshold: 2,
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
      labels: [],
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
    return [
      '# Postman TDD Preview (FAILED)',
      '',
      '<details>',
      '<summary>Agent failure JSON</summary>',
      '',
      '```json',
      JSON.stringify(failure, null, 2),
      '```',
      '</details>'
    ].join('\n');
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

  it('blocks failure context without a commit before asset or model work starts', async () => {
    const summary = await runGuard({
      stickyBody: failureBody({ commit: undefined })
    });

    expect(summary).toMatchObject({
      attempts: 0,
      blockedReason: 'missing_failure_commit',
      status: 'blocked'
    });
  });

  it('blocks malformed failure context before asset or model work starts', async () => {
    const summary = await runGuard({
      stickyBody: failureBody({
        immutablePaths: 'api/openapi.yaml'
      } as unknown as Partial<AgentFailureDocument>)
    });

    expect(summary).toMatchObject({
      attempts: 0,
      blockedReason: 'malformed_failure_context',
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

  it('blocks test_ratchet phase as non-repairable', async () => {
    const summary = await runGuard({
      stickyBody: failureBody({ phase: 'test_ratchet' })
    });

    expect(summary).toMatchObject({
      attempts: 0,
      blockedReason: 'unsupported_failure_phase',
      status: 'blocked'
    });
  });

  it('requires the OpenAI key when the OpenAI repair provider is selected', async () => {
    createRepo('openai-responses');

    await expect(runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github: {} as never,
      inputs: {
        ...actionInputs(),
        openaiApiKey: undefined
      },
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    })).rejects.toThrow('openai-api-key is required when mode=repair and repair-provider=openai-responses');
  });

  it('requires the Anthropic key when the Anthropic repair provider is selected', async () => {
    createRepo('anthropic-messages');

    await expect(runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github: {} as never,
      inputs: {
        ...actionInputs(),
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        repairModel: 'claude-sonnet-5',
        repairProvider: 'anthropic-messages'
      },
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    })).rejects.toThrow('anthropic-api-key is required when mode=repair and repair-provider=anthropic-messages');
  });

  it('inherits the Anthropic repair provider from onboarding config when the action input is omitted', async () => {
    createRepo('anthropic-messages');

    await expect(runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github: {} as never,
      inputs: {
        ...actionInputs(),
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        repairModel: undefined,
        repairProvider: undefined
      },
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    })).rejects.toThrow('anthropic-api-key is required when mode=repair and repair-provider=anthropic-messages');
  });

  it('requires the Postman access token when the Postman Agent Mode repair provider is selected', async () => {
    createRepo('postman-agent-mode');

    await expect(runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github: {} as never,
      inputs: {
        ...actionInputs(),
        openaiApiKey: undefined,
        postmanAccessToken: undefined,
        repairModel: 'GPT_5',
        repairProvider: 'postman-agent-mode'
      },
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    })).rejects.toThrow('postman-access-token is required when mode=repair and repair-provider=postman-agent-mode');
  });

  it('inherits the Postman Agent Mode repair provider from onboarding config when the action input is omitted', async () => {
    createRepo('postman-agent-mode');

    await expect(runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github: {} as never,
      inputs: {
        ...actionInputs(),
        openaiApiKey: undefined,
        postmanAccessToken: undefined,
        repairModel: undefined,
        repairProvider: undefined
      },
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    })).rejects.toThrow('postman-access-token is required when mode=repair and repair-provider=postman-agent-mode');
  });

  it('requires the action repair provider to match onboarding config', async () => {
    createRepo('anthropic-messages');

    await expect(runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github: {} as never,
      inputs: actionInputs(),
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    })).rejects.toThrow('repair-provider input (openai-responses) must match tdd.repair.provider (anthropic-messages)');
  });
});

describe('repair orchestrator maxToolRounds threading', () => {
  let dir = '';
  let previousCwd = '';
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousCwd = process.cwd();
    previousWorkspace = process.env.GITHUB_WORKSPACE;
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-repair-rounds-'));
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
    provider: openai-responses
    allowedWritePaths:
      - src/**
`, 'utf8');
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    repairMocks.ensurePostmanCli.mockResolvedValue(undefined);
    repairMocks.resolveTddWorkspace.mockResolvedValue({ workspaceId: 'ws-1' });
    repairMocks.upsertPreviewAssets.mockResolvedValue({
      collectionId: 'col-1',
      contractIndex: { operations: [], openapiVersion: '3.0' } as never,
      specId: 'spec-1'
    });
    repairMocks.hashPaths.mockReturnValue([]);
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

  function failureBody(): string {
    const failure: AgentFailureDocument = {
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
      }
    };
    return [
      '# Postman TDD Preview (FAILED)',
      '',
      '<details>',
      '<summary>Agent failure JSON</summary>',
      '',
      '```json',
      JSON.stringify(failure, null, 2),
      '```',
      '</details>'
    ].join('\n');
  }

  it('passes repairMaxToolRounds from inputs into runRepairProviderTurn', async () => {
    repairMocks.runRepairProviderTurn.mockResolvedValue({
      status: 'no_change',
      message: 'provider reported no change'
    });
    const github = {
      findStickyComment: async () => ({ body: failureBody(), id: 1 }),
      getPullRequest: async () => ({
        baseRepository: 'postman-cs/pavan-test-TDD',
        headBranch: 'repair-branch',
        headRepository: 'postman-cs/pavan-test-TDD',
        headSha: 'head-sha',
        isFork: false,
        labels: [],
        number: 123
      }),
      upsertRepairComment: async () => 1
    } as unknown as GitHubPrClient;

    await runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github,
      inputs: {
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
        repairMaxToolRounds: 5,
        repairBreakerThreshold: 2,
        repairModel: 'gpt-5.5',
        repairProvider: 'openai-responses'
      },
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    });

    expect(repairMocks.runRepairProviderTurn).toHaveBeenCalledTimes(1);
    expect(repairMocks.runRepairProviderTurn).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolRounds: 5 })
    );
  });
});

describe('repair orchestrator checkpoint resume', () => {
  let dir = '';
  let previousCwd = '';
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousCwd = process.cwd();
    previousWorkspace = process.env.GITHUB_WORKSPACE;
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-checkpoint-resume-'));
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
    provider: openai-responses
    maxAttempts: 3
    allowedWritePaths:
      - src/**
`, 'utf8');
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'api', 'openapi.yaml'), 'openapi: 3.0.3\ninfo:\n  title: test\n  version: 0.1.0\npaths: {}\n', 'utf8');
    repairMocks.ensurePostmanCli.mockResolvedValue(undefined);
    repairMocks.resolveTddWorkspace.mockResolvedValue({ workspaceId: 'ws-1' });
    repairMocks.upsertPreviewAssets.mockResolvedValue({
      collectionId: 'col-1',
      contractIndex: { operations: [], openapiVersion: '3.0' } as never,
      specId: 'spec-1'
    });
    repairMocks.hashPaths.mockReturnValue([]);
    repairMocks.verifyChangedPaths.mockReturnValue([]);
    repairMocks.verifyPathHashes.mockReturnValue(undefined);
    repairMocks.commitAndPushRepair.mockReturnValue('commit-sha');
    repairMocks.startBackgroundCommand.mockReturnValue({ kill: vi.fn() });
    repairMocks.waitForHealth.mockResolvedValue({ ok: true });
    repairMocks.runTddCollection.mockImplementation(async () => {
      const n = repairMocks.runTddCollection.mock.calls.length + 1;
      return { exitCode: 1, logExcerpt: `expected status 200 but got ${400 + n} for op${n}` };
    });
    repairMocks.runRepairProviderTurn.mockResolvedValue({
      status: 'changed',
      summary: 'patch',
      touchedPaths: []
    });
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

  function failureBody(checkpointRef?: SignedRepairCheckpoint | RepairCheckpointPayload): string {
    const failure: AgentFailureDocument = {
      commit: 'head-sha',
      failures: [{ message: 'Synthetic failure.' }],
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      immutablePaths: ['api/openapi.yaml'],
      message: 'Synthetic failure.',
      phase: 'collection_run',
      schemaVersion: 2,
      specPath: 'api/openapi.yaml',
      status: 'failed',
      successCriteria: {
        doneWhen: 'requiredCheck passes on the latest PR head commit',
        failureContextMustMatchPrHeadCommit: true,
        latestHeadOnly: true,
        requiredCheck: 'Postman TDD Preview'
      },
      ...(checkpointRef ? { checkpointRef } : {})
    };
    return [
      '# Postman TDD Preview (FAILED)',
      '',
      '<details>',
      '<summary>Agent failure JSON</summary>',
      '',
      '```json',
      JSON.stringify(failure, null, 2),
      '```',
      '</details>'
    ].join('\n');
  }

  async function runResume(options: {
    stickyBody: string;
    signingKey?: string;
    escalationModel?: string;
    visibleAttemptDetails?: number;
    repairCheckpoint?: SignedRepairCheckpoint | RepairCheckpointPayload;
  }): Promise<{ providerCalls: number; checkpointWritten: boolean; blockedReason?: string }> {
    let capturedSummary: { blockedReason?: string } | undefined;
    const github = {
      findStickyComment: async () => ({ body: options.stickyBody, id: 1 }),
      findRepairSummary: async () => options.visibleAttemptDetails === undefined && !options.repairCheckpoint ? undefined : ({
        attemptDetails: Array.from({ length: options.visibleAttemptDetails ?? 0 }, (_, index) => ({ attempt: index + 1 })),
        attempts: options.visibleAttemptDetails ?? 0,
        checkpointRef: options.repairCheckpoint,
        message: 'Prior repair run.',
        prNumber: 123,
        schemaVersion: 2,
        status: 'blocked'
      }),
      getPullRequest: async () => ({
        baseRepository: 'postman-cs/pavan-test-TDD',
        headBranch: 'repair-branch',
        headRepository: 'postman-cs/pavan-test-TDD',
        headSha: 'head-sha',
        isFork: false,
        labels: [],
        number: 123
      }),
      upsertRepairComment: async (_prNumber: number, nextSummary: unknown) => {
        capturedSummary = nextSummary as { blockedReason?: string };
        return 1;
      }
    } as unknown as GitHubPrClient;

    await runRepairMode({
      endpointProfile: {
        apiBaseUrl: 'https://api.getpostman.com',
        cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
      },
      github,
      inputs: {
        committerEmail: 'support@postman.com',
        committerName: 'Postman',
        configWriteMode: 'none',
        githubToken: 'github-token',
        immutableStateSigningKey: options.signingKey,
        mode: 'repair',
        onboardingConfigPath: '.postman-template/onboarding.yml',
        openaiApiKey: 'openai-token',
        postmanApiKey: 'postman-token',
        postmanRegion: 'us',
        postmanStack: 'prod',
        repairCommitMessage: 'Postman TDD repair',
        repairMaxAttempts: 3,
        repairMaxToolRounds: 12,
        repairBreakerThreshold: 2,
        repairEscalationModel: options.escalationModel,
        repairModel: 'gpt-5.5',
        repairProvider: 'openai-responses'
      },
      mask: (value) => value,
      postman: {} as never,
      pr: {
        number: 123,
        repository: 'postman-cs/pavan-test-TDD'
      }
    });

    return {
      providerCalls: repairMocks.runRepairProviderTurn.mock.calls.length,
      checkpointWritten: existsSync(join(dir, '.postman-tdd', 'checkpoint.json')),
      blockedReason: capturedSummary?.blockedReason
    };
  }

  it('resumes from a signed checkpoint with matching head when the signing key is set', async () => {
    const payload = {
      schemaVersion: 1 as const,
      attempts: 2,
      attemptFingerprints: ['fp1', 'fp2'],
      commit: 'head-sha',
      escalated: false,
      provider: 'openai-responses' as const
    };
    const signed = signRepairCheckpoint(payload, 'signing-key');

    const { providerCalls, checkpointWritten } = await runResume({
      stickyBody: failureBody(signed),
      signingKey: 'signing-key'
    });

    // Resumed at attempts=2, maxAttempts=3 → only 1 new provider turn.
    expect(providerCalls).toBe(1);
    expect(checkpointWritten).toBe(true);
  });

  it('resumes from a signed checkpoint serialized in the repair sticky comment', async () => {
    const signed = signRepairCheckpoint({
      schemaVersion: 1,
      attempts: 2,
      attemptFingerprints: ['fp1', 'fp2'],
      commit: 'head-sha',
      escalated: true,
      provider: 'openai-responses'
    }, 'signing-key');

    const { providerCalls } = await runResume({
      repairCheckpoint: signed,
      signingKey: 'signing-key',
      stickyBody: failureBody()
    });

    expect(providerCalls).toBe(1);
  });

  it('restarts from attempts=0 when the signed checkpoint signature is tampered', async () => {
    const payload = {
      schemaVersion: 1 as const,
      attempts: 2,
      attemptFingerprints: ['fp1', 'fp2'],
      commit: 'head-sha',
      escalated: false,
      provider: 'openai-responses' as const
    };
    const tampered: SignedRepairCheckpoint = {
      ...signRepairCheckpoint(payload, 'signing-key'),
      signature: 'hmac-sha256:deadbeef'
    };

    const { providerCalls } = await runResume({
      stickyBody: failureBody(tampered),
      signingKey: 'signing-key'
    });

    // Tampered → restart from 0 → 3 provider turns.
    expect(providerCalls).toBe(3);
  });

  it('advisory-resumes from an unsigned checkpoint, revalidating attempts from visible attemptDetails', async () => {
    const payload = {
      schemaVersion: 1 as const,
      attempts: 99,
      attemptFingerprints: ['fp1', 'fp2'],
      commit: 'head-sha',
      escalated: false,
      provider: 'openai-responses' as const
    };

    const { providerCalls } = await runResume({
      stickyBody: failureBody(payload),
      visibleAttemptDetails: 1
    });

    // Advisory: attempts are recomputed from one visible attempt detail, not
    // the checkpoint's attempts=99 or its two opaque fingerprints.
    expect(providerCalls).toBe(2);
  });

  it('writes the checkpoint.json artifact each attempt', async () => {
    const { checkpointWritten } = await runResume({
      stickyBody: failureBody()
    });

    expect(checkpointWritten).toBe(true);
    const checkpoint = JSON.parse(readFileSync(join(dir, '.postman-tdd', 'checkpoint.json'), 'utf8'));
    expect(checkpoint.schemaVersion).toBe(1);
    expect(checkpoint.commit).toBe('head-sha');
    expect(checkpoint.provider).toBe('openai-responses');
  });

  it('blocks with repeated_failure when the same fingerprint recurs threshold times', async () => {
    repairMocks.runTddCollection.mockResolvedValue({
      exitCode: 1,
      logExcerpt: 'expected status 200 but got 404 for getUsers'
    });

    const { providerCalls, blockedReason } = await runResume({
      stickyBody: failureBody()
    });

    expect(blockedReason).toBe('repeated_failure');
    // 2 identical failures with threshold 2 → block after 2 attempts (< maxAttempts=3).
    expect(providerCalls).toBe(2);
  });

  it('falls through to budget_exhausted when failures are distinct each attempt', async () => {
    // The beforeEach default mockImplementation returns a distinct log excerpt
    // per call, so fingerprints differ and the breaker never fires.
    const { providerCalls, blockedReason } = await runResume({
      stickyBody: failureBody()
    });

    expect(blockedReason).toBe('budget_exhausted');
    expect(providerCalls).toBe(3);
  });

  it('escalates to a stronger model then blocks with owner_action_required on failure', async () => {
    const { providerCalls, blockedReason } = await runResume({
      stickyBody: failureBody(),
      escalationModel: 'gpt-5.5-pro'
    });

    // 3 budget attempts + 1 escalation attempt = 4 provider turns.
    expect(providerCalls).toBe(4);
    expect(blockedReason).toBe('owner_action_required');
  });

  it('marks escalated=true on the checkpoint when escalation runs', async () => {
    await runResume({
      stickyBody: failureBody(),
      escalationModel: 'gpt-5.5-pro'
    });

    const checkpoint = JSON.parse(readFileSync(join(dir, '.postman-tdd', 'checkpoint.json'), 'utf8'));
    expect(checkpoint.escalated).toBe(true);
  });

  it('repaired via escalation when the escalation oracle passes', async () => {
    // First 3 oracle calls fail (budget), then escalation oracle passes.
    repairMocks.runTddCollection
      .mockResolvedValueOnce({ exitCode: 1, logExcerpt: 'expected status 200 but got 404 for op1' })
      .mockResolvedValueOnce({ exitCode: 1, logExcerpt: 'expected status 200 but got 404 for op2' })
      .mockResolvedValueOnce({ exitCode: 1, logExcerpt: 'expected status 200 but got 404 for op3' })
      .mockResolvedValueOnce({ exitCode: 0, logExcerpt: 'all passed' });

    const { providerCalls, blockedReason } = await runResume({
      stickyBody: failureBody(),
      escalationModel: 'gpt-5.5-pro'
    });

    expect(providerCalls).toBe(4);
    expect(blockedReason).toBeUndefined();
  });
});
