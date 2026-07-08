import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Structural drift oracle (P5-2). This test catches the PR #17 class of drift
// — docs/config referring to things that must exist and agree — by reading
// action.yml, README.md, package.json, and the repo-root AGENTS.md off disk
// and asserting four seams stay in lockstep:
//   (a) action.yml inputs <-> README `## Action Inputs` table (bidirectional)
//   (b) README-documented outputs ⊆ action.yml outputs, and a curated
//       IMPORTANT-OUTPUTS allowlist ⊆ documented outputs (directional, D25)
//   (c) every README `uses: postman-cs/postman-onboarding-tdd@<ref>` pins @v0 (D27)
//   (d) every `npm run <script>` referenced by README or root AGENTS.md exists
//       in package.json scripts
//   (e) root AGENTS.md exists, is NOT in package.json `files`, and
//       .postman-template/AGENTS.md still ships (D26 non-conflation)
// No mocks, no network — same pattern as tests/workflow-templates.test.ts.

const root = process.cwd();
const readText = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const actionYml = parse(readText('action.yml')) as {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
};
const readme = readText('README.md');
const pkg = JSON.parse(readText('package.json')) as {
  scripts: Record<string, string>;
  files: string[];
};
const rootAgents = readText('AGENTS.md');

const actionInputs = Object.keys(actionYml.inputs);
const actionOutputs = Object.keys(actionYml.outputs);

