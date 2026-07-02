import type { ActionInputs, AgentFailureDocument, RepairProvider } from '../types.js';
import type { SecretMasker } from '../secrets.js';
import { runAnthropicRepairTurn } from './anthropic-messages-provider.js';
import { runOpenAiRepairTurn } from './openai-responses-provider.js';
import type { RepairProviderResult } from './provider-common.js';
import type { RepairToolContext } from './tools.js';

interface RepairProviderDispatchOptions {
  failure: AgentFailureDocument;
  fetchImpl?: typeof fetch;
  inputs: ActionInputs;
  maxToolRounds?: number;
  provider: RepairProvider;
  repairContext: RepairToolContext;
  secretMasker: SecretMasker;
}

export function defaultRepairModel(provider: RepairProvider): string {
  return provider === 'anthropic-messages' ? 'claude-sonnet-5' : 'gpt-5.5';
}

export function resolveRepairProviderApiKey(inputs: ActionInputs): string {
  if (inputs.repairProvider === 'openai-responses') {
    if (!inputs.openaiApiKey) {
      throw new Error('openai-api-key is required when mode=repair and repair-provider=openai-responses');
    }
    return inputs.openaiApiKey;
  }
  if (inputs.repairProvider === 'anthropic-messages') {
    if (!inputs.anthropicApiKey) {
      throw new Error('anthropic-api-key is required when mode=repair and repair-provider=anthropic-messages');
    }
    return inputs.anthropicApiKey;
  }
  assertNever(inputs.repairProvider);
}

export function assertMatchingRepairProvider(inputProvider: RepairProvider, configProvider: RepairProvider): RepairProvider {
  if (inputProvider !== configProvider) {
    throw new Error(`repair-provider input (${inputProvider}) must match tdd.repair.provider (${configProvider})`);
  }
  return inputProvider;
}

export function runRepairProviderTurn(options: RepairProviderDispatchOptions): Promise<RepairProviderResult> {
  const apiKey = resolveRepairProviderApiKey(options.inputs);
  if (options.provider === 'openai-responses') {
    return runOpenAiRepairTurn({
      apiKey,
      failure: options.failure,
      fetchImpl: options.fetchImpl,
      maxToolRounds: options.maxToolRounds,
      model: options.inputs.repairModel,
      repairContext: options.repairContext,
      secretMasker: options.secretMasker
    });
  }
  if (options.provider === 'anthropic-messages') {
    return runAnthropicRepairTurn({
      apiKey,
      failure: options.failure,
      fetchImpl: options.fetchImpl,
      maxToolRounds: options.maxToolRounds,
      model: options.inputs.repairModel,
      repairContext: options.repairContext,
      secretMasker: options.secretMasker
    });
  }
  assertNever(options.provider);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported repair provider: ${String(value)}`);
}
