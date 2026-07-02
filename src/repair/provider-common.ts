import type { SecretMasker } from '../secrets.js';
import type { AgentContractHint, AgentFailure, AgentFailureDocument } from '../types.js';
import type { RepairToolContext } from './tools.js';

export interface RepairProviderOptions {
  apiKey: string;
  failure: AgentFailureDocument;
  fetchImpl?: typeof fetch;
  maxToolRounds?: number;
  model: string;
  repairContext: RepairToolContext;
  secretMasker: SecretMasker;
}

export type RepairProviderResult =
  | { status: 'changed'; summary: string; touchedPaths: string[] }
  | { status: 'blocked'; message: string }
  | { status: 'no_change'; message: string };

export interface RepairPromptOptions {
  compact?: boolean;
  maxChars?: number;
}

type JsonRecord = Record<string, unknown>;

interface CompactBudget {
  maxFailureMessageLength: number;
  maxFailures: number;
  maxHints: number;
  maxRulesPerResponse: number;
}

const COMPACT_PROMPT_BUDGETS: CompactBudget[] = [
  { maxFailureMessageLength: 500, maxFailures: 6, maxHints: 4, maxRulesPerResponse: 30 },
  { maxFailureMessageLength: 300, maxFailures: 4, maxHints: 3, maxRulesPerResponse: 20 },
  { maxFailureMessageLength: 180, maxFailures: 3, maxHints: 2, maxRulesPerResponse: 12 },
  { maxFailureMessageLength: 120, maxFailures: 2, maxHints: 1, maxRulesPerResponse: 8 },
  { maxFailureMessageLength: 90, maxFailures: 1, maxHints: 1, maxRulesPerResponse: 4 },
  { maxFailureMessageLength: 80, maxFailures: 1, maxHints: 0, maxRulesPerResponse: 0 }
];

export function buildRepairPrompt(
  failure: AgentFailureDocument,
  context: RepairToolContext,
  options: RepairPromptOptions = {}
): string {
  if (options.compact) {
    return buildCompactRepairPrompt(failure, context, options.maxChars);
  }

  return [
    'You are repairing an API implementation so it passes a Postman TDD contract collection.',
    'Fix implementation code only.',
    'Do not modify, regenerate, or weaken the OpenAPI spec or generated assertions.',
    `Allowed write paths: ${context.patchPolicy.allowedWritePaths.join(', ')}`,
    `Allowed read paths: ${context.allowedReadPaths.join(', ')}`,
    `Immutable paths: ${context.patchPolicy.immutablePaths.join(', ') || '(none)'}`,
    'Use read_file, list_files, and search_files to inspect implementation files.',
    'Use propose_patch with a raw unified git diff when you have a code-only fix.',
    'The propose_patch patch string must begin with diff --git and must not be wrapped in Markdown fences or prose.',
    'If a large single-file diff is difficult to format, use propose_patch with this exact replacement envelope instead: POSTMAN_TDD_REPLACE_FILE <allowed path>, then the complete new file content, then POSTMAN_TDD_END_REPLACE_FILE.',
    'The replacement envelope is still limited to allowed write paths and must not include spec, workflow, secret, shell, or unrelated changes.',
    'Use finish with status=blocked if API intent is unclear, infrastructure is missing, or no implementation-only fix is reasonable.',
    '',
    'Failure context:',
    JSON.stringify({
      baseUrl: failure.baseUrl,
      collectionName: failure.collectionName,
      contractHints: failure.contractHints,
      failures: failure.failures,
      phase: failure.phase,
      successCriteria: failure.successCriteria
    }, null, 2)
  ].join('\n');
}

function buildCompactRepairPrompt(
  failure: AgentFailureDocument,
  context: RepairToolContext,
  maxChars: number | undefined
): string {
  if (!maxChars) {
    return renderCompactRepairPrompt(failure, context, COMPACT_PROMPT_BUDGETS[0]!);
  }

  for (const budget of COMPACT_PROMPT_BUDGETS) {
    const prompt = renderCompactRepairPrompt(failure, context, budget);
    if (prompt.length <= maxChars) return prompt;
  }

  const fallback = renderCompactRepairPrompt(failure, context, COMPACT_PROMPT_BUDGETS.at(-1)!);
  if (fallback.length <= maxChars) return fallback;
  return `${fallback.slice(0, Math.max(0, maxChars - 55))}\n[Prompt truncated to fit provider input limit.]`;
}

