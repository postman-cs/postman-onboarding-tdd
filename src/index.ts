import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';

import {
  createFailureDocument,
  findImmutablePathChanges,
  hashImmutablePaths,
  IMMUTABLE_SPEC_GUARD_MESSAGE,
  writeAgentContext
} from './agent-context.js';
import { loadOnboardingConfig, validateConfigWriteMode, validateRepairProvider } from './config.js';
import { extractCollectionFailures } from './failure-normalizer.js';
import { GitHubPrClient, parseFailureDocument, resolvePrMetadata } from './github/pr-comment.js';
import {
  createImmutableStatePayload,
  IMMUTABLE_STATE_TAMPERED_MESSAGE,
  resolveTrustedImmutableBaseline,
  signImmutableState
} from './immutable-state.js';
import { runRepairMode } from './repair/orchestrator.js';
import { createAssetNames, resolveTddWorkspace, upsertPreviewAssets } from './preview-assets.js';
import { resolvePostmanEndpointProfile, parsePostmanRegion, parsePostmanStack } from './postman/base-urls.js';
import { PostmanClient } from './postman/client.js';
import {
  ensurePostmanCli,
  runCommand,
  runTddCollection,
  startBackgroundCommand,
  waitForHealth
} from './runner.js';
import { createSecretMasker } from './secrets.js';
import type {
  ActionInputs,
  AgentFailureDocument,
  FailurePhase,
  ImmutablePathHash,
  PreviewAssetState,
  ResolvedOnboardingConfig
} from './types.js';
import type { UploadArtifactResponse } from '@actions/artifact';

const AGENT_CONTEXT_DIR = '.postman-tdd';
const AGENT_CONTEXT_ARTIFACT_NAME = 'postman-tdd-agent-context';

interface AgentContextArtifactClient {
  uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string
  ): Promise<UploadArtifactResponse>;
}

export interface RunActionOptions {
  artifactClient?: AgentContextArtifactClient;
  githubClient?: GitHubPrClient;
  postmanClient?: PostmanClient;
}

export function readActionInputs(): ActionInputs {
  const prNumberInput = core.getInput('pr-number');
  const modeRaw = core.getInput('mode') || 'run';
  if (modeRaw !== 'run' && modeRaw !== 'cleanup' && modeRaw !== 'repair') {
    throw new Error(`Unsupported mode "${modeRaw}". Expected run, cleanup, or repair`);
  }
  const repairMaxAttempts = Number(core.getInput('repair-max-attempts') || '3');
  if (!Number.isFinite(repairMaxAttempts) || repairMaxAttempts <= 0) {
    throw new Error(`repair-max-attempts must be a positive number, got: ${core.getInput('repair-max-attempts')}`);
  }
  return {
    committerEmail: core.getInput('committer-email') || 'support@postman.com',
    committerName: core.getInput('committer-name') || 'Postman',
    configWriteMode: validateConfigWriteMode(core.getInput('config-write-mode') || 'commit-and-push'),
    githubToken: core.getInput('github-token', { required: true }),
    immutableStateSigningKey: core.getInput('immutable-state-signing-key') || undefined,
    mode: modeRaw,
    onboardingConfigPath: core.getInput('onboarding-config-path') || '.postman-template/onboarding.yml',
    openaiApiKey: core.getInput('openai-api-key') || undefined,
    postmanAccessToken: core.getInput('postman-access-token') || undefined,
    postmanApiKey: core.getInput('postman-api-key', { required: true }),
    postmanRegion: parsePostmanRegion(core.getInput('postman-region') || 'us'),
    postmanStack: parsePostmanStack(core.getInput('postman-stack') || 'prod'),
    prNumber: prNumberInput ? Number(prNumberInput) : undefined,
    projectName: core.getInput('project-name') || undefined,
    repairCommitMessage: core.getInput('repair-commit-message') || 'Postman TDD repair',
    repairGithubToken: core.getInput('repair-github-token') || undefined,
    repairMaxAttempts,
    repairModel: core.getInput('repair-model') || 'gpt-5.5',
    repairProvider: validateRepairProvider(core.getInput('repair-provider') || 'openai-responses'),
    specPath: core.getInput('spec-path') || undefined,
    workspaceTeamId: core.getInput('workspace-team-id') || undefined
  };
}

