import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const runnerTest = readFileSync(join(process.cwd(), 'tests/runner.test.ts'), 'utf8');

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
const distParity = jobText(ciWorkflow, 'dist-parity');
const ready = jobText(ciWorkflow, 'ready');

describe('CI workflow contract', () => {
  it('uses PR-only supersession and approved action majors', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    // Exact counts — checkout/setup-node appears in gate, dist-parity, and windows.
    expect(actionUses(ciWorkflow, 'checkout')).toEqual([
      'uses: actions/checkout@v7',
      'uses: actions/checkout@v7',
      'uses: actions/checkout@v7',
    ]);
    expect(actionUses(ciWorkflow, 'setup-node')).toEqual([
      'uses: actions/setup-node@v7',
      'uses: actions/setup-node@v7',
      'uses: actions/setup-node@v7',
    ]);
    expect(actionUses(ciWorkflow, 'upload-artifact')).toEqual(['uses: actions/upload-artifact@v7']);
    expect(ciWorkflow).not.toMatch(/uses:\s*actions\/(?:checkout|setup-node|upload-artifact)@v(?!7\b)\d+/);

    // Shallow checkout default: this TDD maintainer CI has no commitlint full-history need.
    expect(ciWorkflow).not.toMatch(/^\s*fetch-depth:\s*/m);

    // Permissions and check names stay fixed; ready aggregates required jobs.
    expect(ciWorkflow).toContain('permissions:\n  contents: read');
    expect(linux).toMatch(/^ {2}gate:\n/);
    expect(windows).toContain('name: Windows gate');
    expect(distParity).toContain('needs: gate');
    expect(ready).toContain('needs: [gate, dist-parity, windows]');
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
    // Pinned binary path — ambient PATH `actionlint` must not satisfy this.
    expect(runGates).toContain(
      'run actionlint "$ACTIONLINT_BIN" .github/workflows/*.yml .postman-template/workflows/*.yml .postman-template/workflows/agents/*.yml',
    );
    // Exact ordered launches — extras/duplicates must fail (C1/R1). Dist parity is now a separate job.
    expect(linuxGateLaunches(runGates)).toEqual([
      'run lint       npm run lint',
      'run test       npm test',
      'run typecheck  npm run typecheck',
      'run actionlint "$ACTIONLINT_BIN" .github/workflows/*.yml .postman-template/workflows/*.yml .postman-template/workflows/agents/*.yml',
    ]);

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('check:dist');
    expect(runGates).not.toContain('run dist');
    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
  });

  it('runs dist parity as a separate job after gate with rebuild and expected-dist upload', () => {
    expect(distParity).toContain('needs: gate');
    expect(distParity).toContain('runs-on: ubuntu-24.04');
    expect(distParity).toContain('- run: npm ci');
    expect(distParity).toContain('- run: npm run build');
    expect(distParity).toContain('- run: npm run check:dist:parity');
    expect(distParity).not.toContain('check:dist:assert');
    expect(distParity).not.toContain('check:dist:shape');
    const upload = namedStep(distParity, 'Upload expected dist on mismatch');
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('uses: actions/upload-artifact@v7');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
    expect(linux).not.toContain('name: expected-dist');
  });

  it('aggregates gate, dist-parity, and windows in a required ready job', () => {
    expect(ready).toContain('if: always()');
    expect(ready).toContain('needs: [gate, dist-parity, windows]');
    expect(ready).toContain('needs.gate.result');
    expect(ready).toContain('needs.dist-parity.result');
    expect(ready).toContain('needs.windows.result');
    expect(ready).toContain('exit 1');
    expect(ready).toContain('CI ready');
  });

  it('caches Windows node_modules with exact key and miss-only prefer-offline npm ci', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    // Job must stay required — no soft-fail or skip (C3/R8 / C4/R9).
    expect(windows).not.toMatch(/continue-on-error:/);
    expect(windows).not.toMatch(/^[ ]{4}if:/m);

    expect(windows).toContain('node-version: 24');
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    expect(windows).toContain('id: windows-node-modules');
    // Semantic pin: any 40-char hex SHA, consistent across file, with semver comment
    {
      const cachePins = [...ciWorkflow.matchAll(/actions\/cache@([0-9a-f]{40})/g)].map((m) => m[1]!);
      expect(cachePins.length).toBeGreaterThanOrEqual(1);
      for (const sha of cachePins) expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(new Set(cachePins).size).toBe(1);
      expect(windows).toMatch(/uses:\s*actions\/cache@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/);
    }
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain(
      "key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}",
    );
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('restore-key');

    // Exact hit skips only install; miss runs the exact prefer-offline flags once.
    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(0);
  });

  it('runs sole direct unconditional unfiltered node --run test on Windows with no queue', () => {
    expect(windows.match(/^\s*- run: node --run test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).not.toContain('npm test');
    expect(windows).not.toMatch(/node --run test --/);
    expect(windows).not.toMatch(/node --run test -/);

    const cacheIdx = windows.indexOf('id: windows-node-modules');
    const missInstallIdx = windows.indexOf('npm ci --prefer-offline --no-audit --no-fund');
    const testIdx = windows.indexOf('- run: node --run test');
    expect(cacheIdx).toBeGreaterThanOrEqual(0);
    expect(missInstallIdx).toBeGreaterThan(cacheIdx);
    expect(testIdx).toBeGreaterThan(missInstallIdx);

    expect(windows).not.toContain('- name: Run gates');
    expect(windows).not.toContain('shell: pwsh');
    expect(windows).not.toContain('$MAX_PARALLEL_GATES');
    expect(windows).not.toContain('MAX_PARALLEL_GATES');
    expect(windows).not.toContain('Start-Process');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toMatch(/@\{ Name = '/);

    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('check:dist');
    expect(windows).not.toContain('actionlint');
  });

  it('keeps native where.exe/PowerShell/cmd runtime tests reachable via unfiltered Windows node --run test', () => {
    // Unfiltered suite is the only Windows runtime command — no path/name filters.
    expect(windows.match(/^\s*- run: node --run test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).not.toContain('npm test');
    expect(windows).not.toMatch(/node --run test --/);

    expect(runnerTest).toContain('where.exe postman');
    expect(runnerTest).toContain('pwsh.exe');
    expect(runnerTest).toContain('uses cmd.exe environment expansion for Windows collection runs');
    expect(runnerTest).toContain(
      'postman collection run "%POSTMAN_TDD_COLLECTION_ID%" --env-var "baseUrl=%POSTMAN_TDD_BASE_URL%"',
    );
  });

  it('uses the pinned actionlint binary without Go', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash',
    );
    expect(install.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('defines the read-only dist parity split exactly', () => {
    expect(packageJson.scripts['check:dist:parity']).toBe('git diff --exit-code -- dist');
    // Shape is same as parity since no artifact verifier exists — kept as alias for queue symmetry.
    expect(packageJson.scripts['check:dist:shape']).toBe('git diff --exit-code -- dist');
    expect(packageJson.scripts['check:dist:assert']).toBe('npm run check:dist:parity');
    expect(packageJson.scripts['check:dist']).toBe('npm run build && npm run check:dist:parity');
  });
});
