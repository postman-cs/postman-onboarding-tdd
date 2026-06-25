import * as core from '@actions/core';
import { readFileSync } from 'node:fs';

import { patchWorkspaceId, resolveWorkspacePath } from './config.js';
import { buildContractIndex, instrumentContractCollection, parseOpenApiDocument } from './contract.js';
import { commitConfigWriteback } from './github/repo-mutation.js';
import type { PostmanClient } from './postman/client.js';
import type { ActionInputs, PreviewAssetState, ResolvedOnboardingConfig } from './types.js';

export function createAssetNames(prNumber: number, projectName: string): { collectionName: string; specName: string } {
  return {
    collectionName: `[TDD PR-${prNumber}] [Contract] ${projectName}`,
    specName: `[TDD PR-${prNumber}] ${projectName}`
  };
}

export async function resolveTddWorkspace(options: {
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

export async function upsertPreviewAssets(options: {
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

function parseWorkspaceTeamId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`workspace-team-id must be numeric, got: ${value}`);
  }
  return parsed;
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
