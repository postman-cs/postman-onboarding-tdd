import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readActionInputs } from '../src/index.js';

describe('action input parsing', () => {
  const envKeys = [
    'INPUT_ANTHROPIC-API-KEY',
    'INPUT_GITHUB-TOKEN',
    'INPUT_MODE',
    'INPUT_OPENAI-API-KEY',
    'INPUT_POSTMAN-ACCESS-TOKEN',
    'INPUT_POSTMAN-API-KEY',
    'INPUT_REPAIR-MODEL',
    'INPUT_REPAIR-PROVIDER'
  ];
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    previousEnv.clear();
  });

  function setInput(name: string, value: string): void {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }

  it('defaults to the OpenAI repair provider and model', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');

    expect(readActionInputs()).toMatchObject({
      openaiApiKey: undefined,
      repairModel: 'gpt-5.5',
      repairProvider: 'openai-responses'
    });
  });

  it('reads Anthropic repair credentials and defaults to a Claude model', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');
    setInput('repair-provider', 'anthropic-messages');
    setInput('anthropic-api-key', 'anthropic-token');

    expect(readActionInputs()).toMatchObject({
      anthropicApiKey: 'anthropic-token',
      openaiApiKey: undefined,
      repairModel: 'claude-sonnet-5',
      repairProvider: 'anthropic-messages'
    });
  });

  it('reads Postman Agent Mode credentials and defaults to a Postman gateway model', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');
    setInput('postman-access-token', 'postman-access-token');
    setInput('repair-provider', 'postman-agent-mode');

    expect(readActionInputs()).toMatchObject({
      postmanAccessToken: 'postman-access-token',
      repairModel: 'GPT_54',
      repairProvider: 'postman-agent-mode'
    });
  });
});
