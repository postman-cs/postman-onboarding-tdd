import type { SecretMasker } from '../secrets.js';
import type { AgentFailureDocument } from '../types.js';
import type { RepairToolContext } from './tools.js';

export interface RepairProviderOptions {
  apiKey: string;
  failure: AgentFailureDocument;
  fetchImpl?: typeof fetch;
  maxToolRounds?: number;
  model: string;
  repairContext: RepairToolContext;
  secretMasker: SecretMasker;
}

export type RepairProviderResult =
  | { status: 'changed'; summary: string; touchedPaths: string[] }
  | { status: 'blocked'; message: string }
  | { status: 'no_change'; message: string };

export function buildRepairPrompt(failure: AgentFailureDocument, context: RepairToolContext): string {
  return [
    'You are repairing an API implementation so it passes a Postman TDD contract collection.',
    'Fix implementation code only.',
    'Do not modify, regenerate, or weaken the OpenAPI spec or generated assertions.',
    `Allowed write paths: ${context.patchPolicy.allowedWritePaths.join(', ')}`,
    `Allowed read paths: ${context.allowedReadPaths.join(', ')}`,
    `Immutable paths: ${context.patchPolicy.immutablePaths.join(', ') || '(none)'}`,
    'Use read_file, list_files, and search_files to inspect implementation files.',
    'Use propose_patch with a unified git diff when you have a code-only fix.',
    'Use finish with status=blocked if API intent is unclear, infrastructure is missing, or no implementation-only fix is reasonable.',
    '',
    'Failure context:',
    JSON.stringify({
      baseUrl: failure.baseUrl,
      collectionName: failure.collectionName,
      failures: failure.failures,
      phase: failure.phase,
      successCriteria: failure.successCriteria
    }, null, 2)
  ].join('\n');
}
