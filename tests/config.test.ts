import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadOnboardingConfig, patchWorkspaceId } from '../src/config.js';

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
});
