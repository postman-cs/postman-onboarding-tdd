import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { git, initGitRepo } from './helpers/git.js';

import { changedPaths } from '../src/repair/git.js';
import { applyValidatedPatch, validatePatch, type PatchPolicy } from '../src/repair/patch.js';

describe('repair patch guard', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function createRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-repair-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.js'), 'const status = "old";\n', 'utf8');
    writeFileSync(join(dir, 'api', 'openapi.yaml'), 'openapi: 3.0.3\n', 'utf8');
    writeFileSync(join(dir, '.github', 'workflows', 'tdd.yml'), 'name: tdd\n', 'utf8');
    initGitRepo(dir);
    return dir;
  }

  function policy(repoRoot: string, allowedWritePaths = ['src/**']): PatchPolicy {
    return {
      allowedWritePaths,
      immutablePaths: ['api/openapi.yaml'],
      repoRoot
    };
  }

  function diffFor(repoRoot: string, path: string, content: string): string {
    const original = readFileSync(join(repoRoot, path), 'utf8');
    writeFileSync(join(repoRoot, path), content, 'utf8');
    const diff = git(repoRoot, ['diff', '--', path]);
    writeFileSync(join(repoRoot, path), original, 'utf8');
    return diff;
  }

  it('applies patches under allowedWritePaths', () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot, 'src/app.js', 'const status = "new";\n');

    expect(applyValidatedPatch(patch, policy(repoRoot))).toEqual({
      touchedPaths: ['src/app.js']
    });
    expect(changedPaths(repoRoot)).toEqual(['src/app.js']);
  });

  it('rejects immutable spec changes even when the write glob is broad', () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot, 'api/openapi.yaml', 'openapi: 3.1.0\n');

    expect(() => validatePatch(patch, policy(repoRoot, ['**']))).toThrow(
      'Patch touches non-writable path: api/openapi.yaml'
    );
  });

  it('rejects workflow and secret-like files', () => {
    const repoRoot = createRepo();
    const workflowPatch = diffFor(repoRoot, '.github/workflows/tdd.yml', 'name: changed\n');
    const envPatch = [
      'diff --git a/.env b/.env',
      'new file mode 100644',
      'index 0000000..5a72eb2',
      '--- /dev/null',
      '+++ b/.env',
      '@@ -0,0 +1 @@',
      '+TOKEN=secret'
    ].join('\n');

    expect(() => validatePatch(workflowPatch, policy(repoRoot, ['**']))).toThrow(
      'Patch touches non-writable path: .github/workflows/tdd.yml'
    );
    expect(() => validatePatch(`${envPatch}\n`, policy(repoRoot, ['**']))).toThrow(
      'Patch touches non-writable path: .env'
    );
  });

  it('reports untracked files as changed paths after an accepted new-file patch', () => {
    const repoRoot = createRepo();
    const patch = [
      'diff --git a/src/new.js b/src/new.js',
      'new file mode 100644',
      'index 0000000..76b5bb8',
      '--- /dev/null',
      '+++ b/src/new.js',
      '@@ -0,0 +1 @@',
      '+export const created = true;'
    ].join('\n');

    applyValidatedPatch(`${patch}\n`, policy(repoRoot));

    expect(changedPaths(repoRoot)).toEqual(['src/new.js']);
  });
});