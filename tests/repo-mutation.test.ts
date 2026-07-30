import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitConfigWriteback, type CommandExecutor } from '../src/github/repo-mutation.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

const runGitCommand: CommandExecutor = async (command, args) => {
  try {
    const { stderr, stdout } = await execFileAsync(command, args);
    return { exitCode: 0, stderr, stdout };
  } catch (error: unknown) {
    const result = error as { code?: number; stderr?: string; stdout?: string };
    return {
      exitCode: typeof result.code === 'number' ? result.code : 1,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? ''
    };
  }
};

describe('commitConfigWriteback push reconciliation', () => {
  let workRoot: string;
  let remoteDir: string;
  let checkoutDir: string;
  let originalCwd: string;
  let originalEnv: { headRef?: string; refName?: string; ref?: string };

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalEnv = {
      headRef: process.env.GITHUB_HEAD_REF,
      refName: process.env.GITHUB_REF_NAME,
      ref: process.env.GITHUB_REF
    };
    workRoot = await mkdtemp(path.join(tmpdir(), 'tdd-repo-mutation-'));
    remoteDir = path.join(workRoot, 'remote.git');
    checkoutDir = path.join(workRoot, 'checkout');

    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
    await execFileAsync('git', ['clone', remoteDir, checkoutDir]);
    await git(checkoutDir, 'config', 'user.name', 'Seed');
    await git(checkoutDir, 'config', 'user.email', 'seed@example.com');
    await writeFile(path.join(checkoutDir, 'README.md'), 'seed\n');
    await git(checkoutDir, 'add', 'README.md');
    await git(checkoutDir, 'commit', '-m', 'seed');
    await git(checkoutDir, 'push', 'origin', 'HEAD:refs/heads/main');

    process.env.GITHUB_HEAD_REF = '';
    process.env.GITHUB_REF_NAME = 'main';
    process.env.GITHUB_REF = 'refs/heads/main';
    process.chdir(checkoutDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalEnv.headRef === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = originalEnv.headRef;
    if (originalEnv.refName === undefined) delete process.env.GITHUB_REF_NAME;
    else process.env.GITHUB_REF_NAME = originalEnv.refName;
    if (originalEnv.ref === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = originalEnv.ref;
    await rm(workRoot, { recursive: true, force: true });
  });

  async function advanceRemoteConcurrently(): Promise<void> {
    // Simulate a concurrent push landing on the remote after our checkout.
    const otherDir = path.join(workRoot, 'other');
    await execFileAsync('git', ['clone', remoteDir, otherDir]);
    await git(otherDir, 'config', 'user.name', 'Peer');
    await git(otherDir, 'config', 'user.email', 'peer@example.com');
    await writeFile(path.join(otherDir, 'peer.txt'), 'peer change\n');
    await git(otherDir, 'add', 'peer.txt');
    await git(otherDir, 'commit', '-m', 'peer: concurrent change');
    await git(otherDir, 'push', 'origin', 'HEAD:refs/heads/main');
  }

  it('pushes the writeback commit on the happy path', async () => {
    await writeFile(path.join(checkoutDir, 'postman-tdd.yaml'), 'workspaceId: ws-1\n');

    const result = await commitConfigWriteback({
      committerEmail: 'bot@example.com',
      committerName: 'Bot',
      configPath: 'postman-tdd.yaml',
      githubToken: 'test-token',
      mode: 'commit-and-push',
      // pushRemoteUrl points the set-url rewrite at the local bare remote so
      // the push is real while the token URL construction stays covered by the
      // default path's string shape.
      pushRemoteUrl: remoteDir,
      repository: 'postman-cs/does-not-matter'
    });

    expect(result.pushed).toBe(true);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const remoteHead = await git(remoteDir, 'rev-parse', 'refs/heads/main');
    expect(remoteHead).toBe(result.commitSha);
  }, 30000);

  it('reconciles a non-fast-forward push by rebasing onto the advanced remote and retrying', async () => {
    await writeFile(path.join(checkoutDir, 'postman-tdd.yaml'), 'workspaceId: ws-2\n');
    await advanceRemoteConcurrently();

    const result = await commitConfigWriteback({
      committerEmail: 'bot@example.com',
      committerName: 'Bot',
      configPath: 'postman-tdd.yaml',
      githubToken: 'test-token',
      mode: 'commit-and-push',
      pushRemoteUrl: remoteDir,
      repository: 'postman-cs/does-not-matter'
    });

    expect(result.pushed).toBe(true);
    // The pushed head contains both the peer commit and the writeback commit.
    const remoteHead = await git(remoteDir, 'rev-parse', 'refs/heads/main');
    expect(remoteHead).toBe(result.commitSha);
    const log = await git(remoteDir, 'log', '--format=%s', 'refs/heads/main');
    expect(log).toContain('peer: concurrent change');
    expect(log).toContain('chore: persist Postman TDD workspace id');
  }, 30000);

  it('keeps the writeback config when concurrent history changes the same file', async () => {
    await writeFile(path.join(checkoutDir, 'postman-tdd.yaml'), 'workspaceId: ws-base\n');
    await git(checkoutDir, 'add', 'postman-tdd.yaml');
    await git(checkoutDir, 'commit', '-m', 'seed config');
    await git(checkoutDir, 'push', 'origin', 'HEAD:refs/heads/main');

    const peerDir = path.join(workRoot, 'peer-config');
    await execFileAsync('git', ['clone', remoteDir, peerDir]);
    await git(peerDir, 'config', 'user.name', 'Peer');
    await git(peerDir, 'config', 'user.email', 'peer@example.com');
    await writeFile(path.join(peerDir, 'postman-tdd.yaml'), 'workspaceId: ws-peer\n');
    await git(peerDir, 'add', 'postman-tdd.yaml');
    await git(peerDir, 'commit', '-m', 'peer: config change');
    await git(peerDir, 'push', 'origin', 'HEAD:refs/heads/main');

    await writeFile(path.join(checkoutDir, 'postman-tdd.yaml'), 'workspaceId: ws-writeback\n');
    const originalRemote = await git(checkoutDir, 'remote', 'get-url', 'origin');
    const result = await commitConfigWriteback({
      committerEmail: 'bot@example.com',
      committerName: 'Bot',
      configPath: 'postman-tdd.yaml',
      githubToken: 'test-token',
      mode: 'commit-and-push',
      pushRemoteUrl: remoteDir,
      repository: 'postman-cs/does-not-matter'
    });

    const remoteHead = await git(remoteDir, 'rev-parse', 'refs/heads/main');
    expect(await git(remoteDir, 'show', 'refs/heads/main:postman-tdd.yaml')).toBe('workspaceId: ws-writeback');
    expect(await git(remoteDir, 'log', '--format=%s', 'refs/heads/main')).toContain('peer: config change');
    expect(await git(remoteDir, 'log', '--format=%s', 'refs/heads/main')).toContain('chore: persist Postman TDD workspace id');
    expect(remoteHead).toBe(result.commitSha);
    expect(await git(checkoutDir, 'remote', 'get-url', 'origin')).toBe(originalRemote);
  }, 30000);

  it('restores the original origin URL after pushing', async () => {
    await writeFile(path.join(checkoutDir, 'postman-tdd.yaml'), 'workspaceId: ws-3\n');
    const before = await git(checkoutDir, 'remote', 'get-url', 'origin');

    await commitConfigWriteback({
      committerEmail: 'bot@example.com',
      committerName: 'Bot',
      configPath: 'postman-tdd.yaml',
      githubToken: 'test-token',
      mode: 'commit-and-push',
      pushRemoteUrl: remoteDir,
      repository: 'postman-cs/does-not-matter'
    });

    const after = await git(checkoutDir, 'remote', 'get-url', 'origin');
    expect(after).toBe(before);
  }, 30000);

  it('uses the bounded config fallback when origin restoration initially fails', async () => {
    await writeFile(path.join(checkoutDir, 'postman-tdd.yaml'), 'workspaceId: ws-4\n');
    const originalRemote = await git(checkoutDir, 'remote', 'get-url', 'origin');
    let restoreAttempts = 0;
    let originSetUrlCalls = 0;
    const executeCommand: CommandExecutor = async (command, args) => {
      if (args.join('\0') === ['remote', 'set-url', 'origin', originalRemote].join('\0')) {
        originSetUrlCalls += 1;
        if (originSetUrlCalls === 2) {
          restoreAttempts += 1;
          return { exitCode: 1, stderr: 'restore command failed: test-token', stdout: '' };
        }
      }
      return runGitCommand(command, args);
    };

    await expect(commitConfigWriteback({
      committerEmail: 'bot@example.com',
      committerName: 'Bot',
      configPath: 'postman-tdd.yaml',
      githubToken: 'test-token',
      mode: 'commit-and-push',
      pushRemoteUrl: remoteDir,
      repository: 'postman-cs/does-not-matter',
      executeCommand
    })).resolves.toMatchObject({ pushed: true });

    expect(restoreAttempts).toBe(1);
    expect(await git(checkoutDir, 'remote', 'get-url', 'origin')).toBe(originalRemote);
  }, 30000);

  it('rejects a failed origin restoration without exposing the token', async () => {
    await writeFile(path.join(checkoutDir, 'postman-tdd.yaml'), 'workspaceId: ws-5\n');
    const originalRemote = await git(checkoutDir, 'remote', 'get-url', 'origin');
    let originSetUrlCalls = 0;
    const executeCommand: CommandExecutor = async (command, args) => {
      if (args.join('\0') === ['remote', 'set-url', 'origin', originalRemote].join('\0')) {
        originSetUrlCalls += 1;
        if (originSetUrlCalls === 2) {
          return { exitCode: 1, stderr: 'restore command failed: test-token', stdout: '' };
        }
      }
      if (args.join('\0') === ['config', 'remote.origin.url', originalRemote].join('\0')) {
        return { exitCode: 1, stderr: 'restore command failed: test-token', stdout: '' };
      }
      return runGitCommand(command, args);
    };

    await expect(commitConfigWriteback({
      committerEmail: 'bot@example.com',
      committerName: 'Bot',
      configPath: 'postman-tdd.yaml',
      githubToken: 'test-token',
      mode: 'commit-and-push',
      pushRemoteUrl: remoteDir,
      repository: 'postman-cs/does-not-matter',
      executeCommand
    })).rejects.toThrow(/Could not restore origin remote URL.*\*\*\*/);
  }, 30000);
});
