import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowDir = join(process.cwd(), '.postman-template', 'workflows');
const agentsDir = join(workflowDir, 'agents');

function readWorkflow(name: string): string {
  return readFileSync(join(workflowDir, name), 'utf8');
}

function readAgent(name: string): string {
  return readFileSync(join(agentsDir, name), 'utf8');
}

describe('packaged workflow templates', () => {
  it('ships a valid no-secrets setup validation workflow template', () => {
    const source = readWorkflow('postman-tdd-validate.yml');
    const workflow = parse(source) as { name: string };

    expect(workflow.name).toBe('Postman TDD Setup Check');
    expect(source).toContain('postman-cs/postman-onboarding-tdd@v0');
    expect(source).toContain('mode: validate');
    expect(source).toContain('contents: read');
    expect(source).not.toContain('postman-api-key');
    expect(source).not.toContain('github-token');
    expect(source).not.toContain('openai-api-key');
    expect(source).not.toContain('anthropic-api-key');
    expect(source).not.toContain('postman-access-token');
  });

  it('ships a valid preview workflow template', () => {
    const source = readWorkflow('postman-tdd-preview.yml');
    const workflow = parse(source) as { name: string };

    expect(workflow.name).toBe('Postman TDD Preview');
    expect(source).toContain('postman-cs/postman-onboarding-tdd@v0');
    expect(source).toContain("mode: ${{ github.event.action == 'closed' && 'cleanup' || 'run' }}");
    expect(source).toContain('postman-api-key: ${{ secrets.POSTMAN_API_KEY }}');
    expect(source).not.toContain('postman-access-token');
  });

  it('ships a valid repair workflow template that inherits the configured provider', () => {
    const source = readWorkflow('postman-tdd-repair.yml');
    const workflow = parse(source) as { name: string };

    expect(workflow.name).toBe('Postman TDD Repair');
    expect(source).toContain('workflow_run:');
    expect(source).toContain('mode: repair');
    expect(source).toContain('pr-number: ${{ github.event.workflow_run.pull_requests[0].number }}');
    expect(source).toContain('repair-github-token: ${{ secrets.POSTMAN_TDD_REPAIR_TOKEN }}');
    expect(source).toContain('openai-api-key: ${{ secrets.OPENAI_API_KEY }}');
    expect(source).toContain('anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}');
    expect(source).toContain('postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}');
    expect(source).not.toContain('repair-provider:');
  });

  it('ships a branch-testable preview and repair workflow template', () => {
    const source = readWorkflow('postman-tdd-preview-and-repair.yml');
    const workflow = parse(source) as { name: string };
    const [previewSource, repairSource] = source.split('mode: repair');

    expect(workflow.name).toBe('Postman TDD Preview + Repair');
    expect(source).toContain('postman-cs/postman-onboarding-tdd@v0');
    expect(source).toContain("mode: ${{ github.event.action == 'closed' && 'cleanup' || 'run' }}");
    expect(source).toContain('needs: tdd');
    expect(source).toContain("needs.tdd.result == 'failure'");
    expect(source).toContain('ref: ${{ github.head_ref }}');
    expect(source).toContain('pr-number: ${{ github.event.pull_request.number }}');
    expect(source).toContain('repair-github-token: ${{ secrets.POSTMAN_TDD_REPAIR_TOKEN }}');
    expect(source).toContain('openai-api-key: ${{ secrets.OPENAI_API_KEY }}');
    expect(source).toContain('anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}');
    expect(source).toContain('postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}');
    expect(source).not.toContain('repair-provider:');
    expect(previewSource).not.toContain('postman-access-token');
    expect(repairSource).toContain('postman-access-token');
  });
});

describe('opt-in agent dispatch templates', () => {
  const agentFiles = [
    { file: 'devin-ci-fix.yml', secret: 'DEVIN_API_KEY' },
    { file: 'codex-ci-fix.yml', secret: 'OPENAI_API_KEY' },
    { file: 'claude-ci-fix.yml', secret: 'ANTHROPIC_API_KEY' },
    { file: 'cursor-ci-fix.yml', secret: 'CURSOR_API_KEY' }
  ];

  for (const { file, secret } of agentFiles) {
    it(`${file} exists, parses as YAML, triggers on Postman TDD Preview, and documents ${secret}`, () => {
      const source = readAgent(file);
      const workflow = parse(source) as { on?: Record<string, unknown> };
      expect(workflow.on).toBeDefined();
      expect(workflow.on?.workflow_run).toBeDefined();
      const workflowRun = workflow.on?.workflow_run as { workflows?: string[]; types?: string[] };
      expect(workflowRun.workflows).toContain('Postman TDD Preview');
      expect(workflowRun.types).toContain('completed');
      // Recursion guard on postman-tdd-fix- prefix.
      expect(source).toContain('postman-tdd-fix-');
      // Documented required secret.
      expect(source).toContain(secret);
      // Concurrency group per PR.
      expect(source).toMatch(/concurrency:/);
      expect(source).toMatch(/cancel-in-progress: false/);
    });
  }

  it('cursor template additionally guards on the cursor/ branch prefix', () => {
    const source = readAgent('cursor-ci-fix.yml');
    expect(source).toContain('cursor/');
  });
});