import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createFailureDocument,
  findImmutablePathChanges,
  hashImmutablePaths,
  IMMUTABLE_SPEC_GUARD_MESSAGE,
  writeAgentContext
} from './agent-context.js';
import { loadOnboardingConfig, validateConfigWriteMode, validateRepairProvider } from './config.js';
import { buildContractHints } from './contract-hints.js';
import { extractCollectionFailures } from './failure-normalizer.js';
import { GitHubPrClient, parseFailureDocument, resolvePrMetadata } from './github/pr-comment.js';
import { publishCheckRunAnnotations } from './github/check-run.js';
import {
  createImmutableStatePayload,
  IMMUTABLE_STATE_TAMPERED_MESSAGE,
  resolveTrustedImmutableBaseline,
  signImmutableState
} from './immutable-state.js';
import { buildLedgerPackets, mergePersistedState, ratchetLedger, scoreLedger, toLedgerSummary, writeLedgerFile } from './ledger.js';
import { runRepairMode } from './repair/orchestrator.js';
import { defaultRepairModel } from './repair/provider-dispatcher.js';
import { createAssetNames, resolveTddWorkspace, upsertPreviewAssets } from './preview-assets.js';
import {
  parsePostmanRegion,
  parsePostmanStack,
  resolvePostmanCliInstallUrl,
  resolvePostmanEndpointProfile
} from './postman/base-urls.js';
import type { PostmanEndpointProfile } from './postman/base-urls.js';
import { PostmanClient } from './postman/client.js';
import { renderJUnit } from './reporting/junit.js';
import { runValidateMode } from './validation.js';
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
  Ledger,
  LedgerSummary,
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
  if (modeRaw !== 'run' && modeRaw !== 'cleanup' && modeRaw !== 'repair' && modeRaw !== 'validate') {
    throw new Error(`Unsupported mode "${modeRaw}". Expected run, cleanup, repair, or validate`);
  }
  const repairProviderInput = core.getInput('repair-provider');
  const repairProvider = repairProviderInput ? validateRepairProvider(repairProviderInput) : undefined;
  const repairModelInput = core.getInput('repair-model') || undefined;
  const repairMaxAttempts = Number(core.getInput('repair-max-attempts') || '3');
  if (!Number.isFinite(repairMaxAttempts) || repairMaxAttempts <= 0) {
    throw new Error(`repair-max-attempts must be a positive number, got: ${core.getInput('repair-max-attempts')}`);
  }
  const repairMaxToolRoundsInput = core.getInput('repair-max-tool-rounds') || '12';
  const repairMaxToolRounds = Number(repairMaxToolRoundsInput);
  if (!Number.isInteger(repairMaxToolRounds) || repairMaxToolRounds < 1 || repairMaxToolRounds > 50) {
    throw new Error(`repair-max-tool-rounds must be an integer between 1 and 50, got: ${repairMaxToolRoundsInput}`);
  }
  const repairBreakerThresholdInput = core.getInput('repair-breaker-threshold') || '2';
  const repairBreakerThreshold = Number(repairBreakerThresholdInput);
  if (!Number.isInteger(repairBreakerThreshold) || repairBreakerThreshold < 2) {
    throw new Error(`repair-breaker-threshold must be an integer >= 2, got: ${repairBreakerThresholdInput}`);
  }
  const repairEscalationModel = core.getInput('repair-escalation-model') || undefined;
  const githubToken = core.getInput('github-token') || '';
  const postmanApiKey = core.getInput('postman-api-key') || '';
  if (modeRaw !== 'validate' && !githubToken) {
    throw new Error('github-token is required unless mode=validate');
  }
  if (modeRaw !== 'validate' && !postmanApiKey) {
    throw new Error('postman-api-key is required unless mode=validate');
  }
  return {
    anthropicApiKey: core.getInput('anthropic-api-key') || undefined,
    committerEmail: core.getInput('committer-email') || 'support@postman.com',
    committerName: core.getInput('committer-name') || 'Postman',
    configWriteMode: validateConfigWriteMode(core.getInput('config-write-mode') || 'commit-and-push'),
    githubToken,
    immutableStateSigningKey: core.getInput('immutable-state-signing-key') || undefined,
    mode: modeRaw,
    onboardingConfigPath: core.getInput('onboarding-config-path') || '.postman-template/onboarding.yml',
    openaiApiKey: core.getInput('openai-api-key') || undefined,
    postmanAccessToken: core.getInput('postman-access-token') || undefined,
    postmanApiKey,
    postmanRegion: parsePostmanRegion(core.getInput('postman-region') || 'us'),
    postmanStack: parsePostmanStack(core.getInput('postman-stack') || 'prod'),
    prNumber: prNumberInput ? Number(prNumberInput) : undefined,
    projectName: core.getInput('project-name') || undefined,
    repairCommitMessage: core.getInput('repair-commit-message') || 'Postman TDD repair',
    repairGithubToken: core.getInput('repair-github-token') || undefined,
    repairMaxAttempts,
    repairMaxToolRounds,
    repairBreakerThreshold,
    repairEscalationModel,
    repairModel: repairModelInput || (repairProvider ? defaultRepairModel(repairProvider) : undefined),
    repairProvider,
    specPath: core.getInput('spec-path') || undefined,
    workspaceTeamId: core.getInput('workspace-team-id') || undefined
  };
}

