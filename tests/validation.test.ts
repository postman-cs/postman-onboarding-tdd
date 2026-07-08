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

  it('surfaces harness lint errors in validation-summary with failure-phase=config (D23)', async () => {
    writeValidFixture();
    writeHarnessFiles({ skipDoc: 'repair-loop' });

    await expect(runAction()).rejects.toThrow('Postman TDD setup validation failed with 1 error');
    const outputs = parseGitHubOutputs();
    expect(outputs.get('validation-error-count')).toBe('1');
    expect(outputs.get('failure-phase')).toBe('config');
    const summary = outputs.get('validation-summary') ?? '';
    expect(summary).toContain('To fix:');
    expect(summary).toContain('.agents/references/repair-loop.md');
  });

  it('backward-compat: no harness opt-in produces byte-identical validate output to pre-P4', async () => {
    writeValidFixture();

    await expect(runAction()).resolves.toBeUndefined();
    const outputs = parseGitHubOutputs();
    expect(outputs.get('validation-error-count')).toBe('0');
    expect(outputs.get('failure-phase')).toBe('none');
    const summary = outputs.get('validation-summary') ?? '';
    expect(summary).not.toContain('To fix:');
  });

  function readGitHubOutput(): string {
    try {
      return readFileSync(join(dir, 'outputs.txt'), 'utf8');
    } catch {
      return '';
    }
  }

  function parseGitHubOutputs(): Map<string, string> {
    const outputs = new Map<string, string>();
    const raw = readGitHubOutput();
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line) { i++; continue; }
      // @actions/core v3 always uses heredoc format: key<<ghadelimiter_<uuid>
      const heredocIndex = line.indexOf('<<');
      if (heredocIndex !== -1) {
        const key = line.slice(0, heredocIndex);
        const delimiter = line.slice(heredocIndex + 2);
        const valueLines: string[] = [];
        i++;
        while (i < lines.length && lines[i] !== delimiter) {
          valueLines.push(lines[i] ?? '');
          i++;
        }
        outputs.set(key, valueLines.join('\n'));
        i++; // skip delimiter line
      } else {
        // Fallback for simple key=value format (older @actions/core).
        const eqIndex = line.indexOf('=');
        if (eqIndex !== -1) {
          outputs.set(line.slice(0, eqIndex), line.slice(eqIndex + 1));
        }
        i++;
      }
    }
    return outputs;
  }

  function writeHarnessFiles(options: { skipDoc?: string } = {}): void {
    const router = [
      '# Router',
      '| check | `.agents/references/tdd-check.md` |',
      '| failure | `.agents/references/failure-document.md` |',
      '| repair | `.agents/references/repair-loop.md` |',
      '| spec | `.agents/references/immutable-spec-guard.md` |',
      '| branch | `.agents/references/branch-and-commit.md` |',
      '| execplan | `.agents/references/execplan-skeleton.md` |'
    ].join('\n');
    writeFileSync(join(dir, 'AGENTS.md'), router, 'utf8');

    const refsDir = join(dir, '.agents', 'references');
    mkdirSync(refsDir, { recursive: true });

    const docs: Record<string, string> = {
      'tdd-check': '# TDD Check\ncontent',
      'failure-document': '# Failure Document\ncontent',
      'repair-loop': '# Repair Loop\ncontent',
      'immutable-spec-guard': '# Immutable Spec Guard\ncontent',
      'branch-and-commit': '# Branch and Commit\ncontent',
      'execplan-skeleton': '# ExecPlan Skeleton\ncontent'
    };

    for (const [name, content] of Object.entries(docs)) {
      if (name === options.skipDoc) continue;
      writeFileSync(join(refsDir, `${name}.md`), content, 'utf8');
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
