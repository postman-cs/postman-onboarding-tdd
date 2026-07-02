import * as core from '@actions/core';

import { buildRepairPrompt, type RepairProviderOptions, type RepairProviderResult } from './provider-common.js';
import { createRepairTools, executeRepairTool, type RepairToolResult } from './tools.js';

const POSTMAN_AGENT_MODE_GATEWAY_URL = 'https://gateway.postman.com/chat';
const POSTMAN_AGENT_MODE_SERVICE = 'agent-mode-service';
const POSTMAN_AGENT_MODE_PRODUCT = 'workspace_localmode_v12';
const POSTMAN_TDD_TOOL_SERVER = 'Postman TDD Repair';

type JsonRecord = Record<string, unknown>;

interface AgentModeTurnState {
  conversationId?: string;
  toolCallGroupId?: string;
}

interface AgentModeToolCall {
  id: string;
  input: JsonRecord;
  name: string;
  toolCallGroupId?: string;
}

interface AgentModeTurnResult {
  conversationId?: string;
  text: string;
  toolCallGroupId?: string;
  toolCalls: AgentModeToolCall[];
}

export type PostmanAgentModeRepairOptions = RepairProviderOptions;
export type PostmanAgentModeRepairResult = RepairProviderResult;

export async function runPostmanAgentModeRepairTurn(options: PostmanAgentModeRepairOptions): Promise<PostmanAgentModeRepairResult> {
  core.info(`[postman-tdd] Postman Agent Mode repair turn: model=${options.model}, failurePhase=${options.failure.phase}, failures=${options.failure.failures.length}.`);
  const tools = createPostmanAgentModeTools(options.repairContext);
  const state: AgentModeTurnState = {};
  let body = createUserQueryBody({
    model: options.model,
    prompt: buildRepairPrompt(options.failure, options.repairContext),
    tools
  });

  for (let round = 0; round < (options.maxToolRounds || 12); round += 1) {
    core.info(`[postman-tdd] Postman Agent Mode round ${round + 1}: sending ${round === 0 ? 'initial repair instructions' : 'tool response(s)'}.`);
    const turn = await sendAgentModeTurn({
      apiKey: options.apiKey,
      body,
      fetchImpl: options.fetchImpl,
      secretMasker: options.secretMasker
    });

    state.conversationId = turn.conversationId || state.conversationId;
    state.toolCallGroupId = turn.toolCallGroupId || state.toolCallGroupId;
    core.info(`[postman-tdd] Postman Agent Mode round ${round + 1}: received ${turn.toolCalls.length} tool call(s).`);

    if (turn.toolCalls.length === 0) {
      return {
        status: 'no_change',
        message: turn.text || 'The repair agent did not call a patch or finish tool.'
      };
    }

    const toolResponses: JsonRecord[] = [];
    for (const call of turn.toolCalls) {
      state.toolCallGroupId = call.toolCallGroupId || state.toolCallGroupId;
      core.info(`[postman-tdd] Executing guarded repair tool: ${call.name}.`);
      const result = executeRepairTool(call.name, call.input, options.repairContext);
      logToolResult(call.name, result);
      toolResponses.push(createToolResponse(call, result));

      if (call.name === 'propose_patch' && result.appliedPatch) {
        return {
          status: 'changed',
          summary: result.summary || 'Applied implementation repair patch.',
          touchedPaths: result.touchedPaths || []
        };
      }
      if (call.name === 'finish') {
        const status = String(call.input.status || '');
        const message = String(call.input.message || result.summary || '').trim();
        if (status === 'blocked') {
          return { status: 'blocked', message: message || 'Repair agent reported blocked.' };
        }
        return { status: 'no_change', message: message || 'Repair agent reported ready without changes.' };
      }
    }

    if (!state.conversationId || !state.toolCallGroupId) {
      return {
        status: 'no_change',
        message: 'Postman Agent Mode requested tool results without a conversationId and toolCallGroupId.'
      };
    }

    body = createToolResponseBody({
      conversationId: state.conversationId,
      model: options.model,
      toolCallGroupId: state.toolCallGroupId,
      toolResponses,
      tools
    });
  }

  core.info('[postman-tdd] Postman Agent Mode repair turn exhausted tool-call rounds without a patch.');
  return {
    status: 'no_change',
    message: 'Repair agent exhausted tool-call rounds without proposing a patch.'
  };
}

