import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseFailureDocument,
  renderStickyComment,
  type GitHubPrClient,
  type PrCommentSummary
} from '../src/github/pr-comment.js';
import { runAction } from '../src/index.js';
import type { PreviewAssetState } from '../src/types.js';

describe('runAction failure publishing', () => {
  const envKeys = [
    'GITHUB_OUTPUT',
    'GITHUB_REPOSITORY',
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
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    previousEnv.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function setInput(name: string, value: string): void {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }

  it('publishes config validation failures to the sticky PR comment', async () => {
    dir = mkdtempSync(join(tmpdir(), 'postman-tdd-run-action-'));
    mkdirSync(join(dir, '.postman-template'), { recursive: true });
    writeFileSync(join(dir, '.postman-template', 'onboarding.yml'), `
spec:
  path: api/openapi.yaml
service:
  name: config-failure-service
tdd:
  enabled: true
  workspace:
    name: Config Failure Preview
`, 'utf8');
    process.chdir(dir);
    process.env.GITHUB_WORKSPACE = dir;
    process.env.GITHUB_REPOSITORY = 'postman-cs/config-failure-service';
    process.env.GITHUB_SHA = 'head-sha';
    const outputPath = join(dir, 'outputs.txt');
    writeFileSync(outputPath, '', 'utf8');
    process.env.GITHUB_OUTPUT = outputPath;
    setInput('mode', 'run');
    setInput('pr-number', '42');
    setInput('postman-api-key', 'postman-token');
    setInput('github-token', 'github-token');
    setInput('config-write-mode', 'none');
    setInput('onboarding-config-path', '.postman-template/onboarding.yml');

    const renderedComments: string[] = [];
    const summaries: PrCommentSummary[] = [];
    const github = {
      findStickyComment: async () => undefined,
      upsertStickyComment: async (
        _prNumber: number,
        state: PreviewAssetState,
        summary: PrCommentSummary
      ) => {
        summaries.push(summary);
        renderedComments.push(renderStickyComment(state, summary));
        return 321;
      }
    } as unknown as GitHubPrClient;
    const postmanCalls: string[] = [];
    const postman = new Proxy({}, {
      get(_target, prop) {
        return () => {
          postmanCalls.push(String(prop));
          throw new Error(`Unexpected Postman client call: ${String(prop)}`);
        };
      }
    });
    const uploads: Array<{ files: string[]; name: string; rootDirectory: string }> = [];
    const artifactClient = {
      uploadArtifact: async (name: string, files: string[], rootDirectory: string) => {
        uploads.push({ files, name, rootDirectory });
        return { digest: 'sha256:config-failure', id: 654 };
      }
    };

    await expect(runAction({
      artifactClient: artifactClient as never,
      githubClient: github,
      postmanClient: postman as never
    })).rejects.toThrow('tdd.baseUrl is required');

    expect(postmanCalls).toEqual([]);
    expect(uploads).toEqual([{
      files: [
        '.postman-tdd/agent-task.md',
        '.postman-tdd/failures.json',
        '.postman-tdd/immutable-spec-guard.mjs'
      ],
      name: 'postman-tdd-agent-context',
      rootDirectory: '.'
    }]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      failurePhase: 'config',
      status: 'failed'
    });
    const body = renderedComments[0] || '';
    expect(body).toContain('Postman TDD Preview (FAILED)');
    expect(body).toContain('**Failure phase:** config');
    expect(body).toContain('tdd.baseUrl is required when tdd.enabled=true');
    const failureDocument = parseFailureDocument(body);
    expect(failureDocument?.commit).toBeTruthy();
    expect(failureDocument).toMatchObject({
      failures: [{ message: 'tdd.baseUrl is required when tdd.enabled=true' }],
      phase: 'config',
      status: 'failed'
    });

    const outputs = readFileSync(outputPath, 'utf8');
    expect(outputs).toContain('status');
    expect(outputs).toContain('failed');
    expect(outputs).toContain('failure-phase');
    expect(outputs).toContain('config');
    expect(outputs).toContain('pr-comment-id');
    expect(outputs).toContain('321');
  });
});
