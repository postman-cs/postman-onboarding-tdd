import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  AgentFailureDocument,
  ImmutablePathHash,
  ImmutableStatePayload,
  SignedImmutableState
} from './types.js';

export const IMMUTABLE_STATE_TAMPERED_MESSAGE =
  'The signed immutable spec baseline could not be verified. Treat the sticky comment as tampered and do not continue implementation repair.';

interface ImmutableStateContext {
  commit?: string;
  immutablePathHashes: ImmutablePathHash[];
  prNumber: number;
  repository: string;
  specPath?: string;
}

interface ImmutableStateExpectation {
  prNumber: number;
  repository: string;
  specPath?: string;
}

export type TrustedImmutableBaseline =
  | {
      hashes: ImmutablePathHash[];
      ok: true;
      signedState?: SignedImmutableState;
    }
  | {
      hashes: ImmutablePathHash[];
      message: string;
      ok: false;
    };

export function createImmutableStatePayload(context: ImmutableStateContext): ImmutableStatePayload {
  return {
    ...(context.commit ? { commit: context.commit } : {}),
    immutablePathHashes: sortHashes(context.immutablePathHashes),
    prNumber: context.prNumber,
    repository: context.repository,
    schemaVersion: 1,
    ...(context.specPath ? { specPath: context.specPath } : {})
  };
}

export function signImmutableState(payload: ImmutableStatePayload, signingKey: string): SignedImmutableState {
  return {
    algorithm: 'hmac-sha256',
    payload,
    schemaVersion: 1,
    signature: `hmac-sha256:${createSignature(payload, signingKey)}`
  };
}

export function verifyImmutableState(
  signedState: SignedImmutableState | undefined,
  signingKey: string,
  expectation: ImmutableStateExpectation
): signedState is SignedImmutableState {
  if (!signedState || signedState.schemaVersion !== 1 || signedState.algorithm !== 'hmac-sha256') {
    return false;
  }
  if (
    signedState.payload.schemaVersion !== 1 ||
    signedState.payload.prNumber !== expectation.prNumber ||
    signedState.payload.repository !== expectation.repository ||
    signedState.payload.specPath !== expectation.specPath
  ) {
    return false;
  }
  if (!signedState.signature.startsWith('hmac-sha256:')) {
    return false;
  }
  const actual = Buffer.from(signedState.signature.slice('hmac-sha256:'.length), 'hex');
  const expected = Buffer.from(createSignature(signedState.payload, signingKey), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function resolveTrustedImmutableBaseline(
  document: AgentFailureDocument | undefined,
  signingKey: string | undefined,
  expectation: ImmutableStateExpectation,
  signedStateOverride?: SignedImmutableState
): TrustedImmutableBaseline {
  const signedState = document ? signedStateOverride || document.immutableState : undefined;
  const hashes = signedState?.payload.immutablePathHashes || document?.immutablePathHashes || [];
  if (hashes.length === 0) {
    return { hashes: [], ok: true };
  }
  if (!signingKey) {
    return { hashes, ok: true };
  }
  if (!verifyImmutableState(signedState, signingKey, expectation)) {
    return {
      hashes,
      message: IMMUTABLE_STATE_TAMPERED_MESSAGE,
      ok: false
    };
  }
  return {
    hashes: signedState.payload.immutablePathHashes,
    ok: true,
    signedState
  };
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createSignature(payload: ImmutableStatePayload, signingKey: string): string {
  return createHmac('sha256', signingKey)
    .update(canonicalize(payload))
    .digest('hex');
}

function sortHashes(hashes: ImmutablePathHash[]): ImmutablePathHash[] {
  return hashes
    .map((hash) => ({ path: hash.path, sha256: hash.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
