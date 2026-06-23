import { describe, expect, it } from 'vitest';

import { extractCollectionFailures } from '../src/failure-normalizer.js';

describe('collection failure normalizer', () => {
  it('extracts compact records from tagged Postman TDD assertions', () => {
    const failures = extractCollectionFailures(`
      1. [Postman TDD] createWidget POST /v1/widgets :: response body matches schema
         AssertionError: $.owner is required
    `);

    expect(failures).toEqual([{
      assertion: 'response body matches schema',
      message: 'Missing required property: owner',
      method: 'POST',
      operationId: 'createWidget',
      path: '/v1/widgets'
    }]);
  });

  it('falls back to small records without raw collection logs', () => {
    const failures = extractCollectionFailures(`
      Postman CLI collection run
      AssertionError: expected 500 to equal 200
      Total run duration: 120ms
    `);

    expect(failures).toEqual([{
      assertion: 'collection assertion',
      message: 'expected 500 to equal 200'
    }]);
    expect(JSON.stringify(failures)).not.toContain('Total run duration');
  });

  it('returns a compact placeholder when no assertion details are detected', () => {
    const failures = extractCollectionFailures('collection exited with code 1');

    expect(failures).toEqual([{
      assertion: 'collection run',
      message: 'Postman TDD collection failed, but no compact assertion details were detected in runner output.'
    }]);
  });
});
