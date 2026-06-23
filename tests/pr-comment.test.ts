import { describe, expect, it } from 'vitest';

import { parseAssetState, renderStickyComment } from '../src/github/pr-comment.js';

describe('PR sticky comment marker', () => {
  it('round-trips asset state through the hidden marker', () => {
    const body = renderStickyComment({
      collectionId: 'col-1',
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
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      agentContextArtifactDigest: 'sha256:abc123',
      agentContextArtifactId: 456,
      agentContextArtifactName: 'postman-tdd-agent-context',
      agentTaskPath: '.postman-tdd/agent-task.md',
      failureDocument: {
        failures: [{ message: 'Expected status 200' }],
        immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
        immutablePaths: ['api/openapi.yaml'],
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR commit',
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });

    expect(body).toContain('Agent context artifact: `postman-tdd-agent-context`');
    expect(body).toContain('**Immutable paths:** `api/openapi.yaml`');
    expect(body).toContain('"immutablePaths": [');
    expect(body).toContain('"immutablePathHashes": [');
    expect(body).toContain('id: 456');
    expect(body).toContain('sha256:abc123');
    expect(body).toContain('Artifact contents: `.postman-tdd/agent-task.md`, `.postman-tdd/failures.json`, and `.postman-tdd/immutable-spec-guard.mjs`');
    expect(body).toContain('Expected status 200');
    expect(body).toContain('Agent failure JSON');
  });
});
