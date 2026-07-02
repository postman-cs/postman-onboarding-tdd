import { readFileSync } from 'node:fs';

import { buildContractIndex, parseOpenApiDocument, type ContractOperation } from './contract.js';
import { resolveWorkspacePath } from './config.js';
import type { AgentContractHint, AgentFailure } from './types.js';

type JsonRecord = Record<string, unknown>;

const MAX_HINTS = 5;
const MAX_DEPTH = 8;
const MAX_RULES_PER_SCHEMA = 80;
const MAX_RULE_LENGTH = 240;

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
          media.schema === undefined ? {} : { schema: summarizeSchema(media.schema) }
        ])),
        status
      }))
  };
}

function summarizeSchema(value: unknown): { rules: string[] } {
  const rules: string[] = [];
  collectSchemaRules(value, '$', 0, rules);
  return { rules };
}

function collectSchemaRules(value: unknown, path: string, depth: number, rules: string[]): void {
  if (rules.length >= MAX_RULES_PER_SCHEMA) return;
  if (depth > MAX_DEPTH) {
    addRule(rules, `${path}: nested schema omitted`);
    return;
  }
  if (!isRecord(value)) return;

  const parts = scalarRuleParts(value);
  const required = Array.isArray(value.required)
    ? value.required.filter((entry) => typeof entry === 'string')
    : [];
  if (required.length > 0) parts.push(`required=${required.join(',')}`);
  if (parts.length > 0) addRule(rules, `${path}: ${parts.join('; ')}`);

  if (isRecord(value.properties)) {
    for (const [key, entry] of Object.entries(value.properties)) {
      collectSchemaRules(entry, propertyPath(path, key), depth + 1, rules);
      if (rules.length >= MAX_RULES_PER_SCHEMA) return;
    }
  }
  if (value.items !== undefined) {
    collectSchemaRules(value.items, `${path}[]`, depth + 1, rules);
  }
  for (const combinator of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!Array.isArray(value[combinator])) continue;
    value[combinator].forEach((entry, index) => {
      collectSchemaRules(entry, `${path}.${combinator}[${index}]`, depth + 1, rules);
    });
  }
  if (isRecord(value.additionalProperties)) {
    collectSchemaRules(value.additionalProperties, `${path}.*`, depth + 1, rules);
  } else if (typeof value.additionalProperties === 'boolean') {
    addRule(rules, `${path}: additionalProperties=${String(value.additionalProperties)}`);
  }
}

function scalarRuleParts(input: JsonRecord): string[] {
  const parts: string[] = [];
  for (const [key, label] of [
    ['type', 'type'],
    ['format', 'format'],
    ['enum', 'enum'],
    ['const', 'const'],
    ['nullable', 'nullable'],
    ['pattern', 'pattern'],
    ['minimum', 'minimum'],
    ['maximum', 'maximum'],
    ['exclusiveMinimum', 'exclusiveMinimum'],
    ['exclusiveMaximum', 'exclusiveMaximum'],
    ['minLength', 'minLength'],
    ['maxLength', 'maxLength'],
    ['minItems', 'minItems'],
    ['maxItems', 'maxItems']
  ] as const) {
    if (input[key] !== undefined) parts.push(`${label}=${formatRuleValue(input[key])}`);
  }
  return parts;
}

function formatRuleValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatRuleValue(entry)).join('|');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
}

function addRule(rules: string[], rule: string): void {
  if (rules.length >= MAX_RULES_PER_SCHEMA) return;
  rules.push(rule.length > MAX_RULE_LENGTH ? `${rule.slice(0, MAX_RULE_LENGTH - 3)}...` : rule);
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
