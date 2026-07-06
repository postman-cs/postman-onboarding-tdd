import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowDir = join(process.cwd(), '.postman-template', 'workflows');

function readWorkflow(name: string): string {
  return readFileSync(join(workflowDir, name), 'utf8');
}

describe('packaged workflow templates', () => {
  it('ships a valid preview workflow template', () => {
    const source = readWorkflow('postman-tdd-preview.yml');
    const workflow = parse(source) as { name: string };

    expect(workflow.name).toBe('Postman TDD Preview');
    expect(source).toContain('postman-cs/postman-onboarding-tdd@main');
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
    expect(source).toContain('postman-cs/postman-onboarding-tdd@main');
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
