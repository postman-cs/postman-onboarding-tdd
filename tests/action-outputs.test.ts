import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const actionYmlPath = join(process.cwd(), 'action.yml');

function readActionYml(): string {
  return readFileSync(actionYmlPath, 'utf8');
}

describe('action.yml outputs', () => {
  it('surfaces ledger-path as an output', () => {
    const source = readActionYml();
    const action = parse(source) as { outputs: Record<string, { description: string }> };
    expect(action.outputs['ledger-path']).toBeDefined();
    expect(action.outputs['ledger-path']?.description).toContain('.postman-tdd/ledger.json');
  });

  it('lists test_ratchet in the failure-phase description', () => {
    const source = readActionYml();
    expect(source).toContain('test_ratchet');
  });

  it('documents the postman-tdd-allow-ratchet-removal escape-hatch label', () => {
    const source = readActionYml();
    expect(source).toContain('postman-tdd-allow-ratchet-removal');
  });
});
