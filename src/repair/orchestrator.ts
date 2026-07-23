import * as core from '@actions/core';
import { resolve } from 'node:path';

import { createFailureDocument } from '../agent-context.js';
import { loadOnboardingConfig } from '../config.js';
import { buildContractHints } from '../contract-hints.js';
import { extractCollectionFailures } from '../failure-normalizer.js';
import { failureFingerprint } from '../ledger.js';
import { GitHubPrClient, parseFailureDocument } from '../github/pr-comment.js';
import { createAssetNames, resolveTddWorkspace, upsertPreviewAssets } from '../preview-assets.js';
import {
  ensurePostmanCli,
  runCommand,
  runTddCollection,
  startBackgroundCommand,
  waitForHealth
} from '../runner.js';
import {
  resolvePostmanCliInstallUrl,
  type PostmanEndpointProfile
} from '../postman/base-urls.js';
import type { PostmanClient } from '../postman/client.js';
import type { ActionInputs, AgentFailureDocument, PrMetadata, PreviewAssetState, RepairCheckpointPayload, RepairProvider, RepairStatus, SignedRepairCheckpoint } from '../types.js';
import type { SecretMasker } from '../secrets.js';
import { commitAndPushRepair, hashPaths, repairBranchName, repairCommitMessage, verifyChangedPaths, verifyPathHashes } from './git.js';
import { assertMatchingRepairProvider, defaultRepairModel, resolveRepairProviderApiKey, runRepairProviderTurn } from './provider-dispatcher.js';
import type { PatchPolicy } from './patch.js';
import { writeRepairSummary, type RepairAttemptDiagnostic, type RepairSummary } from './summary.js';
import { signRepairCheckpoint, verifyRepairCheckpoint, writeCheckpointArtifact } from './checkpoint.js';

export interface RepairModeOptions {
  endpointProfile: PostmanEndpointProfile;
  github: GitHubPrClient;
  inputs: ActionInputs;
  mask: SecretMasker;
  postman: PostmanClient;
  pr: PrMetadata;
}

const REPAIRABLE_PHASES = new Set(['collection_run', 'service_startup', 'health_check']);