export async function runAction(options: RunActionOptions = {}): Promise<void> {
  const inputs = readActionInputs();
  core.setSecret(inputs.postmanApiKey);
  core.setSecret(inputs.githubToken);
  if (inputs.postmanAccessToken) core.setSecret(inputs.postmanAccessToken);
  if (inputs.immutableStateSigningKey) core.setSecret(inputs.immutableStateSigningKey);
  if (inputs.openaiApiKey) core.setSecret(inputs.openaiApiKey);
  if (inputs.repairGithubToken) core.setSecret(inputs.repairGithubToken);

  const mask = createSecretMasker([
    inputs.postmanApiKey,
    inputs.githubToken,
    inputs.postmanAccessToken,
    inputs.immutableStateSigningKey,
    inputs.openaiApiKey,
    inputs.repairGithubToken
  ]);
  const endpointProfile = resolvePostmanEndpointProfile(inputs.postmanStack, inputs.postmanRegion);
  const postman = options.postmanClient ?? new PostmanClient({
    apiKey: inputs.postmanApiKey,
    baseUrl: endpointProfile.apiBaseUrl,
    secretMasker: mask
  });
  const pr = resolvePrMetadata(inputs.prNumber);
  const github = options.githubClient ?? new GitHubPrClient(inputs.githubToken, pr.repository);
  const artifactClient = options.artifactClient ?? new DefaultArtifactClient();

  if (inputs.mode === 'repair') {
    await runRepairMode({
      endpointProfile,
      github,
      inputs,
      mask,
      postman,
      pr
    });
    return;
  }
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

    const assetNames = createAssetNames(pr.number, config.projectName);
    const previousFailureDocument = sticky?.body ? parseFailureDocument(sticky.body) : undefined;
    const trustedBaseline = resolveTrustedImmutableBaseline(
      previousFailureDocument,
      inputs.immutableStateSigningKey,
      {
        prNumber: pr.number,
        repository: pr.repository,
        specPath: config.specPath
      },
      state.immutableState
    );
    if (!trustedBaseline.ok) {
      currentPhase = 'immutable_state_tampered';
      delete state.immutableState;
      const document = createFailureDocument({
        baseUrl: config.runtime.baseUrl,
        collectionName: assetNames.collectionName,
        commit: pr.sha,
        failures: [{
          message: trustedBaseline.message,
          path: config.specPath
        }],
        immutablePathHashes: trustedBaseline.hashes,
        immutablePaths: uniquePaths(trustedBaseline.hashes),
        message: trustedBaseline.message,
        phase: 'immutable_state_tampered',
        specPath: config.specPath
      });
      await publishFailure({
        artifactClient,
        document,
        github,
        prNumber: pr.number,
        state,
        summary: {
          collectionName: assetNames.collectionName,
          failurePhase: 'immutable_state_tampered'
        }
      });
      failurePublished = true;
      throw new Error(IMMUTABLE_STATE_TAMPERED_MESSAGE);
    }
    const previousImmutableHashes = trustedBaseline.hashes;
    const immutableSpecChanges = findImmutablePathChanges(previousImmutableHashes);
    if (immutableSpecChanges.length > 0) {
      currentPhase = 'immutable_spec';
      if (trustedBaseline.signedState) {
        state.immutableState = trustedBaseline.signedState;
      }
      const document = createFailureDocument({
        baseUrl: config.runtime.baseUrl,
        collectionName: assetNames.collectionName,
        commit: pr.sha,
        failures: immutableSpecChanges.map((change) => ({
          actual: change.actualSha256 || '(missing)',
          expected: change.expectedSha256,
          message: IMMUTABLE_SPEC_GUARD_MESSAGE,
          path: change.path
        })),
        immutablePathHashes: previousImmutableHashes,
        immutablePaths: uniquePaths(previousImmutableHashes),
        immutableState: trustedBaseline.signedState,
        message: IMMUTABLE_SPEC_GUARD_MESSAGE,
        phase: 'immutable_spec',
        specPath: config.specPath
      });
      await publishFailure({
        artifactClient,
        document,
        github,
        prNumber: pr.number,
        state,
        summary: {
          collectionName: assetNames.collectionName,
          failurePhase: 'immutable_spec'
        }
      });
      failurePublished = true;
      throw new Error(IMMUTABLE_SPEC_GUARD_MESSAGE);
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
    const immutablePaths = [config.specPath];
    const immutablePathHashes = hashImmutablePaths(immutablePaths);
    const immutableState = inputs.immutableStateSigningKey
      ? signImmutableState(createImmutableStatePayload({
          commit: pr.sha,
          immutablePathHashes,
          prNumber: pr.number,
          repository: pr.repository,
          specPath: config.specPath
        }), inputs.immutableStateSigningKey)
      : undefined;

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
          immutablePathHashes,
          immutablePaths,
          immutableState,
          message: health.message,
          phase: health.phase,
          specPath: config.specPath,
          startCommand: config.runtime.startCommand,
          timeoutSeconds: config.runtime.timeoutSeconds
        });
        if (immutableState) {
          state.immutableState = immutableState;
        }
        await publishFailure({
          artifactClient,
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
          immutablePathHashes,
          immutablePaths,
          immutableState,
          message: `Postman TDD collection failed with exit code ${collectionRun.exitCode}`,
          phase: 'collection_run',
          specPath: config.specPath
        });
        if (immutableState) {
          state.immutableState = immutableState;
        }
        await publishFailure({
          artifactClient,
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
      commit: pr.sha,
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

function uniquePaths(hashes: ImmutablePathHash[]): string[] {
  return [...new Set(hashes.map((hash) => hash.path).filter(Boolean))];
}

function setStandardOutputs(paths: { agentTaskPath: string; failuresJsonPath: string }): void {
  core.setOutput('agent-context-dir', AGENT_CONTEXT_DIR);
  core.setOutput('agent-task-path', paths.agentTaskPath);
  core.setOutput('failures-json-path', paths.failuresJsonPath);
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
  artifactClient: AgentContextArtifactClient;
  document: AgentFailureDocument;
  github: GitHubPrClient;
  prNumber: number;
  state: PreviewAssetState;
  summary: { collectionName: string; failurePhase: FailurePhase };
}): Promise<void> {
  const paths = writeAgentContext(options.document, AGENT_CONTEXT_DIR);
  core.setOutput('failure-phase', options.document.phase);

  let artifact: UploadArtifactResponse | undefined;
  try {
    artifact = await options.artifactClient.uploadArtifact(
      AGENT_CONTEXT_ARTIFACT_NAME,
      [paths.agentTaskPath, paths.failuresJsonPath, paths.immutableSpecGuardPath],
      '.'
    );
    core.setOutput('agent-context-artifact', AGENT_CONTEXT_ARTIFACT_NAME);
    if (artifact.id) {
      core.setOutput('agent-context-artifact-id', String(artifact.id));
    }
    if (artifact.digest) {
      core.setOutput('agent-context-artifact-digest', artifact.digest);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Unable to upload agent context artifact: ${message}`);
  }

  const commentId = await options.github.upsertStickyComment(options.prNumber, options.state, {
    agentContextArtifactDigest: artifact?.digest,
    agentContextArtifactId: artifact?.id,
    agentContextArtifactName: artifact ? AGENT_CONTEXT_ARTIFACT_NAME : undefined,
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
