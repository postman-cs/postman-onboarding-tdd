import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runOpenAiRepairTurn } from '../src/repair/openai-responses-provider.js';
import type { AgentFailureDocument } from '../src/types.js';

describe('OpenAI Responses repair provider', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function createRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-openai-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.js'), 'export const status = "broken";\n', 'utf8');
    writeFileSync(join(dir, 'api', 'openapi.yaml'), 'openapi: 3.0.3\n', 'utf8');
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  function diffFor(repoRoot: string): string {
    writeFileSync(join(repoRoot, 'src', 'app.js'), 'export const status = "fixed";\n', 'utf8');
    const patch = execFileSync('git', ['diff', '--', 'src/app.js'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    writeFileSync(join(repoRoot, 'src', 'app.js'), 'export const status = "broken";\n', 'utf8');
    return patch;
  }

  function failure(): AgentFailureDocument {
    return {
      baseUrl: 'http://127.0.0.1:4010',
      collectionName: '[TDD PR-1] [Contract] service',
      commit: 'abc123',
      failures: [{
        assertion: 'response body matches schema',
        message: 'Missing required property: status',
        method: 'GET',
        path: '/v1/status'
      }],
      immutablePathHashes: [],
      immutablePaths: ['api/openapi.yaml'],
      message: 'collection failed',
      phase: 'collection_run',
      schemaVersion: 1,
      specPath: 'api/openapi.yaml',
      status: 'failed',
      successCriteria: {
        doneWhen: 'requiredCheck passes on the latest PR head commit',
        failureContextMustMatchPrHeadCommit: true,
        latestHeadOnly: true,
        requiredCheck: 'Postman TDD Preview'
      }
    };
  }

  it('applies a guarded propose_patch tool call', async () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot);
    const requests: unknown[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(JSON.parse(String(init?.body || '{}')) as unknown);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          output: [{
            arguments: JSON.stringify({
              patch,
              summary: 'Return the expected status shape.'
            }),
            call_id: 'call_1',
            name: 'propose_patch',
            type: 'function_call'
          }]
        })
      } as Response;
    };

    const result = await runOpenAiRepairTurn({
      apiKey: 'openai-secret',
      failure: failure(),
      fetchImpl,
      model: 'gpt-5.5',
      repairContext: {
        allowedReadPaths: ['src/**'],
        patchPolicy: {
          allowedWritePaths: ['src/**'],
          immutablePaths: ['api/openapi.yaml'],
          repoRoot
        },
        repoRoot
      },
      secretMasker: (value) => value.replace(/openai-secret/g, '***')
    });

    expect(result).toEqual({
      status: 'changed',
      summary: 'Return the expected status shape.',
      touchedPaths: ['src/app.js']
    });
    expect(readFileSync(join(repoRoot, 'src', 'app.js'), 'utf8')).toContain('fixed');
    expect(JSON.stringify(requests)).not.toContain('openapi: 3.0.3');
  });
});