export async function runRepairMode(options: RepairModeOptions): Promise<void> {
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  core.info(`[postman-tdd] Starting repair mode for ${options.pr.repository}#${options.pr.number}.`);
  const config = loadOnboardingConfig({
    configPath: options.inputs.onboardingConfigPath,
    projectNameOverride: options.inputs.projectName,
    specPathOverride: options.inputs.specPath
  });
  logRepairConfig(config, options);

  if (!config.tddEnabled || !config.repair.enabled) {
    core.info(`[postman-tdd] Repair skipped: ${!config.tddEnabled ? 'tdd_disabled' : 'repair_disabled'}.`);
    await publishRepair(options.github, options.pr.number, {
      attempts: 0,
      blockedReason: !config.tddEnabled ? 'tdd_disabled' : 'repair_disabled',
      message: !config.tddEnabled ? 'TDD preview is disabled.' : 'TDD repair is disabled.',
      prNumber: options.pr.number,
      schemaVersion: 2,
      status: 'skipped'
    });
    setRepairOutputs({ attempts: 0, status: 'skipped' });
    return;
  }

  const repairProvider = assertMatchingRepairProvider(options.inputs.repairProvider, config.repair.provider);
  const repairModel = options.inputs.repairModel || defaultRepairModel(repairProvider);
  resolveRepairProviderApiKey(options.inputs, repairProvider);
  core.info(`[postman-tdd] Repair provider resolved: provider=${repairProvider}, model=${repairModel}.`);

  core.info(`[postman-tdd] Fetching PR details for #${options.pr.number}.`);
  const prDetails = await options.github.getPullRequest(options.pr.number);
  core.info(`[postman-tdd] PR details: head=${prDetails.headRepository}:${prDetails.headBranch}@${prDetails.headSha}, base=${prDetails.baseRepository}, fork=${prDetails.isFork}.`);
  if (prDetails.isFork) {
    await block(options, 'fork_pr', 'Postman TDD repair is disabled for fork pull requests in v1.', 0);
    return;
  }

  core.info('[postman-tdd] Reading latest Postman TDD Preview sticky comment.');
  const sticky = await options.github.findStickyComment(options.pr.number);
  const failure = sticky?.body ? parseFailureDocument(sticky.body) : undefined;
  if (!failure) {
    await block(options, 'missing_failure_context', 'No Postman TDD Preview failure JSON was found on the sticky PR comment.', 0);
    return;
  }
  core.info(`[postman-tdd] Failure context found: phase=${failure.phase}, commit=${failure.commit || '(missing)'}, failures=${failure.failures.length}.`);
  const failureCommit = failure.commit;
  if (!isNonEmptyString(failureCommit)) {
    core.info('[postman-tdd] Repair blocked because failure context is missing the PR head commit.');
    await block(options, 'missing_failure_commit', 'Latest failure JSON is missing commit; wait for Postman TDD Preview to publish failure context for the latest PR head.', 0);
    return;
  }
  const malformedReason = validateRepairFailureContext(failure);
  if (malformedReason) {
    core.info(`[postman-tdd] Repair blocked because failure context is malformed: ${malformedReason}.`);
    await block(options, 'malformed_failure_context', `Latest failure JSON is malformed: ${malformedReason}.`, 0);
    return;
  }
  if (failureCommit !== prDetails.headSha) {
    core.info(`[postman-tdd] Repair blocked because failure context is stale: failure=${failureCommit}, head=${prDetails.headSha}.`);
    await block(options, 'stale_failure', `Latest failure JSON commit ${failureCommit} does not match PR head ${prDetails.headSha}.`, 0);
    return;
  }
  if (!REPAIRABLE_PHASES.has(failure.phase)) {
    core.info(`[postman-tdd] Repair blocked because phase ${failure.phase} is unsupported.`);
    await block(options, 'unsupported_failure_phase', `Repair mode does not attempt phase ${failure.phase}.`, 0);
    return;
  }

  const assetNames = createAssetNames(options.pr.number, config.projectName);
  core.info(`[postman-tdd] Repair asset names: spec="${assetNames.specName}", collection="${assetNames.collectionName}".`);
  let state: PreviewAssetState = {
    prNumber: options.pr.number,
    schemaVersion: 1,
    ...(sticky?.assetState?.prNumber === options.pr.number ? sticky.assetState : {})
  };
  core.info(`[postman-tdd] Sticky marker assets before repair: workspace=${state.workspaceId || '(missing)'}, spec=${state.specId || '(missing)'}, collection=${state.collectionId || '(missing)'}.`);
  core.info('[postman-tdd] Repair resolving/updating Postman preview assets for current PR spec.');
  const workspace = await resolveTddWorkspace({
    config,
    inputs: options.inputs,
    postman: options.postman,
    repository: options.pr.repository
  });
  state.workspaceId = workspace.workspaceId;
  const assets = await upsertPreviewAssets({
    assetNames,
    config,
    postman: options.postman,
    state
  });
  state = {
    ...state,
    collectionId: assets.collectionId,
    specId: assets.specId,
    workspaceId: workspace.workspaceId
  };
  core.info(`[postman-tdd] Repair assets ready: workspace=${state.workspaceId}, spec=${state.specId}, collection=${state.collectionId}.`);

  core.info('[postman-tdd] Repair ensuring Postman CLI is available and authenticated.');
  await ensurePostmanCli(options.inputs.postmanApiKey, {
    cliInstallUrl: resolvePostmanCliInstallUrl(options.endpointProfile),
    mask: options.mask,
    postmanRegion: options.inputs.postmanRegion
  });

  const immutablePaths = [...new Set([
    config.specPath,
    ...failure.immutablePaths
  ].filter(Boolean))];
  const immutableHashes = hashPaths(repoRoot, immutablePaths);
  core.info(`[postman-tdd] Repair immutable paths: ${immutablePaths.join(', ')}.`);
  core.info(`[postman-tdd] Recorded immutable path hash baseline for ${immutableHashes.length} path(s).`);
  const patchPolicy: PatchPolicy = {
    allowedWritePaths: config.repair.allowedWritePaths,
    immutablePaths,
    repoRoot
  };
  const maxAttempts = Math.min(options.inputs.repairMaxAttempts, config.repair.maxAttempts);
  core.info(`[postman-tdd] Repair loop budget: maxAttempts=${maxAttempts}.`);

  // D9: Read prior checkpoint from the sticky-comment failure document for resume.
  let startAttempts = 0;
  let resumedEscalated = false;
  let attemptFingerprints: string[] = [];
  let currentCheckpointRef: SignedRepairCheckpoint | RepairCheckpointPayload | undefined;
  let priorRepair: RepairSummary | undefined;
  const priorCheckpoint = failure.checkpointRef || (priorRepair = typeof options.github.findRepairSummary === 'function'
    ? await options.github.findRepairSummary(options.pr.number)
    : undefined)?.checkpointRef;
  if (priorCheckpoint) {
    const checkpointPayload = 'signature' in priorCheckpoint ? priorCheckpoint.payload : priorCheckpoint;
    if (checkpointPayload.commit === prDetails.headSha) {
      if ('signature' in priorCheckpoint && options.inputs.immutableStateSigningKey) {
        if (verifyRepairCheckpoint(priorCheckpoint, options.inputs.immutableStateSigningKey, { commit: prDetails.headSha })) {
          startAttempts = Math.min(checkpointPayload.attempts, maxAttempts);
          resumedEscalated = checkpointPayload.escalated;
          attemptFingerprints = [...checkpointPayload.attemptFingerprints];
          currentCheckpointRef = priorCheckpoint;
          core.info(`[postman-tdd] Authoritative resume from signed checkpoint: attempts=${startAttempts}, fingerprints=${attemptFingerprints.length}.`);
        } else {
          core.info('[postman-tdd] Signed checkpoint failed verification; restarting from attempts=0.');
        }
      } else {
        // Unsigned payload, or signed checkpoint with no signing key configured → ADVISORY resume.
        // Re-verify budgets from the independently visible repair-comment
        // attempt timeline; unsigned checkpoint counters are never trusted.
        priorRepair ||= typeof options.github.findRepairSummary === 'function'
          ? await options.github.findRepairSummary(options.pr.number)
          : undefined;
        const visibleAttempts = priorRepair?.attemptDetails?.length ?? 0;
        startAttempts = Math.min(visibleAttempts, maxAttempts);
        resumedEscalated = Boolean(priorRepair?.checkpointRef && checkpointPayload.escalated);
        attemptFingerprints = checkpointPayload.attemptFingerprints.slice(0, visibleAttempts);
        currentCheckpointRef = priorCheckpoint;
        core.info(`[postman-tdd] Advisory resume from checkpoint: revalidated attempts=${startAttempts} from visible repair-comment history.`);
      }
    } else {
      core.info(`[postman-tdd] Checkpoint commit mismatch; restarting from attempts=0.`);
    }
  }

  let currentFailure: AgentFailureDocument = failure;
  let attempts = startAttempts;
  let escalated = resumedEscalated;
  const attemptDetails: RepairAttemptDiagnostic[] = [];

  while (attempts < maxAttempts) {
    const attemptNumber = attempts + 1;
    core.info(`[postman-tdd] Repair attempt ${attemptNumber}/${maxAttempts}: asking provider for an implementation-only patch.`);
    const repair = await runRepairProviderTurn({
      failure: currentFailure,
      inputs: {
        ...options.inputs,
        repairModel,
        repairProvider
      },
      maxToolRounds: options.inputs.repairMaxToolRounds,
      provider: repairProvider,
      repairContext: {
        allowedReadPaths: config.repair.allowedReadPaths,
        patchPolicy,
        repoRoot
      },
      secretMasker: options.mask
    });
    if (repair.status === 'blocked') {
      core.info(`[postman-tdd] Provider reported blocked: ${repair.message}`);
      attemptDetails.push(providerStoppedAttempt(attemptNumber, 'blocked', repair.message));
      await block(options, 'agent_blocked', repair.message, attempts, attemptDetails, currentCheckpointRef);
      return;
    }
    if (repair.status === 'no_change') {
      core.info(`[postman-tdd] Provider returned no implementation change: ${repair.message}`);
      attemptDetails.push(providerStoppedAttempt(attemptNumber, 'no_change', repair.message));
      await block(options, 'agent_no_change', repair.message, attempts, attemptDetails, currentCheckpointRef);
      return;
    }

    attempts += 1;
    const attempt: RepairAttemptDiagnostic = {
      attempt: attempts,
      localTest: {
        status: 'skipped'
      },
      oracle: {
        status: 'skipped'
      },
      outcome: 'oracle_failed',
      patchSummary: repair.summary,
      providerStatus: 'changed',
      touchedPaths: repair.touchedPaths
    };
    core.info(`[postman-tdd] Repair attempt ${attempts} accepted patch: ${repair.summary}`);
    core.info(`[postman-tdd] Repair attempt ${attempts} touched paths: ${repair.touchedPaths.join(', ') || '(none reported)'}.`);

    if (config.repair.localTestCommand) {
      core.info(`[postman-tdd] Running repair local test command: ${options.mask(config.repair.localTestCommand)}.`);
      const localTest = await runCommand(config.repair.localTestCommand, { mask: options.mask, sanitizeEnv: true });
      if (localTest.exitCode !== 0) {
        core.info(`[postman-tdd] Local test command failed with exit code ${localTest.exitCode}; feeding failure back to provider.`);
        attempt.localTest = {
          command: config.repair.localTestCommand,
          exitCode: localTest.exitCode,
          status: 'failed'
        };
        attempt.outcome = 'local_test_failed';
        attemptDetails.push(attempt);
        currentFailure = createFailureDocument({
          baseUrl: config.runtime.baseUrl,
          collectionName: assetNames.collectionName,
          commit: prDetails.headSha,
          failures: [{
            assertion: 'local test command',
            logExcerpt: localTest.logExcerpt,
            message: `Local test command failed with exit code ${localTest.exitCode}`
          }],
          immutablePathHashes: immutableHashes,
          immutablePaths,
          message: `Local test command failed with exit code ${localTest.exitCode}`,
          phase: 'collection_run',
          specPath: config.specPath
        });
        currentCheckpointRef = buildCheckpoint(
          prDetails.headSha, repairProvider, attempts, escalated, attemptFingerprints, options.inputs.immutableStateSigningKey
        );
        currentFailure = { ...currentFailure, checkpointRef: currentCheckpointRef };
        continue;
      }
      core.info('[postman-tdd] Local test command passed.');
      attempt.localTest = {
        command: config.repair.localTestCommand,
        status: 'passed'
      };
    }

    core.info('[postman-tdd] Running local Postman TDD oracle after repair patch.');
    const result = await runOracle({
      collectionId: state.collectionId || '',
      config,
      immutableHashes,
      immutablePaths,
      mask: options.mask,
      prHeadSha: prDetails.headSha,
      assetNames
    });
    if (result.ok) {
      core.info('[postman-tdd] Local Postman TDD oracle passed.');
      attempt.oracle = {
        status: 'passed'
      };
      attempt.outcome = 'oracle_passed';
      attemptDetails.push(attempt);
      currentCheckpointRef = buildCheckpoint(
        prDetails.headSha, repairProvider, attempts, escalated, attemptFingerprints, options.inputs.immutableStateSigningKey
      );
      core.info('[postman-tdd] Verifying immutable path hashes before commit.');
      verifyPathHashes(repoRoot, immutableHashes);
      const changedPaths = verifyChangedPaths(repoRoot, patchPolicy);
      core.info(`[postman-tdd] Repair diff validated for commit: ${changedPaths.join(', ') || '(none)'}.`);
      const token = options.inputs.repairGithubToken || options.inputs.githubToken;
      if (!options.inputs.repairGithubToken) {
        core.warning('repair-github-token was not set. Commits pushed with GITHUB_TOKEN may not trigger follow-up workflows.');
      }
      core.info(`[postman-tdd] Committing and pushing repair to branch ${repairBranchName(options.pr.number)}.`);
      const commitSha = commitAndPushRepair({
        branch: repairBranchName(options.pr.number),
        commitMessage: repairCommitMessage(options.pr.number),
        committerEmail: options.inputs.committerEmail,
        committerName: options.inputs.committerName,
        githubToken: token,
        patchPolicy,
        repoRoot,
        repository: options.pr.repository
      });
      core.info(`[postman-tdd] Repair commit pushed: ${commitSha}.`);
      const summary = await publishRepair(options.github, options.pr.number, {
        ...(currentCheckpointRef ? { checkpointRef: currentCheckpointRef } : {}),
        attemptDetails,
        attempts,
        commitSha,
        message: 'Postman TDD repair produced an implementation-only commit after the collection passed in the worker.',
        prNumber: options.pr.number,
        schemaVersion: 2,
        status: 'repaired'
      });
      setRepairOutputs({
        attempts,
        commitSha,
        escalated,
        status: 'repaired',
        summaryPath: summary
      });
      return;
    }
    core.info(`[postman-tdd] Local Postman TDD oracle still failed: phase=${result.failure.phase}, failures=${result.failure.failures.length}.`);
    attempt.oracle = failureDiagnostic(result.failure);
    attempt.outcome = 'oracle_failed';
    attemptDetails.push(attempt);
    currentFailure = result.failure;

    // D10: Fingerprint circuit breaker — track consecutive identical post-oracle
    // failure fingerprints and block before spending the next attempt.
    if (result.failure.failures.length > 0) {
      const fp = failureFingerprint(result.failure.failures[0]!);
      attemptFingerprints.push(fp);
      const consecutive = countTrailingConsecutive(attemptFingerprints);
      if (consecutive >= options.inputs.repairBreakerThreshold) {
        const breakerReason = 'repeated_failure';
        const breakerMessage = `Repair circuit breaker: same failure fingerprint (${fp.slice(0, 8)}) recurred ${consecutive} consecutive time(s) (threshold=${options.inputs.repairBreakerThreshold}) after ${attempts} attempt(s).`;
        currentCheckpointRef = buildCheckpoint(
          prDetails.headSha, repairProvider, attempts, escalated, attemptFingerprints, options.inputs.immutableStateSigningKey, breakerReason
        );
        await block(options, breakerReason, breakerMessage, attempts, attemptDetails, currentCheckpointRef);
        return;
      }
    }

    currentCheckpointRef = buildCheckpoint(
      prDetails.headSha, repairProvider, attempts, escalated, attemptFingerprints, options.inputs.immutableStateSigningKey
    );
    currentFailure = { ...currentFailure, checkpointRef: currentCheckpointRef };
  }

  core.info(`[postman-tdd] Repair budget exhausted after ${attempts} accepted attempt(s).`);

  // D11: Rung 2 — optional escalation model (same provider, one extra attempt).
  const escalationModel = options.inputs.repairEscalationModel || config.repair.escalationModel;
  if (escalationModel) {
    escalated = true;
    const escalationAttemptNumber = attempts + 1;
    core.info(`[postman-tdd] Escalation rung: one extra turn with model=${escalationModel} (attempt ${escalationAttemptNumber}).`);
    const escalationRepair = await runRepairProviderTurn({
      failure: currentFailure,
      inputs: {
        ...options.inputs,
        repairModel: escalationModel,
        repairProvider
      },
      maxToolRounds: options.inputs.repairMaxToolRounds,
      provider: repairProvider,
      repairContext: {
        allowedReadPaths: config.repair.allowedReadPaths,
        patchPolicy,
        repoRoot
      },
      secretMasker: options.mask
    });
    if (escalationRepair.status === 'blocked') {
      attemptDetails.push(providerStoppedAttempt(escalationAttemptNumber, 'blocked', escalationRepair.message));
    } else if (escalationRepair.status === 'no_change') {
      attemptDetails.push(providerStoppedAttempt(escalationAttemptNumber, 'no_change', escalationRepair.message));
    } else {
      attempts += 1;
      const escalationAttempt: RepairAttemptDiagnostic = {
        attempt: attempts,
        localTest: { status: 'skipped' },
        oracle: { status: 'skipped' },
        outcome: 'oracle_failed',
        patchSummary: escalationRepair.summary,
        providerStatus: 'changed',
        touchedPaths: escalationRepair.touchedPaths
      };
      const escalationResult = await runOracle({
        collectionId: state.collectionId || '',
        config,
        immutableHashes,
        immutablePaths,
        mask: options.mask,
        prHeadSha: prDetails.headSha,
        assetNames
      });
      if (escalationResult.ok) {
        core.info('[postman-tdd] Escalation oracle passed.');
        escalationAttempt.oracle = { status: 'passed' };
        escalationAttempt.outcome = 'oracle_passed';
        attemptDetails.push(escalationAttempt);
        verifyPathHashes(repoRoot, immutableHashes);
        const changedPaths = verifyChangedPaths(repoRoot, patchPolicy);
        core.info(`[postman-tdd] Escalation diff validated: ${changedPaths.join(', ') || '(none)'}.`);
        const token = options.inputs.repairGithubToken || options.inputs.githubToken;
        const commitSha = commitAndPushRepair({
          branch: repairBranchName(options.pr.number),
          commitMessage: repairCommitMessage(options.pr.number),
          committerEmail: options.inputs.committerEmail,
          committerName: options.inputs.committerName,
          githubToken: token,
          patchPolicy,
          repoRoot,
          repository: options.pr.repository
        });
        core.info(`[postman-tdd] Escalation repair commit pushed: ${commitSha}.`);
        currentCheckpointRef = buildCheckpoint(
          prDetails.headSha, repairProvider, attempts, escalated, attemptFingerprints, options.inputs.immutableStateSigningKey
        );
        const summary = await publishRepair(options.github, options.pr.number, {
          ...(currentCheckpointRef ? { checkpointRef: currentCheckpointRef } : {}),
          attemptDetails,
          attempts,
          commitSha,
          message: 'Postman TDD escalation repair produced an implementation-only commit after the collection passed.',
          prNumber: options.pr.number,
          schemaVersion: 2,
          status: 'repaired'
        });
        setRepairOutputs({ attempts, commitSha, escalated, status: 'repaired', summaryPath: summary });
        return;
      }
      core.info(`[postman-tdd] Escalation oracle still failed: phase=${escalationResult.failure.phase}.`);
      escalationAttempt.oracle = failureDiagnostic(escalationResult.failure);
      escalationAttempt.outcome = 'oracle_failed';
      attemptDetails.push(escalationAttempt);
      currentFailure = escalationResult.failure;
      currentCheckpointRef = buildCheckpoint(
        prDetails.headSha, repairProvider, attempts, escalated, attemptFingerprints, options.inputs.immutableStateSigningKey
      );
    }
  }

  // D11: Rung 3 — terminal block.
  if (escalationModel) {
    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '(run URL unavailable)';
    const firstFailure = currentFailure.failures[0];
    const errorSummary = firstFailure
      ? `${firstFailure.assertion || 'unknown assertion'}: ${firstFailure.message}`
      : currentFailure.message;
    const escalationMessage = `Owner action required: repair could not produce a passing local oracle after ${attempts} attempt(s) including escalation. Models tried: ${repairModel}${escalationModel ? ` → ${escalationModel}` : ''}. Last failure: ${errorSummary}. Recommended next step: inspect the failure context and run logs, then fix manually. Run URL: ${runUrl}`;
    await block(options, 'owner_action_required', escalationMessage, attempts, attemptDetails, currentCheckpointRef, escalated);
  } else {
    await block(options, 'budget_exhausted', `Repair budget exhausted after ${attempts} attempt(s).`, attempts, attemptDetails, currentCheckpointRef, escalated);
  }
}

