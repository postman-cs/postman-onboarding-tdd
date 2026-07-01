import { describe, expect, it } from 'vitest';

import { parseAssetState, parseFailureDocument, renderStickyComment } from '../src/github/pr-comment.js';
import { createImmutableStatePayload, signImmutableState } from '../src/immutable-state.js';
import { isRepairComment, renderRepairComment } from '../src/repair/summary.js';

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
});
