import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runPostmanAgentModeRepairTurn } from '../src/repair/postman-agent-mode-provider.js';
import type { AgentFailureDocument } from '../src/types.js';

type JsonRecord = Record<string, unknown>;

describe('Postman Agent Mode repair provider', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function createRepo(): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-agent-mode-'));
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

  function sse(...events: JsonRecord[]): string {
    return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
  }

  function toolCallEvent(toolCall: JsonRecord, eventType = 'toolCall'): JsonRecord {
    return {
      data: {
        conversationId: 'conv-1',
        toolCallGroupId: 'group-1',
        toolCalls: [toolCall]
      },
      eventType
    };
  }

  function createToolCall(id: string, name: string, input: JsonRecord): JsonRecord {
    return {
      function: {
        arguments: JSON.stringify(input),
        name
      },
      id,
      toolCallGroupId: 'group-1'
    };
  }

  function createMetadataToolCall(id: string, name: string, input: JsonRecord): JsonRecord {
    return {
      function: {
        arguments: JSON.stringify(input),
        name
      },
      id
    };
  }

  it('applies a guarded propose_patch tool call from a toolCallChunk event', async () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot);
    const requests: Array<{ body: JsonRecord; headers: Record<string, string>; url: string }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({
        body: JSON.parse(String(init?.body || '{}')) as JsonRecord,
        headers: init?.headers as Record<string, string>,
        url: String(url)
      });
      return {
        ok: true,
        status: 200,
        text: async () => sse(toolCallEvent(createToolCall('tool-patch', 'propose_patch', {
          patch,
          summary: 'Return the expected status shape.'
        }), 'toolCallChunk'))
      } as Response;
    };

    const result = await runPostmanAgentModeRepairTurn({
      apiKey: 'postman-access-secret',
      failure: failure(),
      fetchImpl,
      model: 'GPT_5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/postman-access-secret/g, '***')
    });

    expect(result).toEqual({
      status: 'changed',
      summary: 'Return the expected status shape.',
      touchedPaths: ['src/app.js']
    });
    const first = requests[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('expected first request');
    expect(first.url).toBe('https://gateway.postman.com/chat');
    expect(first.headers['x-access-token']).toBe('postman-access-secret');
    expect(first.headers['x-pstmn-req-service']).toBe('agent-mode-service');
    expect((first.body.devModeOptions as JsonRecord).selectedModel).toBe('GPT_5');
    const clientTools = first.body.clientTools as JsonRecord;
    expect(clientTools.native).toEqual([]);
    const toolServer = (clientTools.thirdParty as JsonRecord)['Postman TDD Repair'] as JsonRecord;
    const tools = toolServer.tools as JsonRecord[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'finish',
      'list_files',
      'propose_patch',
      'read_file',
      'search_files'
    ]);
    expect(JSON.stringify(tools)).not.toContain('shell');
    expect(JSON.stringify(tools)).not.toContain('write_file');
    expect(JSON.stringify(tools)).not.toContain('workspace');
    expect(readFileSync(join(repoRoot, 'src', 'app.js'), 'utf8')).toContain('fixed');
    expect(JSON.stringify(requests)).not.toContain('openapi: 3.0.3');
  });

  it('continues with TOOL_RESPONSE turns after read_file before applying a patch', async () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot);
    const requests: JsonRecord[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body || '{}')) as JsonRecord;
      requests.push(body);
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => sse(
            { data: { metadata: { conversationId: 'conv-1' }, textContent: 'Inspecting implementation first.' }, eventType: 'textChunk' },
            {
              data: {
                metadata: {
                  conversationId: 'conv-1',
                  toolCallGroupId: 'group-1'
                },
                toolCalls: [createMetadataToolCall('tool-read', 'read_file', { path: 'src/app.js' })]
              },
              eventType: 'toolCall'
            }
          )
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => sse(toolCallEvent(createToolCall('tool-patch', 'propose_patch', {
          patch,
          summary: 'Add the missing response field.'
        })))
      } as Response;
    };

    const result = await runPostmanAgentModeRepairTurn({
      apiKey: 'postman-access-secret',
      failure: failure(),
      fetchImpl,
      model: 'GPT_5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/postman-access-secret/g, '***')
    });

    expect(result.status).toBe('changed');
    expect(requests).toHaveLength(2);
    const second = requests[1];
    expect(second).toBeDefined();
    if (!second) throw new Error('expected second request');
    const input = second.input as JsonRecord;
    expect(input).toMatchObject({
      chatType: 'TOOL_RESPONSE',
      conversationId: 'conv-1',
      toolCallGroupId: 'group-1'
    });
    const toolResponses = input.toolResponses as JsonRecord[];
    expect(toolResponses[0]).toMatchObject({
      toolCallId: 'tool-read',
      toolResponseStatus: 'SUCCESS'
    });
    expect(String(toolResponses[0]?.content)).toContain('broken');
    expect(String(toolResponses[0]?.content)).not.toContain('"tool_use"');
  });

  it('treats malformed finish calls as handled tool errors before continuing', async () => {
    const repoRoot = createRepo();
    const patch = diffFor(repoRoot);
    const requests: JsonRecord[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body || '{}')) as JsonRecord;
      requests.push(body);
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => sse({
            data: {
              metadata: {
                conversationId: 'conv-1',
                toolCallGroupId: 'group-1'
              },
              toolCalls: [createMetadataToolCall('tool-finish', 'finish', {})]
            },
            eventType: 'toolCall'
          })
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => sse(toolCallEvent(createToolCall('tool-patch', 'propose_patch', {
          patch,
          summary: 'Add the missing response field.'
        })))
      } as Response;
    };

    const result = await runPostmanAgentModeRepairTurn({
      apiKey: 'postman-access-secret',
      failure: failure(),
      fetchImpl,
      model: 'GPT_5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/postman-access-secret/g, '***')
    });

    expect(result.status).toBe('changed');
    expect(requests).toHaveLength(2);
    const second = requests[1];
    expect(second).toBeDefined();
    if (!second) throw new Error('expected second request');
    const input = second.input as JsonRecord;
    const toolResponses = input.toolResponses as JsonRecord[];
    expect(toolResponses[0]).toMatchObject({
      toolCallId: 'tool-finish',
      toolResponseFailureType: 'HANDLED_ERROR',
      toolResponseStatus: 'FAILED'
    });
    expect(String(toolResponses[0]?.content)).toContain('finish requires status');
  });

  it('returns blocked when the finish tool reports blocked', async () => {
    const repoRoot = createRepo();
    const fetchImpl = async (): Promise<Response> => ({
      ok: true,
      status: 200,
      text: async () => sse(toolCallEvent(createToolCall('tool-finish', 'finish', {
        message: 'API intent is unclear.',
        status: 'blocked'
      })))
    } as Response);

    await expect(runPostmanAgentModeRepairTurn({
      apiKey: 'postman-access-secret',
      failure: failure(),
      fetchImpl,
      model: 'GPT_5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/postman-access-secret/g, '***')
    })).resolves.toEqual({
      message: 'API intent is unclear.',
      status: 'blocked'
    });
  });

  it('masks Postman Agent Mode API error bodies', async () => {
    const repoRoot = createRepo();
    const fetchImpl = async (): Promise<Response> => ({
      ok: false,
      status: 500,
      text: async () => 'gateway saw postman-access-secret'
    } as Response);

    let thrown: unknown;
    try {
      await runPostmanAgentModeRepairTurn({
        apiKey: 'postman-access-secret',
        failure: failure(),
        fetchImpl,
        model: 'GPT_5',
        repairContext: repairContext(repoRoot),
        secretMasker: (value) => value.replace(/postman-access-secret/g, '***')
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('***');
    expect((thrown as Error).message).not.toContain('postman-access-secret');
  });

  it('masks Postman Agent Mode failure events', async () => {
    const repoRoot = createRepo();
    const fetchImpl = async (): Promise<Response> => ({
      ok: true,
      status: 200,
      text: async () => sse({
        data: {
          errorType: 'gateway_error',
          message: 'agent saw postman-access-secret',
          userMessage: 'Repair failed.'
        },
        eventType: 'failure'
      })
    } as Response);

    let thrown: unknown;
    try {
      await runPostmanAgentModeRepairTurn({
        apiKey: 'postman-access-secret',
        failure: failure(),
        fetchImpl,
        model: 'GPT_5',
        repairContext: repairContext(repoRoot),
        secretMasker: (value) => value.replace(/postman-access-secret/g, '***')
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('***');
    expect((thrown as Error).message).not.toContain('postman-access-secret');
  });

  it('returns no_change when Agent Mode does not call a tool', async () => {
    const repoRoot = createRepo();
    const fetchImpl = async (): Promise<Response> => ({
      ok: true,
      status: 200,
      text: async () => sse({
        data: {
          conversationId: 'conv-1',
          textContent: 'I cannot find a safe implementation-only change.'
        },
        eventType: 'textChunk'
      })
    } as Response);

    await expect(runPostmanAgentModeRepairTurn({
      apiKey: 'postman-access-secret',
      failure: failure(),
      fetchImpl,
      model: 'GPT_5',
      repairContext: repairContext(repoRoot),
      secretMasker: (value) => value.replace(/postman-access-secret/g, '***')
    })).resolves.toEqual({
      message: 'I cannot find a safe implementation-only change.',
      status: 'no_change'
    });
  });
});
