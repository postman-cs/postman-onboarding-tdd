import type { AgentFailure } from './types.js';

const MAX_FAILURES = 10;
const MAX_MESSAGE_LENGTH = 400;
const HTTP_METHOD = '(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE)';
const TDD_ASSERTION_PATTERN = new RegExp(
  `\\[Postman TDD\\]\\s+(?:(?<operationId>[^\\s:]+)\\s+)?(?<method>${HTTP_METHOD})\\s+(?<path>\\S+)\\s+::\\s+(?<assertion>.+)$`,
  'i'
);

interface TaggedAssertion {
  assertion: string;
  method: string;
  operationId?: string;
  path: string;
}

export function extractCollectionFailures(logExcerpt: string): AgentFailure[] {
  const lines = compactLines(logExcerpt);
  const tagged = extractTaggedFailures(lines);
  if (tagged.length > 0) {
    return tagged;
  }

  const interesting = dedupeFailures(lines
    .filter(isInterestingFailureLine)
    .map((line) => ({
      assertion: inferAssertion(line),
      message: normalizeFailureMessage(line)
    })))
    .slice(0, MAX_FAILURES);

  if (interesting.length > 0) {
    return interesting;
  }

  return [{
    assertion: 'collection run',
    message: 'Postman TDD collection failed, but no compact assertion details were detected in runner output.'
  }];
}

function extractTaggedFailures(lines: string[]): AgentFailure[] {
  const failures: AgentFailure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseTaggedAssertion(lines[index] || '');
    if (!parsed) continue;
    failures.push({
      ...parsed,
      message: findNearbyFailureMessage(lines, index, parsed.assertion)
    });
    if (failures.length >= MAX_FAILURES) {
      break;
    }
  }
  return dedupeFailures(failures);
}

function parseTaggedAssertion(line: string): TaggedAssertion | undefined {
  const markerIndex = line.indexOf('[Postman TDD]');
  if (markerIndex === -1) return undefined;
  const candidate = line.slice(markerIndex);
  const match = TDD_ASSERTION_PATTERN.exec(candidate);
  if (!match?.groups) return undefined;
  const method = match.groups.method?.toUpperCase();
  const path = normalizePath(match.groups.path || '');
  const assertion = normalizeAssertion(match.groups.assertion || '');
  if (!method || !path || !assertion) return undefined;
  return {
    assertion,
    method,
    operationId: match.groups.operationId,
    path
  };
}

function findNearbyFailureMessage(lines: string[], assertionIndex: number, fallbackAssertion: string): string {
  const sameLineDetail = detailAfterAssertion(lines[assertionIndex] || '');
  if (sameLineDetail) return normalizeFailureMessage(sameLineDetail);

  for (const line of lines.slice(assertionIndex + 1, assertionIndex + 8)) {
    if (line.includes('[Postman TDD]')) break;
    if (isNoiseLine(line)) continue;
    if (isInterestingFailureLine(line) || line.length > 0) {
      return normalizeFailureMessage(line);
    }
  }

  return `Assertion failed: ${fallbackAssertion}`;
}

function detailAfterAssertion(line: string): string {
  const split = line.split(/\s+-\s+|:\s+AssertionError:?|\s+AssertionError:?\s+/i);
  const candidate = split.length > 1 ? split[split.length - 1] || '' : '';
  return candidate.includes('[Postman TDD]') ? '' : candidate.trim();
}

function compactLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(stripAnsi)
    .map((line) => line
      .replace(/^[\u2502\u2503|>\s]*\d+[.)]\s*/, '')
      .replace(/^[\u2502\u2503|>\s]*(error|fail(?:ed|ure)?|assertionerror)[:\s-]*/i, '')
      .replace(/^[\u2502\u2503|>\s]+/, '')
      .trim())
    .filter(Boolean);
}

function normalizeFailureMessage(value: string): string {
  const cleaned = stripAnsi(value)
    .replace(/^[\u2502\u2503|>\s]*/, '')
    .replace(/^AssertionError(?: \[[^\]]+\])?:?\s*/i, '')
    .replace(/^Error:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const required = cleaned.match(/^\$\.?([A-Za-z0-9_.[\]-]+)\s+is required\.?$/);
  if (required?.[1]) {
    return truncate(`Missing required property: ${required[1].split('.').pop()}`);
  }
  return truncate(cleaned || 'Assertion failed.');
}

function normalizeAssertion(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:failed|error)$/i, '')
    .trim()
    .toLowerCase();
}

function normalizePath(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname || value;
  } catch {
    return value.replace(/[,:;]+$/, '');
  }
}

function inferAssertion(line: string): string {
  const normalized = line.toLowerCase();
  if (normalized.includes('content-type')) return 'content-type matches OpenAPI response content';
  if (normalized.includes('status')) return 'status code is defined by OpenAPI';
  if (normalized.includes('schema') || normalized.includes('required property') || normalized.includes(' is required')) {
    return 'response body matches schema';
  }
  if (normalized.includes('body')) return 'response body matches body contract';
  return 'collection assertion';
}

function isInterestingFailureLine(line: string): boolean {
  return !isNoiseLine(line) && /fail|error|assert|expected|actual|required|missing|schema|status|content-type/i.test(line);
}

function isNoiseLine(line: string): boolean {
  return line.length === 0 ||
    /^[\u250c\u2510\u2514\u2518\u251c\u2524\u2500\u2501\u256d\u256e\u2570\u256f]+$/.test(line) ||
    /^(postman|collection|iteration|request|response|total|duration|data|folder|executed|running)\b/i.test(line) ||
    /^\d+\s+(passed|failed|skipped)\b/i.test(line);
}

function dedupeFailures(failures: AgentFailure[]): AgentFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = [
      failure.operationId || '',
      failure.method || '',
      failure.path || '',
      failure.assertion || '',
      failure.message
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : value;
}
