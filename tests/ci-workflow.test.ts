import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(workflow: string, jobId: string): string {
  const jobsBody = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^[ ]{2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Every uses: ref for an actions/* action — majors, branches, tags, and SHAs. */
function actionUses(source: string, action: string): string[] {
  return source.match(new RegExp(`uses:\\s*actions/${action}@[^\\s#]+`, 'g')) ?? [];
}

/** Static `run <gate> …` launch lines; excludes the `run()` function declaration. */
function linuxGateLaunches(runGatesStep: string): string[] {
  return (runGatesStep.match(/^\s*run [a-z][\w-]* .+$/gm) ?? []).map((line) => line.trim());
}

/** Fail if `earlier` is missing, `later` is missing, or `later` appears first. */
function expectBefore(source: string, earlier: string, later: string): void {
  const earlierAt = source.indexOf(earlier);
  const laterAt = source.indexOf(later);
  expect(earlierAt).toBeGreaterThanOrEqual(0);
  expect(laterAt).toBeGreaterThanOrEqual(0);
  expect(earlierAt).toBeLessThan(laterAt);
}

const linux = jobText(ciWorkflow, 'gate');
const windows = jobText(ciWorkflow, 'windows');

describe('CI workflow contract', () => {
  it('uses PR-only supersession and approved action majors', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    // Exact counts — a single existential @v7 match must not mask a missing or major-drifted use.
    expect(actionUses(ciWorkflow, 'checkout')).toEqual([
      'uses: actions/checkout@v7',
      'uses: actions/checkout@v7',
    ]);
    expect(actionUses(ciWorkflow, 'setup-node')).toEqual([
      'uses: actions/setup-node@v7',
      'uses: actions/setup-node@v7',
    ]);
    expect(actionUses(ciWorkflow, 'upload-artifact')).toEqual(['uses: actions/upload-artifact@v7']);
    expect(ciWorkflow).not.toMatch(/uses:\s*actions\/(?:checkout|setup-node|upload-artifact)@v(?!7\b)\d+/);

    // Shallow checkout default: this TDD maintainer CI has no commitlint full-history need.
    expect(ciWorkflow).not.toMatch(/^\s*fetch-depth:\s*/m);
  });

  it('builds once before a bounded Linux read-only gate queue', () => {
    expect(linux).toContain('runs-on: ubuntu-24.04');
    expect(linux.match(/^\s*- run: npm run build\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run build')).toBeLessThan(linux.indexOf('- name: Run gates'));

    const runGates = namedStep(linux, 'Run gates');
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    // Cap must stay wired into launch — MAX_PARALLEL_GATES alone is not enough.
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    // Cap enforcement must precede child launch (C1/R1).
    expectBefore(
      runGates,
      'while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done',
      '( "$@" ) >"$n.log" 2>&1 & pid[$n]=$!',
    );
    // Final drain before status/result iteration; pass/fail before aggregate exit (C3/R8).
    expectBefore(runGates, 'while [ "${#pid[@]}" -gt 0 ]; do finish_one; done', 'for n in "${names[@]}"; do');
    expectBefore(runGates, 'gate:$n=pass', 'exit $fail');
    expectBefore(runGates, 'gate:$n=fail', 'exit $fail');

    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run dist       npm run check:dist:assert');
    // Pinned binary path — ambient PATH `actionlint` must not satisfy this.
    expect(runGates).toContain(
      'run actionlint "$ACTIONLINT_BIN" .github/workflows/*.yml .postman-template/workflows/*.yml .postman-template/workflows/agents/*.yml',
    );
    // Exact ordered launches — extras/duplicates must fail (C1/R1).
    expect(linuxGateLaunches(runGates)).toEqual([
      'run lint       npm run lint',
      'run test       npm test',
      'run typecheck  npm run typecheck',
      'run dist       npm run check:dist:assert',
      'run actionlint "$ACTIONLINT_BIN" .github/workflows/*.yml .postman-template/workflows/*.yml .postman-template/workflows/agents/*.yml',
    ]);

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toMatch(/npm run check:dist(?:\s|$)/);
    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
  });

  it('retains Windows coverage with a bounded PowerShell read-only gate queue', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    // Job must stay required — no soft-fail or skip (C3/R8 / C4/R9).
    expect(windows).not.toMatch(/continue-on-error:/);
    expect(windows).not.toMatch(/^[ ]{4}if:/m);
    expect(windows.match(/^\s*- run: npm run build\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.indexOf('- run: npm run build')).toBeLessThan(windows.indexOf('- name: Run gates'));

    const runGates = namedStep(windows, 'Run gates');
    expect(runGates).toContain('$MAX_PARALLEL_GATES = 2');
    expect(runGates).toContain('while ($active.Count -ge $MAX_PARALLEL_GATES) { Complete-One }');
    expect(runGates).toContain('while ($active.Count -gt 0) { Complete-One }');
    expect(runGates).toContain('Start-Process');

    // Cap enforcement before Start-Process; drain after launch block and before reporting (C1/R1).
    expectBefore(
      runGates,
      'while ($active.Count -ge $MAX_PARALLEL_GATES) { Complete-One }',
      'Start-Process',
    );
    expectBefore(runGates, 'Start-Process', 'while ($active.Count -gt 0) { Complete-One }');
    expectBefore(runGates, 'while ($active.Count -gt 0) { Complete-One }', 'gate:$($gate.Name)=pass');
    // Pass/fail reporting before aggregate exit (C3/R8).
    expectBefore(runGates, 'gate:$($gate.Name)=pass', 'if ($failed) { exit 1 }');
    expectBefore(runGates, 'gate:$($gate.Name)=fail', 'if ($failed) { exit 1 }');

    expect(runGates).toContain("@{ Name = 'lint'; Arguments = @('run', 'lint') }");
    expect(runGates).toContain("@{ Name = 'test'; Arguments = @('test') }");
    expect(runGates).toContain("@{ Name = 'typecheck'; Arguments = @('run', 'typecheck') }");
    expect(runGates).toContain("@{ Name = 'dist'; Arguments = @('run', 'check:dist:assert') }");
    expect(runGates.match(/@\{ Name = '[^']+'; Arguments = @[^}]+\}/g) ?? []).toHaveLength(4);

    // Queue stays read-only: no mutating build / check:dist in PowerShell gate args.
    expect(runGates).not.toMatch(/Arguments = @\('run', 'build'\)/);
    expect(runGates).not.toMatch(/Arguments = @\('run', 'check:dist'\)/);
    expect(runGates).toContain('gate:$($gate.Name)=pass');
    expect(runGates).toContain('gate:$($gate.Name)=fail');
    expect(runGates).toContain('::group::$($gate.Name)');
  });

  it('uses the pinned actionlint binary without Go', () => {
    expect(ciWorkflow).toContain('1.7.11 "$RUNNER_TEMP"');
    expect(ciWorkflow).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('defines the read-only dist assertion exactly', () => {
    expect(packageJson.scripts['check:dist:assert']).toBe('git diff --exit-code -- dist');
  });
});
