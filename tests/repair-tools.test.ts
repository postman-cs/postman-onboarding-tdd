import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { git, initGitRepo } from './helpers/git.js';

import { executeRepairTool, type RepairToolContext } from '../src/repair/tools.js';

describe('repair tools', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function createContext(): RepairToolContext {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-tools-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.js'), 'export const status = "ok";\n', 'utf8');
    writeFileSync(join(dir, 'api', 'openapi.yaml'), 'openapi: 3.0.3\n', 'utf8');
    writeFileSync(join(dir, '.env'), 'TOKEN=secret\n', 'utf8');
    initGitRepo(dir);
    return {
      allowedReadPaths: ['**'],
      patchPolicy: {
        allowedWritePaths: ['src/**'],
        immutablePaths: ['api/openapi.yaml'],
        repoRoot: dir
      },
      repoRoot: dir
    };
  }

  it('lists and reads allowed implementation files while hiding spec and secret-like files', () => {
    const context = createContext();

    expect(executeRepairTool('list_files', { prefix: '' }, context).paths).toEqual(['src/app.js']);
    expect(executeRepairTool('read_file', { path: 'src/app.js' }, context).content).toContain('status');
    expect(executeRepairTool('read_file', { path: 'api/openapi.yaml' }, context).error).toContain(
      'Path is not readable by the repair agent'
    );
    expect(executeRepairTool('read_file', { path: '.env' }, context).error).toContain(
      'Path is not readable by the repair agent'
    );
  });

  it('accepts a markdown-fenced unified diff while preserving guarded patch validation', () => {
    const context = createContext();
    writeFileSync(join(context.repoRoot, 'src', 'app.js'), 'export const status = "fixed";\n', 'utf8');
    const patch = git(context.repoRoot, ['diff', '--', 'src/app.js']);
    writeFileSync(join(context.repoRoot, 'src', 'app.js'), 'export const status = "ok";\n', 'utf8');

    const result = executeRepairTool('propose_patch', {
      patch: `Here is the implementation-only patch:\n\n\`\`\`diff\n${patch}\`\`\`\n`,
      summary: 'Return fixed status.'
    }, context);

    expect(result.error).toBeUndefined();
    expect(result.touchedPaths).toEqual(['src/app.js']);
    expect(readFileSync(join(context.repoRoot, 'src', 'app.js'), 'utf8')).toContain('fixed');
  });

  it('accepts a guarded full-file replacement envelope for large single-file repairs', () => {
    const context = createContext();

    const result = executeRepairTool('propose_patch', {
      patch: [
        'POSTMAN_TDD_REPLACE_FILE src/app.js',
        'export const status = "fixed";',
        'export const owner = "postman";',
        'POSTMAN_TDD_END_REPLACE_FILE'
      ].join('\n'),
      summary: 'Replace implementation file.'
    }, context);

    expect(result.error).toBeUndefined();
    expect(result.touchedPaths).toEqual(['src/app.js']);
    expect(readFileSync(join(context.repoRoot, 'src', 'app.js'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'export const status = "fixed";\nexport const owner = "postman";\n'
    );
  });

  it('keeps full-file replacement envelopes behind immutable path guards', () => {
    const context = createContext();

    const result = executeRepairTool('propose_patch', {
      patch: [
        'POSTMAN_TDD_REPLACE_FILE api/openapi.yaml',
        'openapi: 3.1.0',
        'POSTMAN_TDD_END_REPLACE_FILE'
      ].join('\n'),
      summary: 'Change spec.'
    }, context);

    expect(result.error).toContain('Patch touches non-writable path: api/openapi.yaml');
    expect(readFileSync(join(context.repoRoot, 'api', 'openapi.yaml'), 'utf8').replace(/\r\n/g, '\n')).toBe('openapi: 3.0.3\n');
  });
});