import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyCheckpoint,
  readCheckpointArtifact,
  signRepairCheckpoint,
  verifyRepairCheckpoint,
  writeCheckpointArtifact
} from '../src/repair/checkpoint.js';

import type { RepairCheckpointPayload } from '../src/types.js';

const signingKey = 'test-checkpoint-signing-key';

function samplePayload(overrides: Partial<RepairCheckpointPayload> = {}): RepairCheckpointPayload {
  return {
    ...emptyCheckpoint('commit-abc', 'openai-responses'),
    attempts: 2,
    attemptFingerprints: ['fp1', 'fp2'],
    escalated: false,
    ...overrides
  };
}

describe('signed repair checkpoint', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('signs and verifies a checkpoint payload', () => {
    const payload = samplePayload();
    const signed = signRepairCheckpoint(payload, signingKey);

    expect(signed.signature).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(signed.schemaVersion).toBe(1);
    expect(signed.algorithm).toBe('hmac-sha256');
    expect(verifyRepairCheckpoint(signed, signingKey, { commit: 'commit-abc' })).toBe(true);
  });

  it('rejects a tampered payload (mutated attempts)', () => {
    const signed = signRepairCheckpoint(samplePayload(), signingKey);
    const tampered = {
      ...signed,
      payload: { ...signed.payload, attempts: 99 }
    };

    expect(verifyRepairCheckpoint(tampered, signingKey, { commit: 'commit-abc' })).toBe(false);
  });

  it('rejects a checkpoint verified against the wrong commit', () => {
    const signed = signRepairCheckpoint(samplePayload(), signingKey);

    expect(verifyRepairCheckpoint(signed, signingKey, { commit: 'different-commit' })).toBe(false);
  });

  it('rejects undefined and malformed checkpoints', () => {
    expect(verifyRepairCheckpoint(undefined, signingKey, { commit: 'commit-abc' })).toBe(false);
    expect(verifyRepairCheckpoint({} as never, signingKey, { commit: 'commit-abc' })).toBe(false);
  });

  it('round-trips a checkpoint payload through write/read artifact', () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-checkpoint-'));
    const payload = samplePayload({ commit: 'artifact-commit' });

    const writtenPath = writeCheckpointArtifact(payload, dir);
    expect(writtenPath).toBe(join(dir, 'checkpoint.json'));

    const read = readCheckpointArtifact(dir);
    expect(read).toEqual(payload);
    expect(readFileSync(writtenPath, 'utf8')).toContain('artifact-commit');
  });

  it('returns undefined when no checkpoint artifact exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-checkpoint-'));
    expect(readCheckpointArtifact(dir)).toBeUndefined();
  });

  it('emptyCheckpoint produces a schemaVersion 1 payload with zero attempts', () => {
    const empty = emptyCheckpoint('commit-xyz', 'anthropic-messages');
    expect(empty).toEqual({
      schemaVersion: 1,
      commit: 'commit-xyz',
      provider: 'anthropic-messages',
      attempts: 0,
      escalated: false,
      attemptFingerprints: []
    });
  });
});
