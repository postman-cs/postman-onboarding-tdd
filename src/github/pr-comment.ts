import { context, getOctokit } from '@actions/github';

import type { ActionStatus, AgentFailureDocument, PreviewAssetState, PrMetadata } from '../types.js';

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
  failureDocument?: AgentFailureDocument;
  failurePhase?: string;
  specId?: string;
  status: ActionStatus;
  workspaceId?: string;
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

export function renderStickyComment(
  state: PreviewAssetState,
  summary: PrCommentSummary
): string {
  const marker = `${MARKER_START}\n${JSON.stringify(state)}\n${MARKER_END}`;
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

  if (summary.status === 'passed') {
    lines.push('The generated TDD contract collection passed against the current PR implementation.');
  } else if (summary.status === 'cleaned-up') {
    lines.push('PR-scoped TDD preview assets were cleaned up.');
  } else if (summary.status === 'skipped') {
    lines.push('TDD preview is disabled for this repository.');
  } else {
    lines.push(`**Failure phase:** ${summary.failurePhase || summary.failureDocument?.phase || 'unknown'}`);
    const immutablePaths = summary.failureDocument?.immutablePaths || [];
    if (immutablePaths.length > 0) {
      lines.push(`**Immutable paths:** ${immutablePaths.map((path) => `\`${path}\``).join(', ')}`);
    }
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
        lines.push(`- ${target ? `${target}: ` : ''}${failure.message}`);
      }
      if (failures.length > 10) {
        lines.push(`- ...and ${failures.length - 10} more failure(s).`);
      }
    }
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
  return lines.join('\n');
}

export function resolvePrMetadata(inputPrNumber?: number): PrMetadata {
  const repository = process.env.GITHUB_REPOSITORY ||
    (context.repo.owner && context.repo.repo ? `${context.repo.owner}/${context.repo.repo}` : '');
  const event = context.payload;
  const pr = event.pull_request;
  const number = inputPrNumber || Number(pr?.number || event.number || 0);
  if (!number || !Number.isInteger(number)) {
    throw new Error('A pull request number is required. Set pr-number or run on a pull_request event.');
  }
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }
  return {
    branch: pr?.head?.ref || process.env.GITHUB_HEAD_REF || undefined,
    number,
    repository,
    sha: pr?.head?.sha || process.env.GITHUB_SHA || undefined
  };
}
