import { readFileSync } from 'node:fs';

import { buildContractIndex, parseOpenApiDocument, type ContractOperation } from './contract.js';
import { resolveWorkspacePath } from './config.js';
import type { AgentContractHint, AgentFailure } from './types.js';

type JsonRecord = Record<string, unknown>;

const MAX_HINTS = 5;
const MAX_DEPTH = 8;

export function buildContractHints(specPath: string | undefined, failures: AgentFailure[]): AgentContractHint[] {
  if (!specPath || failures.length === 0) return [];
  const root = parseOpenApiDocument(readFileSync(resolveWorkspacePath(specPath), 'utf8'));
  const index = buildContractIndex(root);
  const hints: AgentContractHint[] = [];
  const seen = new Set<string>();

  for (const failure of failures) {
    const operation = findOperation(index.operations, failure);
    if (!operation) continue;
    const key = `${operation.method} ${operation.path} ${operation.operationId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(toContractHint(operation));
    if (hints.length >= MAX_HINTS) break;
  }

  return hints;
}

function findOperation(operations: ContractOperation[], failure: AgentFailure): ContractOperation | undefined {
  if (failure.operationId) {
    const byOperationId = operations.find((operation) => operation.operationId === failure.operationId);
    if (byOperationId) return byOperationId;
  }
  const method = failure.method?.toUpperCase();
  if (method && failure.path) {
    return operations.find((operation) => operation.method === method && operation.path === failure.path);
  }
  return undefined;
}

function toContractHint(operation: ContractOperation): AgentContractHint {
  return {
    method: operation.method,
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    path: operation.path,
    responses: Object.entries(operation.responses)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, response]) => ({
        ...(response.description ? { description: response.description } : {}),
        content: Object.fromEntries(Object.entries(response.content).map(([mediaType, media]) => [
          mediaType,
          media.schema === undefined ? {} : { schema: simplifySchema(media.schema) }
        ])),
        status
      }))
  };
}

function simplifySchema(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return {};
  if (Array.isArray(value)) {
    return value.map((entry) => simplifySchema(entry, depth + 1));
  }
  if (!isRecord(value)) return value;

  const output: JsonRecord = {};
  copyScalarKeys(value, output);

  if (Array.isArray(value.required)) {
    output.required = value.required.filter((entry) => typeof entry === 'string');
  }
  if (isRecord(value.properties)) {
    output.properties = Object.fromEntries(Object.entries(value.properties).map(([key, entry]) => [
      key,
      simplifySchema(entry, depth + 1)
    ]));
  }
  if (value.items !== undefined) {
    output.items = simplifySchema(value.items, depth + 1);
  }
  for (const combinator of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(value[combinator])) {
      output[combinator] = value[combinator].map((entry) => simplifySchema(entry, depth + 1));
    }
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'function') {
    output.additionalProperties = typeof value.additionalProperties === 'boolean'
      ? value.additionalProperties
      : simplifySchema(value.additionalProperties, depth + 1);
  }

  return output;
}

function copyScalarKeys(input: JsonRecord, output: JsonRecord): void {
  for (const key of [
    'type',
    'format',
    'enum',
    'const',
    'nullable',
    'pattern',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems'
  ]) {
    if (input[key] !== undefined) output[key] = input[key];
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
