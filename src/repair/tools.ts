import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { applyValidatedPatch, isPathDenied, matchesAny, repoRelativePath, type PatchPolicy } from './patch.js';

export interface RepairToolContext {
  allowedReadPaths: string[];
  patchPolicy: PatchPolicy;
  repoRoot: string;
}

export interface RepairToolResult {
  appliedPatch?: boolean;
  content?: string;
  error?: string;
  matches?: Array<{ line: number; path: string; text: string }>;
  paths?: string[];
  summary?: string;
  touchedPaths?: string[];
}

const MAX_FILE_BYTES = 120_000;
const MAX_SEARCH_RESULTS = 25;

export function createRepairTools(context: RepairToolContext): Array<Record<string, unknown>> {
  void context;
  return [
    {
      type: 'function',
      name: 'list_files',
      description: 'List repository files that are readable to the implementation repair agent.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prefix: { type: 'string' }
        },
        required: ['prefix']
      }
    },
    {
      type: 'function',
      name: 'read_file',
      description: 'Read one allowed implementation file.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    },
    {
      type: 'function',
      name: 'search_files',
      description: 'Search allowed implementation files for a fixed string query.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      }
    },
    {
      type: 'function',
      name: 'propose_patch',
      description: 'Propose and apply a unified git diff that changes implementation files only.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patch: { type: 'string' },
          summary: { type: 'string' }
        },
        required: ['patch', 'summary']
      }
    },
    {
      type: 'function',
      name: 'finish',
      description: 'Report that the repair is blocked or ready without proposing more changes.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string' },
          status: { enum: ['blocked', 'ready'], type: 'string' }
        },
        required: ['status', 'message']
      }
    }
  ];
}

export function executeRepairTool(
  name: string,
  args: Record<string, unknown>,
  context: RepairToolContext
): RepairToolResult {
  try {
    if (name === 'list_files') {
      const prefix = String(args.prefix || '');
      return { paths: listAllowedFiles(context, prefix).slice(0, 200) };
    }
    if (name === 'read_file') {
      const path = assertReadablePath(context, String(args.path || ''));
      const absolutePath = resolve(context.repoRoot, path);
      const stats = statSync(absolutePath);
      if (stats.size > MAX_FILE_BYTES) {
        throw new Error(`File is too large to read through repair tool: ${path}`);
      }
      return { content: readFileSync(absolutePath, 'utf8') };
    }
    if (name === 'search_files') {
      const query = String(args.query || '');
      if (!query) throw new Error('search_files query is required');
      return { matches: searchAllowedFiles(context, query) };
    }
    if (name === 'propose_patch') {
      const patch = String(args.patch || '');
      const result = applyValidatedPatch(patch, context.patchPolicy);
      return {
        appliedPatch: true,
        summary: String(args.summary || '').trim(),
        touchedPaths: result.touchedPaths
      };
    }
    if (name === 'finish') {
      return {
        summary: `${String(args.status || '')}: ${String(args.message || '')}`.trim()
      };
    }
    return { error: `Unknown repair tool: ${name}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function listAllowedFiles(context: RepairToolContext, prefix = ''): string[] {
  const output = execFileSync('git', ['ls-files'], {
    cwd: context.repoRoot,
    encoding: 'utf8'
  });
  const normalizedPrefix = prefix.trim().replace(/^\.\//, '');
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => !normalizedPrefix || path.startsWith(normalizedPrefix))
    .filter((path) => matchesAny(path, context.allowedReadPaths))
    .filter((path) => !isPathDenied(path, context.patchPolicy))
    .sort();
}

function searchAllowedFiles(context: RepairToolContext, query: string): Array<{ line: number; path: string; text: string }> {
  const results: Array<{ line: number; path: string; text: string }> = [];
  for (const path of listAllowedFiles(context)) {
    const absolutePath = resolve(context.repoRoot, path);
    if (!existsSync(absolutePath) || statSync(absolutePath).size > MAX_FILE_BYTES) continue;
    const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] || '';
      if (text.includes(query)) {
        results.push({ line: index + 1, path, text: text.trim().slice(0, 300) });
        if (results.length >= MAX_SEARCH_RESULTS) return results;
      }
    }
  }
  return results;
}

function assertReadablePath(context: RepairToolContext, value: string): string {
  const path = repoRelativePath(context.repoRoot, value);
  if (!matchesAny(path, context.allowedReadPaths)) {
    throw new Error(`Path is outside tdd.repair.allowedReadPaths: ${path}`);
  }
  if (isPathDenied(path, context.patchPolicy)) {
    throw new Error(`Path is not readable by the repair agent: ${path}`);
  }
  if (!existsSync(resolve(context.repoRoot, path))) {
    throw new Error(`Path does not exist: ${path}`);
  }
  return path;
}
