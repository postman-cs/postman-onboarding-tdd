import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  harnessOptIn,
  harnessRemediation,
  parseRouterReferences,
  requiredReferenceDocs
} from '../src/harness-lint.js';
import type { ValidationState } from '../src/validation-types.js';

function emptyState(): ValidationState {
  return { errors: [], warnings: [] };
}

describe('requiredReferenceDocs', () => {
  it('returns exactly the six required stems', () => {
    expect(requiredReferenceDocs()).toEqual([
      'tdd-check',
      'failure-document',
      'repair-loop',
      'immutable-spec-guard',
      'branch-and-commit',
      'execplan-skeleton'
    ]);
  });
});

describe('harnessRemediation', () => {
  it('prefixes the instruction with "To fix: "', () => {
    expect(harnessRemediation('create X')).toBe('To fix: create X');
  });

  it('preserves the instruction verbatim', () => {
    expect(harnessRemediation('add a routing-table row for .agents/references/repair-loop.md to AGENTS.md.'))
      .toBe('To fix: add a routing-table row for .agents/references/repair-loop.md to AGENTS.md.');
  });
});

describe('parseRouterReferences', () => {
  it('extracts referenced doc stems', () => {
    const router = [
      '# Router',
      '| Situation | Read this |',
      '| --- | --- |',
      '| check | `.agents/references/tdd-check.md` |',
      '| failure | .agents/references/failure-document.md |',
      '| repair | .agents/references/repair-loop.md |'
    ].join('\n');
    expect(parseRouterReferences(router)).toEqual([
      'tdd-check',
      'failure-document',
      'repair-loop'
    ]);
  });

  it('dedupes repeated references preserving first-seen order', () => {
    const router = [
      'see .agents/references/tdd-check.md and .agents/references/tdd-check.md',
      'then .agents/references/execplan-skeleton.md'
    ].join('\n');
    expect(parseRouterReferences(router)).toEqual(['tdd-check', 'execplan-skeleton']);
  });

  it('returns an empty array when no references are present', () => {
    expect(parseRouterReferences('# No routing table here\njust prose')).toEqual([]);
  });
});

describe('harnessOptIn', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('opts in when config.harness.enabled is true (no AGENTS.md needed)', () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-optin-'));
    expect(harnessOptIn({ harness: { enabled: true } }, dir)).toBe(true);
  });

  it('opts in when AGENTS.md is present in workspaceRoot even if config is undefined', () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-optin-'));
    writeFileSync(join(dir, 'AGENTS.md'), '# Router\n', 'utf8');
    expect(harnessOptIn(undefined, dir)).toBe(true);
  });

  it('does not opt in when neither config flag nor AGENTS.md is present', () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-optin-'));
    expect(harnessOptIn(undefined, dir)).toBe(false);
    expect(harnessOptIn({ harness: { enabled: false } }, dir)).toBe(false);
  });
});

describe('ValidationState integration', () => {
  it('empty state has no errors or warnings', () => {
    const state = emptyState();
    expect(state.errors).toHaveLength(0);
    expect(state.warnings).toHaveLength(0);
  });
});
