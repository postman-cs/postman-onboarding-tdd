import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

export interface PatchPolicy {
  allowedWritePaths: string[];
  immutablePaths: string[];
  repoRoot: string;
}

export interface PatchValidationResult {
  touchedPaths: string[];
}

const ALWAYS_DENY_PATTERNS = [
  '.env',
  '.env.*',
  '.postman-template/**',
  '.postman-tdd/**',
  '.github/workflows/**',
  '.postman/**',
  'postman/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*secret*',
  '**/*token*'
];

export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /^diff --git a\/(.+?) b\/(.+)$/gm,
    /^--- (?:a\/)?(.+)$/gm,
    /^\+\+\+ (?:b\/)?(.+)$/gm,
    /^rename from (.+)$/gm,
    /^rename to (.+)$/gm,
    /^new file mode .+\n--- \/dev\/null\n\+\+\+ b\/(.+)$/gm,
    /^deleted file mode .+\n--- a\/(.+)\n\+\+\+ \/dev\/null$/gm
  ];
  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) {
      for (const captured of match.slice(1)) {
        if (captured && captured !== '/dev/null') {
          paths.add(normalizeRepoPath(captured));
        }
      }
    }
  }
  return [...paths].filter(Boolean).sort();
}

export function validatePatch(patch: string, policy: PatchPolicy): PatchValidationResult {
  const normalizedPatch = normalizePatchInput(patch, policy);
  const trimmed = normalizedPatch.trim();
  if (!trimmed || !trimmed.includes('diff --git')) {
    throw new Error('Repair patch must be a non-empty unified git diff beginning with diff --git.');
  }
  const touchedPaths = extractPatchPaths(normalizedPatch);
  if (touchedPaths.length === 0) {
    throw new Error('Repair patch did not include any touched paths.');
  }

  for (const path of touchedPaths) {
    if (isPathDenied(path, policy)) {
      throw new Error(`Patch touches non-writable path: ${path}`);
    }
    if (!matchesAny(path, policy.allowedWritePaths)) {
      throw new Error(`Patch path is outside tdd.repair.allowedWritePaths: ${path}`);
    }
  }

  gitApply(['--check', '--whitespace=nowarn'], normalizedPatch, policy.repoRoot);
  return { touchedPaths };
}

export function applyValidatedPatch(patch: string, policy: PatchPolicy): PatchValidationResult {
  const normalizedPatch = normalizePatchInput(patch, policy);
  const result = validatePatch(normalizedPatch, policy);
  gitApply(['--whitespace=nowarn'], normalizedPatch, policy.repoRoot);
  return result;
}

function normalizePatchInput(patch: string, policy: PatchPolicy): string {
  let normalized = String(patch || '').trim();
  const fenced = normalized.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/i);
  if (fenced?.[1]?.includes('diff --git')) {
    normalized = fenced[1].trim();
  }
  normalized = normalized
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('```'))
    .join('\n')
    .trim();
  const replacementPatch = replacementEnvelopeToPatch(normalized, policy);
  if (replacementPatch) {
    return replacementPatch;
  }
  const firstDiff = normalized.indexOf('diff --git ');
  if (firstDiff > 0) {
    normalized = normalized.slice(firstDiff).trim();
  }
  return normalized ? `${normalized.replace(/\s+$/g, '')}\n` : '';
}

function replacementEnvelopeToPatch(value: string, policy: PatchPolicy): string {
  const markerIndex = value.indexOf('POSTMAN_TDD_REPLACE_FILE ');
  const normalized = markerIndex > 0 ? value.slice(markerIndex).trim() : value;
  const match = normalized.match(/^POSTMAN_TDD_REPLACE_FILE\s+([^\r\n]+)\r?\n([\s\S]*?)\r?\nPOSTMAN_TDD_END_REPLACE_FILE\s*$/);
  if (!match) return '';

  const path = repoRelativePath(policy.repoRoot, match[1] || '');
  const content = match[2]?.endsWith('\n') ? match[2] : `${match[2] || ''}\n`;
  const tempDir = mkdtempSync(join(tmpdir(), 'postman-tdd-repair-'));
  const tempPath = join(tempDir, 'replacement');
  try {
    writeFileSync(tempPath, content, 'utf8');
    const result = spawnSync('git', [
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-color',
      '--',
      path,
      tempPath
    ], {
      cwd: policy.repoRoot,
      encoding: 'utf8'
    });
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git diff failed: ${(result.stderr || '').trim() || 'unknown error'}`);
    }
    const diff = String(result.stdout || '').trim();
    if (!diff) return '';
    return `${rewriteReplacementDiffHeaders(diff, path).replace(/\s+$/g, '')}\n`;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function rewriteReplacementDiffHeaders(diff: string, path: string): string {
  return diff
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('diff --git ')) return `diff --git a/${path} b/${path}`;
      if (line.startsWith('--- ')) return `--- a/${path}`;
      if (line.startsWith('+++ ')) return `+++ b/${path}`;
      return line;
    })
    .join('\n');
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatch(normalizeRepoPath(path), normalizeRepoPath(pattern)));
}

export function isPathDenied(path: string, policy: PatchPolicy): boolean {
  const normalized = normalizeRepoPath(path);
  return matchesAny(normalized, [
    ...policy.immutablePaths,
    ...ALWAYS_DENY_PATTERNS
  ]);
}

export function normalizeRepoPath(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^[ab]\//, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '');
}

export function repoRelativePath(repoRoot: string, path: string): string {
  const absolute = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, absolute).split(sep).join('/');
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new Error(`Path is outside repository: ${path}`);
  }
  return normalizeRepoPath(relativePath);
}

function gitApply(args: string[], patch: string, cwd: string): void {
  try {
    execFileSync('git', ['apply', ...args, '-'], {
      cwd,
      input: patch,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    const stderr = Buffer.isBuffer((error as { stderr?: unknown }).stderr)
      ? ((error as { stderr: Buffer }).stderr).toString('utf8')
      : error instanceof Error ? error.message : String(error);
    throw new Error(`git apply failed: ${stderr.trim() || 'unknown error'}`);
  }
}

function globMatch(path: string, pattern: string): boolean {
  const regex = new RegExp(`^${escapeGlob(pattern)}$`);
  return regex.test(path);
}

function escapeGlob(pattern: string): string {
  let output = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      output += '.*';
      index += 1;
    } else if (char === '*') {
      output += '[^/]*';
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += String(char).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return output;
}
