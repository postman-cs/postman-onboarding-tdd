import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentFailureDocument } from './types.js';

export interface AgentContextPaths {
  agentTaskPath: string;
  dir: string;
  failuresJsonPath: string;
}

const DEFAULT_DIR = '.postman-tdd';

type AgentFailureDocumentInput =
  Omit<AgentFailureDocument, 'immutablePaths' | 'schemaVersion' | 'status' | 'successCriteria'> & {
    immutablePaths?: string[];
  };

export function createFailureDocument(
  input: AgentFailureDocumentInput
): AgentFailureDocument {
  const immutablePaths = input.immutablePaths ?? (input.specPath ? [input.specPath] : []);
  return {
    ...input,
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
  writeFileSync(failuresJsonPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  writeFileSync(agentTaskPath, renderAgentTask(document), 'utf8');
  return { agentTaskPath, dir, failuresJsonPath };
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
