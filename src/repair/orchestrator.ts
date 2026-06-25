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
  const config = loadOnboardingConfig({
    configPath: options.inputs.onboardingConfigPath,
    projectNameOverride: options.inputs.projectName,
    specPathOverride: options.inputs.specPath
  });

  if (!config.tddEnabled || !config.repair.enabled) {
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
    throw new Error('openai-api-key is required when mode=repair');
  }
  if (options.inputs.repairProvider !== 'openai-responses' || config.repair.provider !== 'openai-responses') {
    throw new Error('mode=repair v1 only supports repair-provider=openai-responses');
  }

  const prDetails = await options.github.getPullRequest(options.pr.number);
  if (prDetails.isFork) {
    await block(options, 'fork_pr', 'Postman TDD repair is disabled for fork pull requests in v1.', 0);
    return;
  }

  const sticky = await options.github.findStickyComment(options.pr.number);
  const failure = sticky?.body ? parseFailureDocument(sticky.body) : undefined;
  if (!failure) {
    await block(options, 'missing_failure_context', 'No Postman TDD Preview failure JSON was found on the sticky PR comment.', 0);
    return;
  }
  if (failure.commit && failure.commit !== prDetails.headSha) {
    await block(options, 'stale_failure', `Latest failure JSON commit ${failure.commit} does not match PR head ${prDetails.headSha}.`, 0);
    return;
  }
  if (!REPAIRABLE_PHASES.has(failure.phase)) {
    await block(options, 'unsupported_failure_phase', `Repair mode does not attempt phase ${failure.phase}.`, 0);
    return;
  }

  const assetNames = createAssetNames(options.pr.number, config.projectName);
  let state: PreviewAssetState = {
    prNumber: options.pr.number,
    schemaVersion: 1,
    ...(sticky?.assetState?.prNumber === options.pr.number ? sticky.assetState : {})
  };
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
  const patchPolicy: PatchPolicy = {
    allowedWritePaths: config.repair.allowedWritePaths,
    immutablePaths,
    repoRoot
  };
  let currentFailure: AgentFailureDocument = failure;
  let attempts = 0;
  const maxAttempts = Math.min(options.inputs.repairMaxAttempts, config.repair.maxAttempts);

  while (attempts < maxAttempts) {
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
      await block(options, 'agent_blocked', repair.message, attempts);
      return;
    }
    if (repair.status === 'no_change') {
      await block(options, 'agent_no_change', repair.message, attempts);
      return;
    }

    attempts += 1;
    core.info(`Repair attempt ${attempts}: ${repair.summary}`);

    if (config.repair.localTestCommand) {
      const localTest = await runCommand(config.repair.localTestCommand, { mask: options.mask });
      if (localTest.exitCode !== 0) {
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
    }

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
      verifyPathHashes(repoRoot, immutableHashes);
      verifyChangedPaths(repoRoot, patchPolicy);
      const token = options.inputs.repairGithubToken || options.inputs.githubToken;
      if (!options.inputs.repairGithubToken) {
        core.warning('repair-github-token was not set. Commits pushed with GITHUB_TOKEN may not trigger follow-up workflows.');
      }
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
    currentFailure = result.failure;
  }

  await block(options, 'budget_exhausted', `Repair budget exhausted after ${attempts} attempt(s).`, attempts);
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
  const running = startBackgroundCommand(options.config.runtime.startCommand, { mask: options.mask });
  try {
    const health = await waitForHealth(
      options.config.runtime.healthUrl,
      running,
      options.config.runtime.timeoutSeconds,
      options.mask
    );
    if (!health.ok) {
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

    const collectionRun = await runTddCollection(options.collectionId, options.config.runtime.baseUrl, options.mask);
    if (collectionRun.exitCode === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      failure: createFailureDocument({
        baseUrl: options.config.runtime.baseUrl,
        collectionName: options.assetNames.collectionName,
        commit: options.prHeadSha,
        failures: extractCollectionFailures(collectionRun.logExcerpt),
        immutablePathHashes: options.immutableHashes,
        immutablePaths: options.immutablePaths,
        message: `Postman TDD collection failed with exit code ${collectionRun.exitCode}`,
        phase: 'collection_run',
        specPath: options.config.specPath
      })
    };
  } finally {
    if (options.config.runtime.stopCommand) {
      const stop = await runCommand(options.config.runtime.stopCommand, { mask: options.mask });
      if (stop.exitCode !== 0) {
        core.warning(`tdd.stopCommand failed: ${stop.logExcerpt}`);
      }
    } else {
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
