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
  phaseTriage,
  writeAgentContext
} from '../src/agent-context.js';
import { parseFailureDocument, renderStickyComment } from '../src/github/pr-comment.js';
import { emptyCheckpoint, signRepairCheckpoint } from '../src/repair/checkpoint.js';
import type { FailurePhase, LedgerSummary, RepairCheckpointPayload, SignedRepairCheckpoint } from '../src/types.js';

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

  it('round-trips a signed checkpointRef through create -> render -> parse', () => {
    const payload = { ...emptyCheckpoint('commit-abc', 'openai-responses'), attempts: 1, attemptFingerprints: ['fp1'] };
    const signed: SignedRepairCheckpoint = signRepairCheckpoint(payload, 'signing-key');
    const document = createFailureDocument({
      checkpointRef: signed,
      commit: 'commit-abc',
      failures: [{ message: 'fail' }],
      message: 'failed',
      phase: 'collection_run',
      specPath: 'api/openapi.yaml'
    });

    const body = renderStickyComment({ prNumber: 123, schemaVersion: 1 }, {
      failureDocument: document,
      status: 'failed'
    });
    const parsed = parseFailureDocument(body);
    expect(parsed?.checkpointRef).toEqual(signed);
    expect((parsed?.checkpointRef as SignedRepairCheckpoint)?.signature).toMatch(/^hmac-sha256:/);
  });

  it('round-trips a bare (unsigned) checkpointRef payload through create -> render -> parse', () => {
    const payload: RepairCheckpointPayload = {
      ...emptyCheckpoint('commit-abc', 'openai-responses'),
      attempts: 2
    };
    const document = createFailureDocument({
      checkpointRef: payload,
      commit: 'commit-abc',
      failures: [{ message: 'fail' }],
      message: 'failed',
      phase: 'collection_run',
      specPath: 'api/openapi.yaml'
    });

    const body = renderStickyComment({ prNumber: 123, schemaVersion: 1 }, {
      failureDocument: document,
      status: 'failed'
    });
    const parsed = parseFailureDocument(body);
    expect(parsed?.checkpointRef).toEqual(payload);
    expect((parsed?.checkpointRef as { signature?: string })?.signature).toBeUndefined();
  });

  describe('phaseTriage (D14)', () => {
    const cases: Array<{ phase: FailurePhase; ownerActionRequired: boolean; retryable: boolean }> = [
      { phase: 'service_startup', ownerActionRequired: false, retryable: true },
      { phase: 'health_check', ownerActionRequired: false, retryable: true },
      { phase: 'immutable_spec', ownerActionRequired: true, retryable: false },
      { phase: 'immutable_state_tampered', ownerActionRequired: true, retryable: false },
      { phase: 'test_ratchet', ownerActionRequired: true, retryable: false },
      { phase: 'collection_run', ownerActionRequired: false, retryable: false },
      { phase: 'config', ownerActionRequired: false, retryable: false },
      { phase: 'workspace', ownerActionRequired: false, retryable: false },
      { phase: 'asset_upsert', ownerActionRequired: false, retryable: false },
      { phase: 'cleanup', ownerActionRequired: false, retryable: false },
      { phase: 'none', ownerActionRequired: false, retryable: false }
    ];
    for (const { phase, ownerActionRequired, retryable } of cases) {
      it(`returns retryable=${retryable}, ownerActionRequired=${ownerActionRequired} for ${phase}`, () => {
        expect(phaseTriage(phase)).toEqual({ ownerActionRequired, retryable });
      });
    }
  });

  it('createFailureDocument populates retryable/ownerActionRequired from phase', () => {
    const health = createFailureDocument({
      failures: [{ message: 'fail' }],
      message: 'health failed',
      phase: 'health_check',
      specPath: 'api/openapi.yaml'
    });
    expect(health.retryable).toBe(true);
    expect(health.ownerActionRequired).toBe(false);

    const ratchet = createFailureDocument({
      failures: [{ message: 'fail' }],
      message: 'ratchet violated',
      phase: 'test_ratchet',
      specPath: 'api/openapi.yaml'
    });
    expect(ratchet.ownerActionRequired).toBe(true);
    expect(ratchet.retryable).toBe(false);

    const collection = createFailureDocument({
      failures: [{ message: 'fail' }],
      message: 'collection failed',
      phase: 'collection_run',
      specPath: 'api/openapi.yaml'
    });
    expect(collection.retryable).toBe(false);
    expect(collection.ownerActionRequired).toBe(false);
  });

  it('explicit caller retryable override wins over the phase default', () => {
    const document = createFailureDocument({
      failures: [{ message: 'fail' }],
      message: 'collection failed',
      phase: 'collection_run',
      retryable: true,
      specPath: 'api/openapi.yaml'
    });
    // collection_run default is retryable=false, but the explicit input wins.
    expect(document.retryable).toBe(true);
    expect(document.ownerActionRequired).toBe(false);
  });
});