function validateRepairFailureContext(failure: AgentFailureDocument): string | undefined {
  const context = failure as unknown as Record<string, unknown>;
  if (!Array.isArray(context.failures) || !context.failures.every(isFailureEntry)) {
    return 'failures must be an array of failure objects with messages';
  }
  if (!Array.isArray(context.immutablePaths) || !context.immutablePaths.every(isNonEmptyString)) {
    return 'immutablePaths must be an array of path strings';
  }
  if (!Array.isArray(context.immutablePathHashes) || !context.immutablePathHashes.every(isImmutablePathHash)) {
    return 'immutablePathHashes must be an array of path hash objects';
  }
  if (!isSuccessCriteria(context.successCriteria)) {
    return 'successCriteria must describe the required latest-head check';
  }
  return undefined;
}

function isFailureEntry(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.message);
}

function isImmutablePathHash(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.path) && isNonEmptyString(value.sha256);
}

function isSuccessCriteria(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.doneWhen)
    && typeof value.failureContextMustMatchPrHeadCommit === 'boolean'
    && typeof value.latestHeadOnly === 'boolean'
    && isNonEmptyString(value.requiredCheck);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function failureDiagnostic(failure: AgentFailureDocument): NonNullable<RepairAttemptDiagnostic['oracle']> {
  return {
    failureCount: failure.failures.length,
    failures: failure.failures.slice(0, 5).map((entry) => ({
      ...(entry.assertion ? { assertion: entry.assertion } : {}),
      message: entry.message,
      ...(entry.method ? { method: entry.method } : {}),
      ...(entry.operationId ? { operationId: entry.operationId } : {}),
      ...(entry.path ? { path: entry.path } : {})
    })),
    phase: failure.phase,
    status: 'failed'
  };
}

