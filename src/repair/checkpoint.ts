import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { createSignature } from '../immutable-state.js';
import type { RepairCheckpointPayload, RepairProvider, SignedRepairCheckpoint } from '../types.js';

const CHECKPOINT_DIR = '.postman-tdd';
const SIGNATURE_PREFIX = 'hmac-sha256:';

/**
 * Signs a {@link RepairCheckpointPayload} using the same HMAC seam as
 * `signImmutableState` (D9: reuse the ONE signing path in
 * `immutable-state.ts`, never a second crypto implementation). The resulting
 * {@link SignedRepairCheckpoint} is authoritative resume state when its
 * signature verifies against `immutable-state-signing-key` and its
 * `payload.commit` matches the PR head.
 */
export function signRepairCheckpoint(payload: RepairCheckpointPayload, signingKey: string): SignedRepairCheckpoint {
  return {
    algorithm: 'hmac-sha256',
    payload,
    schemaVersion: 1,
    signature: `${SIGNATURE_PREFIX}${createSignature(payload, signingKey)}`
  };
}

/**
 * Verifies a {@link SignedRepairCheckpoint} against the signing key and an
 * expected commit, mirroring `verifyImmutableState`. A checkpoint whose
 * signature verifies AND whose `payload.commit === expectation.commit` is
 * AUTHORITATIVE. A bad signature (tamper) returns false, so the caller
 * restarts from attempts=0 — exactly as `verifyImmutableState` rejects
 * tampered baselines.
 */
export function verifyRepairCheckpoint(
  signed: SignedRepairCheckpoint | undefined,
  signingKey: string,
  expectation: { commit: string }
): signed is SignedRepairCheckpoint {
  if (!signed || signed.schemaVersion !== 1 || signed.algorithm !== 'hmac-sha256') {
    return false;
  }
  if (signed.payload.schemaVersion !== 1 || signed.payload.commit !== expectation.commit) {
    return false;
  }
  if (!signed.signature.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const actual = Buffer.from(signed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expected = Buffer.from(createSignature(signed.payload, signingKey), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Writes the full checkpoint payload to `.postman-tdd/checkpoint.json`,
 * mirroring the `repair-summary.json` artifact pattern (D9 full copy).
 */
export function writeCheckpointArtifact(payload: RepairCheckpointPayload, dir: string = CHECKPOINT_DIR): string {
  mkdirSync(dir, { recursive: true });
  const checkpointPath = join(dir, 'checkpoint.json');
  writeFileSync(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return checkpointPath;
}

/**
 * Reads `.postman-tdd/checkpoint.json` if present. Returns `undefined` when
 * the file is absent or does not parse as a schemaVersion 1 payload.
 */
export function readCheckpointArtifact(dir: string = CHECKPOINT_DIR): RepairCheckpointPayload | undefined {
  const checkpointPath = join(dir, 'checkpoint.json');
  if (!existsSync(checkpointPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath, 'utf8')) as RepairCheckpointPayload;
    return parsed.schemaVersion === 1 && typeof parsed.commit === 'string'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns a fresh empty checkpoint for the start of a repair loop.
 */
export function emptyCheckpoint(commit: string, provider: RepairProvider): RepairCheckpointPayload {
  return {
    attempts: 0,
    attemptFingerprints: [],
    commit,
    escalated: false,
    provider,
    schemaVersion: 1
  };
}
