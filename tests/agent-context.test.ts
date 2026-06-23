import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFailureDocument, writeAgentContext } from '../src/agent-context.js';

describe('agent context', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('writes the minimal agent handoff files', () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-agent-'));
    const document = createFailureDocument({
      baseUrl: 'http://127.0.0.1:4010',
      failures: [{ message: 'Expected $.status to be ok' }],
      message: 'collection failed',
      phase: 'collection_run',
      specPath: 'api/openapi.yaml'
    });

    const paths = writeAgentContext(document, dir);
    expect(readFileSync(paths.agentTaskPath, 'utf8')).toContain('Success Criteria');
    expect(JSON.parse(readFileSync(paths.failuresJsonPath, 'utf8'))).toMatchObject({
      immutablePaths: ['api/openapi.yaml'],
      phase: 'collection_run',
      status: 'failed'
    });
    expect(readFileSync(paths.agentTaskPath, 'utf8')).toContain('Do not change files listed in `immutablePaths`');
    expect(readFileSync(paths.agentTaskPath, 'utf8')).toContain('verify your diff does not include any path listed in `immutablePaths`');
  });
});