function providerStoppedAttempt(
  attempt: number,
  providerStatus: 'blocked' | 'no_change',
  message: string
): RepairAttemptDiagnostic {
  return {
    attempt,
    localTest: {
      status: 'skipped'
    },
    oracle: {
      status: 'skipped'
    },
    outcome: providerStatus === 'blocked' ? 'provider_blocked' : 'provider_no_change',
    patchSummary: message,
    providerStatus,
    touchedPaths: []
  };
}

function logRepairConfig(config: ReturnType<typeof loadOnboardingConfig>, options: RepairModeOptions): void {
  core.startGroup('Postman TDD repair config');
  core.info(`configPath=${config.configPath}`);
  core.info(`projectName=${config.projectName}`);
  core.info(`specPath=${config.specPath}`);
  core.info(`tddEnabled=${config.tddEnabled}`);
  core.info(`repairEnabled=${config.repair.enabled}`);
  core.info(`repairProviderInput=${options.inputs.repairProvider || '(from config)'}`);
  core.info(`repairProviderConfig=${config.repair.provider}`);
  core.info(`repairModelInput=${options.inputs.repairModel || '(provider default)'}`);
  core.info(`repairMaxAttemptsInput=${options.inputs.repairMaxAttempts}`);
  core.info(`repairMaxAttemptsConfig=${config.repair.maxAttempts}`);
  core.info(`allowedWritePaths=${config.repair.allowedWritePaths.join(', ') || '(none)'}`);
  core.info(`allowedReadPaths=${config.repair.allowedReadPaths.join(', ') || '(none)'}`);
  core.info(`localTestCommand=${config.repair.localTestCommand ? options.mask(config.repair.localTestCommand) : '(not configured)'}`);
  core.info(`baseUrl=${options.mask(config.runtime.baseUrl)}`);
  core.info(`healthUrl=${options.mask(config.runtime.healthUrl)}`);
  core.info(`startCommand=${options.mask(config.runtime.startCommand)}`);
  core.info(`stopCommand=${config.runtime.stopCommand ? options.mask(config.runtime.stopCommand) : '(not configured)'}`);
  core.info(`timeoutSeconds=${config.runtime.timeoutSeconds}`);
  core.endGroup();
}