// Injected by esbuild --define at build time; undefined under vitest/tsc.
declare const __ACTION_VERSION__: string | undefined;

function resolveActionVersion(): string {
  return typeof __ACTION_VERSION__ === 'string' && __ACTION_VERSION__ ? __ACTION_VERSION__ : 'unknown';
}

export async function runAction(options: RunActionOptions = {}): Promise<void> {
  const telemetry = createTelemetryContext({
    action: 'postman-onboarding-tdd',
    actionVersion: resolveActionVersion(),
    logger: core
  });
  try {
    await runActionInner(options, telemetry);
    telemetry.emitCompletion('success');
  } catch (error) {
    telemetry.emitCompletion('failure');
    throw error;
  }
}

async function runActionInner(
  options: RunActionOptions,
  telemetry: ReturnType<typeof createTelemetryContext>
): Promise<void> {
  const inputs = readActionInputs();
  if (inputs.postmanApiKey) core.setSecret(inputs.postmanApiKey);
  if (inputs.githubToken) core.setSecret(inputs.githubToken);
  if (inputs.postmanAccessToken) core.setSecret(inputs.postmanAccessToken);
  if (inputs.immutableStateSigningKey) core.setSecret(inputs.immutableStateSigningKey);
  if (inputs.openaiApiKey) core.setSecret(inputs.openaiApiKey);
  if (inputs.anthropicApiKey) core.setSecret(inputs.anthropicApiKey);
  if (inputs.repairGithubToken) core.setSecret(inputs.repairGithubToken);

  const mask = createSecretMasker([
    inputs.postmanApiKey,
    inputs.githubToken,
    inputs.postmanAccessToken,
    inputs.immutableStateSigningKey,
    inputs.openaiApiKey,
    inputs.anthropicApiKey,
    inputs.repairGithubToken
  ]);
  if (inputs.workspaceTeamId) telemetry.setTeamId(inputs.workspaceTeamId);
  if (inputs.mode === 'validate') {
    await runValidateMode({ inputs, mask });
    return;
  }
  const endpointProfile = resolvePostmanEndpointProfile(inputs.postmanStack, inputs.postmanRegion);
  const postman = options.postmanClient ?? new PostmanClient({
    apiKey: inputs.postmanApiKey,
    baseUrl: endpointProfile.apiBaseUrl,
    secretMasker: mask
  });
  const pr = resolvePrMetadata(inputs.prNumber);
  const github = options.githubClient ?? new GitHubPrClient(inputs.githubToken, pr.repository);
  const artifactClient = options.artifactClient ?? new DefaultArtifactClient();
  logActionContext({ endpointProfile, inputs, pr });

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
    core.info(`[postman-tdd] Looking for existing sticky preview comment on PR #${pr.number}.`);
    const sticky = await github.findStickyComment(pr.number);
    prCommentId = sticky?.id ? String(sticky.id) : '';
    core.info(sticky
      ? `[postman-tdd] Found sticky preview comment ${prCommentId}.`
      : '[postman-tdd] No sticky preview comment found; a new one will be created if needed.');
    state = {
      ...state,
      ...(sticky?.assetState?.prNumber === pr.number ? sticky.assetState : {})
    };
    if (state.workspaceId || state.specId || state.collectionId) {
      core.info(`[postman-tdd] Reusing marker asset state: workspace=${state.workspaceId || '(missing)'}, spec=${state.specId || '(missing)'}, collection=${state.collectionId || '(missing)'}.`);
    }

    setStandardOutputs({
      agentTaskPath: `${AGENT_CONTEXT_DIR}/agent-task.md`,
      failuresJsonPath: `${AGENT_CONTEXT_DIR}/failures.json`
    });

    const config = loadOnboardingConfig({
      configPath: inputs.onboardingConfigPath,
      projectNameOverride: inputs.projectName,
      specPathOverride: inputs.specPath
    });
    logResolvedConfig(config, inputs, mask);

    if (!config.tddEnabled) {
      core.info('[postman-tdd] tdd.enabled=false; skipping preview run.');
      core.setOutput('status', 'skipped');
      core.setOutput('failure-phase', 'none');
      return;
    }

    if (inputs.mode === 'cleanup') {
      currentPhase = 'cleanup';
      core.info(`[postman-tdd] Cleanup mode: deleting PR-scoped assets for PR #${pr.number}.`);
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
    core.info(`[postman-tdd] Preview asset names: spec="${assetNames.specName}", collection="${assetNames.collectionName}".`);
    const previousFailureDocument = sticky?.body ? parseFailureDocument(sticky.body) : undefined;
    core.info(previousFailureDocument
      ? `[postman-tdd] Previous failure JSON found: phase=${previousFailureDocument.phase}, commit=${previousFailureDocument.commit || '(missing)'}.`
      : '[postman-tdd] No previous failure JSON found in sticky comment.');
    if (!previousFailureDocument && state.immutableState) {
      core.info('[postman-tdd] Ignoring stale immutable state marker because the sticky comment has no failure JSON.');
      delete state.immutableState;
    }
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
      core.info(`[postman-tdd] Immutable state verification failed: ${trustedBaseline.message}`);
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
      prCommentId = String(await publishFailure({
        artifactClient,
        document,
        github,
        prNumber: pr.number,
        state,
        summary: {
          collectionName: assetNames.collectionName,
          failurePhase: 'immutable_state_tampered'
        }
      }));
      failurePublished = true;
      throw new Error(IMMUTABLE_STATE_TAMPERED_MESSAGE);
    }
    const previousImmutableHashes = trustedBaseline.hashes;
    core.info(`[postman-tdd] Immutable baseline: ${previousImmutableHashes.length} path(s), signing=${inputs.immutableStateSigningKey ? 'enabled' : 'disabled'}.`);
    const immutableSpecChanges = findImmutablePathChanges(previousImmutableHashes);
    if (immutableSpecChanges.length > 0) {
      currentPhase = 'immutable_spec';
      core.info(`[postman-tdd] Immutable spec guard failed for ${immutableSpecChanges.length} path(s).`);
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
      prCommentId = String(await publishFailure({
        artifactClient,
        document,
        github,
        prNumber: pr.number,
        state,
        summary: {
          collectionName: assetNames.collectionName,
          failurePhase: 'immutable_spec'
        }
      }));
      failurePublished = true;
      throw new Error(IMMUTABLE_SPEC_GUARD_MESSAGE);
    }

    currentPhase = 'workspace';
    core.info('[postman-tdd] Resolving shared TDD preview workspace.');
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
    core.info('[postman-tdd] Upserting PR-scoped Postman spec and TDD collection.');
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
    core.info(`[postman-tdd] Asset upsert complete: workspace=${state.workspaceId}, spec=${state.specId}, collection=${state.collectionId}.`);

    let allowRatchetRemoval = false;
    try {
      const prDetails = await github.getPullRequest(pr.number);
      allowRatchetRemoval = prDetails.labels.includes('postman-tdd-allow-ratchet-removal');
      core.info(`[postman-tdd] Ratchet escape-hatch label: ${allowRatchetRemoval ? 'present' : 'absent'}.`);
    } catch (error) {
      core.warning(`[postman-tdd] Could not fetch PR labels for ratchet check: ${formatUnknownError(error)}`);
    }

    const ledger: Ledger = {
      packets: mergePersistedState(buildLedgerPackets(assetResult.contractIndex), state.ledger, pr.sha),
      schemaVersion: 1
    };
    core.info(`[postman-tdd] Built verification ledger with ${ledger.packets.length} packet(s) from contract index.`);

    core.info('[postman-tdd] Ensuring Postman CLI is available and authenticated.');
    await ensurePostmanCli(inputs.postmanApiKey, {
      cliInstallUrl: resolvePostmanCliInstallUrl(endpointProfile),
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
    core.info(`[postman-tdd] Starting service: ${mask(config.runtime.startCommand)}`);
    const running = startBackgroundCommand(config.runtime.startCommand, { mask, sanitizeEnv: true });
    try {
      core.info(`[postman-tdd] Waiting for health check ${mask(config.runtime.healthUrl)} for up to ${config.runtime.timeoutSeconds}s.`);
      const health = await waitForHealth(
        config.runtime.healthUrl,
        running,
        config.runtime.timeoutSeconds,
        mask
      );
      if (!health.ok) {
        core.info(`[postman-tdd] Health check failed in phase=${health.phase}: ${health.message}`);
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
        prCommentId = String(await publishFailure({
          artifactClient,
          document,
          github,
          prNumber: pr.number,
          state,
          summary: {
            collectionName: assetNames.collectionName,
            failurePhase: health.phase
          }
        }));
        failurePublished = true;
        throw new Error(health.message);
      }
      core.info('[postman-tdd] Health check passed.');

      currentPhase = 'collection_run';
      core.info(`[postman-tdd] Running TDD collection ${state.collectionId || '(missing)'} against ${mask(config.runtime.baseUrl)}.`);
      const collectionRun = await runTddCollection(state.collectionId || '', config.runtime.baseUrl, mask);
      if (collectionRun.exitCode !== 0) {
        const failures = extractCollectionFailures(collectionRun.logExcerpt);
        core.info(`[postman-tdd] Collection run failed with exit code ${collectionRun.exitCode}; normalized ${failures.length} failure(s).`);
        const previousLedgerSummary = state.ledger;
        const scoredLedger = scoreLedger(ledger, failures, pr.sha);

        const ratchetResult = ratchetLedger(previousLedgerSummary, scoredLedger, { allowRemoval: allowRatchetRemoval });
        if (ratchetResult.violated) {
          const ratchetFailures = [...ratchetResult.missingKeys, ...ratchetResult.weakenedKeys].map((key) => ({
            message: `Packet ${key} was previously passing but is missing or weakened in this PR.`
          }));
          writeLedgerFile(scoredLedger);
          state.ledger = toLedgerSummary(scoredLedger);
          writeJUnitReport(state.ledger);
          const ratchetDocument = createFailureDocument({
            collectionName: assetNames.collectionName,
            commit: pr.sha,
            failures: ratchetFailures,
            immutablePathHashes,
            immutablePaths,
            immutableState,
            ledger: state.ledger,
            message: 'Previously-passing contract assertions were removed or weakened in this PR.',
            phase: 'test_ratchet',
            specPath: config.specPath
          });
          if (immutableState) {
            state.immutableState = immutableState;
          }
          prCommentId = String(await publishFailure({
            artifactClient,
            document: ratchetDocument,
            github,
            prNumber: pr.number,
            state,
            summary: {
              collectionName: assetNames.collectionName,
              failurePhase: 'test_ratchet',
              ledger: state.ledger
            }
          }));
          failurePublished = true;
          throw new Error(ratchetDocument.message);
        }

        let finalLedger = scoredLedger;
        if (allowRatchetRemoval && (ratchetResult.missingKeys.length > 0 || ratchetResult.weakenedKeys.length > 0)) {
          const keysToDrop = new Set([...ratchetResult.missingKeys, ...ratchetResult.weakenedKeys]);
          finalLedger = { ...scoredLedger, packets: scoredLedger.packets.filter((packet) => !keysToDrop.has(packet.key)) };
          core.info(`[postman-tdd] Ratchet escape hatch: dropped ${keysToDrop.size} previously-passing packet(s) from the ledger.`);
        }

        writeLedgerFile(finalLedger);
        state.ledger = toLedgerSummary(finalLedger);
        writeJUnitReport(state.ledger);
        const document = createFailureDocument({
          baseUrl: config.runtime.baseUrl,
          collectionName: assetNames.collectionName,
          commit: pr.sha,
          contractHints: buildContractHints(config.specPath, failures),
          failures,
          immutablePathHashes,
          immutablePaths,
          immutableState,
          ledger: state.ledger,
          message: `Postman TDD collection failed with exit code ${collectionRun.exitCode}`,
          phase: 'collection_run',
          specPath: config.specPath
        });
        if (immutableState) {
          state.immutableState = immutableState;
        }
        prCommentId = String(await publishFailure({
          artifactClient,
          document,
          github,
          prNumber: pr.number,
          state,
          summary: {
            collectionName: assetNames.collectionName,
            failurePhase: 'collection_run',
            ledger: state.ledger
          }
        }));
        failurePublished = true;
        throw new Error(document.message);
      }
      core.info('[postman-tdd] Collection run passed.');
      const passedLedger = scoreLedger(ledger, [], pr.sha);
      writeLedgerFile(passedLedger);
      state.ledger = toLedgerSummary(passedLedger);
    } finally {
      if (config.runtime.stopCommand) {
        core.info(`[postman-tdd] Running stop command: ${mask(config.runtime.stopCommand)}`);
        const stop = await runCommand(config.runtime.stopCommand, { mask, sanitizeEnv: true });
        if (stop.exitCode !== 0) {
          core.warning(`tdd.stopCommand failed: ${stop.logExcerpt}`);
        }
      } else {
        core.info('[postman-tdd] No stop command configured; terminating started service process.');
        running.kill();
      }
    }

    core.info('[postman-tdd] Updating sticky preview comment with passed status.');
    prCommentId = String(await github.upsertStickyComment(pr.number, state, {
      collectionId: state.collectionId,
      collectionName: assetNames.collectionName,
      commit: pr.sha,
      ledger: state.ledger,
      specId: state.specId,
      status: 'passed',
      workspaceId: state.workspaceId
    }, prCommentId ? Number(prCommentId) : undefined));

    core.setOutput('status', 'passed');
    core.setOutput('failure-phase', 'none');
    core.setOutput('pr-comment-id', prCommentId);
  } catch (error) {
    core.info(`[postman-tdd] Action failed during phase=${currentPhase}.`);
    if (!failurePublished && inputs.mode === 'run' && currentPhase === 'config') {
      try {
        const message = formatUnknownError(error);
        core.info('[postman-tdd] Publishing config failure context to the sticky preview comment.');
        const document = createFailureDocument({
          commit: pr.sha,
          failures: [{
            message
          }],
          message,
          phase: 'config',
          specPath: inputs.specPath
        });
        prCommentId = String(await publishFailure({
          artifactClient,
          document,
          github,
          prNumber: pr.number,
          state,
          summary: {
            collectionName: '',
            failurePhase: 'config'
          }
        }));
        failurePublished = true;
      } catch (publishError) {
        core.warning(`Unable to publish config failure context: ${formatUnknownError(publishError)}`);
      }
    }
    core.setOutput('status', 'failed');
    core.setOutput('pr-comment-id', prCommentId);
    if (!failurePublished) {
      core.setOutput('failure-phase', currentPhase);
    }
    throw error;
  }
}

function logActionContext(options: {
  endpointProfile: PostmanEndpointProfile;
  inputs: ActionInputs;
  pr: { branch?: string; number: number; repository: string; sha?: string };
}): void {
  core.startGroup('Postman TDD action context');
  core.info(`mode=${options.inputs.mode}`);
  core.info(`repository=${options.pr.repository}`);
  core.info(`prNumber=${options.pr.number}`);
  core.info(`headBranch=${options.pr.branch || '(unknown)'}`);
  core.info(`headSha=${options.pr.sha || '(unknown)'}`);
  core.info(`postmanRegion=${options.inputs.postmanRegion}`);
  core.info(`postmanStack=${options.inputs.postmanStack}`);
  core.info(`postmanApiBaseUrl=${options.endpointProfile.apiBaseUrl}`);
  core.info(`configWriteMode=${options.inputs.configWriteMode}`);
  core.info(`repairProviderInput=${options.inputs.repairProvider || '(from config)'}`);
  core.info(`repairMaxAttemptsInput=${options.inputs.repairMaxAttempts}`);
  core.endGroup();
}

function logResolvedConfig(
  config: ResolvedOnboardingConfig,
  inputs: ActionInputs,
  mask: (value: string) => string
): void {
  core.startGroup('Postman TDD resolved config');
  core.info(`configPath=${config.configPath}`);
  core.info(`projectName=${config.projectName}`);
  core.info(`specPath=${config.specPath}`);
  core.info(`tddEnabled=${config.tddEnabled}`);
  core.info(`workspaceName=${config.workspace.name || '(not configured)'}`);
  core.info(`workspaceId=${config.workspace.id || '(not configured)'}`);
  core.info(`baseUrl=${mask(config.runtime.baseUrl)}`);
  core.info(`healthUrl=${mask(config.runtime.healthUrl)}`);
  core.info(`startCommand=${mask(config.runtime.startCommand)}`);
  core.info(`stopCommand=${config.runtime.stopCommand ? mask(config.runtime.stopCommand) : '(not configured)'}`);
  core.info(`timeoutSeconds=${config.runtime.timeoutSeconds}`);
  core.info(`repairEnabled=${config.repair.enabled}`);
  core.info(`repairProvider=${config.repair.provider}`);
  core.info(`repairMaxAttemptsConfig=${config.repair.maxAttempts}`);
  core.info(`repairMaxAttemptsEffectiveInput=${inputs.repairMaxAttempts}`);
  core.info(`repairAllowedWritePaths=${config.repair.allowedWritePaths.join(', ') || '(none)'}`);
  core.info(`repairAllowedReadPaths=${config.repair.allowedReadPaths.join(', ') || '(none)'}`);
  core.info(`repairLocalTestCommand=${config.repair.localTestCommand ? mask(config.repair.localTestCommand) : '(not configured)'}`);
  core.endGroup();
}

function uniquePaths(hashes: ImmutablePathHash[]): string[] {
  return [...new Set(hashes.map((hash) => hash.path).filter(Boolean))];
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setStandardOutputs(paths: { agentTaskPath: string; failuresJsonPath: string }): void {
  core.setOutput('agent-context-dir', AGENT_CONTEXT_DIR);
  core.setOutput('agent-task-path', paths.agentTaskPath);
  core.setOutput('failures-json-path', paths.failuresJsonPath);
  core.setOutput('ledger-path', '.postman-tdd/ledger.json');
  core.setOutput('junit-path', '.postman-tdd/junit.xml');
}

/**
 * D13: assembles the canonical GitHub Actions run URL from standard runner
 * env (GITHUB_SERVER_URL + GITHUB_REPOSITORY + /actions/runs/ + GITHUB_RUN_ID).
 * Returns `undefined` when any of those env vars are absent (local/test), so
 * the published document stays serializable without a fabricated URL.
 */
export function resolveRunUrl(): string | undefined {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!server || !repository || !runId) {
    return undefined;
  }
  return `${server}/${repository}/actions/runs/${runId}`;
}

/**
 * D16: writes the JUnit XML report of the contract run into
 * `.postman-tdd/junit.xml` so it rides the existing agent-context artifact
 * upload. Mirrors the `writeAgentContext`/`writeLedgerFile` mkdir pattern.
 */
function writeJUnitReport(summary: LedgerSummary, dir = AGENT_CONTEXT_DIR): string {
  mkdirSync(dir, { recursive: true });
  const junitPath = join(dir, 'junit.xml');
  writeFileSync(junitPath, renderJUnit(summary), 'utf8');
  return junitPath;
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
    core.info(`[postman-tdd] Deleting collection ${options.state.collectionId}.`);
    await options.postman.deleteCollection(options.state.collectionId);
  }
  if (options.state.specId) {
    core.info(`[postman-tdd] Deleting spec ${options.state.specId}.`);
    await options.postman.deleteSpec(options.state.specId);
  }
}

