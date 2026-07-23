import { describe, expect, it } from 'vitest';

import { parseAssetState, parseFailureDocument, renderStickyComment } from '../src/github/pr-comment.js';
import { createImmutableStatePayload, signImmutableState } from '../src/immutable-state.js';
import { toLedgerSummary } from '../src/ledger.js';
import { isRepairComment, parseRepairSummary, renderRepairComment } from '../src/repair/summary.js';
import type { Ledger, LedgerSummary } from '../src/types.js';

describe('PR sticky comment marker', () => {
  it('omits immutable state from passed hidden markers', () => {
    const immutableState = signImmutableState(createImmutableStatePayload({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      prNumber: 123,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    }), 'secret');
    const body = renderStickyComment({
      collectionId: 'col-1',
      immutableState,
      prNumber: 123,
      schemaVersion: 1,
      specId: 'spec-1',
      workspaceId: 'ws-1'
    }, {
      status: 'passed'
    });

    expect(parseAssetState(body)).toEqual({
      collectionId: 'col-1',
      prNumber: 123,
      schemaVersion: 1,
      specId: 'spec-1',
      workspaceId: 'ws-1'
    });
    expect(body).toContain('Postman TDD Preview (PASSED)');
  });

  it('renders failure summaries with the agent artifact pointer', () => {
    const immutableState = signImmutableState(createImmutableStatePayload({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      prNumber: 123,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    }), 'secret');
    const body = renderStickyComment({
      immutableState,
      prNumber: 123,
      schemaVersion: 1
    }, {
      agentContextArtifactDigest: 'sha256:abc123',
      agentContextArtifactId: 456,
      agentContextArtifactName: 'postman-tdd-agent-context',
      agentTaskPath: '.postman-tdd/agent-task.md',
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'Expected status 200' }],
        immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
        immutablePaths: ['api/openapi.yaml'],
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });

    expect(body).toContain('Agent context artifact: `postman-tdd-agent-context`');
    expect(body).toContain('**Generated for commit:** `abc123`');
    expect(body).toContain('Before acting, compare `commit` in the Agent failure JSON to the current PR head SHA');
    expect(body).toContain('**Immutable paths:** `api/openapi.yaml`');
    expect(body).toContain('## Next Action');
    expect(body).toContain('**What happened:** The generated Postman collection ran against the PR service and found contract failures.');
    expect(body).toContain('**Next action:** Fix the PR implementation so the API behavior matches the generated Postman TDD contract.');
    expect(body).toContain('**Repair eligibility:** Eligible for automated repair when repair is enabled');
    expect(body).toContain('**Done when:** `Postman TDD Preview` passes on the latest PR head commit.');
    expect(body).toContain('"immutablePaths": [');
    expect(body).toContain('"immutablePathHashes": [');
    expect(body).toContain('id: 456');
    expect(body).toContain('sha256:abc123');
    expect(body).toContain('Artifact contents: `.postman-tdd/agent-task.md`, `.postman-tdd/failures.json`, and `.postman-tdd/immutable-spec-guard.mjs`');
    expect(body).toContain('Expected status 200');
    expect(body).toContain('Agent failure JSON');
    expect(parseAssetState(body)).toMatchObject({
      immutableState,
      prNumber: 123,
      schemaVersion: 1
    });
    expect(parseFailureDocument(body)).toMatchObject({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      immutablePaths: ['api/openapi.yaml'],
      phase: 'collection_run',
      status: 'failed'
    });
    expect(body.indexOf('## Next Action')).toBeLessThan(body.indexOf('Agent context artifact:'));
    expect(body.indexOf('Agent context artifact:')).toBeLessThan(body.indexOf('## Current Failures'));
    expect(body.indexOf('## Current Failures')).toBeLessThan(body.indexOf('<summary>Agent failure JSON</summary>'));
  });

  it('renders config failures as setup work, not implementation repair', () => {
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'tdd.baseUrl is required when tdd.enabled=true' }],
        immutablePathHashes: [],
        immutablePaths: [],
        message: 'tdd.baseUrl is required when tdd.enabled=true',
        phase: 'config',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });

    expect(body).toContain('**Failure phase:** config');
    expect(body).toContain('**What happened:** The onboarding configuration or action inputs failed validation before preview assets or collection checks could run.');
    expect(body).toContain('**Next action:** Fix `.postman-template/onboarding.yml` or the action inputs');
    expect(body).toContain('**Repair eligibility:** Not eligible for automated implementation repair');
    expect(body).toContain('## Current Failures');
    expect(body).toContain('Agent failure JSON');
  });

  it('renders health check guidance with runtime details', () => {
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'The service did not become healthy.' }],
        healthUrl: 'http://127.0.0.1:4010/v1/health',
        immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
        immutablePaths: ['api/openapi.yaml'],
        message: 'The service did not become healthy.',
        phase: 'health_check',
        schemaVersion: 1,
        specPath: 'api/openapi.yaml',
        startCommand: './scripts/postman-tdd-start.sh',
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        },
        timeoutSeconds: 60
      },
      status: 'failed'
    });

    expect(body).toContain('**Failure phase:** health_check');
    expect(body).toContain('The service started, but the configured health check did not pass in time.');
    expect(body).toContain('startCommand=`./scripts/postman-tdd-start.sh`');
    expect(body).toContain('healthUrl=`http://127.0.0.1:4010/v1/health`');
    expect(body).toContain('timeout=60s');
    expect(body).toContain('**Repair eligibility:** Eligible for automated repair when repair is enabled');
  });

  it('renders repair comments with a separate sticky marker', () => {
    const body = renderRepairComment({
      attempts: 2,
      blockedReason: 'budget_exhausted',
      message: 'Repair budget exhausted after 2 attempt(s).',
      prNumber: 123,
      schemaVersion: 1,
      status: 'blocked'
    });

    expect(isRepairComment(body)).toBe(true);
    expect(body).toContain('postman-tdd-repair');
    expect(body).toContain('Postman TDD Repair (BLOCKED)');
    expect(body).toContain('**Attempts:** 2');
    expect(body).toContain('`budget_exhausted`');
    expect(body).toContain('## Next Action');
    expect(body).toContain('**What happened:** Repair used all accepted attempts without producing a passing local TDD oracle.');
    expect(body).toContain('**Next action:** Review the latest preview failures and repair summary');
    expect(body).toContain('**Done when:** `Postman TDD Preview` passes on the latest PR head commit.');
    expect(body).not.toContain('postman-tdd-preview');
  });

  it('renders repaired comments with review guidance', () => {
    const body = renderRepairComment({
      attemptDetails: [{
        attempt: 1,
        localTest: {
          command: 'npm test',
          status: 'passed'
        },
        oracle: {
          status: 'passed'
        },
        outcome: 'oracle_passed',
        patchSummary: 'Implement the missing widget owner fields.',
        providerStatus: 'changed',
        touchedPaths: ['src/server.js']
      }],
      attempts: 1,
      commitSha: 'repair-sha',
      message: 'Postman TDD repair produced an implementation-only commit after the collection passed in the worker.',
      prNumber: 123,
      schemaVersion: 1,
      status: 'repaired'
    });

    expect(body).toContain('Postman TDD Repair (REPAIRED)');
    expect(body).toContain('**Commit:** `repair-sha`');
    expect(body).toContain('## Attempt Timeline');
    expect(body).toContain('| Attempt | Patch | Paths | Local test | Oracle | Outcome |');
    expect(body).toContain('| 1 | Implement the missing widget owner fields. | src/server.js | passed | passed | oracle passed |');
    expect(body).toContain('**What happened:** Repair produced an implementation-only commit after the local oracle passed.');
    expect(body).toContain('**Next action:** Review the repair commit and wait for preview to rerun on the updated PR branch.');
  });

  it('renders a schemaVersion 2 repair summary with checkpointRef', () => {
    const body = renderRepairComment({
      attempts: 1,
      blockedReason: 'budget_exhausted',
      checkpointRef: {
        algorithm: 'hmac-sha256',
        payload: {
          attempts: 1,
          attemptFingerprints: ['fp1'],
          commit: 'head-sha',
          escalated: false,
          provider: 'openai-responses',
          schemaVersion: 1
        },
        schemaVersion: 1,
        signature: 'hmac-sha256:abc123'
      },
      message: 'Repair budget exhausted after 1 attempt(s).',
      prNumber: 123,
      schemaVersion: 2,
      status: 'blocked'
    });

    expect(isRepairComment(body)).toBe(true);
    expect(body).toContain('Postman TDD Repair (BLOCKED)');
    expect(parseRepairSummary(body)).toMatchObject({
      attempts: 1,
      checkpointRef: expect.objectContaining({ signature: 'hmac-sha256:abc123' }),
      schemaVersion: 2
    });
  });

  it('still renders a v1 repair summary without checkpointRef (backward compat)', () => {
    const body = renderRepairComment({
      attempts: 0,
      blockedReason: 'stale_failure',
      message: 'Stale failure context.',
      prNumber: 123,
      schemaVersion: 1,
      status: 'blocked'
    });

    expect(isRepairComment(body)).toBe(true);
    expect(body).toContain('Postman TDD Repair (BLOCKED)');
    expect(body).toContain('`stale_failure`');
    expect(parseRepairSummary(body)).toMatchObject({ attempts: 0, schemaVersion: 1 });
  });

  it('renders blocked repair comments with failed attempt diagnostics', () => {
    const body = renderRepairComment({
      attemptDetails: [{
        attempt: 1,
        localTest: {
          command: 'npm test',
          exitCode: 1,
          status: 'failed'
        },
        oracle: {
          status: 'skipped'
        },
        outcome: 'local_test_failed',
        patchSummary: 'Add the missing createServer export.',
        providerStatus: 'changed',
        touchedPaths: ['src/server.js']
      }, {
        attempt: 2,
        localTest: {
          command: 'npm test',
          status: 'passed'
        },
        oracle: {
          failureCount: 1,
          failures: [{
            assertion: 'response body matches schema',
            message: 'Missing required property: generatedAt',
            method: 'GET',
            operationId: 'getWidgetSummary',
            path: '/v1/widgets/summary'
          }],
          phase: 'collection_run',
          status: 'failed'
        },
        outcome: 'oracle_failed',
        patchSummary: 'Add widget list and summary endpoints.',
        providerStatus: 'changed',
        touchedPaths: ['src/server.js']
      }],
      attempts: 2,
      blockedReason: 'budget_exhausted',
      message: 'Repair budget exhausted after 2 attempt(s).',
      prNumber: 123,
      schemaVersion: 1,
      status: 'blocked'
    });

    expect(body).toContain('Postman TDD Repair (BLOCKED)');
    expect(body).toContain('| 1 | Add the missing createServer export. | src/server.js | failed (1) | skipped | local test failed |');
    expect(body).toContain('| 2 | Add widget list and summary endpoints. | src/server.js | passed | collection_run, 1 failure(s) | oracle failed |');
    expect(body).not.toContain('Missing required property: generatedAt');
  });

  it('round-trips ledger summary through the marker on a failed comment', () => {
    const ledger: LedgerSummary = {
      failing: 1,
      packets: [
        { key: 'getWidgets', lastFailureFingerprint: 'abc123', passes: false, title: 'getWidgets' },
        { key: 'createWidget', passes: true, title: 'createWidget' }
      ],
      passing: 1,
      total: 2
    };
    const body = renderStickyComment({
      ledger,
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'Expected status 200' }],
        immutablePathHashes: [],
        immutablePaths: [],
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });

    const parsed = parseAssetState(body);
    expect(parsed?.ledger).toEqual(ledger);
  });

  it('round-trips ledger summary through the marker on a passed comment', () => {
    const ledger: LedgerSummary = {
      failing: 0,
      packets: [{ key: 'getWidgets', passes: true, title: 'getWidgets' }],
      passing: 1,
      total: 1
    };
    const body = renderStickyComment({
      ledger,
      prNumber: 123,
      schemaVersion: 1
    }, {
      status: 'passed'
    });

    const parsed = parseAssetState(body);
    expect(parsed?.ledger).toEqual(ledger);
  });

  it('parses a v1 marker without ledger unchanged (backward compat)', () => {
    const body = renderStickyComment({
      collectionId: 'col-1',
      prNumber: 123,
      schemaVersion: 1,
      specId: 'spec-1',
      workspaceId: 'ws-1'
    }, {
      status: 'passed'
    });

    const parsed = parseAssetState(body);
    expect(parsed).toEqual({
      collectionId: 'col-1',
      prNumber: 123,
      schemaVersion: 1,
      specId: 'spec-1',
      workspaceId: 'ws-1'
    });
    expect(parsed?.ledger).toBeUndefined();
  });

  it('caps embedded ledger summary at 20 packets from a 30-packet ledger (D8)', () => {
    const ledger: Ledger = {
      packets: Array.from({ length: 30 }, (_, i) => ({
        acceptance: [],
        attempts: 0,
        key: `op${i}`,
        method: 'GET',
        passes: true,
        path: `/v1/op${i}`,
        title: `op${i}`
      })),
      schemaVersion: 1
    };
    const summary = toLedgerSummary(ledger);
    expect(summary.packets).toHaveLength(20);
    expect(summary.total).toBe(30);

    const body = renderStickyComment({
      ledger: summary,
      prNumber: 123,
      schemaVersion: 1
    }, {
      status: 'passed'
    });

    const parsed = parseAssetState(body);
    expect(parsed?.ledger?.packets).toHaveLength(20);
    expect(parsed?.ledger?.total).toBe(30);
  });

  it('renders a packet status table when ledger is present on a failed comment', () => {
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'Expected status 200', method: 'GET', operationId: 'getWidgets', path: '/v1/widgets' }],
        immutablePathHashes: [],
        immutablePaths: [],
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      ledger: {
        failing: 1,
        packets: [
          { key: 'getWidgets', lastFailureFingerprint: 'abcdef1234567890', passes: false, title: 'getWidgets' },
          { key: 'createWidget', passes: true, title: 'createWidget' }
        ],
        passing: 1,
        total: 2
      } satisfies LedgerSummary,
      status: 'failed'
    });

    expect(body).toContain('## Packet Status');
    expect(body).toContain('| getWidgets | fail | abcdef12 |');
    expect(body).toContain('| createWidget | pass |');
    expect(body.indexOf('## Current Failures')).toBeLessThan(body.indexOf('## Packet Status'));
    expect(body.indexOf('## Packet Status')).toBeLessThan(body.indexOf('<summary>Agent failure JSON</summary>'));
  });

  it('omits the packet status table when ledger is absent', () => {
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'Expected status 200' }],
        immutablePathHashes: [],
        immutablePaths: [],
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });

    expect(body).not.toContain('## Packet Status');
  });

  it('renders test_ratchet guidance naming the escape-hatch label', () => {
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'Packet getWidgets was previously passing but is missing or weakened in this PR.' }],
        immutablePathHashes: [],
        immutablePaths: [],
        message: 'Previously-passing contract assertions were removed or weakened in this PR.',
        phase: 'test_ratchet',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });

    expect(body).toContain('**Failure phase:** test_ratchet');
    expect(body).toContain('postman-tdd-allow-ratchet-removal');
    expect(body).toContain('Not eligible for automated implementation repair because previously-passing contract assertions were removed or weakened.');
    expect(body).toContain('Previously-passing contract assertions were removed or weakened in this PR.');
  });

  it('replaces the packet status table with a counts-only line when body exceeds 60000 chars (D8)', () => {
    const largeHashes = Array.from({ length: 520 }, (_, i) => ({
      path: `p${i}`,
      sha256: 'a'.repeat(64)
    }));
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc123',
        failures: [{ message: 'Expected status 200' }],
        immutablePathHashes: largeHashes,
        immutablePaths: [],
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      ledger: {
        failing: 1,
        packets: [{ key: 'getWidgets', lastFailureFingerprint: 'abc123', passes: false, title: 'getWidgets' }],
        passing: 0,
        total: 1
      } satisfies LedgerSummary,
      status: 'failed'
    });

    expect(body).not.toContain('## Packet Status');
    expect(body).toContain('**Packet Status:**');
    expect(body).toContain('Full ledger in the `.postman-tdd/ledger.json` run artifact');
    expect(body.length).toBeLessThanOrEqual(65536);
  });
});