async function runOracle(options: {
  assetNames: { collectionName: string; specName: string };
  collectionId: string;
  config: ReturnType<typeof loadOnboardingConfig>;
  immutableHashes: Array<{ path: string; sha256: string }>;
  immutablePaths: string[];
  mask: SecretMasker;
  prHeadSha: string;
}): Promise<{ ok: true } | { failure: AgentFailureDocument; ok: false }> {
  core.info(`[postman-tdd] Oracle starting service: ${options.mask(options.config.runtime.startCommand)}.`);
  const running = startBackgroundCommand(options.config.runtime.startCommand, { mask: options.mask, sanitizeEnv: true });
  try {
    core.info(`[postman-tdd] Oracle waiting for health check ${options.mask(options.config.runtime.healthUrl)} for up to ${options.config.runtime.timeoutSeconds}s.`);
    const health = await waitForHealth(
      options.config.runtime.healthUrl,
      running,
      options.config.runtime.timeoutSeconds,
      options.mask
    );
    if (!health.ok) {
      core.info(`[postman-tdd] Oracle health check failed: phase=${health.phase}, message=${health.message}.`);
      return {
        ok: false,
        failure: createFailureDocument({
          baseUrl: options.config.runtime.baseUrl,
          collectionName: options.assetNames.collectionName,
          commit: options.prHeadSha,
          failures: [{
            logExcerpt: health.logExcerpt,
            message: health.message
          }],
          healthUrl: options.config.runtime.healthUrl,
          immutablePathHashes: options.immutableHashes,
          immutablePaths: options.immutablePaths,
          message: health.message,
          phase: health.phase,
          specPath: options.config.specPath,
          startCommand: options.config.runtime.startCommand,
          timeoutSeconds: options.config.runtime.timeoutSeconds
        })
      };
    }
    core.info('[postman-tdd] Oracle health check passed.');

    core.info(`[postman-tdd] Oracle running collection ${options.collectionId} against ${options.mask(options.config.runtime.baseUrl)}.`);
    const collectionRun = await runTddCollection(options.collectionId, options.config.runtime.baseUrl, options.mask);
    if (collectionRun.exitCode === 0) {
      core.info('[postman-tdd] Oracle collection run passed.');
      return { ok: true };
    }
    const failures = extractCollectionFailures(collectionRun.logExcerpt);
    core.info(`[postman-tdd] Oracle collection run failed with exit code ${collectionRun.exitCode}; normalized ${failures.length} failure(s).`);
    return {
      ok: false,
      failure: createFailureDocument({
        baseUrl: options.config.runtime.baseUrl,
        collectionName: options.assetNames.collectionName,
        commit: options.prHeadSha,
        contractHints: buildContractHints(options.config.specPath, failures),
        failures,
        immutablePathHashes: options.immutableHashes,
        immutablePaths: options.immutablePaths,
        message: `Postman TDD collection failed with exit code ${collectionRun.exitCode}`,
        phase: 'collection_run',
        specPath: options.config.specPath
      })
    };
  } finally {
    if (options.config.runtime.stopCommand) {
      core.info(`[postman-tdd] Oracle running stop command: ${options.mask(options.config.runtime.stopCommand)}.`);
      const stop = await runCommand(options.config.runtime.stopCommand, { mask: options.mask, sanitizeEnv: true });
      if (stop.exitCode !== 0) {
        core.warning(`tdd.stopCommand failed: ${stop.logExcerpt}`);
      }
    } else {
      core.info('[postman-tdd] Oracle terminating started service process.');
      running.kill();
    }
  }
}

