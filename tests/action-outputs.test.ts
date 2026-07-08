import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const actionYmlPath = join(process.cwd(), 'action.yml');
const readmePath = join(process.cwd(), 'README.md');

function readActionYml(): string {
  return readFileSync(actionYmlPath, 'utf8');
}

function readReadme(): string {
  return readFileSync(readmePath, 'utf8');
}

describe('action.yml outputs', () => {
  it('surfaces ledger-path as an output', () => {
    const source = readActionYml();
    const action = parse(source) as { outputs: Record<string, { description: string }> };
    expect(action.outputs['ledger-path']).toBeDefined();
    expect(action.outputs['ledger-path']?.description).toContain('.postman-tdd/ledger.json');
  });

  it('surfaces junit-path as an output', () => {
    const source = readActionYml();
    const action = parse(source) as { outputs: Record<string, { description: string }> };
    expect(action.outputs['junit-path']).toBeDefined();
    expect(action.outputs['junit-path']?.description).toContain('.postman-tdd/junit.xml');
  });

  it('lists test_ratchet in the failure-phase description', () => {
    const source = readActionYml();
    expect(source).toContain('test_ratchet');
  });

  it('documents the postman-tdd-allow-ratchet-removal escape-hatch label', () => {
    const source = readActionYml();
    expect(source).toContain('postman-tdd-allow-ratchet-removal');
  });

  it('surfaces repair-escalated as an output', () => {
    const source = readActionYml();
    const action = parse(source) as { outputs: Record<string, { description: string }> };
    expect(action.outputs['repair-escalated']).toBeDefined();
  });

  it('documents repeated_failure and owner_action_required in repair-blocked-reason', () => {
    const source = readActionYml();
    expect(source).toContain('repeated_failure');
    expect(source).toContain('owner_action_required');
  });

  it('documents all three P2 repair inputs', () => {
    const source = readActionYml();
    expect(source).toContain('repair-max-tool-rounds');
    expect(source).toContain('repair-breaker-threshold');
    expect(source).toContain('repair-escalation-model');
  });

  it('README documents all four agent secrets and the postman-tdd-fix- branch convention', () => {
    const source = readReadme();
    expect(source).toContain('CURSOR_API_KEY');
    expect(source).toContain('DEVIN_API_KEY');
    expect(source).toContain('OPENAI_API_KEY');
    expect(source).toContain('ANTHROPIC_API_KEY');
    expect(source).toContain('postman-tdd-fix-');
  });
});
