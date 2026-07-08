import { context, getOctokit } from '@actions/github';

import { isRepairComment, renderRepairComment, type RepairSummary } from '../repair/summary.js';
import type { ActionStatus, AgentFailureDocument, FailurePhase, LedgerSummary, PreviewAssetState, PrMetadata } from '../types.js';

const MARKER_START = '<!-- postman-tdd-preview';
const MARKER_END = '-->';

export interface StickyComment {
  assetState?: PreviewAssetState;
  body: string;
  id: number;
}

export interface PrCommentSummary {
  agentContextArtifactDigest?: string;
  agentContextArtifactId?: number;
  agentContextArtifactName?: string;
  agentTaskPath?: string;
  collectionId?: string;
  collectionName?: string;
  commit?: string;
  failureDocument?: AgentFailureDocument;
  failurePhase?: string;
  ledger?: LedgerSummary;
  specId?: string;
  status: ActionStatus;
  workspaceId?: string;
}

export interface PullRequestDetails {
  baseRepository: string;
  headBranch: string;
  headRepository: string;
  headSha: string;
  isFork: boolean;
  labels: string[];
  number: number;
}

export class GitHubPrClient {
  private readonly octokit: ReturnType<typeof getOctokit>;
  private readonly owner: string;
  private readonly repo: string;

  constructor(token: string, repository: string) {
    this.octokit = getOctokit(token);
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) {
      throw new Error(`GITHUB_REPOSITORY must be owner/repo, got: ${repository}`);
    }
    this.owner = owner;
    this.repo = repo;
  }

  async findStickyComment(prNumber: number): Promise<StickyComment | undefined> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      issue_number: prNumber,
      owner: this.owner,
      per_page: 100,
      repo: this.repo
    });
    const found = comments.find((comment) => comment.body?.includes(MARKER_START));
    if (!found?.body) {
      return undefined;
    }
    return {
      assetState: parseAssetState(found.body),
      body: found.body,
      id: found.id
    };
  }

  async getPullRequest(prNumber: number): Promise<PullRequestDetails> {
    const response = await this.octokit.rest.pulls.get({
      owner: this.owner,
      pull_number: prNumber,
      repo: this.repo
    });
    const data = response.data;
    const headRepository = data.head.repo?.full_name || '';
    const baseRepository = data.base.repo?.full_name || `${this.owner}/${this.repo}`;
    const labels = Array.isArray(data.labels)
      ? data.labels.map((label) => (typeof label === 'string' ? label : label.name)).filter((label): label is string => Boolean(label))
      : [];
    return {
      baseRepository,
      headBranch: data.head.ref,
      headRepository,
      headSha: data.head.sha,
      isFork: headRepository !== baseRepository,
      labels,
      number: data.number
    };
  }

  async upsertRepairComment(prNumber: number, summary: RepairSummary): Promise<number> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      issue_number: prNumber,
      owner: this.owner,
      per_page: 100,
      repo: this.repo
    });
    const body = renderRepairComment(summary);
    const existing = comments.find((comment) => isRepairComment(comment.body));
    if (existing) {
      await this.octokit.rest.issues.updateComment({
        comment_id: existing.id,
        owner: this.owner,
        repo: this.repo,
        body
      });
      return existing.id;
    }
    const created = await this.octokit.rest.issues.createComment({
      issue_number: prNumber,
      owner: this.owner,
      repo: this.repo,
      body
    });
    return created.data.id;
  }

  async upsertStickyComment(
    prNumber: number,
    state: PreviewAssetState,
    summary: PrCommentSummary,
    existingCommentId?: number
  ): Promise<number> {
    const body = renderStickyComment(state, summary);
    if (existingCommentId) {
      await this.octokit.rest.issues.updateComment({
        comment_id: existingCommentId,
        owner: this.owner,
        repo: this.repo,
        body
      });
      return existingCommentId;
    }
    const existing = await this.findStickyComment(prNumber);
    if (existing) {
      await this.octokit.rest.issues.updateComment({
        comment_id: existing.id,
        owner: this.owner,
        repo: this.repo,
        body
      });
      return existing.id;
    }
    const created = await this.octokit.rest.issues.createComment({
      issue_number: prNumber,
      owner: this.owner,
      repo: this.repo,
      body
    });
    return created.data.id;
  }
}