// Extract the body of a `## <Heading>` section: from the line after the
// heading to the line before the next `## ` heading (H2 only, so `###`
// subsections are included in their parent H2 section).
function section(source: string, heading: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  expect(start, `heading ${heading} must exist in README`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.startsWith('## ')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

// Pull `| `<name>` |` table rows out of a markdown region. The backtick-quoted
// first cell distinguishes real input/output rows from `| Input |` /
// `| Output |` headers and `| --- |` separators.
function tableNames(region: string): string[] {
  const names: string[] = [];
  for (const line of region.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m && m[1]) names.push(m[1]);
  }
  return names;
}

const readmeInputNames = tableNames(section(readme, '## Action Inputs'));
const readmeOutputNames = tableNames(section(readme, '## Action Outputs'));

// The curated IMPORTANT-OUTPUTS allowlist (D25): the union of the README's
// three output tables today. action.yml MAY declare outputs the README omits
// (7 internal/artifact plumbing outputs), but every allowlist member must stay
// documented.
const IMPORTANT_OUTPUTS = [
  'status',
  'failure-phase',
  'workspace-id',
  'spec-id',
  'tdd-collection-id',
  'pr-comment-id',
  'agent-context-artifact',
  'ledger-path',
  'junit-path',
  'validation-error-count',
  'validation-warning-count',
  'validation-summary',
  'repair-status',
  'repair-blocked-reason',
  'repair-attempts',
  'repair-commit-sha',
  'repair-summary-path'
];

describe('action.yml <-> README input parity (bidirectional, D25)', () => {
  it('documents every action.yml input in the README Action Inputs table', () => {
    const undocumented = actionInputs.filter((n) => !readmeInputNames.includes(n));
    expect(
      undocumented,
      `action.yml inputs missing from README ## Action Inputs: ${undocumented.join(', ')}. ` +
        `Add a \`| \\\`${undocumented[0] ?? 'name'}\\\` | ... |\` row to the table.`
    ).toEqual([]);
  });

  it('has no phantom README input rows (every README input is a real action.yml input)', () => {
    const phantom = readmeInputNames.filter((n) => !actionInputs.includes(n));
    expect(
      phantom,
      `README ## Action Inputs documents inputs not in action.yml: ${phantom.join(', ')}. ` +
        `Either add the input to action.yml or remove the phantom row.`
    ).toEqual([]);
  });
});

describe('action.yml <- README output parity (directional + allowlist, D25)', () => {
  it('has no phantom README output docs (every documented output exists in action.yml)', () => {
    const phantom = readmeOutputNames.filter((n) => !actionOutputs.includes(n));
    expect(
      phantom,
      `README ## Action Outputs documents outputs not in action.yml: ${phantom.join(', ')}. ` +
        `Either add the output to action.yml or remove the phantom row.`
    ).toEqual([]);
  });

  it('documents every IMPORTANT-OUTPUTS allowlist member in README', () => {
    const missing = IMPORTANT_OUTPUTS.filter((n) => !readmeOutputNames.includes(n));
    expect(
      missing,
      `IMPORTANT-OUTPUTS allowlist members missing from README ## Action Outputs: ${missing.join(', ')}. ` +
        `These are curated public outputs and must stay documented.`
    ).toEqual([]);
  });
});

describe('README uses: version-pin convention (D27)', () => {
  // Every `uses: postman-cs/postman-onboarding-tdd@<ref>` must pin exactly @v0.
  // Captures refs so a failure names the offending pin. Scoped to `uses:` lines
  // only — immutable v0.x.y refs are allowed in changelog/release prose.
  const REPO_SLUG = 'postman-cs/postman-onboarding-tdd';
  const usesPinRe = new RegExp(`uses:\\s*${REPO_SLUG}@(\\S+)`, 'g');
  const pins: string[] = [];
  for (const m of readme.matchAll(usesPinRe)) if (m[1]) pins.push(m[1]);

  it('has at least one uses: postman-cs/postman-onboarding-tdd@<ref> example', () => {
    expect(
      pins.length,
      'README has no `uses: postman-cs/postman-onboarding-tdd@<ref>` example — the check cannot vacuously pass.'
    ).toBeGreaterThan(0);
  });

  it('pins every uses: example to @v0 (the rolling alias)', () => {
    const off = pins.filter((ref) => ref !== 'v0');
    expect(
      off,
      `README uses: examples pin to non-v0 refs: ${off.join(', ')}. ` +
        `Pin every copy-paste example to @v0 (rolling alias); immutable v0.x.y belongs in changelog prose only.`
    ).toEqual([]);
  });
});

describe('npm run script references exist in package.json', () => {
  const scriptNames = Object.keys(pkg.scripts);
  const npmRunRe = /npm run ([a-z][a-z0-9:-]*)/g;

  function missingIn(source: string): string[] {
    const refs = new Set<string>();
    for (const m of source.matchAll(npmRunRe)) if (m[1]) refs.add(m[1]);
    return [...refs].filter((r) => !scriptNames.includes(r));
  }

  it('every `npm run <script>` referenced by README exists in package.json scripts', () => {
    const missing = missingIn(readme);
    expect(
      missing,
      `README references npm run scripts not in package.json: ${missing.join(', ')}. ` +
        `Either add the script to package.json or fix the README reference.`
    ).toEqual([]);
  });

  it('every `npm run <script>` referenced by root AGENTS.md exists in package.json scripts', () => {
    const missing = missingIn(rootAgents);
    expect(
      missing,
      `root AGENTS.md references npm run scripts not in package.json: ${missing.join(', ')}. ` +
        `Either add the script to package.json or fix the AGENTS.md reference.`
    ).toEqual([]);
  });
});

describe('root AGENTS.md non-conflation guard (D26)', () => {
  it('ships a repo-root AGENTS.md (maintainer router)', () => {
    expect(rootAgents.length, 'repo-root AGENTS.md must exist').toBeGreaterThan(0);
  });

  it('does NOT list root AGENTS.md in package.json files (maintainer router, not shipped)', () => {
    expect(
      pkg.files.includes('AGENTS.md'),
      'package.json files[] includes "AGENTS.md" — the root maintainer router must NOT ship in the npm tarball (D26).'
    ).toBe(false);
  });

  it('still ships .postman-template/ (the customer harness router lives there)', () => {
    expect(
      pkg.files.includes('.postman-template/'),
      'package.json files[] is missing ".postman-template/" — the customer harness must still ship.'
    ).toBe(true);
  });

  it('ships .postman-template/AGENTS.md (the customer router, distinct from root)', () => {
    const customer = readText('.postman-template/AGENTS.md');
    expect(customer.length, '.postman-template/AGENTS.md must exist and be non-empty').toBeGreaterThan(0);
  });
});
