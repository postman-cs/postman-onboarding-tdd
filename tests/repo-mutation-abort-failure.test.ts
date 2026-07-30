import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitConfigWriteback, type CommandExecutor } from '../src/github/repo-mutation.js';

describe('commitConfigWriteback rebase abort failure', () => {
  let originalEnv: { headRef?: string; refName?: string; ref?: string };

  beforeEach(() => {
    originalEnv = {
      headRef: process.env.GITHUB_HEAD_REF,
      refName: process.env.GITHUB_REF_NAME,
      ref: process.env.GITHUB_REF
    };
    process.env.GITHUB_HEAD_REF = '';
    process.env.GITHUB_REF_NAME = 'main';
    process.env.GITHUB_REF = 'refs/heads/main';
  });

  afterEach(() => {
    if (originalEnv.headRef === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = originalEnv.headRef;
    if (originalEnv.refName === undefined) delete process.env.GITHUB_REF_NAME;
    else process.env.GITHUB_REF_NAME = originalEnv.refName;
    if (originalEnv.ref === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = originalEnv.ref;
  });

  it('masks both rebase and abort failures after a non-fast-forward push', async () => {
    const calls: string[][] = [];
    const originalRemote = 'https://github.com/acme/example.git';
    const executeCommand: CommandExecutor = async (command, args) => {
      expect(command).toBe('git');
      calls.push(args);
      const signature = args.join('\0');
      if (signature === ['diff', '--cached', '--quiet'].join('\0')) {
        return { exitCode: 1, stderr: '', stdout: '' };
      }
      if (signature === ['rev-parse', 'HEAD'].join('\0')) {
        return { exitCode: 0, stderr: '', stdout: 'writeback-sha\n' };
      }
      if (signature === ['remote', 'get-url', 'origin'].join('\0')) {
        return { exitCode: 0, stderr: '', stdout: `${originalRemote}\n` };
      }
      if (signature === ['push', 'origin', 'HEAD:refs/heads/main'].join('\0')) {
        return { exitCode: 1, stderr: 'rejected non-fast-forward', stdout: '' };
      }
      if (signature === ['rebase', '-X', 'theirs', 'FETCH_HEAD'].join('\0')) {
        return { exitCode: 1, stderr: 'rebase failed: test-token', stdout: '' };
      }
      if (signature === ['rebase', '--abort'].join('\0')) {
        return { exitCode: 1, stderr: 'abort failed: test-token', stdout: '' };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    };

    let error: Error | undefined;
    try {
      await commitConfigWriteback({
        committerEmail: 'bot@example.com',
        committerName: 'Bot',
        configPath: 'postman-tdd.yaml',
        githubToken: 'test-token',
        mode: 'commit-and-push',
        pushRemoteUrl: 'https://example.invalid/acme/example.git',
        repository: 'acme/example',
        executeCommand
      });
    } catch (caught: unknown) {
      error = caught as Error;
    }

    expect(calls).toContainEqual(['fetch', '--no-tags', 'origin', 'refs/heads/main']);
    expect(calls.filter((args) => args.join('\0') === ['rebase', '--abort'].join('\0'))).toHaveLength(1);
    expect(calls).toContainEqual(['remote', 'set-url', 'origin', originalRemote]);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('Could not rebase config writeback onto main: rebase failed: ***');
    expect(error?.message).toContain('could not abort rebase: abort failed: ***');
    expect(error?.message).not.toContain('test-token');
  });
});
