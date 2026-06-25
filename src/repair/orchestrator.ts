import * as core from '@actions/core';
import { resolve } from 'node:path';

import { createFailureDocument } from '../agent-context.js';
import { loadOnboardingConfig } from '../config.js';
import { extractCollectionFailures } from '../failure-normalizer.js';
import { GitHubPrClient, parseFailureDocument } from '../github/pr-comment.js';
import { createAssetNames, resolveTddWorkspace, upsertPreviewAssets } from '../preview-assets.js';
import {
  ensurePostmanCli,
  runCommand,
  runTddCollection,
  startBackgroundCommand,
  waitForHealth
} from '../runner.js';
import type { PostmanEndpointProfile } from '../postman/base-urls.js';
import type { PostmanClient } from '../postman/client.js';
import type { ActionInputs, AgentFailureDocument, PrMetadata, PreviewAssetState, RepairStatus } from '../types.js';
import type { SecretMasker } from '../secrets.js';
import { commitAndPushRepair, hashPaths, verifyChangedPaths, verifyPathHashes } from './git.js';
import { runOpenAiRepairTurn } from './openai-responses-provider.js';
import type { PatchPolicy } from './patch.js';
import { writeRepairSummary, type RepairSummary } from './summary.js';

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
      schemaVersion: 1,
      status: 'skipped'
    });
    setRepairOutputs({ attempts: 0, status: 'skipped' });
    return;
  }

  if (!options.inputs.openaiApiKey) {
    core.info('[postman-tdd] Repair cannot start because openai-api-key was not provided.');
    throw new Error('openai-api-key is required when mode=repair');
  }
  if (options.inputs.repairProvider !== 'openai-responses' || config.repair.provider !== 'openai-responses') {
    throw new Error('mode=repair v1 only supports repair-provider=openai-responses');
  }

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
  if (failure.commit && failure.commit !== prDetails.headSha) {
    core.info(`[postman-tdd] Repair blocked because failure context is stale: failure=${failure.commit}, head=${prDetails.headSha}.`);
    await block(options, 'stale_failure', `Latest failure JSON commit ${failure.commit} does not match PR head ${prDetails.headSha}.`, 0);
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
    cliInstallUrl: options.endpointProfile.cliInstallUrl,
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
  let currentFailure: AgentFailureDocument = failure;
  let attempts = 0;
  const maxAttempts = Math.min(options.inputs.repairMaxAttempts, config.repair.maxAttempts);
  core.info(`[postman-tdd] Repair loop budget: maxAttempts=${maxAttempts}.`);

  while (attempts < maxAttempts) {
    core.info(`[postman-tdd] Repair attempt ${attempts + 1}/${maxAttempts}: asking provider for an implementation-only patch.`);
    const repair = await runOpenAiRepairTurn({
      apiKey: options.inputs.openaiApiKey,
      failure: currentFailure,
      model: options.inputs.repairModel,
      repairContext: {
        allowedReadPaths: config.repair.allowedReadPaths,
        patchPolicy,
        repoRoot
      },
      secretMasker: options.mask
    });
    if (repair.status === 'blocked') {
      core.info(`[postman-tdd] Provider reported blocked: ${repair.message}`);
      await block(options, 'agent_blocked', repair.message, attempts);
      return;
    }
    if (repair.status === 'no_change') {
      core.info(`[postman-tdd] Provider returned no implementation change: ${repair.message}`);
      await block(options, 'agent_no_change', repair.message, attempts);
      return;
    }

    attempts += 1;
    core.info(`[postman-tdd] Repair attempt ${attempts} accepted patch: ${repair.summary}`);
    core.info(`[postman-tdd] Repair attempt ${attempts} touched paths: ${repair.touchedPaths.join(', ') || '(none reported)'}.`);

    if (config.repair.localTestCommand) {
      core.info(`[postman-tdd] Running repair local test command: ${options.mask(config.repair.localTestCommand)}.`);
      const localTest = await runCommand(config.repair.localTestCommand, { mask: options.mask });
      if (localTest.exitCode !== 0) {
        core.info(`[postman-tdd] Local test command failed with exit code ${localTest.exitCode}; feeding failure back to provider.`);
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
        continue;
      }
      core.info('[postman-tdd] Local test command passed.');
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
      core.info('[postman-tdd] Verifying immutable path hashes before commit.');
      verifyPathHashes(repoRoot, immutableHashes);
      const changedPaths = verifyChangedPaths(repoRoot, patchPolicy);
      core.info(`[postman-tdd] Repair diff validated for commit: ${changedPaths.join(', ') || '(none)'}.`);
      const token = options.inputs.repairGithubToken || options.inputs.githubToken;
      if (!options.inputs.repairGithubToken) {
        core.warning('repair-github-token was not set. Commits pushed with GITHUB_TOKEN may not trigger follow-up workflows.');
      }
      core.info(`[postman-tdd] Committing and pushing repair to branch ${prDetails.headBranch}.`);
      const commitSha = commitAndPushRepair({
        branch: prDetails.headBranch,
        commitMessage: options.inputs.repairCommitMessage,
        committerEmail: options.inputs.committerEmail,
        committerName: options.inputs.committerName,
        githubToken: token,
        patchPolicy,
        repoRoot,
        repository: options.pr.repository
      });
      core.info(`[postman-tdd] Repair commit pushed: ${commitSha}.`);
      const summary = await publishRepair(options.github, options.pr.number, {
        attempts,
        commitSha,
        message: 'Postman TDD repair produced an implementation-only commit after the collection passed in the worker.',
        prNumber: options.pr.number,
        schemaVersion: 1,
        status: 'repaired'
      });
      setRepairOutputs({
        attempts,
        commitSha,
        status: 'repaired',
        summaryPath: summary
      });
      return;
    }
    core.info(`[postman-tdd] Local Postman TDD oracle still failed: phase=${result.failure.phase}, failures=${result.failure.failures.length}.`);
    currentFailure = result.failure;
  }

  core.info(`[postman-tdd] Repair budget exhausted after ${attempts} accepted attempt(s).`);
  await block(options, 'budget_exhausted', `Repair budget exhausted after ${attempts} attempt(s).`, attempts);
}

