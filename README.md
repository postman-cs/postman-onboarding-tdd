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

Commit it to the customer repository's default branch, usually `main`, so all future PR branches inherit the same generic agent instructions.

The file is intentionally static and branch-safe. It tells any coding agent to read the latest `Postman TDD Preview` sticky PR comment, use the inline failure JSON as the source of truth, fix implementation code only, and wait for the next TDD workflow result after each push.

Do not commit generated run-specific files from `.postman-tdd/`. Those files are created during CI and can become stale after every commit.

The generic prompt for an agent can stay small:

```text
Follow .postman-template/tdd-agent.md for this PR.
```

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

The PR comment names the artifact, summarizes the failure, and includes machine-readable failure JSON for quick agent handoff. The success criterion is always:

```text
The latest PR commit has a passing GitHub check named Postman TDD Preview.
```

The failure JSON also includes `immutablePaths`, defaulting to the configured OpenAPI `spec.path`, plus `immutablePathHashes`. Humans can submit spec changes in the PR, but implementation-fix agents must treat those paths as read-only once a TDD failure exists. Agents can run `node .postman-tdd/immutable-spec-guard.mjs snapshot` at start and `node .postman-tdd/immutable-spec-guard.mjs verify` before commit/push.

On subsequent workflow runs, the action compares the current immutable path hashes against the previous sticky comment baseline before regenerating Postman assets. If an implementation-fix commit changed the spec, the action publishes an `immutable_spec` failure to the sticky PR comment and fails the check.

Set `immutable-state-signing-key` to a GitHub secret that implementation agents cannot read. When configured, the action signs the immutable baseline with HMAC-SHA256 and refuses to trust a missing or invalid signature, publishing `immutable_state_tampered` instead. Without this input, the action keeps the unsigned sticky-comment baseline behavior for backward compatibility.

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
| `immutable-state-signing-key` | no | | Dedicated HMAC key for signed immutable spec baselines. Store as a GitHub secret that implementation agents cannot read. |
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