async function block(
  options: RepairModeOptions,
  reason: string,
  message: string,
  attempts: number,
  attemptDetails: RepairAttemptDiagnostic[] = [],
  checkpointRef?: SignedRepairCheckpoint | RepairCheckpointPayload,
  escalated: boolean = false
): Promise<void> {
  core.info(`[postman-tdd] Repair blocked: reason=${reason}, attempts=${attempts}, message=${message}`);
  const summaryPath = await publishRepair(options.github, options.pr.number, {
    ...(attemptDetails.length > 0 ? { attemptDetails } : {}),
    ...(checkpointRef ? { checkpointRef } : {}),
    attempts,
    blockedReason: reason,
    message,
    prNumber: options.pr.number,
    schemaVersion: 2,
    status: 'blocked'
  });
  setRepairOutputs({
    attempts,
    blockedReason: reason,
    escalated,
    status: 'blocked',
    summaryPath
  });
}

async function publishRepair(
  github: GitHubPrClient,
  prNumber: number,
  summary: RepairSummary
): Promise<string> {
  core.info(`[postman-tdd] Writing repair summary and updating repair sticky comment: status=${summary.status}, attempts=${summary.attempts}.`);
  const summaryPath = writeRepairSummary(summary);
  await github.upsertRepairComment(prNumber, summary);
  return resolve(summaryPath);
}

