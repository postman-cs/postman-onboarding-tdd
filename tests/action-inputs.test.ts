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
    'INPUT_REPAIR-MAX-TOOL-ROUNDS',
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

  it('leaves the repair provider and model unset when the action input is omitted', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');

    expect(readActionInputs()).toMatchObject({
      openaiApiKey: undefined,
      repairModel: undefined,
      repairProvider: undefined
    });
  });

  it('allows validate mode without GitHub or Postman credentials', () => {
    setInput('mode', 'validate');

    expect(readActionInputs()).toMatchObject({
      githubToken: '',
      mode: 'validate',
      postmanApiKey: ''
    });
  });

  it('requires GitHub and Postman credentials outside validate mode', () => {
    expect(() => readActionInputs()).toThrow('github-token is required unless mode=validate');

    setInput('github-token', 'github-token');
    expect(() => readActionInputs()).toThrow('postman-api-key is required unless mode=validate');
  });

  it('defaults to an OpenAI model when the OpenAI repair provider input is set', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');
    setInput('repair-provider', 'openai-responses');

    expect(readActionInputs()).toMatchObject({
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
      repairModel: 'GPT_5',
      repairProvider: 'postman-agent-mode'
    });
  });

  it('defaults repair-max-tool-rounds to 12 when the action input is omitted', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');

    expect(readActionInputs().repairMaxToolRounds).toBe(12);
  });

  it('accepts valid repair-max-tool-rounds values at the range edges', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');

    setInput('repair-max-tool-rounds', '1');
    expect(readActionInputs().repairMaxToolRounds).toBe(1);

    setInput('repair-max-tool-rounds', '50');
    expect(readActionInputs().repairMaxToolRounds).toBe(50);
  });

  it('throws on repair-max-tool-rounds below 1, above 50, non-integer, or non-numeric', () => {
    setInput('github-token', 'github-token');
    setInput('postman-api-key', 'postman-token');

    for (const value of ['0', '51', 'abc', '1.5']) {
      setInput('repair-max-tool-rounds', value);
      expect(() => readActionInputs()).toThrow('repair-max-tool-rounds must be an integer between 1 and 50');
    }
  });
});
