import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
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
    const patch = execFileSync('git', ['diff', '--', 'src/app.js'], {
      cwd: context.repoRoot,
      encoding: 'utf8'
    });
    writeFileSync(join(context.repoRoot, 'src', 'app.js'), 'export const status = "ok";\n', 'utf8');

    const result = executeRepairTool('propose_patch', {
      patch: `Here is the implementation-only patch:\n\n\`\`\`diff\n${patch}\`\`\`\n`,
      summary: 'Return fixed status.'
    }, context);

    expect(result.error).toBeUndefined();
    expect(result.touchedPaths).toEqual(['src/app.js']);
    expect(readFileSync(join(context.repoRoot, 'src', 'app.js'), 'utf8')).toContain('fixed');
  });
});
