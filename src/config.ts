import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';

import type { ConfigWriteMode, RepairProvider, ResolvedOnboardingConfig } from './types.js';

type JsonRecord = Record<string, unknown>;

export interface ConfigLoadOptions {
  configPath: string;
  projectNameOverride?: string;
  specPathOverride?: string;
}

export interface WorkspaceIdPatchResult {
  changed: boolean;
  configPath: string;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string {
  return String(value || '').trim();
}

function numberValue(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number, got: ${String(value)}`);
  }
  return parsed;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => stringValue(entry))
    .filter(Boolean);
}

export function validateRepairProvider(value: string | undefined): RepairProvider {
  const normalized = stringValue(value || 'openai-responses');
  if (normalized === 'openai-responses') {
    return normalized;
  }
  throw new Error(`Unsupported repair-provider "${value}". Expected openai-responses`);
}

export function loadOnboardingConfig(options: ConfigLoadOptions): ResolvedOnboardingConfig {
  const configPath = options.configPath;
  let raw = '';
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read onboarding config ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML in ${configPath}: ${doc.errors[0]?.message || 'unknown parse error'}`);
  }
  const root = asRecord(doc.toJSON());
  const service = asRecord(root.service);
  const spec = asRecord(root.spec);
  const tdd = asRecord(root.tdd);
  const workspace = asRecord(tdd.workspace);
  const repairConfig = asRecord(tdd.repair);

  const projectName = stringValue(options.projectNameOverride || service.name);
  const specPath = stringValue(options.specPathOverride || spec.path);
  const workspaceName = stringValue(workspace.name);
  const workspaceId = stringValue(workspace.id);
  const enabled = tdd.enabled === true || stringValue(tdd.enabled).toLowerCase() === 'true';

  if (!projectName) {
    throw new Error('service.name or project-name input is required');
  }
  if (!specPath) {
    throw new Error('spec.path or spec-path input is required');
  }
  if (enabled && !workspaceName && !workspaceId) {
    throw new Error('tdd.workspace.name or tdd.workspace.id is required when tdd.enabled=true');
  }

  const runtime = {
    baseUrl: stringValue(tdd.baseUrl),
    healthUrl: stringValue(tdd.healthUrl),
    startCommand: stringValue(tdd.startCommand),
    stopCommand: stringValue(tdd.stopCommand) || undefined,
    timeoutSeconds: numberValue(tdd.timeoutSeconds, 90, 'tdd.timeoutSeconds')
  };

  const repairEnabled = repairConfig.enabled === true ||
    stringValue(repairConfig.enabled).toLowerCase() === 'true';
  const repairAllowedWritePaths = stringArrayValue(repairConfig.allowedWritePaths);
  const repairAllowedReadPaths = stringArrayValue(repairConfig.allowedReadPaths);
  const repair = {
    allowedReadPaths: repairAllowedReadPaths.length > 0 ? repairAllowedReadPaths : repairAllowedWritePaths,
    allowedWritePaths: repairAllowedWritePaths,
    enabled: repairEnabled,
    localTestCommand: stringValue(repairConfig.localTestCommand) || undefined,
    maxAttempts: numberValue(repairConfig.maxAttempts, 3, 'tdd.repair.maxAttempts'),
    provider: validateRepairProvider(stringValue(repairConfig.provider) || 'openai-responses')
  };

  if (enabled) {
    if (!runtime.baseUrl) throw new Error('tdd.baseUrl is required when tdd.enabled=true');
    if (!runtime.healthUrl) throw new Error('tdd.healthUrl is required when tdd.enabled=true');
    if (!runtime.startCommand) throw new Error('tdd.startCommand is required when tdd.enabled=true');
  }
  if (repair.enabled && repair.allowedWritePaths.length === 0) {
    throw new Error('tdd.repair.allowedWritePaths is required when tdd.repair.enabled=true');
  }

  return {
    configPath,
    projectName,
    specPath,
    tddEnabled: enabled,
    workspace: {
      ...(workspaceId ? { id: workspaceId } : {}),
      name: workspaceName
    },
    runtime,
    repair
  };
}

export function patchWorkspaceId(configPath: string, workspaceId: string): WorkspaceIdPatchResult {
  const raw = readFileSync(configPath, 'utf8');
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML in ${configPath}: ${doc.errors[0]?.message || 'unknown parse error'}`);
  }

  const existing = stringValue(doc.getIn(['tdd', 'workspace', 'id']));
  if (existing === workspaceId) {
    return { changed: false, configPath };
  }

  if (!doc.has('tdd')) {
    doc.set('tdd', {});
  }
  if (!doc.hasIn(['tdd', 'workspace'])) {
    doc.setIn(['tdd', 'workspace'], {});
  }
  doc.setIn(['tdd', 'workspace', 'id'], workspaceId);
  writeFileSync(configPath, String(doc), 'utf8');
  return { changed: true, configPath };
}

export function validateConfigWriteMode(value: string | undefined): ConfigWriteMode {
  const normalized = stringValue(value || 'commit-and-push');
  if (normalized === 'commit-and-push' || normalized === 'commit-only' || normalized === 'none') {
    return normalized;
  }
  throw new Error(`Unsupported config-write-mode "${value}". Expected commit-and-push, commit-only, or none`);
}

export function resolveWorkspacePath(path: string): string {
  return resolve(process.env.GITHUB_WORKSPACE || process.cwd(), path);
}

export function resolveConfigRelativePath(configPath: string, relativePath: string): string {
  if (relativePath.startsWith('/')) {
    return relativePath;
  }
  return resolve(dirname(resolveWorkspacePath(configPath)), relativePath);
}
