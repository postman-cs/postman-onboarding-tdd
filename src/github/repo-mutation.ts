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
  /** Test seam: overrides the authenticated push remote URL (default builds the
   * x-access-token github.com URL from githubToken + repository). */
  pushRemoteUrl?: string;
  /** Test seam: overrides command execution while production uses spawn. */
  executeCommand?: CommandExecutor;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;

function execFile(command: string, args: string[]): Promise<CommandResult> {
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

async function mustExec(
  command: string,
  args: string[],
  mask: (value: string) => string,
  executeCommand: CommandExecutor
): Promise<CommandResult> {
  const result = await executeCommand(command, args);
  if (result.exitCode !== 0) {
    throw new Error(mask(result.stderr || result.stdout || `${command} ${args.join(' ')} failed`));
  }
  return result;
}

async function restoreOrigin(
  originalRemote: string,
  mask: (value: string) => string,
  executeCommand: CommandExecutor
): Promise<void> {
  const restore = await executeCommand('git', ['remote', 'set-url', 'origin', originalRemote]);
  if (restore.exitCode === 0) return;

  const fallback = await executeCommand('git', ['config', 'remote.origin.url', originalRemote]);
  if (fallback.exitCode === 0) return;

  throw new Error(mask(
    `Could not restore origin remote URL: ${restore.stderr || restore.stdout || 'remote set-url failed'}; ` +
    `fallback failed: ${fallback.stderr || fallback.stdout || 'git config failed'}`
  ));
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
  const executeCommand = options.executeCommand ?? execFile;
  await mustExec('git', ['config', 'user.name', options.committerName], mask, executeCommand);
  await mustExec('git', ['config', 'user.email', options.committerEmail], mask, executeCommand);
  await mustExec('git', ['add', '--', options.configPath], mask, executeCommand);
  const diff = await executeCommand('git', ['diff', '--cached', '--quiet']);
  if (diff.exitCode === 0) {
    return { commitSha: '', pushed: false };
  }

  await mustExec('git', ['commit', '-m', 'chore: persist Postman TDD workspace id'], mask, executeCommand);
  const commitSha = (await mustExec('git', ['rev-parse', 'HEAD'], mask, executeCommand)).stdout.trim();

  if (options.mode !== 'commit-and-push') {
    return { commitSha, pushed: false };
  }

  const branch = normalizeBranch(process.env.GITHUB_HEAD_REF) ||
    normalizeBranch(process.env.GITHUB_REF_NAME) ||
    normalizeBranch(process.env.GITHUB_REF);
  if (!branch) {
    throw new Error('Could not resolve current branch for config-write-mode=commit-and-push');
  }

  const originalRemote = (await mustExec('git', ['remote', 'get-url', 'origin'], mask, executeCommand)).stdout.trim();
  try {
    await executeCommand('git', ['config', '--unset-all', 'http.https://github.com/.extraheader']);
    await mustExec(
      'git',
      [
        'remote',
        'set-url',
        'origin',
        options.pushRemoteUrl ??
          `https://x-access-token:${options.githubToken}@github.com/${options.repository}.git`
      ],
      mask,
      executeCommand
    );
    // A concurrent push (or a checkout that was stale at job start) makes the
    // direct push non-fast-forward. Reconcile by rebasing the writeback commit
    // onto the advanced remote head and retrying once, mirroring the released
    // repo-sync reconcile semantics. The config writeback is authoritative for
    // its own path, so -X theirs keeps this commit's content on conflict.
    let pushed = false;
    let lastError = '';
    for (let pushAttempt = 0; pushAttempt < 2; pushAttempt += 1) {
      const push = await executeCommand('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      if (push.exitCode === 0) {
        pushed = true;
        break;
      }
      lastError = push.stderr || push.stdout || 'git push failed';
      const targetAdvanced = /non-fast-forward|fetch first|remote contains work/i.test(lastError);
      if (!targetAdvanced || pushAttempt === 1) {
        break;
      }
      await mustExec('git', ['fetch', '--no-tags', 'origin', `refs/heads/${branch}`], mask, executeCommand);
      const rebase = await executeCommand('git', ['rebase', '-X', 'theirs', 'FETCH_HEAD']);
      if (rebase.exitCode !== 0) {
        const abort = await executeCommand('git', ['rebase', '--abort']);
        if (abort.exitCode !== 0) {
          throw new Error(mask(
            `Could not rebase config writeback onto ${branch}: ${rebase.stderr || rebase.stdout || 'rebase failed'}; ` +
            `could not abort rebase: ${abort.stderr || abort.stdout || 'rebase --abort failed'}`
          ));
        }
        throw new Error(
          mask(`Could not rebase config writeback onto ${branch}: ${rebase.stderr || rebase.stdout || 'rebase failed'}`)
        );
      }
    }
    if (!pushed) {
      throw new Error(mask(lastError));
    }
  } finally {
    await restoreOrigin(originalRemote, mask, executeCommand);
  }

  const finalSha = (await mustExec('git', ['rev-parse', 'HEAD'], mask, executeCommand)).stdout.trim();
  return { commitSha: finalSha, pushed: true };
}
