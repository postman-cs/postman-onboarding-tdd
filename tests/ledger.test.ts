import { describe, expect, it } from 'vitest';

import type { ContractIndex } from '../src/contract.js';
import {
  buildLedgerPackets,
  emptyLedger,
  failureFingerprint,
  packetKey,
  ratchetLedger,
  scoreLedger,
  toLedgerSummary
} from '../src/ledger.js';
import type { AgentFailure, Ledger, LedgerSummary } from '../src/types.js';

function makeIndex(
  operations: Array<{ method: string; path: string; operationId?: string }>
): ContractIndex {
  return {
    operations: operations.map((op) => ({
      method: op.method,
      operationId: op.operationId,
      path: op.path,
      responses: {}
    })),
    openapiVersion: '3.0',
    warnings: []
  };
}

function makeFailure(failure: AgentFailure): AgentFailure {
  return { ...failure };
}

describe('packetKey', () => {
  it('returns operationId when present', () => {
    expect(packetKey({ method: 'GET', operationId: 'getWidgets', path: '/v1/widgets', responses: {} }))
      .toBe('getWidgets');
  });

  it('falls back to method + path when operationId is absent', () => {
    expect(packetKey({ method: 'POST', path: '/v1/widgets', responses: {} }))
      .toBe('POST /v1/widgets');
  });
});

describe('buildLedgerPackets', () => {
  it('creates one packet per operation seeded with five acceptance entries', () => {
    const index = makeIndex([
      { method: 'GET', operationId: 'listWidgets', path: '/v1/widgets' },
      { method: 'POST', path: '/v1/widgets' }
    ]);
    const packets = buildLedgerPackets(index);

    expect(packets).toHaveLength(2);
    expect(packets[0]?.key).toBe('listWidgets');
    expect(packets[0]?.passes).toBe(false);
    expect(packets[0]?.attempts).toBe(0);
    expect(packets[0]?.acceptance).toHaveLength(5);
    expect(packets[0]?.acceptance.map((a) => a.assertion)).toEqual([
      'operation mapping exists',
      'status code is defined by OpenAPI',
      'response body matches body contract',
      'content-type matches OpenAPI response content',
      'response body matches schema'
    ]);
    expect(packets[1]?.key).toBe('POST /v1/widgets');
    expect(packets[1]?.title).toBe('POST /v1/widgets');
    expect(packets[0]?.title).toBe('listWidgets');
  });

  it('defensively copies acceptance entries so callers cannot mutate the seed', () => {
    const index = makeIndex([{ method: 'GET', operationId: 'op1', path: '/v1/x' }]);
    const packets = buildLedgerPackets(index);
    packets[0]?.acceptance.push({ assertion: 'tampered', criterion: 'x' });
    const fresh = buildLedgerPackets(index);
    expect(fresh[0]?.acceptance).toHaveLength(5);
  });
});

