import { describe, expect, it } from 'vitest';

import { repairBranchName, repairCommitMessage } from '../src/repair/git.js';

describe('repair branch/commit conventions (D17)', () => {
  it('repairBranchName returns the postman-tdd-fix- prefix with the PR number', () => {
    expect(repairBranchName(42)).toBe('postman-tdd-fix-42');
    expect(repairBranchName(1)).toBe('postman-tdd-fix-1');
    expect(repairBranchName(99999)).toBe('postman-tdd-fix-99999');
  });

  it('repairCommitMessage is idempotent (stable across two calls) and contains [check:<id>]', () => {
    const a = repairCommitMessage(42, '99');
    const b = repairCommitMessage(42, '99');
    expect(a).toBe(b);
    expect(a).toContain('[check:99]');
    expect(a).toContain('PR #42');
  });

  it('repairCommitMessage omits the [check:...] segment when checkRunId is absent', () => {
    const msg = repairCommitMessage(42);
    expect(msg).not.toContain('[check:');
    expect(msg).toContain('PR #42');
  });

  it('repairCommitMessage accepts a numeric checkRunId', () => {
    const msg = repairCommitMessage(7, 12345);
    expect(msg).toContain('[check:12345]');
  });
});