function renderCompactRepairPrompt(
  failure: AgentFailureDocument,
  context: RepairToolContext,
  budget: CompactBudget
): string {
  return [
    'Repair the API implementation so it passes Postman TDD.',
    `Rules: code only; do not modify OpenAPI spec/generated assertions/immutable paths (${context.patchPolicy.immutablePaths.join(', ') || 'none'}).`,
    `Allowed write paths: ${context.patchPolicy.allowedWritePaths.join(', ')}`,
    `Allowed read paths: ${context.allowedReadPaths.join(', ')}`,
    'Inspect with list_files/read_file/search_files.',
    'Patch with propose_patch as raw unified diff starting diff --git.',
    'If diff formatting fails, propose_patch may use: POSTMAN_TDD_REPLACE_FILE <allowed path> ... POSTMAN_TDD_END_REPLACE_FILE.',
    'Use finish status=blocked only when an implementation-only fix is unsafe or unclear.',
    'Failure context JSON:',
    JSON.stringify(createCompactFailureContext(failure, budget))
  ].join('\n');
}

function createCompactFailureContext(failure: AgentFailureDocument, budget: CompactBudget): JsonRecord {
  return {
    phase: failure.phase,
    message: truncateText(failure.message, 160),
    failureCount: failure.failures.length,
    failures: failure.failures.slice(0, budget.maxFailures).map((entry) => compactFailure(entry, budget)),
    ...(failure.contractHints && budget.maxHints > 0
      ? { contractHints: compactContractHints(failure.contractHints, budget) }
      : {}),
    successCriteria: {
      requiredCheck: failure.successCriteria.requiredCheck,
      doneWhen: failure.successCriteria.doneWhen
    }
  };
}

function compactFailure(failure: AgentFailure, budget: CompactBudget): JsonRecord {
  return omitUndefined({
    method: failure.method,
    path: failure.path,
    operationId: failure.operationId,
    assertion: truncateText(failure.assertion, 160),
    message: truncateText(failure.message, budget.maxFailureMessageLength)
  });
}

function compactContractHints(hints: AgentContractHint[], budget: CompactBudget): JsonRecord[] {
  return hints.slice(0, budget.maxHints).map((hint) => omitUndefined({
    method: hint.method,
    path: hint.path,
    operationId: hint.operationId,
    responses: hint.responses.slice(0, 2).map((response) => ({
      status: response.status,
      content: compactContent(response.content, budget.maxRulesPerResponse)
    }))
  }));
}

function compactContent(
  content: Record<string, { schema?: unknown }>,
  maxRulesPerResponse: number
): JsonRecord {
  const preferredEntries = Object.entries(content).sort(([left], [right]) => {
    if (left === 'application/json') return -1;
    if (right === 'application/json') return 1;
    return left.localeCompare(right);
  });
  return Object.fromEntries(preferredEntries.slice(0, 2).map(([mediaType, media]) => [
    mediaType,
    media.schema === undefined ? {} : { schema: summarizePromptSchema(media.schema, maxRulesPerResponse) }
  ]));
}

function summarizePromptSchema(schema: unknown, maxRules: number): JsonRecord {
  const rules = schemaToRules(schema, maxRules);
  return { rules };
}

function schemaToRules(schema: unknown, maxRules: number): string[] {
  if (maxRules <= 0) return [];
  if (isRecord(schema) && Array.isArray(schema.rules)) {
    return schema.rules
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, maxRules)
      .map((entry) => truncateRequiredText(entry, 220));
  }

  const rules: string[] = [];
  collectPromptSchemaRules(schema, '$', 0, maxRules, rules);
  return rules;
}

function collectPromptSchemaRules(
  value: unknown,
  path: string,
  depth: number,
  maxRules: number,
  rules: string[]
): void {
  if (rules.length >= maxRules || depth > 7 || !isRecord(value)) return;

  const parts = scalarRuleParts(value);
  const required = Array.isArray(value.required)
    ? value.required.filter((entry) => typeof entry === 'string')
    : [];
  if (required.length > 0) parts.push(`required=${required.join(',')}`);
  if (parts.length > 0) addRule(rules, `${path}: ${parts.join('; ')}`, maxRules);

  if (isRecord(value.properties)) {
    for (const [key, entry] of Object.entries(value.properties)) {
      collectPromptSchemaRules(entry, propertyPath(path, key), depth + 1, maxRules, rules);
      if (rules.length >= maxRules) return;
    }
  }
  if (value.items !== undefined) {
    collectPromptSchemaRules(value.items, `${path}[]`, depth + 1, maxRules, rules);
  }
  for (const combinator of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!Array.isArray(value[combinator])) continue;
    value[combinator].forEach((entry, index) => {
      collectPromptSchemaRules(entry, `${path}.${combinator}[${index}]`, depth + 1, maxRules, rules);
    });
  }
  if (isRecord(value.additionalProperties)) {
    collectPromptSchemaRules(value.additionalProperties, `${path}.*`, depth + 1, maxRules, rules);
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
  if (Array.isArray(value)) return value.map((entry) => formatRuleValue(entry)).join('|');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
}

function addRule(rules: string[], rule: string, maxRules: number): void {
  if (rules.length >= maxRules) return;
  rules.push(truncateRequiredText(rule, 220));
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function truncateRequiredText(value: string, maxLength: number): string {
  return truncateText(value, maxLength) || '';
}

function omitUndefined(input: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
