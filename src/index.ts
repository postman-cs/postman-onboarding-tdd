import * as core from '@actions/core';
import { readFileSync } from 'node:fs';

import { createFailureDocument, writeAgentContext } from './agent-context.js';
import { loadOnboardingConfig, patchWorkspaceId, resolveWorkspacePath, validateConfigWriteMode } from './config.js';
import { buildContractIndex, instrumentContractCollection, parseOpenApiDocument } from './contract.js';
import { GitHubPrClient, resolvePrMetadata } from './github/pr-comment.js';
import { commitConfigWriteback } from './github/repo-mutation.js';
import { resolvePostmanEndpointProfile, parsePostmanRegion, parsePostmanStack } from './postman/base-urls.js';
import { PostmanClient } from './postman/client.js';
import {
  ensurePostmanCli,
  runCommand,
  runTddCollection,
  startBackgroundCommand,
  waitForHealth
} from './runner.js';
import { createSecretMasker, sanitizeLogExcerpt } from './secrets.js';
import type {
  ActionInputs,
  AgentFailure,
  AgentFailureDocument,
  FailurePhase,
  PreviewAssetState,
  ResolvedOnboardingConfig
} from './types.js';

const AGENT_CONTEXT_DIR = '.postman-tdd';

export interface RunActionOptions {
  githubClient?: GitHubPrClient;
  postmanClient?: PostmanClient;
}

export function readActionInputs(): ActionInputs {
  const prNumberInput = core.getInput('pr-number');
  const modeRaw = core.getInput('mode') || 'run';
  if (modeRaw !== 'run' && modeRaw !== 'cleanup') {
    throw new Error(`Unsupported mode "${modeRaw}". Expected run or cleanup`);
  }
  return {
    committerEmail: core.getInput('committer-email') || 'support@postman.com',
    committerName: core.getInput('committer-name') || 'Postman',
    configWriteMode: validateConfigWriteMode(core.getInput('config-write-mode') || 'commit-and-push'),
    githubToken: core.getInput('github-token', { required: true }),
    mode: modeRaw,
    onboardingConfigPath: core.getInput('onboarding-config-path') || '.postman-template/onboarding.yml',
    postmanAccessToken: core.getInput('postman-access-token') || undefined,
    postmanApiKey: core.getInput('postman-api-key', { required: true }),
    postmanRegion: parsePostmanRegion(core.getInput('postman-region') || 'us'),
    postmanStack: parsePostmanStack(core.getInput('postman-stack') || 'prod'),
    prNumber: prNumberInput ? Number(prNumberInput) : undefined,
    projectName: core.getInput('project-name') || undefined,
    specPath: core.getInput('spec-path') || undefined,
    workspaceTeamId: core.getInput('workspace-team-id') || undefined
  };
}

