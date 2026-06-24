# Postman Onboarding TDD Preview

`postman-onboarding-tdd` is a GitHub Action for PR-scoped, spec-driven TDD.

It generates a temporary Postman contract collection from the pull request version of an OpenAPI spec, runs that collection against the PR implementation on localhost in CI, and reports failures back to the PR for humans or agents to iterate on.

## Model

- One shared Postman TDD preview workspace.
- One Spec Hub spec and one TDD contract collection per PR.
- PR number is the asset namespace.
- Every new commit to the PR overwrites the same PR-scoped assets.
- The canonical onboarding workflow remains responsible for durable main-branch Postman assets.

## Repository Config

Add TDD settings to `.postman-template/onboarding.yml`:

```yaml
spec:
  path: api/openapi.yaml

service:
  name: reference-service

tdd:
  enabled: true
  workspace:
    name: Banner Health - API TDD Preview
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./scripts/postman-tdd-start.sh
  stopCommand: ./scripts/postman-tdd-stop.sh # optional
  timeoutSeconds: 90
```

On the first run, if `tdd.workspace.id` is missing, the action finds or creates `tdd.workspace.name` and writes the ID back to the config according to `config-write-mode`.

The customer-owned `startCommand` is responsible for making the PR implementation reachable at `baseUrl`. It can run a local process, Docker Compose, dependent mocks, seed data, or anything else the service needs.

## Agent Instructions

Copy this repository's [`.postman-template/tdd-agent.md`](.postman-template/tdd-agent.md) into the customer service repository at the same path:

```text
.postman-template/tdd-agent.md
```

Also copy the optional policy and Codex hook templates if implementation-repair agents will run in a Codex-compatible harness that executes lifecycle hooks:

```text
.postman-template/agent-policy.json
.postman-template/hooks/codex-pre-tool-use.mjs
.postman-template/codex/hooks.json
```

Commit these files to the customer repository's default branch, usually `main`, so all future PR branches inherit the same generic agent instructions and policy. The hook templates are optional guardrails; the GitHub Action immutable-spec guard remains the required enforcement layer.

The file is intentionally static and branch-safe. It tells any coding agent to read the latest `Postman TDD Preview` sticky PR comment, use the inline failure JSON as the source of truth, fix implementation code only, push changes, and wait for the next TDD workflow result on the latest PR head commit after each push.

Do not commit generated run-specific files from `.postman-tdd/`. Those files are created during CI and can become stale after every commit.

The generic prompt for an agent can stay small:

```text
Follow .postman-template/tdd-agent.md for this PR.
```

### Optional Codex Pre-Tool Hook

For Codex-compatible repair automation that executes lifecycle hooks, the v1 policy is artifact-free. It reads committed repo files:

```text
.postman-template/agent-policy.json
.postman-template/onboarding.yml
```

The policy resolves `spec.path` from onboarding config and is intended to deny tool calls that try to create, edit, write, delete, move, or rename that path.

To enable the sample hook in a customer repo, copy or merge the template into the project hook layer used by your Codex runtime:

```bash
mkdir -p .codex
cp .postman-template/codex/hooks.json .codex/hooks.json
```

The hook command delegates to:

```bash
node .postman-template/hooks/codex-pre-tool-use.mjs
```

Hook support varies by Codex surface and launch mode. Before relying on this guardrail, verify that your runtime actually executes the hook by attempting a harmless test edit to the configured `spec.path`; the expected result is that the tool call is blocked with:

```text
The OpenAPI spec is immutable during implementation repair. Revert spec changes and fix code only.
```

Codex project-local hooks require the project `.codex/` layer to be trusted. Non-managed command hooks may also need to be reviewed and trusted before they run. In vetted automation that already controls the hook source and runtime, the agent launcher can use Codex's `--dangerously-bypass-hook-trust` option for that invocation.

This hook is prevention, not the final enforcement layer. Treat it as optional local or harness-level ergonomics. The signed workflow-level immutable spec guard remains mandatory and still fails the PR if the spec changes after a TDD failure.

## Required Secrets

Create these GitHub secrets in the customer service repository before enabling the workflow:

| Secret | Required | Used for |
| --- | --- | --- |
| `POSTMAN_API_KEY` | yes | Postman API access for workspace, spec, collection, and collection-run operations. |
| `POSTMAN_ACCESS_TOKEN` | no | Compatibility with broader onboarding pipelines. |
| `POSTMAN_TDD_SIGNING_KEY` | recommended | HMAC key for signed immutable spec baselines. Implementation agents must not be able to read this secret. |