function createPostmanAgentModeTools(context: RepairProviderOptions['repairContext']): JsonRecord[] {
  return createRepairTools(context).map((tool) => ({
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters
  }));
}

async function sendAgentModeTurn(options: {
  apiKey: string;
  body?: JsonRecord;
  fetchImpl?: typeof fetch;
  secretMasker: (value: string) => string;
}): Promise<AgentModeTurnResult> {
  if (!options.body) {
    throw new Error('Postman Agent Mode request body is required.');
  }
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(POSTMAN_AGENT_MODE_GATEWAY_URL, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'Content-Type': 'application/json',
      'x-access-token': options.apiKey,
      'x-app-version': 'postman-tdd-action',
      'x-pstmn-req-service': POSTMAN_AGENT_MODE_SERVICE
    },
    body: JSON.stringify(options.body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Postman Agent Mode API failed (${response.status}): ${options.secretMasker(text).slice(0, 1000)}`);
  }
  return parseAgentModeEvents(text, options.secretMasker);
}

function createUserQueryBody(options: {
  model: string;
  prompt: string;
  tools: JsonRecord[];
}): JsonRecord {
  return createAgentModeBody({
    input: {
      agent: null,
      chatType: 'USER_QUERY',
      conversationId: null,
      product: POSTMAN_AGENT_MODE_PRODUCT,
      query: options.prompt,
      skill: null,
      startedFrom: 'CHAT_INPUT',
      toolResponse: '',
      useCase: null
    },
    model: options.model,
    tools: options.tools
  });
}

function createToolResponseBody(options: {
  conversationId: string;
  model: string;
  toolCallGroupId: string;
  toolResponses: JsonRecord[];
  tools: JsonRecord[];
}): JsonRecord {
  return createAgentModeBody({
    input: {
      agent: null,
      chatType: 'TOOL_RESPONSE',
      conversationId: options.conversationId,
      product: POSTMAN_AGENT_MODE_PRODUCT,
      skill: null,
      startedFrom: 'TOOL_RESPONSE',
      toolCallGroupId: options.toolCallGroupId,
      toolResponses: options.toolResponses,
      useCase: null
    },
    model: options.model,
    tools: options.tools
  });
}

function createAgentModeBody(options: {
  input: JsonRecord;
  model: string;
  tools: JsonRecord[];
}): JsonRecord {
  return {
    backgroundContext: [],
    clientKBTerms: {
      excludedKBTerms: [],
      nativeTermsHash: null
    },
    clientTools: {
      excludedTools: [],
      native: [],
      thirdParty: {
        [POSTMAN_TDD_TOOL_SERVER]: {
          tools: options.tools
        }
      }
    },
    devModeOptions: {
      autoRun: true,
      isParallelToolCallingSupported: true,
      selectedModel: options.model
    },
    input: options.input,
    mandatoryContext: {
      workspaceId: ''
    },
    platform: resolvePlatform(),
    selectedContext: []
  };
}

function createToolResponse(call: AgentModeToolCall, result: RepairToolResult): JsonRecord {
  const summary = result.error || result.summary || `Finished executing ${call.name}.`;
  return {
    content: JSON.stringify(result),
    toolCallId: call.id,
    toolResponseStatus: result.error ? 'FAILED' : 'SUCCESS',
    toolResponseSummary: summary.slice(0, 300),
    ...(result.error ? { toolResponseFailureType: 'HANDLED_ERROR' } : {})
  };
}

function parseAgentModeEvents(body: string, secretMasker: (value: string) => string): AgentModeTurnResult {
  const result: AgentModeTurnResult = {
    text: '',
    toolCalls: []
  };
  for (const event of parseSseJsonEvents(body)) {
    const data = isRecord(event.data) ? event.data : event;
    result.conversationId = stringValue(event.conversationId)
      || stringValue(data.conversationId)
      || result.conversationId;
    result.toolCallGroupId = stringValue(event.toolCallGroupId)
      || stringValue(data.toolCallGroupId)
      || result.toolCallGroupId;

    const eventType = String(event.eventType || event.type || '');
    if (eventType === 'textChunk') {
      result.text += stringValue(data.textContent) || stringValue(data.text) || '';
    }
    if (eventType === 'failure') {
      throw new Error(`Postman Agent Mode API failure: ${secretMasker(formatFailureEvent(data)).slice(0, 1000)}`);
    }
    if (eventType === 'toolCall' || eventType === 'toolCallChunk') {
      const calls = extractToolCalls(data);
      for (const call of calls) {
        result.toolCalls.push(call);
        result.toolCallGroupId = call.toolCallGroupId || result.toolCallGroupId;
      }
    }
  }
  result.text = result.text.trim();
  return result;
}

function parseSseJsonEvents(body: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as JsonRecord;
    events.push(parsed);
    return events;
  }
  for (const line of body.split(/\r?\n/)) {
    const normalized = line.trim();
    if (!normalized.startsWith('data:')) continue;
    const payload = normalized.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    const parsed = JSON.parse(payload) as unknown;
    if (isRecord(parsed)) events.push(parsed);
  }
  return events;
}

function extractToolCalls(data: JsonRecord): AgentModeToolCall[] {
  const rawCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [data];
  const calls: AgentModeToolCall[] = [];
  for (const rawCall of rawCalls) {
    if (!isRecord(rawCall)) continue;
    const fn = isRecord(rawCall.function) ? rawCall.function : {};
    const name = stringValue(fn.name) || stringValue(rawCall.name) || stringValue(rawCall.toolName);
    if (!name) continue;
    const id = stringValue(rawCall.id) || stringValue(rawCall.toolCallId) || name;
    const input = parseToolArguments(fn.arguments ?? rawCall.arguments ?? rawCall.args);
    const toolCallGroupId = stringValue(rawCall.toolCallGroupId) || stringValue(data.toolCallGroupId) || undefined;
    calls.push({ id, input, name, toolCallGroupId });
  }
  return calls;
}

function parseToolArguments(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatFailureEvent(data: JsonRecord): string {
  const parts = [
    stringValue(data.errorType),
    stringValue(data.userMessage),
    stringValue(data.message)
  ].filter(Boolean);
  return parts.join(': ') || JSON.stringify(data);
}

function logToolResult(name: string, result: RepairToolResult): void {
  if (result.error) {
    core.info(`[postman-tdd] Guarded repair tool ${name} returned error: ${result.error}`);
  } else if (name === 'list_files') {
    core.info(`[postman-tdd] Guarded repair tool ${name} returned ${result.paths?.length || 0} path(s).`);
  } else if (name === 'search_files') {
    core.info(`[postman-tdd] Guarded repair tool ${name} returned ${result.matches?.length || 0} match(es).`);
  } else if (name === 'read_file') {
    core.info(`[postman-tdd] Guarded repair tool ${name} returned allowed file content.`);
  } else if (name === 'propose_patch') {
    core.info(`[postman-tdd] Guarded repair tool ${name} applied patch touching: ${result.touchedPaths?.join(', ') || '(none)'}.`);
  }
}

function resolvePlatform(): string {
  if (process.platform === 'darwin') return 'DESKTOP_MACOS';
  if (process.platform === 'win32') return 'DESKTOP_WINDOWS';
  return 'DESKTOP_LINUX';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
