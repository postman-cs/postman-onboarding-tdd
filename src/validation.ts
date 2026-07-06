import * as core from '@actions/core';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { loadOnboardingConfig } from './config.js';
import { buildContractIndex, parseOpenApiDocument } from './contract.js';
import { isPathDenied, type PatchPolicy } from './repair/patch.js';
import type { ActionInputs, ResolvedOnboardingConfig } from './types.js';

interface ValidationIssue {
  message: string;
}

interface ValidationState {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateModeOptions {
  inputs: ActionInputs;
  mask: (value: string) => string;
}

export async function runValidateMode(options: ValidateModeOptions): Promise<void> {
  const state: ValidationState = {
    errors: [],
    warnings: []
  };

  core.startGroup('Postman TDD setup validation');
  core.info(`configPath=${options.inputs.onboardingConfigPath}`);
  core.info(`projectNameOverride=${options.inputs.projectName || '(not configured)'}`);
  core.info(`specPathOverride=${options.inputs.specPath || '(not configured)'}`);
  core.info(`repairProviderInput=${options.inputs.repairProvider || '(from config)'}`);
  core.endGroup();

  let config: ResolvedOnboardingConfig | undefined;
  try {
    config = loadOnboardingConfig({
      configPath: options.inputs.onboardingConfigPath,
      projectNameOverride: options.inputs.projectName,
      specPathOverride: options.inputs.specPath
    });
  } catch (error) {
    state.errors.push({ message: formatUnknownError(error) });
  }

  if (config) {
    validateSpec(config, state);
    validateCommands(config, state, options.mask);
    validateRepairConfig(config, options.inputs, state);
    validateWorkflowSelection(state);
  }

  for (const warning of state.warnings) {
    core.warning(`[postman-tdd] ${warning.message}`);
  }
  for (const error of state.errors) {
    core.error(`[postman-tdd] ${error.message}`);
  }

  core.setOutput('validation-error-count', String(state.errors.length));
  core.setOutput('validation-warning-count', String(state.warnings.length));
  core.setOutput('validation-summary', renderValidationSummary(state));

  if (state.errors.length > 0) {
    core.setOutput('status', 'failed');
    core.setOutput('failure-phase', 'config');
    throw new Error(`Postman TDD setup validation failed with ${state.errors.length} error(s).`);
  }

  core.info(`[postman-tdd] Setup validation passed with ${state.warnings.length} warning(s).`);
  core.setOutput('status', 'passed');
  core.setOutput('failure-phase', 'none');
}

function validateSpec(config: ResolvedOnboardingConfig, state: ValidationState): void {
  const specPath = resolveWorkspacePath(config.specPath);
  if (!existsSync(specPath)) {
    state.errors.push({ message: `OpenAPI spec path does not exist: ${config.specPath}` });
    return;
  }
  if (!statSync(specPath).isFile()) {
    state.errors.push({ message: `OpenAPI spec path is not a file: ${config.specPath}` });
    return;
  }

  try {
    const document = parseOpenApiDocument(readFileSync(specPath, 'utf8'));
    const index = buildContractIndex(document);
    for (const warning of index.warnings) {
      state.warnings.push({ message: warning });
    }
    if (index.operations.length === 0) {
      state.errors.push({ message: 'OpenAPI spec must define at least one operation for Postman TDD.' });
    } else {
      core.info(`[postman-tdd] OpenAPI ${index.openapiVersion} spec parsed with ${index.operations.length} operation(s).`);
    }
  } catch (error) {
    state.errors.push({ message: `OpenAPI spec could not be parsed: ${formatUnknownError(error)}` });
  }
}

function validateCommands(
  config: ResolvedOnboardingConfig,
  state: ValidationState,
  mask: (value: string) => string
): void {
  validateCommandPath('tdd.startCommand', config.runtime.startCommand, state, mask);
  if (config.runtime.stopCommand) {
    validateCommandPath('tdd.stopCommand', config.runtime.stopCommand, state, mask);
  }
  if (config.repair.localTestCommand) {
    validateCommandPath('tdd.repair.localTestCommand', config.repair.localTestCommand, state, mask);
  }
}

function validateCommandPath(
  label: string,
  command: string,
  state: ValidationState,
  mask: (value: string) => string
): void {
  const path = firstSimplePathToken(command);
  if (!path) {
    state.warnings.push({
      message: `${label} is not a simple path command, so validate mode did not check that it exists: ${mask(command)}`
    });
    return;
  }
  const absolutePath = resolveWorkspacePath(path);
  if (!existsSync(absolutePath)) {
    state.errors.push({ message: `${label} references a path that does not exist: ${mask(path)}` });
    return;
  }
  if (!statSync(absolutePath).isFile()) {
    state.errors.push({ message: `${label} references a path that is not a file: ${mask(path)}` });
  }
}

function validateRepairConfig(
  config: ResolvedOnboardingConfig,
  inputs: ActionInputs,
  state: ValidationState
): void {
  if (!config.repair.enabled) return;

  if (inputs.repairProvider && inputs.repairProvider !== config.repair.provider) {
    state.errors.push({
      message: `repair-provider input ${inputs.repairProvider} does not match tdd.repair.provider ${config.repair.provider}.`
    });
  }

  const policy: PatchPolicy = {
    allowedWritePaths: config.repair.allowedWritePaths,
    immutablePaths: [config.specPath],
    repoRoot: process.env.GITHUB_WORKSPACE || process.cwd()
  };
  for (const path of config.repair.allowedWritePaths) {
    if (isPathDenied(path, policy)) {
      state.errors.push({ message: `tdd.repair.allowedWritePaths includes a non-writable path: ${path}` });
    }
  }
  for (const path of config.repair.allowedReadPaths) {
    if (isPathDenied(path, policy)) {
      state.errors.push({ message: `tdd.repair.allowedReadPaths includes a non-readable path: ${path}` });
    }
  }
  state.warnings.push({
    message: 'validate mode does not verify provider API keys; repair credentials are checked when mode=repair runs.'
  });
}

function validateWorkflowSelection(state: ValidationState): void {
  const workflowDir = resolveWorkspacePath('.github/workflows');
  if (!existsSync(workflowDir)) return;

  const workflowFiles = readdirSync(workflowDir).filter((entry) => /\.ya?ml$/i.test(entry));
  const hasPreview = workflowFiles.includes('postman-tdd-preview.yml');
  const hasRepair = workflowFiles.includes('postman-tdd-repair.yml');
  const hasCombined = workflowFiles.includes('postman-tdd-preview-and-repair.yml');

  if (hasCombined && hasPreview) {
    state.warnings.push({
      message: 'Both postman-tdd-preview.yml and postman-tdd-preview-and-repair.yml are present; this can create duplicate preview runs.'
    });
  }
  if (hasCombined && hasRepair) {
    state.warnings.push({
      message: 'Both postman-tdd-repair.yml and postman-tdd-preview-and-repair.yml are present; keep the combined workflow for branch testing only.'
    });
  }

  for (const file of workflowFiles) {
    const path = join(workflowDir, file);
    const source = readFileSync(path, 'utf8');
    if (source.includes('postman-access-token:') && !source.includes('mode: repair')) {
      state.warnings.push({
        message: `${basename(file)} passes postman-access-token outside a repair workflow; preview-only jobs do not need that secret.`
      });
    }
  }
}

function firstSimplePathToken(command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0] || '';
  if (first.startsWith('./') || first.startsWith('../') || first.startsWith('/')) {
    return first;
  }
  return undefined;
}

function resolveWorkspacePath(path: string): string {
  return resolve(process.env.GITHUB_WORKSPACE || process.cwd(), path);
}

function renderValidationSummary(state: ValidationState): string {
  const lines = [
    `errors=${state.errors.length}`,
    `warnings=${state.warnings.length}`
  ];
  for (const error of state.errors) {
    lines.push(`error: ${error.message}`);
  }
  for (const warning of state.warnings) {
    lines.push(`warning: ${warning.message}`);
  }
  return lines.join('\n');
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
