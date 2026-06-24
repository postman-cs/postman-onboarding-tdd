#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_POLICY_PATH = '.postman-template/agent-policy.json';
const DEFAULT_DENY_MESSAGE = 'The OpenAPI spec is immutable during implementation repair. Revert spec changes and fix code only.';

const WRITE_LIKE_COMMAND = /\b(sed|perl)\b[\s\S]*\s-i(?:\s|$)|(^|[;&|]\s*)(rm|mv|tee)\b|(^|[;&|]\s*)cat\b[\s\S]*>|>\s*[^&]|\b(writeFile(?:Sync)?|appendFile(?:Sync)?|openSync|createWriteStream)\b|\bopen\s*\([^)]*['"][wa+]/i;
const GIT_WRITE_LIKE = /\bgit\s+(checkout|restore|apply|reset)\b/i;

function main() {
  const root = findRepoRoot();
  const policy = readPolicy(root);
  const immutablePaths = resolveImmutablePaths(root, policy);
  if (immutablePaths.length === 0) {
    process.exit(0);
  }

  const input = readHookInput();
  if (!input) {
    process.exit(0);
  }

  const decision = evaluateToolCall(input, immutablePaths, root);
  if (decision.blocked) {
    const message = policy.deny?.[0]?.message || DEFAULT_DENY_MESSAGE;
    console.error(message);
    if (decision.reason) {
      console.error(decision.reason);
    }
    process.exit(policy.runtimeBehavior?.denyExitCode || 12);
  }
}

function findRepoRoot() {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const root = git.status === 0 ? git.stdout.trim() : '';
  return root || process.cwd();
}

function readPolicy(root) {
  const policyPath = resolve(root, process.env.POSTMAN_TDD_AGENT_POLICY || DEFAULT_POLICY_PATH);
  if (!existsSync(policyPath)) {
    return {
      deny: [{ message: DEFAULT_DENY_MESSAGE, paths: ['${spec.path}'] }],
      immutablePathsFrom: [{
        fallback: 'api/openapi.yaml',
        field: 'spec.path',
        path: '.postman-template/onboarding.yml',
        type: 'yaml'
      }]
    };
  }
  return JSON.parse(readFileSync(policyPath, 'utf8'));
}

function resolveImmutablePaths(root, policy) {
  const values = new Set();
  const variables = {
    'spec.path': undefined
  };

  for (const source of policy.immutablePathsFrom || []) {
    if (source.type !== 'yaml' || source.field !== 'spec.path') continue;
    variables['spec.path'] = readSpecPath(root, source.path) || source.fallback;
    if (variables['spec.path']) {
      values.add(variables['spec.path']);
    }
  }

  for (const rule of policy.deny || []) {
    for (const rawPath of rule.paths || []) {
      const expanded = String(rawPath).replace(/\$\{spec\.path\}/g, variables['spec.path'] || '');
      if (expanded) {
        values.add(expanded);
      }
    }
  }

  return [...values].map((path) => normalizePath(path, root)).filter(Boolean);
}

function readSpecPath(root, onboardingPath) {
  const absolutePath = resolve(root, onboardingPath || '.postman-template/onboarding.yml');
  if (!existsSync(absolutePath)) return undefined;
  const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  let inSpec = false;
  let specIndent = -1;

  for (const line of lines) {
    if (/^\s*$|^\s*#/.test(line)) continue;
    const indent = leadingSpaces(line);
    if (/^\s*spec\s*:\s*(?:#.*)?$/.test(line)) {
      inSpec = true;
      specIndent = indent;
      continue;
    }
    if (inSpec && indent <= specIndent) {
      inSpec = false;
    }
    if (!inSpec) continue;
    const match = line.match(/^\s*path\s*:\s*["']?([^"'\s#]+)["']?/);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function readHookInput() {
  const raw = readFileSync(0, 'utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function evaluateToolCall(input, immutablePaths, root) {
  const strings = collectStrings(input);
  const patchText = strings.filter((value) => value.includes('*** Begin Patch') || value.includes('diff --git')).join('\n');
  const patchPaths = extractPatchPaths(patchText);
  const directPaths = extractDirectPathValues(input);
  const commandText = strings.join('\n');

  for (const path of [...patchPaths, ...directPaths]) {
    const match = matchImmutablePath(path, immutablePaths, root);
    if (match) {
      return {
        blocked: true,
        reason: `Blocked tool call touching immutable path: ${match}`
      };
    }
  }

  if (isWriteLikeCommand(commandText)) {
    for (const immutablePath of immutablePaths) {
      if (commandMentionsPath(commandText, immutablePath)) {
        return {
          blocked: true,
          reason: `Blocked command referencing immutable path: ${immutablePath}`
        };
      }
    }
  }

  return { blocked: false };
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, output);
  }
  return output;
}

function extractDirectPathValues(value, output = [], key = '') {
  if (typeof value === 'string') {
    if (/^(path|file|filename|target|destination|new_path|old_path)$/i.test(key)) {
      output.push(value);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) extractDirectPathValues(entry, output, key);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, entry] of Object.entries(value)) {
      extractDirectPathValues(entry, output, childKey);
    }
  }
  return output;
}

function extractPatchPaths(patch) {
  if (!patch) return [];
  const paths = [];
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm,
    /^\*\*\* Move to:\s*(.+)$/gm,
    /^diff --git a\/(.+?) b\/(.+)$/gm,
    /^--- a\/(.+)$/gm,
    /^\+\+\+ b\/(.+)$/gm
  ];

  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) {
      for (const captured of match.slice(1)) {
        if (captured && captured !== '/dev/null') paths.push(captured.trim());
      }
    }
  }
  return paths;
}

function isWriteLikeCommand(command) {
  return WRITE_LIKE_COMMAND.test(command) || GIT_WRITE_LIKE.test(command);
}

function commandMentionsPath(command, path) {
  const escaped = escapeRegExp(path);
  const basename = path.split('/').pop();
  return new RegExp(`(^|[\\s'"=:/])(?:\\./)?${escaped}($|[\\s'"` + '`' + `;|&])`).test(command) ||
    (basename ? command.includes(path) || command.includes(`/${path}`) || command.includes(basename) && command.includes(path) : false);
}

function matchImmutablePath(candidate, immutablePaths, root) {
  const normalized = normalizePath(candidate, root);
  return immutablePaths.find((immutablePath) => normalized === immutablePath);
}

function normalizePath(value, root) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^[ab]\//, '')
    .replace(/^\.\//, '');
  if (!cleaned) return '';
  const absolute = resolve(root, cleaned);
  const rel = relative(root, absolute).split(sep).join('/');
  return rel.startsWith('..') ? cleaned : rel;
}

function leadingSpaces(value) {
  return value.match(/^\s*/)?.[0].length || 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main();
