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
      agentTaskPath: '.postman-tdd/agent-task.md',
      failureDocument: {
        failures: [{ message: 'Expected status 200' }],
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

    expect(body).toContain('Agent context artifact');
    expect(body).toContain('Expected status 200');
  });
});