function setRepairOutputs(options: {
  attempts: number;
  blockedReason?: string;
  commitSha?: string;
  escalated?: boolean;
  status: RepairStatus;
  summaryPath?: string;
}): void {
  core.setOutput('repair-status', options.status);
  core.setOutput('repair-attempts', String(options.attempts));
  core.setOutput('repair-blocked-reason', options.blockedReason || '');
  core.setOutput('repair-commit-sha', options.commitSha || '');
  core.setOutput('repair-escalated', String(options.escalated || false));
  core.setOutput('repair-summary-path', options.summaryPath || '');
  core.setOutput('status', options.status === 'repaired' ? 'passed' : options.status === 'skipped' ? 'skipped' : 'failed');
  core.setOutput('failure-phase', 'none');
}

/**
 * Counts the trailing run of consecutive identical fingerprints at the end of
 * the array (D10 circuit breaker signal). Returns 0 for an empty array.
 */
function countTrailingConsecutive(fingerprints: string[]): number {
  if (fingerprints.length === 0) return 0;
  const last = fingerprints[fingerprints.length - 1]!;
  let count = 0;
  for (let i = fingerprints.length - 1; i >= 0 && fingerprints[i] === last; i--) {
    count++;
  }
  return count;
}

/**
 * Builds, signs (when a signing key is configured), and persists a
 * {@link RepairCheckpointPayload} to `.postman-tdd/checkpoint.json` (D9 full
 * copy). Returns the signed checkpoint when the key is present, or the bare
 * payload when it is not, for attachment as `checkpointRef` on failure
 * documents and repair summaries.
 */
function buildCheckpoint(
  commit: string,
  provider: RepairProvider,
  attempts: number,
  escalated: boolean,
  attemptFingerprints: string[],
  signingKey: string | undefined,
  breakerReason?: string
): SignedRepairCheckpoint | RepairCheckpointPayload {
  const payload: RepairCheckpointPayload = {
    schemaVersion: 1,
    attempts,
    attemptFingerprints,
    commit,
    escalated,
    provider,
    ...(breakerReason ? { breakerReason } : {})
  };
  writeCheckpointArtifact(payload);
  if (signingKey) {
    return signRepairCheckpoint(payload, signingKey);
  }
  return payload;
}
