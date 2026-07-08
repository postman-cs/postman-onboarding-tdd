import * as core from '@actions/core';

import { buildRepairPrompt, isRecord, logToolResult, type RepairProviderOptions, type RepairProviderResult } from './provider-common.js';
import { createRepairTools, executeRepairTool } from './tools.js';

type JsonRecord = Record<string, unknown>;
type AnthropicContentBlock = JsonRecord;
type AnthropicMessage = {
  content: AnthropicContentBlock[];
  role: 'assistant' | 'user';
};

type ToolUseBlock = JsonRecord & {
  id: string;
  input: JsonRecord;
  name: string;
  type: 'tool_use';
};

export type AnthropicRepairOptions = RepairProviderOptions;
export type AnthropicRepairResult = RepairProviderResult;

export async function runAnthropicRepairTurn(options: AnthropicRepairOptions): Promise<AnthropicRepairResult> {
  core.info(`[postman-tdd] Anthropic Messages repair turn: model=${options.model}, failurePhase=${options.failure.phase}, failures=${options.failure.failures.length}.`);
  const messages: AnthropicMessage[] = [{
    content: [{
      text: buildRepairPrompt(options.failure, options.repairContext),
      type: 'text'
    }],
    role: 'user'
  }];
  const tools = createAnthropicTools(options.repairContext);

  for (let round = 0; round < (options.maxToolRounds || 12); round += 1) {
    core.info(`[postman-tdd] Anthropic Messages round ${round + 1}: sending ${messages.length === 1 ? 'initial repair instructions' : 'tool result(s)'}.`);
    const response = await createMessage({
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      messages,
      model: options.model,
      secretMasker: options.secretMasker,
      tools
    });
    const content = Array.isArray(response.content)
      ? response.content.filter(isRecord)
      : [];
    const calls = content.filter(isToolUseBlock);
    core.info(`[postman-tdd] Anthropic Messages round ${round + 1}: received ${calls.length} tool use block(s).`);
    if (calls.length === 0) {
      return {
        status: 'no_change',
        message: extractText(response) || 'The repair agent did not call a patch or finish tool.'
      };
    }

    messages.push({
      content,
      role: 'assistant'
    });
    const toolResults: AnthropicContentBlock[] = [];
    for (const call of calls) {
      core.info(`[postman-tdd] Executing guarded repair tool: ${call.name}.`);
      const result = executeRepairTool(call.name, call.input, options.repairContext);
      logToolResult(call.name, result);
      toolResults.push({
        content: JSON.stringify(result),
        ...(result.error ? { is_error: true } : {}),
        tool_use_id: call.id,
        type: 'tool_result'
      });

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
    messages.push({
      content: toolResults,
      role: 'user'
    });
  }

  core.info('[postman-tdd] Anthropic repair turn exhausted tool-call rounds without a patch.');
  return {
    status: 'no_change',
    message: 'Repair agent exhausted tool-call rounds without proposing a patch.'
  };
}

function createAnthropicTools(context: RepairProviderOptions['repairContext']): Array<Record<string, unknown>> {
  return createRepairTools(context).map((tool) => ({
    description: tool.description,
    input_schema: tool.parameters,
    name: tool.name
  }));
}

async function createMessage(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  messages: AnthropicMessage[];
  model: string;
  secretMasker: (value: string) => string;
  tools: unknown[];
}): Promise<JsonRecord> {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey
    },
    body: JSON.stringify({
      max_tokens: 4096,
      messages: options.messages,
      model: options.model,
      tools: options.tools
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic Messages API failed (${response.status}): ${options.secretMasker(text).slice(0, 1000)}`);
  }
  return JSON.parse(text) as JsonRecord;
}

function isToolUseBlock(value: AnthropicContentBlock): value is ToolUseBlock {
  return value.type === 'tool_use'
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && isRecord(value.input);
}


function extractText(response: JsonRecord): string {
  const content = Array.isArray(response.content) ? response.content : [];
  const chunks: string[] = [];
  for (const item of content) {
    const record = item && typeof item === 'object' ? item as JsonRecord : undefined;
    if (record?.type === 'text' && typeof record.text === 'string') {
      chunks.push(record.text);
    }
  }
  return chunks.join('\n').trim();
}