import { describe, expect, it, vi } from 'vitest';

import { createCustomerCommandEnv, ensurePostmanCli, runCommand, runTddCollection } from '../src/runner.js';

describe('customer command environment', () => {
  const mask = (value: string) => value;

  it('strips action inputs and secret-like variables', () => {
    const env = createCustomerCommandEnv({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token',
      ANTHROPIC_API_KEY: 'anthropic-key',
      AWS_ACCESS_KEY_ID: 'aws-access-key',
      DATABASE_PASSWORD: 'database-password',
      GH_TOKEN: 'gh-token',
      GITHUB_TOKEN: 'github-token',
      HOME: '/tmp/home',
      'INPUT_POSTMAN-API-KEY': 'postman-input',
      'input_openai-api-key': 'openai-input',
      NODE_AUTH_TOKEN: 'node-auth-token',
      OPENAI_API_KEY: 'openai-key',
      PATH: '/usr/bin',
      POSTMAN_ACCESS_TOKEN: 'postman-access-token',
      SAFE_FEATURE_FLAG: 'true',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock'
    }, {
      SAFE_FEATURE_FLAG: 'false',
      SAFE_OVERRIDE: 'allowed'
    });

    expect(env).toEqual({
      HOME: '/tmp/home',
      PATH: '/usr/bin',
      SAFE_FEATURE_FLAG: 'false',
      SAFE_OVERRIDE: 'allowed'
    });
  });

  it('runs commands with a sanitized environment when requested', async () => {
    const script = [
      "const forbidden = ['INPUT_POSTMAN-API-KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'POSTMAN_ACCESS_TOKEN'];",
      'const leaked = forbidden.filter((name) => process.env[name]);',
      "if (leaked.length > 0) { console.error('leaked:' + leaked.join(',')); process.exit(2); }",
      "process.stdout.write(process.env.SAFE_VALUE || 'missing');"
    ].join(' ');

    const result = await runCommand(`node -e ${JSON.stringify(script)}`, {
      env: {
        GITHUB_TOKEN: 'github-token',
        ANTHROPIC_API_KEY: 'anthropic-key',
        'INPUT_POSTMAN-API-KEY': 'postman-input',
        OPENAI_API_KEY: 'openai-key',
        POSTMAN_ACCESS_TOKEN: 'postman-access-token',
        SAFE_VALUE: 'visible'
      },
      mask,
      sanitizeEnv: true
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('visible');
  });
});

describe('Postman CLI installation', () => {
  const mask = (value: string) => value;

  it('uses the official Windows installer and verifies the command before login', async () => {
    const commandRunner = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, logExcerpt: '', stderr: '', stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, logExcerpt: '', stderr: '', stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, logExcerpt: '', stderr: '', stdout: 'postman.exe' })
      .mockResolvedValueOnce({ exitCode: 0, logExcerpt: '', stderr: '', stdout: '' });

    await ensurePostmanCli('PMAK-test', {
      cliInstallUrl: 'https://dl-cli.pstmn.io/install/win64.ps1',
      commandRunner,
      mask,
      platform: 'win32',
      postmanRegion: 'us'
    });

    expect(commandRunner).toHaveBeenNthCalledWith(
      1,
      'where.exe postman',
      expect.objectContaining({ mask })
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('pwsh.exe -NoProfile -InputFormat None -ExecutionPolicy AllSigned'),
      expect.objectContaining({
        env: { POSTMAN_CLI_INSTALL_URL: 'https://dl-cli.pstmn.io/install/win64.ps1' },
        mask
      })
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      3,
      'where.exe postman',
      expect.objectContaining({ mask })
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      4,
      'postman login --with-api-key "%POSTMAN_API_KEY%"',
      expect.objectContaining({ env: { POSTMAN_API_KEY: 'PMAK-test' }, mask })
    );
  });

  it('uses cmd.exe environment expansion for Windows collection runs', async () => {
    const commandRunner = vi.fn().mockResolvedValue({
      exitCode: 0,
      logExcerpt: '',
      stderr: '',
      stdout: ''
    });

    await runTddCollection('collection-1', 'http://localhost:4010', mask, {
      commandRunner,
      platform: 'win32'
    });

    expect(commandRunner).toHaveBeenCalledWith(
      'postman collection run "%POSTMAN_TDD_COLLECTION_ID%" --env-var "baseUrl=%POSTMAN_TDD_BASE_URL%"',
      expect.objectContaining({
        env: {
          POSTMAN_TDD_BASE_URL: 'http://localhost:4010',
          POSTMAN_TDD_COLLECTION_ID: 'collection-1'
        },
        mask
      })
    );
  });
});
