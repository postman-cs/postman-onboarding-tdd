import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
