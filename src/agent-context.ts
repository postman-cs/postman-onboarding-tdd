import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveWorkspacePath } from './config.js';
import type { AgentFailureDocument, ImmutablePathHash } from './types.js';

export interface AgentContextPaths {
  agentTaskPath: string;
  dir: string;
  failuresJsonPath: string;
  immutableSpecGuardPath: string;
}

const DEFAULT_DIR = '.postman-tdd';
export const IMMUTABLE_SPEC_GUARD_MESSAGE = 'The OpenAPI spec is immutable during implementation repair. Revert spec changes and fix code only.';

type AgentFailureDocumentInput =
  Omit<AgentFailureDocument, 'immutablePathHashes' | 'immutablePaths' | 'schemaVersion' | 'status' | 'successCriteria'> & {
    immutablePathHashes?: ImmutablePathHash[];
    immutablePaths?: string[];
  };

export function hashImmutablePaths(paths: string[]): ImmutablePathHash[] {
  return paths.map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(resolveWorkspacePath(path))).digest('hex')
  }));
}

export function createFailureDocument(
  input: AgentFailureDocumentInput
): AgentFailureDocument {
  const immutablePaths = input.immutablePaths ?? (input.specPath ? [input.specPath] : []);
  const immutablePathHashes = input.immutablePathHashes ?? [];
  return {
    ...input,
    immutablePathHashes,
    immutablePaths,
    schemaVersion: 1,
    status: 'failed',
    successCriteria: {
      requiredCheck: 'Postman TDD Preview',
      doneWhen: 'requiredCheck passes on the latest PR commit'
    }
  };
}

export function writeAgentContext(document: AgentFailureDocument, dir = DEFAULT_DIR): AgentContextPaths {
  mkdirSync(dir, { recursive: true });
  const agentTaskPath = join(dir, 'agent-task.md');
  const failuresJsonPath = join(dir, 'failures.json');
  const immutableSpecGuardPath = join(dir, 'immutable-spec-guard.mjs');
  writeFileSync(failuresJsonPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  writeFileSync(agentTaskPath, renderAgentTask(document), 'utf8');
  writeFileSync(immutableSpecGuardPath, renderImmutableSpecGuard(), 'utf8');
  return { agentTaskPath, dir, failuresJsonPath, immutableSpecGuardPath };
}

export function renderAgentTask(document: AgentFailureDocument): string {
  const target = document.specPath || 'the OpenAPI spec';
  const immutablePaths = document.immutablePaths.length > 0
    ? document.immutablePaths.map((path) => `- \`${path}\``)
    : ['- No immutable paths were provided. Treat the configured OpenAPI spec path as read-only.'];
  const lines = [
    '# Postman TDD Task',
    '',
    'The generated Postman TDD contract collection failed against the current PR implementation.',
    '',
    '## Goal',
    '',
    `Update the implementation so it satisfies \`${target}\`.`,
    '',
    '## Success Criteria',
    '',
    'You are done when the GitHub check named `Postman TDD Preview` passes on your latest commit.',
    '',
    'A passing run means:',
    '- the PR OpenAPI spec was used to generate the TDD contract collection',
    '- the service started successfully in CI',
    '- the generated TDD collection passed against the local CI service',
    '- no generated TDD assertions were weakened or bypassed',
    '',
    '## Immutable Paths',
    '',
    'Humans may submit OpenAPI spec changes in the PR. During implementation repair, treat these paths as read-only:',
    ...immutablePaths,
    '',
    'Do not edit, reformat, move, regenerate, or weaken these files. If the failure requires a spec change, stop and report the API intent issue.',
    '',
    '## Immutable Spec Guard',
    '',
    'At agent start, record immutable spec hashes:',
    '',
    '```bash',
    'node .postman-tdd/immutable-spec-guard.mjs snapshot',
    '```',
    '',
    'Before committing or pushing, verify the immutable spec hashes are unchanged:',
    '',
    '```bash',
    'node .postman-tdd/immutable-spec-guard.mjs verify',
    '```',
    '',
    `If verification fails, stop with: "${IMMUTABLE_SPEC_GUARD_MESSAGE}"`,
    '',
    '## Rules',
    '',
    '- Fix implementation code only.',
    '- Do not change files listed in `immutablePaths`.',
    '- Before pushing, verify your diff does not include any path listed in `immutablePaths`.',
    '- Do not edit generated Postman assertions or `.postman-tdd/failures.json`.',
    '- Prefer the smallest implementation change that satisfies the spec.',
    '- Push code changes to this PR branch; the GitHub workflow will rerun automatically.',
    '- If it fails again, use the updated `.postman-tdd/failures.json` and iterate.',
    '',
    '## Exit Conditions',
    '',
    'Stop and report back if:',
    '- the failure requires changing product/API intent',
    '- the OpenAPI spec appears internally inconsistent',
    '- required external secrets, credentials, or infrastructure are missing',
    '- the same failure remains after two reasonable implementation attempts',
    '- fixing the failure requires unrelated architectural changes',
    '',
    '## Current Failure Phase',
    '',
    `\`${document.phase}\`: ${document.message}`,
    '',
    '## Failure Details',
    '',
    'See `.postman-tdd/failures.json`.'
  ];
  return `${lines.join('\n')}\n`;
}

export function renderImmutableSpecGuard(): string {
  return `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAIL_MESSAGE = ${JSON.stringify(IMMUTABLE_SPEC_GUARD_MESSAGE)};
const currentDir = dirname(fileURLToPath(import.meta.url));
const failuresPath = resolve(currentDir, 'failures.json');
const snapshotPath = resolve(currentDir, 'immutable-spec-start.json');
const mode = process.argv[2] || 'verify';

function fail(detail) {
  console.error(FAIL_MESSAGE);
  if (detail) console.error(detail);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(\`Could not read \${path}: \${error instanceof Error ? error.message : String(error)}\`);
  }
}

function hashFile(path) {
  if (!existsSync(path)) {
    fail(\`Missing immutable path: \${path}\`);
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const failureDocument = readJson(failuresPath);
const immutablePaths = Array.isArray(failureDocument.immutablePaths)
  ? failureDocument.immutablePaths.filter((path) => typeof path === 'string' && path.length > 0)
  : [];

if (immutablePaths.length === 0) {
  console.log('No immutable paths declared.');
  process.exit(0);
}

if (mode === 'snapshot') {
  const snapshot = immutablePaths.map((path) => ({ path, sha256: hashFile(path) }));
  writeFileSync(snapshotPath, \`\${JSON.stringify({ schemaVersion: 1, hashes: snapshot }, null, 2)}\\n\`, 'utf8');
  console.log(\`Recorded immutable spec hash snapshot for \${snapshot.length} path(s).\`);
  process.exit(0);
}

if (mode !== 'verify') {
  console.error('Usage: node .postman-tdd/immutable-spec-guard.mjs snapshot|verify');
  process.exit(2);
}

const expected = existsSync(snapshotPath)
  ? readJson(snapshotPath).hashes
  : failureDocument.immutablePathHashes;

if (!Array.isArray(expected) || expected.length === 0) {
  fail('No immutable spec hash snapshot exists. Run snapshot before making implementation changes.');
}

for (const item of expected) {
  if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string') {
    fail('Invalid immutable spec hash record.');
  }
  const actual = hashFile(item.path);
  if (actual !== item.sha256) {
    fail(\`Changed immutable path: \${item.path}\`);
  }
}

console.log(\`Immutable spec guard passed for \${expected.length} path(s).\`);
`;
}
