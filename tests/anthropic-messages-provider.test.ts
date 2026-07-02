import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runAnthropicRepairTurn } from '../src/repair/anthropic-messages-provider.js';
import type { AgentFailureDocument } from '../src/types.js';

describe('Anthropic Messages repair provider', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function createRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-anthropic-'));
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

  function repairContext(repoRoot: string) {
    return {
      allowedReadPaths: ['src/**'],
      patchPolicy: {
        allowedWritePaths: ['src/**'],
        immutablePaths: ['api/openapi.yaml'],
        repoRoot
      },
      repoRoot
    };
  }

  it('applies a guarded propose_patch tool use block', async () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot);
    const requests: Array<{ body: Record<string, unknown>; headers: Record<string, string>; url: string }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
        url: String(url)
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{
            id: 'toolu_patch',
            input: {
              patch,
              summary: 'Return the expected status shape.'
            },
            name: 'propose_patch',
            type: 'tool_use'
          }]
        })
      } as Response;
    };

    const result = await runAnthropicRepairTurn({
      apiKey: 'anthropic-secret',
      failure: failure(),
      fetchImpl,
      model: 'claude-sonnet-5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/anthropic-secret/g, '***')
    });

    expect(result).toEqual({
      status: 'changed',
      summary: 'Return the expected status shape.',
      touchedPaths: ['src/app.js']
    });
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0]?.headers['x-api-key']).toBe('anthropic-secret');
    const tools = requests[0]?.body.tools as Array<Record<string, unknown>>;
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        input_schema: expect.objectContaining({ type: 'object' }),
        name: 'propose_patch'
      })
    ]));
    expect(JSON.stringify(tools)).not.toContain('parameters');
    expect(readFileSync(join(repoRoot, 'src', 'app.js'), 'utf8')).toContain('fixed');
    expect(JSON.stringify(requests)).not.toContain('openapi: 3.0.3');
  });

  it('continues tool rounds with tool_result blocks after read_file', async () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot);
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            content: [
              { text: 'I will inspect the implementation first.', type: 'text' },
              {
                id: 'toolu_read',
                input: { path: 'src/app.js' },
                name: 'read_file',
                type: 'tool_use'
              }
            ],
            stop_reason: 'tool_use'
          })
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{
            id: 'toolu_patch',
            input: {
              patch,
              summary: 'Add the missing response field.'
            },
            name: 'propose_patch',
            type: 'tool_use'
          }]
        })
      } as Response;
    };

    const result = await runAnthropicRepairTurn({
      apiKey: 'anthropic-secret',
      failure: failure(),
      fetchImpl,
      model: 'claude-sonnet-5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/anthropic-secret/g, '***')
    });

    expect(result.status).toBe('changed');
    expect(requests).toHaveLength(2);
    const secondMessages = requests[1]?.messages as Array<{ content: Array<Record<string, unknown>>; role: string }>;
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[1]).toMatchObject({
      content: [expect.objectContaining({ type: 'text' }), expect.objectContaining({ id: 'toolu_read', type: 'tool_use' })],
      role: 'assistant'
    });
    expect(secondMessages[2]).toMatchObject({
      content: [expect.objectContaining({ tool_use_id: 'toolu_read', type: 'tool_result' })],
      role: 'user'
    });
    expect(JSON.stringify(secondMessages[2]?.content[0])).toContain('broken');
    expect(JSON.stringify(secondMessages[2]?.content[0])).not.toContain('"type":"tool_use"');
  });

  it('returns blocked when the finish tool reports blocked', async () => {
    const repoRoot = createRepo();
    const fetchImpl = async (): Promise<Response> => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{
          id: 'toolu_finish',
          input: {
            message: 'API intent is unclear.',
            status: 'blocked'
          },
          name: 'finish',
          type: 'tool_use'
        }]
      })
    } as Response);

    await expect(runAnthropicRepairTurn({
      apiKey: 'anthropic-secret',
      failure: failure(),
      fetchImpl,
      model: 'claude-sonnet-5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/anthropic-secret/g, '***')
    })).resolves.toEqual({
      message: 'API intent is unclear.',
      status: 'blocked'
    });
  });

  it('masks Anthropic API error bodies', async () => {
    const repoRoot = createRepo();
    const fetchImpl = async (): Promise<Response> => ({
      ok: false,
      status: 500,
      text: async () => 'provider saw anthropic-secret'
    } as Response);

    let thrown: unknown;
    try {
      await runAnthropicRepairTurn({
        apiKey: 'anthropic-secret',
        failure: failure(),
        fetchImpl,
        model: 'claude-sonnet-5',
        repairContext: repairContext(repoRoot),
        secretMasker: (value) => value.replace(/anthropic-secret/g, '***')
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('***');
    expect((thrown as Error).message).not.toContain('anthropic-secret');
  });

  it('returns no_change when Claude does not call a tool', async () => {
    const repoRoot = createRepo();
    const fetchImpl = async (): Promise<Response> => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{
          text: 'I cannot find a safe implementation-only change.',
          type: 'text'
        }]
      })
    } as Response);

    await expect(runAnthropicRepairTurn({
      apiKey: 'anthropic-secret',
      failure: failure(),
      fetchImpl,
      model: 'claude-sonnet-5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/anthropic-secret/g, '***')
    })).resolves.toEqual({
      message: 'I cannot find a safe implementation-only change.',
      status: 'no_change'
    });
  });
});
