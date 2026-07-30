import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitConfigWriteback } from '../src/github/repo-mutation.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

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
});
