import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isPathDenied, matchesAny, normalizeRepoPath, repoRelativePath, type PatchPolicy } from './patch.js';

export interface GitRepairCommitOptions {
  branch: string;
  commitMessage: string;
  committerEmail: string;
  committerName: string;
  githubToken: string;
  patchPolicy: PatchPolicy;
  repoRoot: string;
  repository: string;
}

export function hashPaths(repoRoot: string, paths: string[]): Array<{ path: string; sha256: string }> {
  return paths.map((path) => {
    const normalized = repoRelativePath(repoRoot, path);
    return {
      path: normalized,
      sha256: createHash('sha256').update(readFileSync(resolve(repoRoot, normalized))).digest('hex')
    };
  });
}

export function verifyPathHashes(repoRoot: string, hashes: Array<{ path: string; sha256: string }>): void {
  for (const expected of hashes) {
    const normalized = repoRelativePath(repoRoot, expected.path);
    const actual = createHash('sha256').update(readFileSync(resolve(repoRoot, normalized))).digest('hex');
    if (actual !== expected.sha256) {
      throw new Error(`Immutable path changed during repair: ${normalized}`);
    }
  }
}

export function changedPaths(repoRoot: string): string[] {
  const output = execGit(repoRoot, ['diff', '--name-only']);
  const untracked = execGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([
    ...output.split(/\r?\n/),
    ...untracked.split(/\r?\n/)
  ]
    .map(normalizeRepoPath)
    .filter(Boolean))]
    .sort();
}

export function verifyChangedPaths(repoRoot: string, policy: PatchPolicy): string[] {
  const paths = changedPaths(repoRoot);
  for (const path of paths) {
    if (isPathDenied(path, policy)) {
      throw new Error(`Repair diff contains non-writable path: ${path}`);
    }
    if (!matchesAny(path, policy.allowedWritePaths)) {
      throw new Error(`Repair diff contains path outside tdd.repair.allowedWritePaths: ${path}`);
    }
  }
  return paths;
}

export function commitAndPushRepair(options: GitRepairCommitOptions): string {
  const paths = verifyChangedPaths(options.repoRoot, options.patchPolicy);
  if (paths.length === 0) {
    throw new Error('No implementation changes to commit.');
  }

  execGit(options.repoRoot, ['config', 'user.name', options.committerName]);
  execGit(options.repoRoot, ['config', 'user.email', options.committerEmail]);
  execGit(options.repoRoot, ['add', '--', ...paths]);
  execGit(options.repoRoot, ['commit', '-m', options.commitMessage, '--', ...paths]);
  const commitSha = execGit(options.repoRoot, ['rev-parse', 'HEAD']).trim();

  const remote = `https://x-access-token:${encodeURIComponent(options.githubToken)}@github.com/${options.repository}.git`;
  execGit(options.repoRoot, ['push', remote, `HEAD:${options.branch}`]);
  return commitSha;
}

export function execGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const stderr = Buffer.isBuffer((error as { stderr?: unknown }).stderr)
      ? ((error as { stderr: Buffer }).stderr).toString('utf8')
      : error instanceof Error ? error.message : String(error);
    throw new Error(`git ${redactGitArgs(args).join(' ')} failed: ${redactSecret(stderr.trim()) || 'unknown error'}`);
  }
}

function redactGitArgs(args: string[]): string[] {
  return args.map(redactSecret);
}

function redactSecret(value: string): string {
  return value.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}
