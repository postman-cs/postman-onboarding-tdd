import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const templateRoot = join(process.cwd(), '.postman-template');
const referencesRoot = join(templateRoot, 'agents', 'references');

const requiredDocs = [
  'tdd-check',
  'failure-document',
  'repair-loop',
  'immutable-spec-guard',
  'branch-and-commit',
  'execplan-skeleton'
];

function readTemplate(relativePath: string): string {
  return readFileSync(join(templateRoot, relativePath), 'utf8');
}

function readReference(name: string): string {
  return readFileSync(join(referencesRoot, `${name}.md`), 'utf8');
}

describe('packaged harness templates', () => {
  it('ships an AGENTS.md router', () => {
    const source = readTemplate('AGENTS.md');
    expect(source.length).toBeGreaterThan(0);
    expect(source.trimStart().startsWith('#')).toBe(true);
  });

  it('keeps AGENTS.md at or under 100 non-empty lines', () => {
    const source = readTemplate('AGENTS.md');
    const nonEmptyLines = source.split('\n').filter((line) => line.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(100);
  });

  for (const name of requiredDocs) {
    it(`ships a non-empty ${name}.md reference that starts with an H1`, () => {
      const source = readReference(name);
      expect(source.trim().length).toBeGreaterThan(0);
      expect(source.trimStart().startsWith('#')).toBe(true);
    });
  }

  for (const name of requiredDocs) {
    it(`AGENTS.md routes to .agents/references/${name}.md`, () => {
      const router = readTemplate('AGENTS.md');
      expect(router).toContain(`.agents/references/${name}.md`);
    });
  }

  it('documents the postman-tdd-fix- branch prefix in branch-and-commit.md', () => {
    expect(readReference('branch-and-commit')).toContain('postman-tdd-fix-');
  });
});