export function parseAssetState(body: string): PreviewAssetState | undefined {
  const start = body.indexOf(MARKER_START);
  if (start === -1) return undefined;
  const jsonStart = body.indexOf('\n', start);
  const end = body.indexOf(MARKER_END, jsonStart);
  if (jsonStart === -1 || end === -1) return undefined;
  const raw = body.slice(jsonStart, end).trim();
  try {
    const parsed = JSON.parse(raw) as PreviewAssetState;
    return parsed.schemaVersion === 1 && Number.isInteger(parsed.prNumber)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseFailureDocument(body: string): AgentFailureDocument | undefined {
  const summary = '<summary>Agent failure JSON</summary>';
  const summaryIndex = body.indexOf(summary);
  if (summaryIndex === -1) return undefined;
  const fenceStart = body.indexOf('```json', summaryIndex);
  if (fenceStart === -1) return undefined;
  const jsonStart = body.indexOf('\n', fenceStart);
  if (jsonStart === -1) return undefined;
  const fenceEnd = body.indexOf('```', jsonStart);
  if (fenceEnd === -1) return undefined;
  const raw = body.slice(jsonStart, fenceEnd).trim();
  try {
    const parsed = JSON.parse(raw) as AgentFailureDocument;
    return parsed.schemaVersion === 1 && parsed.status === 'failed' && Array.isArray(parsed.failures)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

const PACKET_STATUS_BUDGET = 60000;

function renderPacketStatusTable(ledger: LedgerSummary | undefined): string[] {
  if (!ledger || ledger.packets.length === 0) {
    return [];
  }
  const rows = ledger.packets.slice(0, 20);
  const lines = [
    '',
    '## Packet Status',
    '',
    '| Packet | Status | Last failure |',
    '| --- | --- | --- |'
  ];
  for (const packet of rows) {
    const status = packet.passes ? 'pass' : 'fail';
    const fingerprint = packet.lastFailureFingerprint
      ? packet.lastFailureFingerprint.slice(0, 8)
      : '';
    lines.push(`| ${packet.title} | ${status} | ${fingerprint} |`);
  }
  return lines;
}

function renderPacketStatusCountsLines(ledger: LedgerSummary | undefined): string[] {
  if (!ledger) {
    return [];
  }
  return [
    '',
    `**Packet Status:** ${ledger.total} total, ${ledger.passing} passing, ${ledger.failing} failing. Full ledger in the \`.postman-tdd/ledger.json\` run artifact.`
  ];
}

export function renderStickyComment(
  state: PreviewAssetState,
  summary: PrCommentSummary
): string {
  const marker = `${MARKER_START}\n${JSON.stringify(markerAssetState(state, summary.status))}\n${MARKER_END}`;
  let packetStatusStart = 0;
  let packetStatusEnd = 0;
  const statusLabel = summary.status === 'passed'
    ? 'PASSED'
    : summary.status === 'cleaned-up'
      ? 'CLEANED UP'
      : summary.status === 'skipped'
        ? 'SKIPPED'
        : 'FAILED';
  const lines = [
    marker,
    `# Postman TDD Preview (${statusLabel})`,
    '',
    `**Workspace:** ${summary.workspaceId || state.workspaceId || '(unresolved)'}`,
    `**Spec:** ${summary.specId || state.specId || '(unresolved)'}`,
    `**Collection:** ${summary.collectionId || state.collectionId || '(unresolved)'}`,
    ''
  ];
  const commit = summary.failureDocument?.commit || summary.commit;
  if (commit) {
    lines.push(`**Generated for commit:** \`${commit}\``);
    lines.push('');
  }

  if (summary.status === 'passed') {
    lines.push('The generated TDD contract collection passed against the current PR implementation.');
    lines.push('');
    lines.push('Success: `Postman TDD Preview` passed for the latest PR head commit.');
  } else if (summary.status === 'cleaned-up') {
    lines.push('PR-scoped TDD preview assets were cleaned up.');
  } else if (summary.status === 'skipped') {
    lines.push('TDD preview is disabled for this repository.');
  } else {
    const failurePhase = normalizeFailurePhase(summary.failureDocument?.phase || summary.failurePhase);
    lines.push(`**Failure phase:** ${failurePhase || 'unknown'}`);
    const immutablePaths = summary.failureDocument?.immutablePaths || [];
    if (immutablePaths.length > 0) {
      lines.push(`**Immutable paths:** ${immutablePaths.map((path) => `\`${path}\``).join(', ')}`);
    }
    const criteria = summary.failureDocument?.successCriteria;
    if (criteria) {
      lines.push(`**Success:** \`${criteria.requiredCheck}\` passes on the latest PR head commit.`);
      lines.push('Before acting, compare `commit` in the Agent failure JSON to the current PR head SHA. If they differ, wait for the next TDD run.');
    }
    lines.push('');
    lines.push(...renderFailureHandoff(summary.failureDocument, failurePhase));
    lines.push('');
    if (summary.agentContextArtifactName) {
      const artifactDetails = [
        summary.agentContextArtifactId ? `id: ${summary.agentContextArtifactId}` : '',
        summary.agentContextArtifactDigest ? `digest: ${summary.agentContextArtifactDigest}` : ''
      ].filter(Boolean).join(', ');
      lines.push(`Agent context artifact: \`${summary.agentContextArtifactName}\`${artifactDetails ? ` (${artifactDetails})` : ''}.`);
      lines.push('Artifact contents: `.postman-tdd/agent-task.md`, `.postman-tdd/failures.json`, and `.postman-tdd/immutable-spec-guard.mjs`.');
    } else {
      lines.push('Agent context files generated during the run: `.postman-tdd/agent-task.md`, `.postman-tdd/failures.json`, and `.postman-tdd/immutable-spec-guard.mjs`.');
    }
    if (summary.agentTaskPath) {
      lines.push(`Agent entrypoint: \`${summary.agentTaskPath}\``);
    }
    const failures = summary.failureDocument?.failures || [];
    if (failures.length > 0) {
      lines.push('');
      lines.push('## Current Failures');
      for (const failure of failures.slice(0, 10)) {
        const target = [failure.method, failure.path].filter(Boolean).join(' ');
        const operation = failure.operationId ? `${failure.operationId}: ` : '';
        const assertion = failure.assertion ? ` [${failure.assertion}]` : '';
        lines.push(`- ${operation}${target || 'collection'}${assertion}: ${failure.message}`);
      }
      if (failures.length > 10) {
        lines.push(`- ...and ${failures.length - 10} more failure(s).`);
      }
    }
    packetStatusStart = lines.length;
    lines.push(...renderPacketStatusTable(summary.ledger));
    packetStatusEnd = lines.length;
    if (summary.failureDocument) {
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Agent failure JSON</summary>');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(summary.failureDocument, null, 2));
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    }
  }

  lines.push('');
  lines.push('_Generated by Postman Onboarding TDD._');
  let body = lines.join('\n');
  if (body.length > PACKET_STATUS_BUDGET && packetStatusEnd > packetStatusStart) {
    lines.splice(
      packetStatusStart,
      packetStatusEnd - packetStatusStart,
      ...renderPacketStatusCountsLines(summary.ledger)
    );
    body = lines.join('\n');
  }
  return body;
}

function normalizeFailurePhase(value: string | undefined): FailurePhase | 'unknown' {
  switch (value) {
    case 'asset_upsert':
    case 'cleanup':
    case 'collection_run':
    case 'config':
    case 'health_check':
    case 'immutable_spec':
    case 'immutable_state_tampered':
    case 'none':
    case 'service_startup':
    case 'test_ratchet':
    case 'workspace':
      return value;
    default:
      return 'unknown';
  }
}

function renderFailureHandoff(
  document: AgentFailureDocument | undefined,
  phase: FailurePhase | 'unknown'
): string[] {
  const guidance = failureGuidance(document, phase);
  return [
    '## Next Action',
    '',
    `**What happened:** ${guidance.whatHappened}`,
    `**Next action:** ${guidance.nextAction}`,
    `**Repair eligibility:** ${guidance.repairEligibility}`,
    `**Done when:** ${guidance.doneWhen}`
  ];
}

function failureGuidance(
  document: AgentFailureDocument | undefined,
  phase: FailurePhase | 'unknown'
): {
  doneWhen: string;
  nextAction: string;
  repairEligibility: string;
  whatHappened: string;
} {
  const doneWhen = document?.successCriteria?.requiredCheck
    ? `\`${document.successCriteria.requiredCheck}\` passes on the latest PR head commit.`
    : '`Postman TDD Preview` passes on the latest PR head commit.';
  const implementationRepair = 'Eligible for automated repair when repair is enabled, the failure context matches the latest PR head, the PR is not from a fork, and the fix stays within `tdd.repair.allowedWritePaths`.';
  const serviceDetails = serviceFailureDetails(document);
  switch (phase) {
    case 'config':
      return {
        doneWhen,
        nextAction: 'Fix `.postman-template/onboarding.yml` or the action inputs, then push a new commit or rerun the workflow.',
        repairEligibility: 'Not eligible for automated implementation repair because the action could not load a valid TDD configuration.',
        whatHappened: 'The onboarding configuration or action inputs failed validation before preview assets or collection checks could run.'
      };
    case 'workspace':
      return {
        doneWhen,
        nextAction: 'Check the configured workspace name/id, Postman credentials, team settings, and workspace access.',
        repairEligibility: 'Not eligible for automated implementation repair because this is a Postman workspace setup issue.',
        whatHappened: 'The action could not resolve the configured Postman workspace for this PR preview.'
      };
    case 'asset_upsert':
      return {
        doneWhen,
        nextAction: 'Check the OpenAPI document, Postman credentials, team access, and any asset validation errors, then rerun preview.',
        repairEligibility: 'Not eligible for automated implementation repair because Postman preview assets were not created or updated.',
        whatHappened: 'The action could not create or update the PR-scoped Postman spec/collection assets.'
      };
    case 'service_startup':
      return {
        doneWhen,
        nextAction: 'Fix the service startup command or its repository setup so the process stays running long enough for the health check.',
        repairEligibility: implementationRepair,
        whatHappened: `The configured start command exited before the health check passed.${serviceDetails}`
      };
    case 'health_check':
      return {
        doneWhen,
        nextAction: 'Fix the service or health endpoint so the configured health URL returns a successful response before the timeout.',
        repairEligibility: implementationRepair,
        whatHappened: `The service started, but the configured health check did not pass in time.${serviceDetails}`
      };
    case 'collection_run':
      return {
        doneWhen,
        nextAction: 'Fix the PR implementation so the API behavior matches the generated Postman TDD contract. Do not edit immutable paths unless the API intent truly changed.',
        repairEligibility: implementationRepair,
        whatHappened: 'The generated Postman collection ran against the PR service and found contract failures.'
      };
    case 'immutable_spec':
      return {
        doneWhen,
        nextAction: 'Revert changes to immutable paths or start a separate API-contract change with the intended OpenAPI update.',
        repairEligibility: 'Not eligible for automated implementation repair because immutable API contract files changed.',
        whatHappened: 'An immutable path changed after the preview baseline was recorded.'
      };
    case 'immutable_state_tampered':
      return {
        doneWhen,
        nextAction: 'Wait for a fresh preview run or ask a maintainer to inspect the sticky comment state and signing key configuration.',
        repairEligibility: 'Not eligible for automated implementation repair until the signed immutable baseline can be trusted.',
        whatHappened: 'The signed immutable-state marker could not be verified, so the failure context is treated as tampered.'
      };
    case 'test_ratchet':
      return {
        doneWhen,
        nextAction: 'Restore the removed or weakened contract assertions, or — for a deliberate removal — add the `postman-tdd-allow-ratchet-removal` label to the PR and re-run. Alternatively, open a separate contract-change PR.',
        repairEligibility: 'Not eligible for automated implementation repair because previously-passing contract assertions were removed or weakened.',
        whatHappened: 'Previously-passing contract assertions were removed or weakened in this PR.'
      };
    case 'cleanup':
      return {
        doneWhen,
        nextAction: 'Inspect cleanup logs and Postman asset permissions, then rerun cleanup if PR-scoped assets remain.',
        repairEligibility: 'Not eligible for automated implementation repair because cleanup does not patch PR code.',
        whatHappened: 'The action encountered a cleanup failure while deleting PR-scoped preview assets.'
      };
    case 'none':
    case 'unknown':
    default:
      return {
        doneWhen,
        nextAction: 'Inspect the current failures and agent context below, then rerun preview after applying the appropriate fix.',
        repairEligibility: 'Depends on the failure phase and repair configuration.',
        whatHappened: 'The preview failed before the action could classify the phase clearly.'
      };
  }
}

function serviceFailureDetails(document: AgentFailureDocument | undefined): string {
  const details = [
    document?.startCommand ? `startCommand=\`${document.startCommand}\`` : '',
    document?.healthUrl ? `healthUrl=\`${document.healthUrl}\`` : '',
    document?.timeoutSeconds ? `timeout=${document.timeoutSeconds}s` : ''
  ].filter(Boolean).join(', ');
  return details ? ` (${details})` : '';
}

function markerAssetState(state: PreviewAssetState, status: ActionStatus): PreviewAssetState {
  if (status === 'failed') {
    return state;
  }
  const next = { ...state };
  delete next.immutableState;
  return next;
}

export function resolvePrMetadata(inputPrNumber?: number): PrMetadata {
  const repository = process.env.GITHUB_REPOSITORY ||
    (context.repo.owner && context.repo.repo ? `${context.repo.owner}/${context.repo.repo}` : '');
  const event = context.payload;
  const pr = event.pull_request;
  const workflowRun = event.workflow_run as {
    head_branch?: string;
    head_sha?: string;
    pull_requests?: Array<{ number?: number }>;
  } | undefined;
  const workflowRunPr = workflowRun?.pull_requests?.[0];
  const number = inputPrNumber || Number(pr?.number || workflowRunPr?.number || event.number || 0);
  if (!number || !Number.isInteger(number)) {
    throw new Error('A pull request number is required. Set pr-number or run on a pull_request event.');
  }
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }
  return {
    branch: pr?.head?.ref || workflowRun?.head_branch || process.env.GITHUB_HEAD_REF || undefined,
    number,
    repository,
    sha: pr?.head?.sha || workflowRun?.head_sha || process.env.GITHUB_SHA || undefined
  };
}
