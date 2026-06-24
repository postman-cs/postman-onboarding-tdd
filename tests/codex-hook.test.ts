import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hookPath = resolve('.postman-template/hooks/codex-pre-tool-use.mjs');
const policyTemplate = readFileSync(resolve('.postman-template/agent-policy.json'), 'utf8');
const denyMessage = 'The OpenAPI spec is immutable during implementation repair. Revert spec changes and fix code only.';

describe('Codex pre-tool hook template', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-codex-hook-'));
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    writeFileSync(join(dir, '.postman-template/agent-policy.json'), policyTemplate, 'utf8');
    writeFileSync(join(dir, '.postman-template/onboarding.yml'), [
      'version: 1',
      'spec:',
      '  path: api/openapi.yaml',
      ''
    ].join('\n'), 'utf8');
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('blocks apply_patch edits to the configured OpenAPI spec', () => {
    expect(() => runHook({
      tool: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: api/openapi.yaml',
          '@@',
          '-openapi: 3.0.3',
          '+openapi: 3.1.0',
          '*** End Patch'
        ].join('\n')
      }
    })).toThrowError(denyMessage);
  });

  it('blocks shell writes that reference the configured OpenAPI spec', () => {
    expect(() => runHook({
      tool: 'Bash',
      arguments: {
        command: "sed -i 's/owner/user/' api/openapi.yaml"
      }
    })).toThrowError(denyMessage);
  });

  it('blocks direct file-write payloads for the configured OpenAPI spec', () => {
    expect(() => runHook({
      tool: 'Write',
      arguments: {
        path: 'api/openapi.yaml',
        content: 'openapi: 3.1.0'
      }
    })).toThrowError(denyMessage);
  });

  it('allows implementation patches', () => {
    expect(() => runHook({
      tool: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: src/server.js',
          '@@',
          '-status: active',
          '+status: archived',
          '*** End Patch'
        ].join('\n')
      }
    })).not.toThrow();
  });

  it('allows read-only commands that reference the configured OpenAPI spec', () => {
    expect(() => runHook({
      tool: 'Bash',
      arguments: {
        command: 'sed -n "1,40p" api/openapi.yaml'
      }
    })).not.toThrow();
  });

  function runHook(payload: unknown): void {
    execFileSync(process.execPath, [hookPath], {
      cwd: dir,
      input: JSON.stringify(payload),
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }
});
