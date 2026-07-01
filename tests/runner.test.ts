import { describe, expect, it } from 'vitest';

import { createCustomerCommandEnv, runCommand } from '../src/runner.js';

describe('customer command environment', () => {
  const mask = (value: string) => value;

  it('strips action inputs and secret-like variables', () => {
    const env = createCustomerCommandEnv({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token',
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
      "const forbidden = ['INPUT_POSTMAN-API-KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'POSTMAN_ACCESS_TOKEN'];",
      'const leaked = forbidden.filter((name) => process.env[name]);',
      "if (leaked.length > 0) { console.error('leaked:' + leaked.join(',')); process.exit(2); }",
      "process.stdout.write(process.env.SAFE_VALUE || 'missing');"
    ].join(' ');

    const result = await runCommand(`node -e ${JSON.stringify(script)}`, {
      env: {
        GITHUB_TOKEN: 'github-token',
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
