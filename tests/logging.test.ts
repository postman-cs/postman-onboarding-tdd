import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type LogSink } from '@postman-cse/automation-core';

import { runAction } from '../src/index.js';
import type { GitHubPrClient } from '../src/github/pr-comment.js';

/**
 * A log line is evidence. These tests pin the properties that make it worth
 * trusting: a credential an upstream echoes back never survives into output,
 * a failure names the phase it died in, and debug chatter stays opt-in.
 */

vi.hoisted(() => {
  // @actions/github snapshots GITHUB_EVENT_PATH at import time; a real event
  // payload in CI would override the SHA these tests set.
  delete process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_EVENT_NAME;
});

const PMAK = 'PMAK-tddloggingtestkey-0123456789';

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      debug: (message) => lines.push('debug ' + message),
      info: (message) => lines.push('info ' + message),
      warning: (message) => lines.push('warning ' + message),
      error: (message) => lines.push('error ' + message)
    }
  };
}

describe('onboarding-tdd logging', () => {
  const envKeys = [
    'GITHUB_OUTPUT',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ID',
    'GITHUB_SERVER_URL',
    'GITHUB_SHA',
    'GITHUB_WORKSPACE',
    'INPUT_CONFIG-WRITE-MODE',
    'INPUT_GITHUB-TOKEN',
    'INPUT_MODE',
    'INPUT_ONBOARDING-CONFIG-PATH',
    'INPUT_POSTMAN-API-KEY',
    'INPUT_PR-NUMBER'
  ];
  const previousEnv = new Map<string, string | undefined>();
  let dir = '';
  let previousCwd = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function prepareRepo(): void {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-logging-'));
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    writeFileSync(
      join(dir, '.postman-template', 'onboarding.yml'),
      'spec:\n  path: api/openapi.yaml\nservice:\n  name: logging-service\ntdd:\n  enabled: true\n',
      'utf8'
    );
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    process.env.GITHUB_REPOSITORY = 'postman-cs/logging-service';
    process.env.GITHUB_SHA = 'head-sha';
    const outputPath = join(dir, 'outputs.txt');
    writeFileSync(outputPath, '', 'utf8');
    process.env.GITHUB_OUTPUT = outputPath;
    process.env['INPUT_MODE'] = 'run';
    process.env['INPUT_PR-NUMBER'] = '42';
    process.env['INPUT_POSTMAN-API-KEY'] = PMAK;
    process.env['INPUT_GITHUB-TOKEN'] = 'github-token-value';
    process.env['INPUT_CONFIG-WRITE-MODE'] = 'none';
    process.env['INPUT_ONBOARDING-CONFIG-PATH'] = '.postman-template/onboarding.yml';
  }

  // An upstream that reflects the credential back must not turn a diagnostic
  // line into a leak.
  function echoingGithubClient(): GitHubPrClient {
    return {
      findStickyComment: async () => {
        throw new Error('GitHub rejected the request: ' + PMAK);
      },
      upsertStickyComment: async () => 321
    } as unknown as GitHubPrClient;
  }

  const artifactClient = {
    uploadArtifact: async () => ({ digest: 'sha256:logging', id: 654 })
  };

  function run(logger: ReturnType<typeof createLogger>): Promise<void> {
    return runAction({
      artifactClient: artifactClient as never,
      githubClient: echoingGithubClient(),
      logger,
      postmanClient: {} as never
    });
  }

  it('never emits the credential it was handed, even when upstream echoes it back', async () => {
    prepareRepo();
    const { sink, lines } = recordingSink();

    await expect(run(createLogger({ sink, level: 'debug' }))).rejects.toThrow();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(PMAK);
    expect(lines.join('\n')).toContain('***');
  });

  it('names the phase that failed, which setFailed alone would not', async () => {
    prepareRepo();
    const { sink, lines } = recordingSink();

    await expect(run(createLogger({ sink, level: 'debug' }))).rejects.toThrow();

    const all = lines.join('\n');
    expect(all).toContain('action failed');
    expect(all).toContain('phase=config');
  });

  it('keeps debug chatter out of a default run and opens it under RUNNER_DEBUG', async () => {
    async function collect(env: NodeJS.ProcessEnv): Promise<string[]> {
      prepareRepo();
      const { sink, lines } = recordingSink();
      await run(createLogger({ sink, env })).catch(() => undefined);
      return lines;
    }

    expect((await collect({})).filter((line) => line.startsWith('debug'))).toHaveLength(0);
    expect(
      (await collect({ RUNNER_DEBUG: '1' })).filter((line) => line.startsWith('debug')).length
    ).toBeGreaterThan(0);
  });
});
