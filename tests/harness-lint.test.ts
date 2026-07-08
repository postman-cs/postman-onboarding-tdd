import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  harnessOptIn,
  harnessRemediation,
  parseRouterReferences,
  requiredReferenceDocs,
  validateHarness
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

describe('validateHarness', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function writeHarnessFixture(options: {
    routerContent?: string;
    skipReferenceDocs?: string[];
    extraReferenceDocs?: Record<string, string>;
  } = {}): string {
    dir = mkdtempSync(join(tmpdir(), 'harness-validate-'));
    const defaultRouter = [
      '# Router',
      '| check | `.agents/references/tdd-check.md` |',
      '| failure | `.agents/references/failure-document.md` |',
      '| repair | `.agents/references/repair-loop.md` |',
      '| spec | `.agents/references/immutable-spec-guard.md` |',
      '| branch | `.agents/references/branch-and-commit.md` |',
      '| execplan | `.agents/references/execplan-skeleton.md` |'
    ].join('\n');
    writeFileSync(join(dir, 'AGENTS.md'), options.routerContent ?? defaultRouter, 'utf8');

    const refsDir = join(dir, '.agents', 'references');
    mkdirSync(refsDir, { recursive: true });

    const docs: Record<string, string> = {
      'tdd-check': '# TDD Check\ncontent',
      'failure-document': '# Failure Document\ncontent',
      'repair-loop': '# Repair Loop\ncontent',
      'immutable-spec-guard': '# Immutable Spec Guard\ncontent',
      'branch-and-commit': '# Branch and Commit\ncontent',
      'execplan-skeleton': '# ExecPlan Skeleton\ncontent',
      ...options.extraReferenceDocs
    };
    const skip = new Set(options.skipReferenceDocs ?? []);
    for (const [name, content] of Object.entries(docs)) {
      if (skip.has(name)) continue;
      writeFileSync(join(refsDir, `${name}.md`), content, 'utf8');
    }
    return dir;
  }

  it('pushes zero errors for a valid AGENTS.md with all six reference files', () => {
    const workspace = writeHarnessFixture();
    const state = emptyState();
    validateHarness(undefined, state, workspace);
    expect(state.errors).toHaveLength(0);
  });

  it('pushes one error naming .agents/references/repair-loop.md when it is missing', () => {
    const workspace = writeHarnessFixture({ skipReferenceDocs: ['repair-loop'] });
    const state = emptyState();
    validateHarness(undefined, state, workspace);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.message).toContain('.agents/references/repair-loop.md');
  });

  it('pushes one error to add a row when the router omits immutable-spec-guard', () => {
    const routerWithoutGuard = [
      '# Router',
      '| check | `.agents/references/tdd-check.md` |',
      '| failure | `.agents/references/failure-document.md` |',
      '| repair | `.agents/references/repair-loop.md` |',
      '| branch | `.agents/references/branch-and-commit.md` |',
      '| execplan | `.agents/references/execplan-skeleton.md` |'
    ].join('\n');
    const workspace = writeHarnessFixture({ routerContent: routerWithoutGuard });
    const state = emptyState();
    validateHarness(undefined, state, workspace);
    const guardErrors = state.errors.filter((e) => e.message.includes('immutable-spec-guard'));
    expect(guardErrors).toHaveLength(1);
    expect(guardErrors[0]?.message).toContain('To fix:');
  });

  it('emits a warning (not error) when AGENTS.md exceeds 100 non-empty lines', () => {
    const longRouter = ['# Router', ...Array.from({ length: 101 }, (_, i) => `line ${i}`)].join('\n');
    const workspace = writeHarnessFixture({ routerContent: longRouter });
    const state = emptyState();
    validateHarness(undefined, state, workspace);
    const lineWarnings = state.warnings.filter((w) => w.message.includes('100'));
    expect(lineWarnings.length).toBeGreaterThan(0);
    // The >100-lines issue is a warning, not an error.
    const lineErrors = state.errors.filter((e) => e.message.includes('100'));
    expect(lineErrors).toHaveLength(0);
  });

  it('starts every pushed error message with "To fix:"', () => {
    const workspace = writeHarnessFixture({ skipReferenceDocs: ['repair-loop', 'tdd-check'] });
    const state = emptyState();
    validateHarness(undefined, state, workspace);
    expect(state.errors.length).toBeGreaterThan(0);
    for (const error of state.errors) {
      expect(error.message.startsWith('To fix:')).toBe(true);
    }
  });

  it('pushes nothing when not opted in (no config flag, no AGENTS.md)', () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-noinert-'));
    const state = emptyState();
    validateHarness(undefined, state, dir);
    expect(state.errors).toHaveLength(0);
    expect(state.warnings).toHaveLength(0);
  });

  it('pushes one AGENTS.md error when config.harness.enabled is true but AGENTS.md is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-configonly-'));
    const state = emptyState();
    validateHarness({ harness: { enabled: true } } as never, state, dir);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.message).toContain('To fix:');
    expect(state.errors[0]?.message).toContain('AGENTS.md');
  });

  it('warns on orphan reference files present but not routed', () => {
    const workspace = writeHarnessFixture({
      extraReferenceDocs: { 'orphan-doc': '# Orphan\ncontent' }
    });
    const state = emptyState();
    validateHarness(undefined, state, workspace);
    const orphanWarnings = state.warnings.filter((w) => w.message.includes('orphan-doc'));
    expect(orphanWarnings).toHaveLength(1);
  });
});
