import { execFileSync } from 'node:child_process';

// Hermetic git environment: ignore the host machine's global and system git
// config (core.hooksPath pre-commit hooks, commit signing, etc.) so tests that
// create and commit into temp repos pass on any dev machine, not only on bare
// CI runners.
export const hermeticGitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null'
};

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: hermeticGitEnv });
}

export function initGitRepo(cwd: string): void {
  git(cwd, ['init']);
  git(cwd, ['config', 'user.name', 'Test']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'initial']);
}
