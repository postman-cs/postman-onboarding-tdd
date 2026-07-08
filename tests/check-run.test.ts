import { describe, expect, it, vi } from 'vitest';

import type { LedgerSummary } from '../src/types.js';

const checksMocks = vi.hoisted(() => ({
  create: vi.fn(),
  warning: vi.fn()
}));

// Mock @actions/github so getOctokit returns a controlled octokit whose
// rest.checks.create is the mocked function. This keeps the test hermetic
// (no real API call, no real token).
vi.mock('@actions/github', () => ({
  getOctokit: () => ({
    rest: {
      checks: {
        create: checksMocks.create
      }
    }
  })
}));

// Mock @actions/core so core.warning is observable without polluting output.
// check-run.ts uses `import * as core from '@actions/core'`, so the mock
// must provide named exports (info, warning) on the module namespace.
vi.mock('@actions/core', () => ({
  info: () => {},
  warning: checksMocks.warning
}));

// Import AFTER the mocks are registered.
const { publishCheckRunAnnotations } = await import('../src/github/check-run.js');

function makeLedger(failingCount: number, passingCount = 0): LedgerSummary {
  const packets = [];
  for (let i = 0; i < failingCount; i++) {
    packets.push({ key: `fail-${i}`, lastFailureFingerprint: `fp${i}abcdef`, passes: false, title: `Failing op ${i}` });
  }
  for (let i = 0; i < passingCount; i++) {
    packets.push({ key: `pass-${i}`, passes: true, title: `Passing op ${i}` });
  }
  return { failing: failingCount, packets, passing: passingCount, total: failingCount + passingCount };
}

describe('publishCheckRunAnnotations', () => {
  it('caps annotations at 50 for a 60-failing-packet ledger', async () => {
    checksMocks.create.mockClear();
    checksMocks.create.mockResolvedValue({ data: { id: 1 } });

    await publishCheckRunAnnotations({
      headSha: 'abc',
      ledger: makeLedger(60),
      owner: 'postman-cs',
      repo: 'test',
      specPath: 'api/openapi.yaml',
      token: 'tok'
    });

    expect(checksMocks.create).toHaveBeenCalledTimes(1);
    const call = checksMocks.create.mock.calls[0]?.[0];
    expect(call.conclusion).toBe('failure');
    expect(call.head_sha).toBe('abc');
    expect(call.name).toBe('Postman TDD Contract');
    expect(call.output.annotations).toHaveLength(50);
    for (const annotation of call.output.annotations) {
      expect(annotation.annotation_level).toBe('failure');
      expect(annotation.path).toBe('api/openapi.yaml');
    }
  });

  it('resolves (does not reject) and warns when octokit.rest.checks.create rejects', async () => {
    checksMocks.create.mockClear();
    checksMocks.warning.mockClear();
    checksMocks.create.mockRejectedValue(new Error('HttpError 403: Resource not accessible by integration'));

    await expect(publishCheckRunAnnotations({
      headSha: 'abc',
      ledger: makeLedger(2),
      owner: 'postman-cs',
      repo: 'test',
      token: 'tok'
    })).resolves.toBeUndefined();

    expect(checksMocks.warning).toHaveBeenCalled();
    const warningArg = checksMocks.warning.mock.calls[0]?.[0] as string;
    expect(warningArg).toMatch(/checks: write|Resource not accessible/i);
  });

  it('creates a check without throwing when the ledger has 0 failing packets', async () => {
    checksMocks.create.mockClear();
    checksMocks.create.mockResolvedValue({ data: { id: 1 } });

    await expect(publishCheckRunAnnotations({
      headSha: 'abc',
      ledger: makeLedger(0, 3),
      owner: 'postman-cs',
      repo: 'test',
      token: 'tok'
    })).resolves.toBeUndefined();

    expect(checksMocks.create).toHaveBeenCalledTimes(1);
    const call = checksMocks.create.mock.calls[0]?.[0];
    expect(call.output.annotations).toHaveLength(0);
    // Still marks conclusion as failure (the run itself failed, just no per-packet annotations).
    expect(call.conclusion).toBe('failure');
  });

  it('defaults the path to openapi.yaml when specPath is absent', async () => {
    checksMocks.create.mockClear();
    checksMocks.create.mockResolvedValue({ data: { id: 1 } });

    await publishCheckRunAnnotations({
      headSha: 'abc',
      ledger: makeLedger(1),
      owner: 'postman-cs',
      repo: 'test',
      token: 'tok'
    });

    const call = checksMocks.create.mock.calls[0]?.[0];
    expect(call.output.annotations[0].path).toBe('openapi.yaml');
  });
});
