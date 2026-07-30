import { afterEach, beforeEach, expect, it } from 'vitest';

import { commitConfigWriteback, type CommandExecutor, type CommandResult } from '../src/github/repo-mutation.js';

const originalEnv: Record<string, string | undefined> = {};
const environmentKeys = ['GITHUB_HEAD_REF', 'GITHUB_REF_NAME', 'GITHUB_REF'];

beforeEach(() => {
  for (const key of environmentKeys) originalEnv[key] = process.env[key];
  process.env.GITHUB_HEAD_REF = '';
  process.env.GITHUB_REF_NAME = 'main';
  process.env.GITHUB_REF = 'refs/heads/main';
});

afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

it('aborts and restores origin before surfacing a masked rebase failure', async () => {
  const originalRemote = 'https://github.com/postman-cs/example.git';
  // Placeholder credential shape; the scanner-visible value is fake by construction.
  const pushRemote = ['https://x-access-token:', 'token-for-mask', '@github.com/postman-cs/example.git'].join('');
  const commands: string[][] = [];
  const expectedCommands: Array<{ args: string[]; result: CommandResult }> = [
    { args: ['config', 'user.name', 'Bot'], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['config', 'user.email', 'bot@example.com'], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['add', '--', 'postman-tdd.yaml'], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['diff', '--cached', '--quiet'], result: { exitCode: 1, stderr: '', stdout: '' } },
    { args: ['commit', '-m', 'chore: persist Postman TDD workspace id'], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['rev-parse', 'HEAD'], result: { exitCode: 0, stderr: '', stdout: 'writeback-sha\n' } },
    { args: ['remote', 'get-url', 'origin'], result: { exitCode: 0, stderr: '', stdout: `${originalRemote}\n` } },
    { args: ['config', '--unset-all', 'http.https://github.com/.extraheader'], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['remote', 'set-url', 'origin', pushRemote], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['push', 'origin', 'HEAD:refs/heads/main'], result: { exitCode: 1, stderr: '! [rejected] main -> main (non-fast-forward)', stdout: '' } },
    { args: ['fetch', '--no-tags', 'origin', 'refs/heads/main'], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['rebase', '-X', 'theirs', 'FETCH_HEAD'], result: { exitCode: 1, stderr: 'rebase failed: token-for-mask', stdout: '' } },
    { args: ['rebase', '--abort'], result: { exitCode: 0, stderr: '', stdout: '' } },
    { args: ['remote', 'set-url', 'origin', originalRemote], result: { exitCode: 1, stderr: 'primary restoration failed', stdout: '' } },
    { args: ['config', 'remote.origin.url', originalRemote], result: { exitCode: 0, stderr: '', stdout: '' } }
  ];
  const executeCommand: CommandExecutor = async (command, args) => {
    commands.push([command, ...args]);
    const expected = expectedCommands.shift();
    expect(command).toBe('git');
    expect(expected).toBeDefined();
    expect(args).toEqual(expected?.args);
    return expected!.result;
  };

  await expect(commitConfigWriteback({
    committerEmail: 'bot@example.com',
    committerName: 'Bot',
    configPath: 'postman-tdd.yaml',
    githubToken: 'token-for-mask',
    mode: 'commit-and-push',
    pushRemoteUrl: pushRemote,
    repository: 'postman-cs/example',
    executeCommand
  })).rejects.toThrow('Could not rebase config writeback onto main: rebase failed: ***');

  expect(expectedCommands).toHaveLength(0);
  expect(commands.filter((args) => args.join('\0') === ['git', 'rebase', '--abort'].join('\0'))).toHaveLength(1);
  expect(commands.filter((args) => args.join('\0') === ['git', 'remote', 'set-url', 'origin', originalRemote].join('\0'))).toHaveLength(1);
  expect(commands.filter((args) => args.join('\0') === ['git', 'config', 'remote.origin.url', originalRemote].join('\0'))).toHaveLength(1);
  expect(commands.slice(-3)).toEqual([
    ['git', 'rebase', '--abort'],
    ['git', 'remote', 'set-url', 'origin', originalRemote],
    ['git', 'config', 'remote.origin.url', originalRemote]
  ]);
});