async function publishFailure(options: {
  artifactClient: AgentContextArtifactClient;
  document: AgentFailureDocument;
  github: GitHubPrClient;
  prNumber: number;
  state: PreviewAssetState;
  summary: { collectionName: string; failurePhase: FailurePhase; ledger?: LedgerSummary };
}): Promise<number> {
  core.info(`[postman-tdd] Publishing failure context: phase=${options.document.phase}, failures=${options.document.failures.length}.`);
  // D13/P3-2: enrich the document additively with runUrl (from runner env),
  // phase-keyed failedJobs, and the JUnit artifact name. These are populated
  // here (not at the ~7 createFailureDocument call sites) so every publish
  // path gets them for free. ??= preserves any explicit caller value.
  options.document.runUrl ??= resolveRunUrl();
  options.document.failedJobs ??= [`postman-tdd:${options.document.phase}`];
  const junitPath = options.document.ledger ? join(AGENT_CONTEXT_DIR, 'junit.xml') : undefined;
  if (junitPath) {
    options.document.artifact = { ...options.document.artifact, junit: 'junit.xml' };
  }
  const paths = writeAgentContext(options.document, AGENT_CONTEXT_DIR);
  core.info(`[postman-tdd] Wrote agent context files: ${paths.agentTaskPath}, ${paths.failuresJsonPath}, ${paths.immutableSpecGuardPath}.`);
  core.setOutput('failure-phase', options.document.phase);

  // D15/P3-4: best-effort check-run annotations on failing ledger packets.
  // Owner/repo from GITHUB_REPOSITORY, head sha from the document commit,
  // token from the github-token input. Swallow-safe — never throws.
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository && options.document.commit) {
    const [owner, repo] = repository.split('/');
    if (owner && repo) {
      await publishCheckRunAnnotations({
        headSha: options.document.commit,
        ledger: options.document.ledger,
        owner,
        repo,
        specPath: options.document.specPath,
        token: core.getInput('github-token')
      });
    }
  }

  let artifact: UploadArtifactResponse | undefined;
  try {
    core.info(`[postman-tdd] Uploading agent context artifact "${AGENT_CONTEXT_ARTIFACT_NAME}".`);
    artifact = await options.artifactClient.uploadArtifact(
      AGENT_CONTEXT_ARTIFACT_NAME,
      [paths.agentTaskPath, paths.failuresJsonPath, paths.immutableSpecGuardPath, ...(junitPath ? [junitPath] : [])],
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

  core.info('[postman-tdd] Updating sticky preview comment with failed status.');
  const commentId = await options.github.upsertStickyComment(options.prNumber, options.state, {
    agentContextArtifactDigest: artifact?.digest,
    agentContextArtifactId: artifact?.id,
    agentContextArtifactName: artifact ? AGENT_CONTEXT_ARTIFACT_NAME : undefined,
    agentTaskPath: paths.agentTaskPath,
    collectionId: options.state.collectionId,
    collectionName: options.summary.collectionName,
    failureDocument: options.document,
    failurePhase: options.summary.failurePhase,
    ledger: options.summary.ledger,
    specId: options.state.specId,
    status: 'failed',
    workspaceId: options.state.workspaceId
  });
  core.setOutput('pr-comment-id', String(commentId));
  return commentId;
}
