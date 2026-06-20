import { spawn, type ChildProcess } from 'node:child_process';

import { sanitizeLogExcerpt, type SecretMasker } from './secrets.js';

export interface RunningProcess {
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
  logs(): string;
  process: ChildProcess;
}

export interface CommandResult {
  exitCode: number;
  logExcerpt: string;
  stderr: string;
  stdout: string;
}

class RingLog {
  private value = '';

  constructor(private readonly maxLength = 12000) {}

  append(chunk: unknown): void {
    this.value += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (this.value.length > this.maxLength) {
      this.value = this.value.slice(this.value.length - this.maxLength);
    }
  }

  text(): string {
    return this.value;
  }
}

export function startBackgroundCommand(
  command: string,
  options: { env?: NodeJS.ProcessEnv; mask: SecretMasker }
): RunningProcess {
  const logs = new RingLog();
  const child = spawn(command, {
    detached: process.platform !== 'win32',
    env: { ...process.env, ...(options.env || {}) },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout?.on('data', (chunk) => logs.append(chunk));
  child.stderr?.on('data', (chunk) => logs.append(chunk));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    exit,
    kill() {
      if (child.exitCode !== null) return;
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Best-effort cleanup.
      }
    },
    logs: () => sanitizeLogExcerpt(logs.text(), options.mask),
    process: child
  };
}

export function runCommand(
  command: string,
  options: { env?: NodeJS.ProcessEnv; mask: SecretMasker }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      env: { ...process.env, ...(options.env || {}) },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      resolve({
        exitCode: code || 0,
        logExcerpt: sanitizeLogExcerpt(`${out}\n${err}`, options.mask),
        stdout: options.mask(out),
        stderr: options.mask(err)
      });
    });
  });
}

export async function ensurePostmanCli(
  apiKey: string,
  options: {
    cliInstallUrl: string;
    mask: SecretMasker;
    postmanRegion: 'us' | 'eu';
  }
): Promise<void> {
  const which = await runCommand('command -v postman', { mask: options.mask });
  if (which.exitCode !== 0) {
    const install = await runCommand('curl -fsSL "$POSTMAN_CLI_INSTALL_URL" | sh', {
      env: { POSTMAN_CLI_INSTALL_URL: options.cliInstallUrl },
      mask: options.mask
    });
    if (install.exitCode !== 0) {
      throw new Error(`Failed to install Postman CLI: ${install.logExcerpt}`);
    }
  }

  const regionArg = options.postmanRegion === 'eu' ? ' --region eu' : '';
  const login = await runCommand(`postman login --with-api-key "$POSTMAN_API_KEY"${regionArg}`, {
    env: { POSTMAN_API_KEY: apiKey },
    mask: options.mask
  });
  if (login.exitCode !== 0) {
    throw new Error(`Postman CLI login failed: ${login.logExcerpt}`);
  }
}

export async function waitForHealth(
  healthUrl: string,
  running: RunningProcess,
  timeoutSeconds: number,
  mask: SecretMasker
): Promise<{ ok: true } | { ok: false; phase: 'service_startup' | 'health_check'; message: string; logExcerpt: string }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = '';

  while (Date.now() < deadline) {
    const earlyExit = await Promise.race([
      running.exit.then((result) => result),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000))
    ]);
    if (earlyExit) {
      return {
        ok: false,
        phase: 'service_startup',
        message: `The service start command exited before the health check passed (code=${earlyExit.code ?? 'null'}, signal=${earlyExit.signal ?? 'none'}).`,
        logExcerpt: running.logs()
      };
    }

    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return { ok: true };
      }
      lastError = `HTTP ${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    phase: 'health_check',
    message: `The service did not become healthy at ${healthUrl} within ${timeoutSeconds} seconds. Last error: ${mask(lastError)}`,
    logExcerpt: running.logs()
  };
}

export async function runTddCollection(
  collectionId: string,
  baseUrl: string,
  mask: SecretMasker
): Promise<CommandResult> {
  return runCommand(
    'postman collection run "$POSTMAN_TDD_COLLECTION_ID" --env-var "baseUrl=$POSTMAN_TDD_BASE_URL"',
    {
      env: {
        POSTMAN_TDD_BASE_URL: baseUrl,
        POSTMAN_TDD_COLLECTION_ID: collectionId
      },
      mask
    }
  );
}