export async function runAction(options: RunActionOptions = {}): Promise<void> {
  const inputs = readActionInputs();
  core.setSecret(inputs.postmanApiKey);
  core.setSecret(inputs.githubToken);
  if (inputs.postmanAccessToken) core.setSecret(inputs.postmanAccessToken);

  const mask = createSecretMasker([
    inputs.postmanApiKey,
    inputs.githubToken,
    inputs.postmanAccessToken
  ]);
  const endpointProfile = resolvePostmanEndpointProfile(inputs.postmanStack, inputs.postmanRegion);
  const postman = options.postmanClient ?? new PostmanClient({
    apiKey: inputs.postmanApiKey,
    baseUrl: endpointProfile.apiBaseUrl,
    secretMasker: mask
  });
  const pr = resolvePrMetadata(inputs.prNumber);
  const github = options.githubClient ?? new GitHubPrClient(inputs.githubToken, pr.repository);
  let prCommentId = '';
  let currentPhase: FailurePhase = 'config';
  let failurePublished = false;
  let state: PreviewAssetState = {
    prNumber: pr.number,
    schemaVersion: 1
  };

  try {
    const sticky = await github.findStickyComment(pr.number);
    prCommentId = sticky?.id ? String(sticky.id) : '';
    state = {
      ...state,
      ...(sticky?.assetState?.prNumber === pr.number ? sticky.assetState : {})
    };

    const config = loadOnboardingConfig({
      configPath: inputs.onboardingConfigPath,
      projectNameOverride: inputs.projectName,
      specPathOverride: inputs.specPath
    });

    setStandardOutputs({
      agentTaskPath: `${AGENT_CONTEXT_DIR}/agent-task.md`,
      failuresJsonPath: `${AGENT_CONTEXT_DIR}/failures.json`
    });

    if (!config.tddEnabled) {
      core.setOutput('status', 'skipped');
      core.setOutput('failure-phase', 'none');
      return;
    }

    if (inputs.mode === 'cleanup') {
      currentPhase = 'cleanup';
      await cleanupPreviewAssets({ github, postman, prNumber: pr.number, state });
      prCommentId = String(await github.upsertStickyComment(pr.number, state, {
        status: 'cleaned-up',
        workspaceId: state.workspaceId,
        specId: state.specId,
        collectionId: state.collectionId
      }, prCommentId ? Number(prCommentId) : undefined));
      core.setOutput('status', 'cleaned-up');
      core.setOutput('failure-phase', 'none');
      core.setOutput('pr-comment-id', prCommentId);
      return;
    }

    currentPhase = 'workspace';
    const resolvedWorkspace = await resolveTddWorkspace({
      config,
      inputs,
      postman,
      repository: pr.repository
    });
    state.workspaceId = resolvedWorkspace.workspaceId;
    if (resolvedWorkspace.configCommitSha) {
      core.setOutput('config-commit-sha', resolvedWorkspace.configCommitSha);
    }

    currentPhase = 'asset_upsert';
    const assetNames = createAssetNames(pr.number, config.projectName);
    const assetResult = await upsertPreviewAssets({
      assetNames,
      config,
      postman,
      state
    });
    state = {
      ...state,
      collectionId: assetResult.collectionId,
      specId: assetResult.specId,
      workspaceId: resolvedWorkspace.workspaceId
    };
    core.setOutput('workspace-id', state.workspaceId || '');
    core.setOutput('spec-id', state.specId || '');
    core.setOutput('tdd-collection-id', state.collectionId || '');

    await ensurePostmanCli(inputs.postmanApiKey, {
      cliInstallUrl: endpointProfile.cliInstallUrl,
      mask,
      postmanRegion: inputs.postmanRegion
    });

    currentPhase = 'service_startup';
    const running = startBackgroundCommand(config.runtime.startCommand, { mask });
    try {
      const health = await waitForHealth(
        config.runtime.healthUrl,
        running,
        config.runtime.timeoutSeconds,
        mask
      );
      if (!health.ok) {
        const document = createFailureDocument({
          baseUrl: config.runtime.baseUrl,
          collectionName: assetNames.collectionName,
          commit: pr.sha,
          failures: [{
            logExcerpt: health.logExcerpt,
            message: health.message
          }],
          healthUrl: config.runtime.healthUrl,
          message: health.message,
          phase: health.phase,
          specPath: config.specPath,
          startCommand: config.runtime.startCommand,
          timeoutSeconds: config.runtime.timeoutSeconds
        });
        await publishFailure({
          document,
          github,
          prNumber: pr.number,
          state,
          summary: {
            collectionName: assetNames.collectionName,
            failurePhase: health.phase
          }
        });
        failurePublished = true;
        throw new Error(health.message);
      }

      currentPhase = 'collection_run';
      const collectionRun = await runTddCollection(state.collectionId || '', config.runtime.baseUrl, mask);
      if (collectionRun.exitCode !== 0) {
        const failures = extractCollectionFailures(collectionRun.logExcerpt);
        const document = createFailureDocument({
          baseUrl: config.runtime.baseUrl,
          collectionName: assetNames.collectionName,
          commit: pr.sha,
          failures,
          message: `Postman TDD collection failed with exit code ${collectionRun.exitCode}`,
          phase: 'collection_run',
          specPath: config.specPath
        });
        await publishFailure({
          document,
          github,
          prNumber: pr.number,
          state,
          summary: {
            collectionName: assetNames.collectionName,
            failurePhase: 'collection_run'
          }
        });
        failurePublished = true;
        throw new Error(document.message);
      }
    } finally {
      if (config.runtime.stopCommand) {
        const stop = await runCommand(config.runtime.stopCommand, { mask });
        if (stop.exitCode !== 0) {
          core.warning(`tdd.stopCommand failed: ${stop.logExcerpt}`);
        }
      } else {
        running.kill();
      }
    }

    prCommentId = String(await github.upsertStickyComment(pr.number, state, {
      collectionId: state.collectionId,
      collectionName: assetNames.collectionName,
      specId: state.specId,
      status: 'passed',
      workspaceId: state.workspaceId
    }, prCommentId ? Number(prCommentId) : undefined));

    core.setOutput('status', 'passed');
    core.setOutput('failure-phase', 'none');
    core.setOutput('pr-comment-id', prCommentId);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setOutput('pr-comment-id', prCommentId);
    if (!failurePublished) {
      core.setOutput('failure-phase', currentPhase);
    }
    throw error;
  }
}

