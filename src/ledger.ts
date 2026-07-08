import { createHash } from 'node:crypto';

import type { ContractIndex, ContractOperation } from './contract.js';
import type { AgentFailure, Ledger, LedgerAcceptance, LedgerPacket, LedgerSummary } from './types.js';

const LEDGER_SUMMARY_PACKET_CAP = 20;

const CONTRACT_ACCEPTANCES: LedgerAcceptance[] = [
  {
    assertion: 'operation mapping exists',
    criterion: 'The operation path is defined and non-empty.'
  },
  {
    assertion: 'status code is defined by OpenAPI',
    criterion: 'The response status code is declared in the OpenAPI responses for this operation.'
  },
  {
    assertion: 'response body matches body contract',
    criterion: 'The response body presence matches the OpenAPI response body declaration.'
  },
  {
    assertion: 'content-type matches OpenAPI response content',
    criterion: 'The response Content-Type matches one of the OpenAPI response content media types.'
  },
  {
    assertion: 'response body matches schema',
    criterion: 'The response body validates against the OpenAPI response schema.'
  }
];

/**
 * Returns the durable packet key for an OpenAPI operation.
 *
 * Uses `operationId` when present, else falls back to `${method} ${path}`.
 * Per oasdiff stability rules an `operationId` rename is INFO-level
 * non-breaking metadata, so `method+path` is the durable fallback identity
 * across renames (D1). The existing failure-normalizer regex and the
 * contract-hints lookup follow the same operationId-then-method+path
 * resolution order.
 */
export function packetKey(op: ContractOperation): string {
  return op.operationId || `${op.method} ${op.path}`;
}

export function buildLedgerPackets(index: ContractIndex): LedgerPacket[] {
  return index.operations.map((op) => ({
    acceptance: CONTRACT_ACCEPTANCES.map((entry) => ({ ...entry })),
    attempts: 0,
    key: packetKey(op),
    method: op.method,
    operationId: op.operationId,
    passes: false,
    path: op.path,
    title: op.operationId || `${op.method} ${op.path}`
  }));
}

export function failureFingerprint(failure: AgentFailure): string {
  return createHash('sha256')
    .update(`${failure.assertion || ''}\0${failure.message}`)
    .digest('hex');
}

export function scoreLedger(ledger: Ledger, failures: AgentFailure[], commit?: string): Ledger {
  const packets = ledger.packets.map((packet) => {
    const matching = failures.filter((failure) => failureMatchesPacket(failure, packet));
    if (matching.length === 0) {
      return {
        ...packet,
        lastVerifiedCommit: commit,
        passes: true
      };
    }
    return {
      ...packet,
      attempts: packet.attempts + 1,
      lastFailureFingerprint: failureFingerprint(matching[0]!),
      passes: false
    };
  });
  return {
    ...ledger,
    generatedAtCommit: commit ?? ledger.generatedAtCommit,
    packets
  };
}

export function ratchetLedger(
  previous: LedgerSummary | undefined,
  current: Ledger,
  opts?: { allowRemoval?: boolean }
): { missingKeys: string[]; violated: boolean; weakenedKeys: string[] } {
  const missingKeys: string[] = [];
  const weakenedKeys: string[] = [];

  if (!previous) {
    return { missingKeys, violated: false, weakenedKeys };
  }

  const currentByKey = new Map(current.packets.map((packet) => [packet.key, packet]));
  for (const prevPacket of previous.packets) {
    if (!prevPacket.passes) continue;
    const currentPacket = currentByKey.get(prevPacket.key);
    if (!currentPacket) {
      missingKeys.push(prevPacket.key);
    } else if (currentPacket.acceptance.length < CONTRACT_ACCEPTANCES.length) {
      weakenedKeys.push(prevPacket.key);
    }
  }

  const allowRemoval = opts?.allowRemoval === true;
  const violated = !allowRemoval && (missingKeys.length > 0 || weakenedKeys.length > 0);
  return { missingKeys, violated, weakenedKeys };
}

/**
 * Builds a compact ledger summary hard-capped at 20 packets (D8).
 *
 * The cap is enforced inside this function, not left to the caller, so every
 * consumer (marker embed, table render, AgentFailureDocument.ledger) inherits
 * it. `total`/`passing`/`failing` stay accurate counts while `packets[]` is
 * truncated to the first 20 entries.
 */
export function toLedgerSummary(ledger: Ledger): LedgerSummary {
  const passing = ledger.packets.filter((packet) => packet.passes).length;
  const failing = ledger.packets.length - passing;
  return {
    failing,
    packets: ledger.packets.slice(0, LEDGER_SUMMARY_PACKET_CAP).map((packet) => ({
      key: packet.key,
      lastFailureFingerprint: packet.lastFailureFingerprint,
      passes: packet.passes,
      title: packet.title
    })),
    passing,
    total: ledger.packets.length
  };
}

export function emptyLedger(): Ledger {
  return { packets: [], schemaVersion: 1 };
}

function failureMatchesPacket(failure: AgentFailure, packet: LedgerPacket): boolean {
  if (failure.operationId && packet.operationId) {
    return failure.operationId === packet.operationId;
  }
  const method = failure.method?.toUpperCase();
  if (method && failure.path) {
    return method === packet.method && failure.path === packet.path;
  }
  return false;
}
