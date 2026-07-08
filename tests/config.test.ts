import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadOnboardingConfig, patchWorkspaceId, validateRepairProvider } from '../src/config.js';

describe('onboarding config', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function writeConfig(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-config-'));
    const path = join(dir, 'onboarding.yml');
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('loads TDD config defaults and service/spec paths', () => {
    const path = writeConfig(`
version: 1
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Banner Health - API TDD Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./scripts/postman-tdd-start.sh
`);

    expect(loadOnboardingConfig({ configPath: path })).toMatchObject({
      projectName: 'reference-service',
      specPath: 'api/openapi.yaml',
      tddEnabled: true,
      workspace: {
        name: 'Banner Health - API TDD Preview'
      },
      runtime: {
        baseUrl: 'http://127.0.0.1:4010',
        healthUrl: 'http://127.0.0.1:4010/v1/health',
        startCommand: './scripts/postman-tdd-start.sh',
        timeoutSeconds: 90
      }
    });
  });

  it('loads the packaged onboarding sample', () => {
    expect(loadOnboardingConfig({ configPath: join(process.cwd(), '.postman-template', 'onboarding.yml') })).toMatchObject({
      projectName: 'reference-service',
      repair: {
        allowedReadPaths: ['src/**', 'test/**', 'package.json', 'package-lock.json'],
        allowedWritePaths: ['src/**'],
        enabled: false,
        localTestCommand: 'npm test',
        maxAttempts: 3,
        provider: 'openai-responses'
      },
      specPath: 'api/openapi.yaml',
      tddEnabled: true
    });
  });

  it('patches workspace id without removing unrelated config', () => {
    const path = writeConfig(`
version: 1
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
repoSync:
  generateCiWorkflow: false
`);

    expect(patchWorkspaceId(path, 'ws-123')).toEqual({ changed: true, configPath: path });
    const updated = readFileSync(path, 'utf8');
    expect(updated).toContain('id: ws-123');
    expect(updated).toContain('generateCiWorkflow: false');
  });

  it('validates required runtime fields when enabled', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
`);

    expect(() => loadOnboardingConfig({ configPath: path })).toThrow('tdd.baseUrl is required');
  });

  it('loads repair config and defaults allowedReadPaths to allowedWritePaths', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
    provider: openai-responses
    maxAttempts: 2
    allowedWritePaths:
      - src/**
    localTestCommand: npm test
`);

    expect(loadOnboardingConfig({ configPath: path })).toMatchObject({
      repair: {
        allowedReadPaths: ['src/**'],
        allowedWritePaths: ['src/**'],
        enabled: true,
        localTestCommand: 'npm test',
        maxAttempts: 2,
        provider: 'openai-responses'
      }
    });
  });

  it('accepts Anthropic Messages as a repair provider', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
    provider: anthropic-messages
    allowedWritePaths:
      - src/**
`);

    expect(loadOnboardingConfig({ configPath: path }).repair.provider).toBe('anthropic-messages');
  });

  it('uses explicit repair allowedReadPaths when provided', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
    allowedWritePaths:
      - src/**
    allowedReadPaths:
      - src/**
      - package.json
`);

    expect(loadOnboardingConfig({ configPath: path }).repair).toMatchObject({
      allowedReadPaths: ['src/**', 'package.json'],
      allowedWritePaths: ['src/**']
    });
  });

  it('requires repair allowedWritePaths when repair is enabled', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
`);

    expect(() => loadOnboardingConfig({ configPath: path })).toThrow('tdd.repair.allowedWritePaths is required');
  });

  it('validates known repair providers', () => {
    expect(validateRepairProvider('openai-responses')).toBe('openai-responses');
    expect(validateRepairProvider('anthropic-messages')).toBe('anthropic-messages');
    expect(validateRepairProvider('postman-agent-mode')).toBe('postman-agent-mode');
    expect(() => validateRepairProvider('other-provider')).toThrow(
      'Expected openai-responses, anthropic-messages, or postman-agent-mode'
    );
  });

  it('reads tdd.repair.escalationModel when configured', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
    provider: openai-responses
    escalationModel: gpt-5.5-pro
    allowedWritePaths:
      - src/**
`);

    expect(loadOnboardingConfig({ configPath: path }).repair.escalationModel).toBe('gpt-5.5-pro');
  });

  it('defaults escalationModel to undefined when not configured', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
    provider: openai-responses
    allowedWritePaths:
      - src/**
`);

    expect(loadOnboardingConfig({ configPath: path }).repair.escalationModel).toBeUndefined();
  });

  it('defaults harness.enabled to false when tdd.harness is absent', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
`);

    const config = loadOnboardingConfig({ configPath: path });
    expect(config.harness).toEqual({ enabled: false });
  });

  it('parses tdd.harness.enabled: true', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  harness:
    enabled: true
`);

    const config = loadOnboardingConfig({ configPath: path });
    expect(config.harness).toEqual({ enabled: true });
  });

  it('parses tdd.harness.enabled: "true" (string form)', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  harness:
    enabled: "true"
`);

    const config = loadOnboardingConfig({ configPath: path });
    expect(config.harness).toEqual({ enabled: true });
  });

  it('does not alter projectName/specPath/repair when tdd.harness is added', () => {
    const path = writeConfig(`
spec:
  path: api/openapi.yaml
service:
  name: reference-service
tdd:
  enabled: true
  workspace:
    name: Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./start.sh
  repair:
    enabled: true
    provider: openai-responses
    allowedWritePaths:
      - src/**
  harness:
    enabled: true
`);

    const config = loadOnboardingConfig({ configPath: path });
    expect(config).toMatchObject({
      projectName: 'reference-service',
      specPath: 'api/openapi.yaml',
      repair: {
        enabled: true,
        provider: 'openai-responses',
        allowedWritePaths: ['src/**']
      },
      harness: { enabled: true }
    });
  });
});