describe('failureFingerprint', () => {
  it('is deterministic for the same assertion + message', () => {
    const a = failureFingerprint(makeFailure({ assertion: 'status code is defined by OpenAPI', message: 'Expected 200' }));
    const b = failureFingerprint(makeFailure({ assertion: 'status code is defined by OpenAPI', message: 'Expected 200' }));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('differs when the assertion or message differs', () => {
    const a = failureFingerprint(makeFailure({ assertion: 'x', message: 'm' }));
    const b = failureFingerprint(makeFailure({ assertion: 'x', message: 'n' }));
    const c = failureFingerprint(makeFailure({ assertion: 'y', message: 'm' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('scoreLedger', () => {
  it('flips packets to passes:true and sets lastVerifiedCommit when no failures match', () => {
    const index = makeIndex([{ method: 'GET', operationId: 'getWidgets', path: '/v1/widgets' }]);
    const ledger: Ledger = { packets: buildLedgerPackets(index), schemaVersion: 1 };
    const scored = scoreLedger(ledger, [], 'commit-1');

    expect(scored.packets[0]?.passes).toBe(true);
    expect(scored.packets[0]?.lastVerifiedCommit).toBe('commit-1');
    expect(scored.packets[0]?.attempts).toBe(0);
    expect(scored.generatedAtCommit).toBe('commit-1');
  });

  it('marks failing packets and increments attempts with a lastFailureFingerprint', () => {
    const index = makeIndex([
      { method: 'GET', operationId: 'getWidgets', path: '/v1/widgets' },
      { method: 'POST', operationId: 'createWidget', path: '/v1/widgets' }
    ]);
    const ledger: Ledger = { packets: buildLedgerPackets(index), schemaVersion: 1 };
    const failure: AgentFailure = {
      assertion: 'status code is defined by OpenAPI',
      message: 'Expected 200',
      method: 'GET',
      operationId: 'getWidgets',
      path: '/v1/widgets'
    };
    const scored = scoreLedger(ledger, [failure], 'commit-2');

    expect(scored.packets[0]?.passes).toBe(false);
    expect(scored.packets[0]?.attempts).toBe(1);
    expect(scored.packets[0]?.lastFailureFingerprint).toBeTruthy();
    expect(scored.packets[1]?.passes).toBe(true);
    expect(scored.packets[1]?.lastVerifiedCommit).toBe('commit-2');
  });

  it('accumulates attempts across scoring runs when failures persist', () => {
    const index = makeIndex([{ method: 'GET', operationId: 'getWidgets', path: '/v1/widgets' }]);
    let ledger: Ledger = { packets: buildLedgerPackets(index), schemaVersion: 1 };
    const failure: AgentFailure = {
      assertion: 'status code is defined by OpenAPI',
      message: 'Expected 200',
      method: 'GET',
      operationId: 'getWidgets',
      path: '/v1/widgets'
    };
    ledger = scoreLedger(ledger, [failure], 'commit-1');
    ledger = scoreLedger(ledger, [failure], 'commit-2');
    expect(ledger.packets[0]?.attempts).toBe(2);
    expect(ledger.packets[0]?.passes).toBe(false);
  });

  it('matches failures by method+path when operationId is absent on both sides', () => {
    const index = makeIndex([{ method: 'DELETE', path: '/v1/widgets/{id}' }]);
    const ledger: Ledger = { packets: buildLedgerPackets(index), schemaVersion: 1 };
    const failure: AgentFailure = {
      assertion: 'response body matches schema',
      message: 'Missing field',
      method: 'DELETE',
      path: '/v1/widgets/{id}'
    };
    const scored = scoreLedger(ledger, [failure], 'commit-1');
    expect(scored.packets[0]?.passes).toBe(false);
  });
});

describe('ratchetLedger', () => {
  function makeSummary(packets: Array<{ key: string; passes: boolean }>): LedgerSummary {
    return {
      failing: packets.filter((p) => !p.passes).length,
      packets: packets.map((p) => ({
        key: p.key,
        passes: p.passes,
        title: p.key
      })),
      passing: packets.filter((p) => p.passes).length,
      total: packets.length
    };
  }

  it('returns no violation when there is no previous summary', () => {
    const ledger: Ledger = { packets: buildLedgerPackets(makeIndex([{ method: 'GET', operationId: 'a', path: '/a' }])), schemaVersion: 1 };
    const result = ratchetLedger(undefined, ledger);
    expect(result.violated).toBe(false);
    expect(result.missingKeys).toEqual([]);
    expect(result.weakenedKeys).toEqual([]);
  });

  it('returns no violation when all previously-passing packets are still present', () => {
    const previous = makeSummary([{ key: 'getWidgets', passes: true }]);
    const packets = buildLedgerPackets(makeIndex([{ method: 'GET', operationId: 'getWidgets', path: '/v1/widgets' }]));
    const ledger: Ledger = { packets, schemaVersion: 1 };
    const result = ratchetLedger(previous, ledger);
    expect(result.violated).toBe(false);
  });

  it('flags a violation when a previously-passing packet is removed (no allowRemoval)', () => {
    const previous = makeSummary([{ key: 'getWidgets', passes: true }]);
    const ledger: Ledger = { packets: [], schemaVersion: 1 };
    const result = ratchetLedger(previous, ledger);
    expect(result.violated).toBe(true);
    expect(result.missingKeys).toEqual(['getWidgets']);
  });

  it('suppresses the violation and surfaces missing keys when allowRemoval is true (D7)', () => {
    const previous = makeSummary([{ key: 'getWidgets', passes: true }]);
    const ledger: Ledger = { packets: [], schemaVersion: 1 };
    const result = ratchetLedger(previous, ledger, { allowRemoval: true });
    expect(result.violated).toBe(false);
    expect(result.missingKeys).toEqual(['getWidgets']);
  });

  it('does not flag packets that were previously failing', () => {
    const previous = makeSummary([{ key: 'getWidgets', passes: false }]);
    const ledger: Ledger = { packets: [], schemaVersion: 1 };
    const result = ratchetLedger(previous, ledger);
    expect(result.violated).toBe(false);
    expect(result.missingKeys).toEqual([]);
  });

  it('flags weakened packets whose acceptance shrank below the contract baseline', () => {
    const previous = makeSummary([{ key: 'getWidgets', passes: true }]);
    const ledger: Ledger = {
      packets: [
        {
          acceptance: [{ assertion: 'x', criterion: 'y' }],
          attempts: 0,
          key: 'getWidgets',
          method: 'GET',
          passes: true,
          path: '/v1/widgets',
          title: 'getWidgets'
        }
      ],
      schemaVersion: 1
    };
    const result = ratchetLedger(previous, ledger);
    expect(result.violated).toBe(true);
    expect(result.weakenedKeys).toEqual(['getWidgets']);
  });

  it('suppresses weakened-key violations under allowRemoval but still surfaces the keys', () => {
    const previous = makeSummary([{ key: 'getWidgets', passes: true }]);
    const ledger: Ledger = {
      packets: [
        {
          acceptance: [{ assertion: 'x', criterion: 'y' }],
          attempts: 0,
          key: 'getWidgets',
          method: 'GET',
          passes: true,
          path: '/v1/widgets',
          title: 'getWidgets'
        }
      ],
      schemaVersion: 1
    };
    const result = ratchetLedger(previous, ledger, { allowRemoval: true });
    expect(result.violated).toBe(false);
    expect(result.weakenedKeys).toEqual(['getWidgets']);
  });
});

describe('toLedgerSummary', () => {
  it('produces accurate counts and compact packet entries', () => {
    const index = makeIndex([
      { method: 'GET', operationId: 'a', path: '/a' },
      { method: 'GET', operationId: 'b', path: '/b' }
    ]);
    const ledger = scoreLedger(
      { packets: buildLedgerPackets(index), schemaVersion: 1 },
      [makeFailure({ assertion: 'x', method: 'GET', operationId: 'a', path: '/a', message: 'fail' })],
      'commit-1'
    );
    const summary = toLedgerSummary(ledger);

    expect(summary.total).toBe(2);
    expect(summary.passing).toBe(1);
    expect(summary.failing).toBe(1);
    expect(summary.packets).toHaveLength(2);
    expect(summary.packets[0]?.key).toBe('a');
    expect(summary.packets[0]?.passes).toBe(false);
    expect(summary.packets[0]?.lastFailureFingerprint).toBeTruthy();
    expect(summary.packets[1]?.passes).toBe(true);
  });

  it('caps packets at 20 while keeping total accurate (D8)', () => {
    const operations = Array.from({ length: 30 }, (_, i) => ({
      method: 'GET',
      operationId: `op${i}`,
      path: `/v1/op${i}`
    }));
    const ledger = scoreLedger(
      { packets: buildLedgerPackets(makeIndex(operations)), schemaVersion: 1 },
      [],
      'commit-1'
    );
    const summary = toLedgerSummary(ledger);

    expect(summary.total).toBe(30);
    expect(summary.packets).toHaveLength(20);
    expect(summary.passing).toBe(30);
    expect(summary.failing).toBe(0);
  });
});

describe('emptyLedger', () => {
  it('returns a schemaVersion 1 ledger with no packets', () => {
    expect(emptyLedger()).toEqual({ packets: [], schemaVersion: 1 });
  });
});