function setStandardOutputs(paths: { agentTaskPath: string; failuresJsonPath: string }): void {
  core.setOutput('agent-context-dir', AGENT_CONTEXT_DIR);
  core.setOutput('agent-task-path', paths.agentTaskPath);
  core.setOutput('failures-json-path', paths.failuresJsonPath);
}

async function resolveTddWorkspace(options: {
  config: ResolvedOnboardingConfig;
  inputs: ActionInputs;
  postman: PostmanClient;
  repository: string;
}): Promise<{ configCommitSha?: string; workspaceId: string }> {
  const configuredId = options.config.workspace.id;
  if (configuredId) {
    core.info(`Using configured TDD workspace: ${configuredId}`);
    return { workspaceId: configuredId };
  }

  const matches = await options.postman.findWorkspacesByName(options.config.workspace.name);
  if (matches.length > 1) {
    throw new Error(
      `Multiple Postman workspaces named "${options.config.workspace.name}" exist. Set tdd.workspace.id explicitly.`
    );
  }

  const workspaceId = matches[0]?.id ||
    (await options.postman.createWorkspace(
      options.config.workspace.name,
      `Shared TDD preview workspace for ${options.config.projectName}`,
      parseWorkspaceTeamId(options.inputs.workspaceTeamId)
    )).id;

  if (options.inputs.configWriteMode === 'none') {
    core.warning(`Resolved TDD workspace ${workspaceId}, but config-write-mode=none so tdd.workspace.id was not persisted.`);
    return { workspaceId };
  }

  const patch = patchWorkspaceId(options.config.configPath, workspaceId);
  if (!patch.changed) {
    return { workspaceId };
  }
  const result = await commitConfigWriteback({
    committerEmail: options.inputs.committerEmail,
    committerName: options.inputs.committerName,
    configPath: options.config.configPath,
    githubToken: options.inputs.githubToken,
    mode: options.inputs.configWriteMode,
    repository: options.repository
  });
  return { configCommitSha: result.commitSha, workspaceId };
}

function parseWorkspaceTeamId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`workspace-team-id must be numeric, got: ${value}`);
  }
  return parsed;
}

function createAssetNames(prNumber: number, projectName: string): { collectionName: string; specName: string } {
  return {
    collectionName: `[TDD PR-${prNumber}] [Contract] ${projectName}`,
    specName: `[TDD PR-${prNumber}] ${projectName}`
  };
}

