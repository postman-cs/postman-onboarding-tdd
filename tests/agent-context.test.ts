import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createFailureDocument,
  findImmutablePathChanges,
  hashImmutablePaths,
  IMMUTABLE_SPEC_GUARD_MESSAGE,
  writeAgentContext
} from '../src/agent-context.js';
import { parseFailureDocument, renderStickyComment } from '../src/github/pr-comment.js';
import type { LedgerSummary } from '../src/types.js';

describe('agent context', () => {
  let dir = '';

  afterEach(() => {
    delete process.env.GITHUB_WORKSPACE;
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
      immutablePathHashes: [],
      immutablePaths: ['api/openapi.yaml'],
      phase: 'collection_run',
      status: 'failed'
    });
    expect(readFileSync(paths.agentTaskPath, 'utf8')).toContain('Do not change files listed in `immutablePaths`');
    expect(readFileSync(paths.agentTaskPath, 'utf8')).toContain('verify your diff does not include any path listed in `immutablePaths`');
    expect(readFileSync(paths.agentTaskPath, 'utf8')).toContain('node .postman-tdd/immutable-spec-guard.mjs snapshot');
    expect(readFileSync(paths.immutableSpecGuardPath, 'utf8')).toContain(IMMUTABLE_SPEC_GUARD_MESSAGE);
  });

  it('fails immutable spec verification when the spec changes after snapshot', () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-agent-'));
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'api/openapi.yaml'), 'openapi: 3.1.0\n', 'utf8');

    const document = createFailureDocument({
      failures: [{ message: 'Expected $.status to be ok' }],
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'unused-after-snapshot' }],
      message: 'collection failed',
      phase: 'collection_run',
      specPath: 'api/openapi.yaml'
    });
    const paths = writeAgentContext(document, join(dir, '.postman-tdd'));

    execFileSync(process.execPath, [paths.immutableSpecGuardPath, 'snapshot'], { cwd: dir });
    execFileSync(process.execPath, [paths.immutableSpecGuardPath, 'verify'], { cwd: dir });

    writeFileSync(join(dir, 'api/openapi.yaml'), 'openapi: 3.1.0\ninfo: {}\n', 'utf8');

    expect(() => {
      execFileSync(process.execPath, [paths.immutableSpecGuardPath, 'verify'], {
        cwd: dir,
        stdio: 'pipe'
      });
    }).toThrowError(IMMUTABLE_SPEC_GUARD_MESSAGE);
  });

  it('detects immutable path hash changes for workflow-level enforcement', () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-agent-'));
    process.env.GITHUB_WORKSPACE = dir;
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'api/openapi.yaml'), 'openapi: 3.1.0\n', 'utf8');

    const baseline = hashImmutablePaths(['api/openapi.yaml']);
    expect(findImmutablePathChanges(baseline)).toEqual([]);

    writeFileSync(join(dir, 'api/openapi.yaml'), 'openapi: 3.1.0\ninfo: {}\n', 'utf8');

    expect(findImmutablePathChanges(baseline)).toMatchObject([{
      expectedSha256: baseline[0]?.sha256,
      path: 'api/openapi.yaml'
    }]);
  });

  it('createFailureDocument emits schemaVersion 2 and forwards ledger', () => {
    const ledger: LedgerSummary = {
      failing: 1,
      packets: [{ key: 'op1', lastFailureFingerprint: 'abc', passes: false, title: 'op1' }],
      passing: 0,
      total: 1
    };
    const document = createFailureDocument({
      failures: [{ message: 'fail' }],
      ledger,
      message: 'failed',
      phase: 'collection_run',
      specPath: 'api/openapi.yaml'
    });
    expect(document.schemaVersion).toBe(2);
    expect(document.ledger).toEqual(ledger);
    expect(document.status).toBe('failed');
  });

  it('round-trips a v2 document with ledger through parseFailureDocument', () => {
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc',
        failures: [{ message: 'fail' }],
        immutablePathHashes: [],
        immutablePaths: [],
        ledger: {
          failing: 1,
          packets: [{ key: 'op1', passes: false, title: 'op1' }],
          passing: 0,
          total: 1
        },
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 2,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });
    const parsed = parseFailureDocument(body);
    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.ledger).toBeDefined();
    expect(parsed?.ledger?.total).toBe(1);
  });

  it('still parses a v1 document without ledger', () => {
    const body = renderStickyComment({
      prNumber: 123,
      schemaVersion: 1
    }, {
      failureDocument: {
        commit: 'abc',
        failures: [{ message: 'fail' }],
        immutablePathHashes: [],
        immutablePaths: [],
        message: 'failed',
        phase: 'collection_run',
        schemaVersion: 1,
        status: 'failed',
        successCriteria: {
          doneWhen: 'requiredCheck passes on the latest PR head commit',
          failureContextMustMatchPrHeadCommit: true,
          latestHeadOnly: true,
          requiredCheck: 'Postman TDD Preview'
        }
      },
      status: 'failed'
    });
    const parsed = parseFailureDocument(body);
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.ledger).toBeUndefined();
  });
});