`POSTMAN_TDD_SIGNING_KEY` should be a long random value. Pass it to the action input named `immutable-state-signing-key`:

```yaml
immutable-state-signing-key: ${{ secrets.POSTMAN_TDD_SIGNING_KEY }}
```

The GitHub secret is named `POSTMAN_TDD_SIGNING_KEY`; the action input is named `immutable-state-signing-key`.

## Example Workflow

```yaml
name: Postman TDD Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
    paths:
      - api/**
      - src/**
      - scripts/postman-tdd-start.sh
      - .postman-template/onboarding.yml

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: postman-tdd-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  tdd:
    if: github.actor != 'github-actions[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.head_ref }}
          fetch-depth: 0

      - uses: postman-cs/postman-onboarding-tdd@main
        with:
          mode: ${{ github.event.action == 'closed' && 'cleanup' || 'run' }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          immutable-state-signing-key: ${{ secrets.POSTMAN_TDD_SIGNING_KEY }}
          workspace-team-id: ${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}
```

## Agent Handoff

When the TDD collection fails, the action writes local agent context files during the run and uploads them as the `postman-tdd-agent-context` workflow artifact:

```text
.postman-tdd/
  agent-task.md
  failures.json
  immutable-spec-guard.mjs
```

The sticky PR comment is the primary agent interface. It names the artifact when one is available, summarizes the failure, shows the commit that produced the failure context, and includes compact machine-readable failure JSON for quick agent handoff. Artifacts are optional convenience; agents that cannot access artifacts should use the inline JSON from the sticky comment.

The success criterion is always:

```text
The latest PR head commit has a passing GitHub check named Postman TDD Preview.
```

Agents must compare the failure JSON `commit` with the current PR head SHA before acting. If they differ, the sticky comment is stale and the agent should wait for the next `Postman TDD Preview` run to finish.

Collection-run failures are normalized into compact records instead of raw runner logs:

```json
{
  "operationId": "createWidget",
  "method": "POST",
  "path": "/v1/widgets",
  "assertion": "response body matches schema",
  "message": "Missing required property: owner"
}
```

Raw sanitized log excerpts are reserved for `service_startup` and `health_check` failures, where startup output is needed to diagnose why the service did not become reachable.

The failure JSON also includes `immutablePaths`, defaulting to the configured OpenAPI `spec.path`, plus `immutablePathHashes`. Humans can submit spec changes in the PR, but implementation-fix agents must treat those paths as read-only once a TDD failure exists. Agents can run `node .postman-tdd/immutable-spec-guard.mjs snapshot` at start and `node .postman-tdd/immutable-spec-guard.mjs verify` before commit/push.

On subsequent workflow runs, the action compares the current immutable path hashes against the previous sticky comment baseline before regenerating Postman assets. If an implementation-fix commit changed the spec, the action publishes an `immutable_spec` failure to the sticky PR comment and fails the check.

For tamper detection, create the GitHub secret `POSTMAN_TDD_SIGNING_KEY` and pass it through the action input `immutable-state-signing-key`. When configured, the action signs the immutable baseline with HMAC-SHA256 and refuses to trust a missing or invalid signature, publishing `immutable_state_tampered` instead. Without this input, the action keeps the unsigned sticky-comment baseline behavior for backward compatibility.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `mode` | no | `run` | `run` or `cleanup`. |
| `onboarding-config-path` | no | `.postman-template/onboarding.yml` | Service onboarding config path. |
| `project-name` | no | `service.name` | Optional service name override. |
| `spec-path` | no | `spec.path` | Optional OpenAPI spec path override. |
| `pr-number` | no | pull request event number | Optional PR number override. |
| `postman-api-key` | yes | | Postman API key. |
| `postman-access-token` | no | | Compatibility input for onboarding pipelines. |
| `github-token` | yes | | Token for PR comments and config writeback. |
| `immutable-state-signing-key` | no | | Action input for the HMAC key used to sign immutable spec baselines. Recommended value: `${{ secrets.POSTMAN_TDD_SIGNING_KEY }}`. |
| `workspace-team-id` | no | | Numeric Postman sub-team ID for org-mode workspace creation. |
| `config-write-mode` | no | `commit-and-push` | `commit-and-push`, `commit-only`, or `none`. |
| `committer-name` | no | `Postman` | Commit author name for config writeback. |
| `committer-email` | no | `support@postman.com` | Commit author email for config writeback. |
| `postman-region` | no | `us` | `us` or `eu`. |
| `postman-stack` | no | `prod` | `prod` or `beta`. |

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run check:dist
```
