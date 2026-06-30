import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  createImmutableStatePayload,
  IMMUTABLE_STATE_TAMPERED_MESSAGE,
  resolveTrustedImmutableBaseline,
  signImmutableState,
  verifyImmutableState
} from '../src/immutable-state.js';
import type { AgentFailureDocument } from '../src/types.js';

const signingKey = 'test-signing-key';

function failureDocument(overrides: Partial<AgentFailureDocument> = {}): AgentFailureDocument {
  return {
    failures: [{ message: 'failed' }],
    immutablePathHashes: [{
      path: 'api/openapi.yaml',
      sha256: 'abc123'
    }],
    immutablePaths: ['api/openapi.yaml'],
    message: 'failed',
    phase: 'collection_run',
    schemaVersion: 1,
    status: 'failed',
    successCriteria: {
      doneWhen: 'requiredCheck passes on the latest PR head commit',
      failureContextMustMatchPrHeadCommit: true,
      latestHeadOnly: true,
      requiredCheck: 'Postman TDD Preview'
    },
    ...overrides
  };
}

describe('immutable state signing', () => {
  it('canonicalizes object keys before signing', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({ z: [{ b: true, a: false }] })).toBe('{"z":[{"a":false,"b":true}]}');
  });

  it('signs and verifies an immutable baseline payload', () => {
    const payload = createImmutableStatePayload({
      commit: 'abc',
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    });
    const signed = signImmutableState(payload, signingKey);

    expect(signed.signature).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(verifyImmutableState(signed, signingKey, {
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    })).toBe(true);
  });

  it('rejects tampered payloads and replayed PR state', () => {
    const payload = createImmutableStatePayload({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    });
    const signed = signImmutableState(payload, signingKey);

    expect(verifyImmutableState({
      ...signed,
      payload: {
        ...signed.payload,
        immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'changed' }]
      }
    }, signingKey, {
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    })).toBe(false);

    expect(verifyImmutableState(signed, signingKey, {
      prNumber: 5,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    })).toBe(false);
  });

  it('fails closed on unsigned baselines when signing is enabled', () => {
    expect(resolveTrustedImmutableBaseline(failureDocument(), signingKey, {
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    })).toEqual({
      hashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      message: IMMUTABLE_STATE_TAMPERED_MESSAGE,
      ok: false
    });
  });

  it('trusts signed baselines and preserves unsigned compatibility when signing is disabled', () => {
    const payload = createImmutableStatePayload({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    });
    const signed = signImmutableState(payload, signingKey);
    const signedDocument = failureDocument({ immutableState: signed });

    expect(resolveTrustedImmutableBaseline(signedDocument, signingKey, {
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    })).toMatchObject({
      hashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      ok: true,
      signedState: signed
    });

    expect(resolveTrustedImmutableBaseline(failureDocument(), undefined, {
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    })).toMatchObject({
      hashes: [{ path: 'api/openapi.yaml', sha256: 'abc123' }],
      ok: true
    });
  });

  it('can trust signed state from the hidden marker even if visible JSON was changed', () => {
    const payload = createImmutableStatePayload({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'trusted' }],
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    });
    const signed = signImmutableState(payload, signingKey);

    expect(resolveTrustedImmutableBaseline(failureDocument({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'tampered' }]
    }), signingKey, {
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    }, signed)).toMatchObject({
      hashes: [{ path: 'api/openapi.yaml', sha256: 'trusted' }],
      ok: true,
      signedState: signed
    });
  });

  it('ignores marker-only immutable state when there is no failure document', () => {
    const payload = createImmutableStatePayload({
      immutablePathHashes: [{ path: 'api/openapi.yaml', sha256: 'stale' }],
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    });
    const signed = signImmutableState(payload, signingKey);

    expect(resolveTrustedImmutableBaseline(undefined, signingKey, {
      prNumber: 4,
      repository: 'postman-cs/pavan-test-TDD',
      specPath: 'api/openapi.yaml'
    }, signed)).toEqual({
      hashes: [],
      ok: true
    });
  });
});
