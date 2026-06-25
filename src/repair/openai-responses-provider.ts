import * as core from '@actions/core';

import { createRepairTools, executeRepairTool, type RepairToolContext } from './tools.js';
import type { AgentFailureDocument } from '../types.js';
import type { SecretMasker } from '../secrets.js';

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

export interface OpenAiRepairOptions {
  apiKey: string;
  failure: AgentFailureDocument;
  fetchImpl?: FetchLike;
  maxToolRounds?: number;
  model: string;
  repairContext: RepairToolContext;
  secretMasker: SecretMasker;
}

export type OpenAiRepairResult =
  | { status: 'changed'; summary: string; touchedPaths: string[] }
  | { status: 'blocked'; message: string }
  | { status: 'no_change'; message: string };

export async function runOpenAiRepairTurn(options: OpenAiRepairOptions): Promise<OpenAiRepairResult> {
  core.info(`[postman-tdd] OpenAI Responses repair turn: model=${options.model}, failurePhase=${options.failure.phase}, failures=${options.failure.failures.length}.`);
  let input: unknown[] = [{
    content: [{
      text: buildRepairPrompt(options.failure, options.repairContext),
      type: 'input_text'
    }],
    role: 'user'
  }];
  const tools = createRepairTools(options.repairContext);
  let previousResponseId: string | undefined;

  for (let round = 0; round < (options.maxToolRounds || 12); round += 1) {
    core.info(`[postman-tdd] OpenAI Responses round ${round + 1}: sending ${previousResponseId ? 'tool output(s)' : 'initial repair instructions'}.`);
    const response = await createResponse({
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      input,
      model: options.model,
      previousResponseId,
      secretMasker: options.secretMasker,
      tools
    });
    if (typeof response.id === 'string') {
      previousResponseId = response.id;
    }
    const calls = (Array.isArray(response.output) ? response.output : [])
      .filter((item): item is JsonRecord => isFunctionCall(item));
    core.info(`[postman-tdd] OpenAI Responses round ${round + 1}: received ${calls.length} function call(s).`);
    if (calls.length === 0) {
      return {
        status: 'no_change',
        message: extractText(response) || 'The repair agent did not call a patch or finish tool.'
      };
    }

    const toolOutputs: unknown[] = [];
    for (const call of calls) {
      const name = String(call.name || '');
      const args = parseArguments(call.arguments);
      core.info(`[postman-tdd] Executing guarded repair tool: ${name}.`);
      const result = executeRepairTool(name, args, options.repairContext);
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
      toolOutputs.push({
        call_id: call.call_id,
        output: JSON.stringify(result),
        type: 'function_call_output'
      });

      if (name === 'propose_patch' && result.appliedPatch) {
        return {
          status: 'changed',
          summary: result.summary || 'Applied implementation repair patch.',
          touchedPaths: result.touchedPaths || []
        };
      }
      if (name === 'finish') {
        const status = String(args.status || '');
        const message = String(args.message || result.summary || '').trim();
        if (status === 'blocked') {
          return { status: 'blocked', message: message || 'Repair agent reported blocked.' };
        }
        return { status: 'no_change', message: message || 'Repair agent reported ready without changes.' };
      }
    }
    input = toolOutputs;
  }

  core.info('[postman-tdd] OpenAI repair turn exhausted tool-call rounds without a patch.');
  return {
    status: 'no_change',
    message: 'Repair agent exhausted tool-call rounds without proposing a patch.'
  };
}

async function createResponse(options: {
  apiKey: string;
  fetchImpl?: FetchLike;
  input: unknown[];
  model: string;
  previousResponseId?: string;
  secretMasker: SecretMasker;
  tools: unknown[];
}): Promise<JsonRecord> {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: options.input,
      model: options.model,
      ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
      tool_choice: 'auto',
      tools: options.tools
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI Responses API failed (${response.status}): ${options.secretMasker(text).slice(0, 1000)}`);
  }
  return JSON.parse(text) as JsonRecord;
}

function buildRepairPrompt(failure: AgentFailureDocument, context: RepairToolContext): string {
  return [
    'You are repairing an API implementation so it passes a Postman TDD contract collection.',
    'Fix implementation code only.',
    'Do not modify, regenerate, or weaken the OpenAPI spec or generated assertions.',
    `Allowed write paths: ${context.patchPolicy.allowedWritePaths.join(', ')}`,
    `Allowed read paths: ${context.allowedReadPaths.join(', ')}`,
    `Immutable paths: ${context.patchPolicy.immutablePaths.join(', ') || '(none)'}`,
    'Use read_file, list_files, and search_files to inspect implementation files.',
    'Use propose_patch with a unified git diff when you have a code-only fix.',
    'Use finish with status=blocked if API intent is unclear, infrastructure is missing, or no implementation-only fix is reasonable.',
    '',
    'Failure context:',
    JSON.stringify({
      baseUrl: failure.baseUrl,
      collectionName: failure.collectionName,
      failures: failure.failures,
      phase: failure.phase,
      successCriteria: failure.successCriteria
    }, null, 2)
  ].join('\n');
}

function isFunctionCall(item: unknown): item is JsonRecord {
  return Boolean(item && typeof item === 'object' && (item as JsonRecord).type === 'function_call');
}

function parseArguments(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  try {
    return JSON.parse(String(value || '{}')) as JsonRecord;
  } catch {
    return {};
  }
}

function extractText(response: JsonRecord): string {
  const output = Array.isArray(response.output) ? response.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const record = item && typeof item === 'object' ? item as JsonRecord : undefined;
    const content = Array.isArray(record?.content) ? record.content : [];
    for (const entry of content) {
      const entryRecord = entry && typeof entry === 'object' ? entry as JsonRecord : undefined;
      if (typeof entryRecord?.text === 'string') chunks.push(entryRecord.text);
    }
  }
  return chunks.join('\n').trim();
}