function logRepairConfig(config: ReturnType<typeof loadOnboardingConfig>, options: RepairModeOptions): void {
  core.startGroup('Postman TDD repair config');
  core.info(`configPath=${config.configPath}`);
  core.info(`projectName=${config.projectName}`);
  core.info(`specPath=${config.specPath}`);
  core.info(`tddEnabled=${config.tddEnabled}`);
  core.info(`repairEnabled=${config.repair.enabled}`);
  core.info(`repairProviderInput=${options.inputs.repairProvider}`);
  core.info(`repairProviderConfig=${config.repair.provider}`);
  core.info(`repairModel=${options.inputs.repairModel}`);
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
  const running = startBackgroundCommand(options.config.runtime.startCommand, { mask: options.mask });
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
      const stop = await runCommand(options.config.runtime.stopCommand, { mask: options.mask });
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
  attempts: number
): Promise<void> {
  core.info(`[postman-tdd] Repair blocked: reason=${reason}, attempts=${attempts}, message=${message}`);
  const summaryPath = await publishRepair(options.github, options.pr.number, {
    attempts,
    blockedReason: reason,
    message,
    prNumber: options.pr.number,
    schemaVersion: 1,
    status: 'blocked'
  });
  setRepairOutputs({
    attempts,
    blockedReason: reason,
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
  status: RepairStatus;
  summaryPath?: string;
}): void {
  core.setOutput('repair-status', options.status);
  core.setOutput('repair-attempts', String(options.attempts));
  core.setOutput('repair-blocked-reason', options.blockedReason || '');
  core.setOutput('repair-commit-sha', options.commitSha || '');
  core.setOutput('repair-summary-path', options.summaryPath || '');
  core.setOutput('status', options.status === 'repaired' ? 'passed' : options.status === 'skipped' ? 'skipped' : 'failed');
  core.setOutput('failure-phase', 'none');
}
