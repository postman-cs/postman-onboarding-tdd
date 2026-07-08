import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedOnboardingConfig } from './types.js';
import type { ValidationState } from './validation-types.js';

/**
 * The six required reference docs every shipped/copyed harness router must
 * route to (D24 rule 4). Stems are file basenames without the `.md` suffix;
 * the post-copy path form is `.agents/references/<stem>.md`.
 */
export function requiredReferenceDocs(): string[] {
  return [
    'tdd-check',
    'failure-document',
    'repair-loop',
    'immutable-spec-guard',
    'branch-and-commit',
    'execplan-skeleton'
  ];
}

/**
 * D21: every harness lint issue is an imperative agent remediation
 * instruction, not a bare error. This helper centralizes the `To fix: ` shape
 * so tests assert one format and consumers can tell harness errors apart.
 */
export function harnessRemediation(instruction: string): string {
  return `To fix: ${instruction}`;
}

/**
 * Extract every distinct `.agents/references/<name>.md` path token from a
 * router's source text, returning the `<name>` stems deduped in first-seen
 * order (D24 rule 2/3). Pure — no filesystem access.
 */
export function parseRouterReferences(routerSource: string): string[] {
  const seen = new Set<string>();
  const stems: string[] = [];
  const pattern = /\.agents\/references\/([^\s)/]+)\.md/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(routerSource)) !== null) {
    const stem = match[1];
    if (stem !== undefined && !seen.has(stem)) {
      seen.add(stem);
      stems.push(stem);
    }
  }
  return stems;
}

/**
 * D19 opt-in gate. The harness lint runs if EITHER (a) the resolved config
 * has `harness.enabled === true`, OR (b) a root `AGENTS.md` exists in the
 * workspace (presence-based opt-in — a customer who copied the harness in
 * gets linted without editing config). If neither holds, lint is inert.
 */
export function harnessOptIn(
  config: { harness?: { enabled: boolean } } | undefined,
  workspaceRoot: string
): boolean {
  if (config?.harness?.enabled === true) return true;
  return existsSync(join(workspaceRoot, 'AGENTS.md'));
}

/**
 * D22/D24: the harness lint pass. Opt-in gated (D19) — if the customer has
 * not opted in via `tdd.harness.enabled` or a root `AGENTS.md`, this pushes
 * nothing to `state` and validation-error-count/summary are byte-identical to
 * pre-P4. When opted in, it enforces the D24 router internal-consistency
 * rules, pushing every issue as an imperative `To fix:` remediation (D21) to
 * the SAME `state.errors`/`state.warnings` arrays the other validate checks
 * feed, so the existing summary/throw machinery surfaces them unchanged (D23).
 */
export function validateHarness(
  config: ResolvedOnboardingConfig | undefined,
  state: ValidationState,
  workspaceRoot: string
): void {
  if (!harnessOptIn(config, workspaceRoot)) return;

  const agentsPath = join(workspaceRoot, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    state.errors.push({
      message: harnessRemediation('create AGENTS.md at the repository root by copying .postman-template/AGENTS.md.')
    });
    return;
  }

  const routerSource = readFileSync(agentsPath, 'utf8');
  const referenced = parseRouterReferences(routerSource);
  const required = requiredReferenceDocs();
  const referencesDir = join(workspaceRoot, '.agents', 'references');

  // D24 rule 2: routing table must contain at least one reference path.
  if (referenced.length === 0) {
    state.errors.push({
      message: harnessRemediation('add a routing-table row that references at least one .agents/references/<name>.md path to AGENTS.md.')
    });
  }

  // D24 rule 4: every required doc must be routed.
  for (const stem of required) {
    if (!referenced.includes(stem)) {
      state.errors.push({
        message: harnessRemediation(`add a routing-table row that references .agents/references/${stem}.md to AGENTS.md, or create that reference file.`)
      });
    }
  }

  // D24 rule 3: every routed doc must exist; rule 5: required docs, when
  // present, must be non-empty with an H1 first line.
  for (const stem of referenced) {
    const docPath = join(referencesDir, `${stem}.md`);
    if (!existsSync(docPath)) {
      state.errors.push({
        message: harnessRemediation(`create .agents/references/${stem}.md (referenced by AGENTS.md) at the repository root.`)
      });
      continue;
    }
    if (!required.includes(stem)) continue;
    const content = readFileSync(docPath, 'utf8');
    if (content.trim().length === 0) {
      state.errors.push({
        message: harnessRemediation(`populate .agents/references/${stem}.md with content starting with an # heading.`)
      });
      continue;
    }
    if (!content.trimStart().startsWith('#')) {
      state.errors.push({
        message: harnessRemediation(`start .agents/references/${stem}.md with an # heading.`)
      });
    }
  }

  // D24 rule 1: AGENTS.md <=100 non-empty lines is a design target (WARNING).
  const nonEmptyLines = routerSource.split('\n').filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length > 100) {
    state.warnings.push({
      message: `AGENTS.md has ${nonEmptyLines.length} non-empty lines; keep it at or under 100 for agent readability.`
    });
  }

  // D24: orphan reference files (present on disk but not routed) => WARNING.
  if (existsSync(referencesDir)) {
    const onDisk = readdirSync(referencesDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.slice(0, -3));
    for (const stem of onDisk) {
      if (!referenced.includes(stem)) {
        state.warnings.push({
          message: `.agents/references/${stem}.md exists but is not routed by AGENTS.md; either route it or remove it.`
        });
      }
    }
  }
}
