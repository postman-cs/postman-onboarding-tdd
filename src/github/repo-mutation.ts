import { spawn } from 'node:child_process';

import { createSecretMasker } from '../secrets.js';
import type { ConfigWriteMode } from '../types.js';

export interface CommitConfigWritebackOptions {
  committerEmail: string;
  committerName: string;
  configPath: string;
  githubToken: string;
  mode: ConfigWriteMode;
  repository: string;
}

interface ExecResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function execFile(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('close', (code) => {
      resolve({
        exitCode: code || 0,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

async function mustExec(command: string, args: string[], mask: (value: string) => string): Promise<ExecResult> {
  const result = await execFile(command, args);
  if (result.exitCode !== 0) {
    throw new Error(mask(result.stderr || result.stdout || `${command} ${args.join(' ')} failed`));
  }
  return result;
}

function normalizeBranch(value: string | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('refs/heads/')) return raw.slice('refs/heads/'.length);
  if (raw.startsWith('refs/')) return '';
  return raw;
}

export async function commitConfigWriteback(
  options: CommitConfigWritebackOptions
): Promise<{ commitSha: string; pushed: boolean }> {
  if (options.mode === 'none') {
    return { commitSha: '', pushed: false };
  }

  const mask = createSecretMasker([options.githubToken]);
  await mustExec('git', ['config', 'user.name', options.committerName], mask);
  await mustExec('git', ['config', 'user.email', options.committerEmail], mask);
  await mustExec('git', ['add', '--', options.configPath], mask);
  const diff = await execFile('git', ['diff', '--cached', '--quiet']);
  if (diff.exitCode === 0) {
    return { commitSha: '', pushed: false };
  }

  await mustExec('git', ['commit', '-m', 'chore: persist Postman TDD workspace id'], mask);
  const commitSha = (await mustExec('git', ['rev-parse', 'HEAD'], mask)).stdout.trim();

  if (options.mode !== 'commit-and-push') {
    return { commitSha, pushed: false };
  }

  const branch = normalizeBranch(process.env.GITHUB_HEAD_REF) ||
    normalizeBranch(process.env.GITHUB_REF_NAME) ||
    normalizeBranch(process.env.GITHUB_REF);
  if (!branch) {
    throw new Error('Could not resolve current branch for config-write-mode=commit-and-push');
  }

  const originalRemote = (await mustExec('git', ['remote', 'get-url', 'origin'], mask)).stdout.trim();
  try {
    await execFile('git', ['config', '--unset-all', 'http.https://github.com/.extraheader']);
    await mustExec(
      'git',
      ['remote', 'set-url', 'origin', `https://x-access-token:${options.githubToken}@github.com/${options.repository}.git`],
      mask
    );
    await mustExec('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], mask);
  } finally {
    await execFile('git', ['remote', 'set-url', 'origin', originalRemote]);
  }

  return { commitSha, pushed: true };
}