async function upsertPreviewAssets(options: {
  assetNames: { collectionName: string; specName: string };
  config: ResolvedOnboardingConfig;
  postman: PostmanClient;
  state: PreviewAssetState;
}): Promise<{ collectionId: string; specId: string }> {
  const specContent = readFileSync(resolveWorkspacePath(options.config.specPath), 'utf8');
  const document = parseOpenApiDocument(specContent);
  const contractIndex = buildContractIndex(document);
  const specId = await upsertSpec({
    content: specContent,
    name: options.assetNames.specName,
    openapiVersion: contractIndex.openapiVersion,
    postman: options.postman,
    specId: options.state.specId,
    workspaceId: options.state.workspaceId || ''
  });

  const tempCollectionId = await options.postman.generateCollection(
    specId,
    options.config.projectName,
    `[TDD PR-${options.state.prNumber}] [Contract]`
  );
  const tempCollection = await options.postman.getCollection(tempCollectionId);
  if (!tempCollection || typeof tempCollection !== 'object') {
    throw new Error(`Generated TDD collection ${tempCollectionId} could not be fetched`);
  }
  const planned = instrumentContractCollection(tempCollection as Record<string, unknown>, contractIndex);
  for (const warning of planned.warnings) {
    core.warning(warning);
  }

  let collectionId = options.state.collectionId || '';
  if (collectionId) {
    try {
      await options.postman.updateCollection(collectionId, planned.collection);
      await options.postman.deleteCollection(tempCollectionId);
    } catch {
      core.warning(`Existing PR TDD collection ${collectionId} could not be updated; adopting generated collection ${tempCollectionId}`);
      collectionId = tempCollectionId;
      await options.postman.updateCollection(collectionId, planned.collection);
    }
  } else {
    collectionId = tempCollectionId;
    await options.postman.updateCollection(collectionId, planned.collection);
  }

  return { collectionId, specId };
}

async function upsertSpec(options: {
  content: string;
  name: string;
  openapiVersion: '3.0' | '3.1';
  postman: PostmanClient;
  specId?: string;
  workspaceId: string;
}): Promise<string> {
  if (options.specId) {
    try {
      await options.postman.updateSpec(options.specId, options.content);
      return options.specId;
    } catch {
      core.warning(`Existing PR TDD spec ${options.specId} could not be updated; creating a new spec.`);
    }
  }
  return options.postman.uploadSpec(options.workspaceId, options.name, options.content, options.openapiVersion);
}

async function cleanupPreviewAssets(options: {
  github: GitHubPrClient;
  postman: PostmanClient;
  prNumber: number;
  state: PreviewAssetState;
}): Promise<void> {
  void options.github;
  void options.prNumber;
  if (options.state.collectionId) {
    await options.postman.deleteCollection(options.state.collectionId);
  }
  if (options.state.specId) {
    await options.postman.deleteSpec(options.state.specId);
  }
}

async function publishFailure(options: {
  document: AgentFailureDocument;
  github: GitHubPrClient;
  prNumber: number;
  state: PreviewAssetState;
  summary: { collectionName: string; failurePhase: FailurePhase };
}): Promise<void> {
  const paths = writeAgentContext(options.document, AGENT_CONTEXT_DIR);
  core.setOutput('failure-phase', options.document.phase);
  const commentId = await options.github.upsertStickyComment(options.prNumber, options.state, {
    agentTaskPath: paths.agentTaskPath,
    collectionId: options.state.collectionId,
    collectionName: options.summary.collectionName,
    failureDocument: options.document,
    failurePhase: options.summary.failurePhase,
    specId: options.state.specId,
    status: 'failed',
    workspaceId: options.state.workspaceId
  });
  core.setOutput('pr-comment-id', String(commentId));
}

function extractCollectionFailures(logExcerpt: string): AgentFailure[] {
  const lines = logExcerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.filter((line) => /fail|error|assert|expected|actual/i.test(line)).slice(0, 10);
  if (interesting.length === 0) {
    return [{
      logExcerpt: sanitizeLogExcerpt(logExcerpt, (value) => value),
      message: 'Postman TDD collection failed. Check the log excerpt for details.'
    }];
  }
  return interesting.map((line) => ({ message: line }));
}
