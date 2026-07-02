import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildContractHints } from '../src/contract-hints.js';

describe('contract hints', () => {
  let dir = '';
  let previousWorkspace: string | undefined;

  afterEach(() => {
    if (previousWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = previousWorkspace;
    }
    previousWorkspace = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('includes compact response schema enums for failed operations', () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-hints-'));
    previousWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = dir;
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'api', 'openapi.yaml'), [
      'openapi: 3.0.3',
      'info:',
      '  title: Test',
      '  version: 1.0.0',
      'paths:',
      '  /v1/health:',
      '    get:',
      '      operationId: getHealth',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      '                required: [status, checks]',
      '                properties:',
      '                  status:',
      '                    type: string',
      '                    enum: [ok, degraded]',
      '                  checks:',
      '                    type: object',
      '                    required: [database, postman]',
      '                    properties:',
      '                      database:',
      '                        type: string',
      '                        enum: [pass, warn, fail]',
      '                      postman:',
      '                        type: string',
      '                        enum: [pass, warn, fail]',
      ''
    ].join('\n'), 'utf8');

    const hints = buildContractHints('api/openapi.yaml', [{
      assertion: 'response body matches schema',
      message: '$.checks.database expected enum value ["pass","warn","fail"]',
      method: 'GET',
      operationId: 'getHealth',
      path: '/v1/health'
    }]);

    expect(hints).toHaveLength(1);
    expect(JSON.stringify(hints[0])).toContain('"enum":["pass","warn","fail"]');
    expect(hints[0]).toMatchObject({
      method: 'GET',
      operationId: 'getHealth',
      path: '/v1/health'
    });
  });
});
