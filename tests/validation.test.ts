import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAction } from '../src/index.js';

describe('validate mode', () => {
  const envKeys = [
    'INPUT_ANTHROPIC-API-KEY',
    'INPUT_CONFIG-WRITE-MODE',
    'GITHUB_OUTPUT',
    'GITHUB_WORKSPACE',
    'INPUT_GITHUB-TOKEN',
    'INPUT_MODE',
    'INPUT_ONBOARDING-CONFIG-PATH',
    'INPUT_OPENAI-API-KEY',
    'INPUT_POSTMAN-ACCESS-TOKEN',
    'INPUT_POSTMAN-API-KEY',
    'INPUT_REPAIR-MODEL',
    'INPUT_REPAIR-PROVIDER'
  ];
  const previousEnv = new Map<string, string | undefined>();
  let dir = '';
  let previousCwd = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-validate-'));
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    process.env.GITHUB_OUTPUT = join(dir, 'outputs.txt');
    writeFileSync(process.env.GITHUB_OUTPUT, '', 'utf8');
    process.env.INPUT_MODE = 'validate';
    process.env['INPUT_ONBOARDING-CONFIG-PATH'] = '.postman-template/onboarding.yml';
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const key of envKeys) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    previousEnv.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('passes a valid setup without requiring secrets', async () => {
    writeValidFixture();

    await expect(runAction()).resolves.toBeUndefined();
  });

  it('fails when the configured spec path is missing', async () => {
    writeValidFixture({ writeSpec: false });

    await expect(runAction()).rejects.toThrow('Postman TDD setup validation failed with 1 error');
  });

  it('fails when repair write paths include the immutable spec', async () => {
    writeValidFixture({
      repair: `
  repair:
    enabled: true
    provider: postman-agent-mode
    allowedWritePaths:
      - api/openapi.yaml
`
    });

    await expect(runAction()).rejects.toThrow('Postman TDD setup validation failed with 2 error');
  });

  it('produces no harness lint messages when no AGENTS.md and no tdd.harness (backward compat)', async () => {
    writeValidFixture();

    await expect(runAction()).resolves.toBeUndefined();
    const output = readGitHubOutput();
    expect(output).not.toContain('To fix:');
  });

  it('emits exactly one harness error when tdd.harness.enabled is true but AGENTS.md is missing', async () => {
    writeValidFixture({ harness: true });

    await expect(runAction()).rejects.toThrow('Postman TDD setup validation failed with 1 error');
    const output = readGitHubOutput();
    expect(output).toContain('To fix:');
    expect(output).toContain('AGENTS.md');
  });

  function readGitHubOutput(): string {
    try {
      return readFileSync(join(dir, 'outputs.txt'), 'utf8');
    } catch {
      return '';
    }
  }

  function writeValidFixture(options: {
    repair?: string;
    writeSpec?: boolean;
    harness?: boolean;
  } = {}): void {
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'postman-tdd-start.sh'), '#!/usr/bin/env bash\nnpm start\n', 'utf8');
    writeFileSync(join(dir, '.github', 'workflows', 'postman-tdd-preview.yml'), 'name: Postman TDD Preview\n', 'utf8');
    const harnessBlock = options.harness ? '  harness:\n    enabled: true\n' : '';
    writeFileSync(join(dir, '.postman-template', 'onboarding.yml'), `
version: 1
spec:
  path: api/openapi.yaml
service:
  name: validate-fixture
tdd:
  enabled: true
  workspace:
    name: Validate Fixture
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./scripts/postman-tdd-start.sh
  timeoutSeconds: 30
${harnessBlock}${options.repair || ''}
`, 'utf8');
    if (options.writeSpec !== false) {
      writeFileSync(join(dir, 'api', 'openapi.yaml'), `
openapi: 3.0.3
info:
  title: Validate Fixture
  version: 1.0.0
paths:
  /v1/health:
    get:
      responses:
        "200":
          description: ok
`, 'utf8');
    }
  }
});
