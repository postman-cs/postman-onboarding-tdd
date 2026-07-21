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

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  mask: SecretMasker;
  sanitizeEnv?: boolean;
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
  options: CommandOptions
): RunningProcess {
  const logs = new RingLog();
  const child = spawn(command, {
    detached: process.platform !== 'win32',
    env: resolveCommandEnv(options),
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
  options: CommandOptions
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      env: resolveCommandEnv(options),
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

export function createCustomerCommandEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const source of [baseEnv, extraEnv]) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined || isSensitiveEnvName(name)) continue;
      env[name] = value;
    }
  }
  return env;
}

function resolveCommandEnv(options: CommandOptions): NodeJS.ProcessEnv {
  if (options.sanitizeEnv) {
    return createCustomerCommandEnv(process.env, options.env || {});
  }
  return { ...process.env, ...(options.env || {}) };
}

function isSensitiveEnvName(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized.startsWith('INPUT_')
    || normalized.includes('TOKEN')
    || normalized.includes('SECRET')
    || normalized.includes('PASSWORD')
    || normalized.includes('API_KEY')
    || normalized.includes('API-KEY')
    || normalized.includes('ACCESS_KEY')
    || normalized.includes('ACCESS-KEY')
    || normalized.includes('PRIVATE_KEY')
    || normalized.includes('PRIVATE-KEY')
    || normalized === 'SSH_AUTH_SOCK'
    || normalized === 'GIT_ASKPASS'
    || normalized === 'SSH_ASKPASS';
}

export async function ensurePostmanCli(
  apiKey: string,
  options: {
    cliInstallUrl: string;
    commandRunner?: typeof runCommand;
    mask: SecretMasker;
    platform?: NodeJS.Platform;
    postmanRegion: 'us' | 'eu';
  }
): Promise<void> {
  const commandRunner = options.commandRunner ?? runCommand;
  const platform = options.platform ?? process.platform;
  const lookupCommand = platform === 'win32' ? 'where.exe postman' : 'command -v postman';
  const which = await commandRunner(lookupCommand, { mask: options.mask });
  if (which.exitCode !== 0) {
    const installCommand =
      platform === 'win32'
        ? 'powershell.exe -NoProfile -InputFormat None -ExecutionPolicy AllSigned -Command "[System.Net.ServicePointManager]::SecurityProtocol = 3072; iex ((New-Object System.Net.WebClient).DownloadString($env:POSTMAN_CLI_INSTALL_URL))"'
        : 'curl -fsSL "$POSTMAN_CLI_INSTALL_URL" | sh';
    const install = await commandRunner(installCommand, {
      env: { POSTMAN_CLI_INSTALL_URL: options.cliInstallUrl },
      mask: options.mask
    });
    if (install.exitCode !== 0) {
      throw new Error(`Failed to install Postman CLI: ${install.logExcerpt}`);
    }
    const installed = await commandRunner(lookupCommand, { mask: options.mask });
    if (installed.exitCode !== 0) {
      throw new Error(`Postman CLI installation completed but the postman command is unavailable: ${installed.logExcerpt}`);
    }
  }

  const regionArg = options.postmanRegion === 'eu' ? ' --region eu' : '';
  const apiKeyReference = platform === 'win32' ? '%POSTMAN_API_KEY%' : '$POSTMAN_API_KEY';
  const login = await commandRunner(`postman login --with-api-key "${apiKeyReference}"${regionArg}`, {
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
  mask: SecretMasker,
  options: {
    commandRunner?: typeof runCommand;
    platform?: NodeJS.Platform;
  } = {}
): Promise<CommandResult> {
  const commandRunner = options.commandRunner ?? runCommand;
  const platform = options.platform ?? process.platform;
  const collectionReference = platform === 'win32'
    ? '%POSTMAN_TDD_COLLECTION_ID%'
    : '$POSTMAN_TDD_COLLECTION_ID';
  const baseUrlReference = platform === 'win32'
    ? '%POSTMAN_TDD_BASE_URL%'
    : '$POSTMAN_TDD_BASE_URL';
  return commandRunner(
    `postman collection run "${collectionReference}" --env-var "baseUrl=${baseUrlReference}"`,
    {
      env: {
        POSTMAN_TDD_BASE_URL: baseUrl,
        POSTMAN_TDD_COLLECTION_ID: collectionId
      },
      mask
    }
  );
}
