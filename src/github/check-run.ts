import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import type { LedgerSummary } from '../types.js';

/**
 * D15: best-effort, non-throwing check-run annotation publisher.
 *
 * Emits one `failure` annotation per failing ledger packet (capped at 50 —
 * the GitHub checks API limit per update) through the same `getOctokit`
 * already used by `pr-comment.ts`. No new dependency.
 *
 * `path` is the spec file (the operation location the contract is derived
 * from; per-operation line numbers are NOT available from the current
 * ContractIndex). `message` carries the packet title + a short fingerprint
 * slice. The check-run summary is a packet status table.
 *
 * Any octokit error (e.g. a 403 when `GITHUB_TOKEN` lacks `checks: write`)
 * is `core.warning`'d and swallowed — the sticky comment stays the primary
 * consumption surface. This function NEVER throws into the oracle path.
 */

const ANNOTATION_CAP = 50; // GitHub checks API caps a single update at 50 annotations.

export interface CheckRunAnnotationArgs {
  headSha: string;
  ledger?: LedgerSummary;
  owner: string;
  repo: string;
  specPath?: string;
  token: string;
}

export async function publishCheckRunAnnotations(args: CheckRunAnnotationArgs): Promise<void> {
  try {
    const octokit = getOctokit(args.token);
    const failingPackets = (args.ledger?.packets ?? []).filter((packet) => !packet.passes);
    const annotations = failingPackets.slice(0, 50).map((packet) => {
      const fingerprint = packet.lastFailureFingerprint ? ` [${packet.lastFailureFingerprint.slice(0, 12)}]` : '';
      return {
        annotation_level: 'failure' as const,
        end_line: 1,
        message: `${packet.title}${fingerprint}`,
        path: args.specPath ?? 'openapi.yaml',
        start_line: 1,
        title: packet.key
      };
    });

    const total = args.ledger?.total ?? 0;
    const passing = args.ledger?.passing ?? 0;
    const failing = args.ledger?.failing ?? 0;
    const summary = `Postman TDD contract: ${passing}/${total} packets passing, ${failing} failing.${failingPackets.length > ANNOTATION_CAP ? ` (showing first ${ANNOTATION_CAP} of ${failingPackets.length} failures.)` : ''}`;

    await octokit.rest.checks.create({
      conclusion: 'failure',
      head_sha: args.headSha,
      name: 'Postman TDD Contract',
      owner: args.owner,
      repo: args.repo,
      status: 'completed',
      output: {
        annotations,
        summary,
        title: 'Postman TDD contract failures'
      }
    });
    core.info(`[postman-tdd] Published ${annotations.length} check-run annotation(s).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/403|forbidden|checks: write|Resource not accessible/i.test(message)) {
      core.warning(`[postman-tdd] Could not create check-run annotations (GITHUB_TOKEN likely lacks checks: write permission). Sticky comment remains the primary surface. Error: ${message}`);
    } else {
      core.warning(`[postman-tdd] Check-run annotation publish failed (non-fatal): ${message}`);
    }
  }
}
