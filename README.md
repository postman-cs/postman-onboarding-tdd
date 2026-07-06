# Postman Onboarding TDD

`postman-onboarding-tdd` is a GitHub Action that turns an OpenAPI change in a pull request into a runnable Postman TDD check.

For each PR, the action:

1. Reads the PR version of your OpenAPI spec.
2. Creates or updates one PR-scoped Spec Hub spec and one generated TDD contract collection in a shared Postman workspace.
3. Starts your service in CI using the command you provide.
4. Runs the generated collection against your local CI service URL.
5. Posts a sticky PR comment with a human-readable summary and compact JSON that coding agents can use.

The optional repair worker can also call a configured AI repair provider, make implementation-only changes, run the same Postman collection locally, and push one repair commit only after the local TDD run passes.

## End-To-End Flow

```mermaid
flowchart TD
  A["Developer opens or updates a PR"] --> B["Postman TDD Preview workflow starts"]
  B --> C["Read PR OpenAPI spec"]
  C --> D["Upsert PR-scoped Spec Hub spec and TDD collection"]
  D --> E["Start customer service in CI with tdd.startCommand"]
  E --> F["Wait for tdd.healthUrl"]
  F --> G["Run generated Postman collection against tdd.baseUrl"]
  G --> H{"Collection passed?"}

  H -- "Yes" --> I["Update sticky PR comment: passed"]
  I --> J["PR has passing Postman TDD Preview check"]

  H -- "No" --> K["Normalize failures into compact JSON"]
  K --> L["Update sticky PR comment and optional agent artifact"]
  L --> M{"Automated repair enabled?"}

  M -- "No" --> N["Human or external agent reads sticky comment"]
  N --> O["Fix implementation only and push"]
  O --> B

  M -- "Yes" --> P["Postman TDD Repair workflow starts after failed preview"]
  P --> Q["Verify failure JSON matches latest PR head SHA"]
  Q --> R{"Repairable and same-repo PR?"}
  R -- "No" --> S["Post repair comment: blocked"]
  R -- "Yes" --> T["Repair provider proposes implementation-only patch"]
  T --> U["Validate allowed write paths and immutable spec"]
  U --> V["Run local tests, start service, run Postman collection"]
  V --> W{"Local TDD passed?"}
  W -- "No" --> X["Retry until budget exhausted or blocked"]
  X --> T
  W -- "Yes" --> Y["Verify immutable paths again"]
  Y --> Z["Push one repair commit with repair token"]
  Z --> B
```

## What Customers Configure

You add three things to the service repository:

1. `.postman-template/onboarding.yml`
2. One script that starts the service for CI TDD
3. One or two GitHub workflows

For most teams, start with the preview workflow first. Add the automated repair workflow after the preview check is stable.

## Quick Start

1. Copy the sample config into the service repository:

   ```bash
   mkdir -p .postman-template
   curl -fsSL https://raw.githubusercontent.com/postman-cs/postman-onboarding-tdd/main/.postman-template/onboarding.yml \
     -o .postman-template/onboarding.yml
   ```

   If your environment cannot access the raw GitHub URL, copy `.postman-template/onboarding.yml` from a local checkout of this repository. If the package is installed locally, the same sample is available at `node_modules/@postman-cse/onboarding-tdd/.postman-template/onboarding.yml`.

2. Edit `.postman-template/onboarding.yml`:

   - set `spec.path` to the service OpenAPI file,
   - set `service.name`,
   - set `tdd.workspace.name`,
   - set `tdd.baseUrl`, `tdd.healthUrl`, and `tdd.startCommand`,
   - keep `tdd.repair.enabled: false` until the preview workflow is stable, then enable repair.

3. Add the preview workflow from [Preview Workflow](#preview-workflow).

4. Add the required secrets from [GitHub Secrets](#github-secrets).

5. Open a PR that changes the OpenAPI spec or implementation and confirm `Postman TDD Preview` posts a PR comment.

6. Enable repair using [Repair Setup Checklist](#repair-setup-checklist).

## Repository Config

Create or update `.postman-template/onboarding.yml`. A complete sample is packaged at `.postman-template/onboarding.yml` in this repository:

```yaml
version: 1

spec:
  path: api/openapi.yaml

service:
  name: reference-service

tdd:
  enabled: true
  workspace:
    name: Reference Service - TDD Preview
    # id is optional on the first run.
    # The action can create/find the workspace and write the id back.
    # id: 00000000-0000-0000-0000-000000000000
  baseUrl: http://127.0.0.1:4010
  healthUrl: http://127.0.0.1:4010/v1/health
  startCommand: ./scripts/postman-tdd-start.sh
  stopCommand: ./scripts/postman-tdd-stop.sh # optional
  timeoutSeconds: 90
  repair:
    enabled: false
    provider: openai-responses
    maxAttempts: 3
    allowedWritePaths:
      - src/**
    allowedReadPaths:
      - src/**
      - test/**
      - package.json
    localTestCommand: npm test # optional
```

`startCommand` is customer-owned. It must make the PR implementation reachable at `baseUrl`. It can run the app directly, start Docker Compose, launch mocks, seed data, or do whatever the service needs in CI.

The action runs `startCommand`, `stopCommand`, and repair `localTestCommand` with a sanitized environment. GitHub Action `INPUT_*` values and token-, secret-, password-, API-key-, access-key-, and private-key-like variables are removed before customer-owned commands start.

This is how the action stays language- and framework-neutral. Java, Node.js, C#, Python, Docker Compose, and multi-service repos all use the same contract: provide one command that starts the PR implementation locally.

If `tdd.workspace.id` is missing, the action:

1. Looks for exactly one Postman workspace with `tdd.workspace.name`.
2. Creates the workspace if none exists.
3. Fails if multiple exact-name workspaces exist.
4. Writes the workspace ID back to `onboarding.yml` unless `config-write-mode` is `none`.

If the repository does not allow workflow commits back to PR branches, set `config-write-mode: none` and add `tdd.workspace.id` manually after the first workspace is created.

## GitHub Secrets

Create these secrets in the customer service repository:

| Secret | Required | Purpose |
| --- | --- | --- |
| `POSTMAN_API_KEY` | yes | Creates/updates Postman workspace, spec, collection, and runs the collection. |
| `POSTMAN_ACCESS_TOKEN` | repair with Postman Agent Mode | Used when `repair-provider` is `postman-agent-mode`. |
| `POSTMAN_TDD_SIGNING_KEY` | recommended | Signs the immutable-spec baseline so agents cannot tamper with sticky comment state. |
| `OPENAI_API_KEY` | repair with OpenAI | Used when `repair-provider` is `openai-responses`. |
| `ANTHROPIC_API_KEY` | repair with Claude | Used when `repair-provider` is `anthropic-messages`. |
| `POSTMAN_TDD_REPAIR_TOKEN` | repair recommended | PAT or GitHub App token used to push repair commits and trigger the next preview run. |

Use a long random value for `POSTMAN_TDD_SIGNING_KEY`. Implementation agents should not be able to read it.

`POSTMAN_TDD_REPAIR_TOKEN` should be a token that can push to PR branches. A normal `GITHUB_TOKEN` push may not trigger the follow-up workflow run, so production repair should use a PAT or GitHub App token.

## Repair Setup Checklist

Use this checklist after the preview workflow is already posting `Postman TDD Preview` comments.

1. In `.postman-template/onboarding.yml`, enable repair and choose a provider:

   ```yaml
   tdd:
     repair:
       enabled: true
       provider: anthropic-messages # or openai-responses
       maxAttempts: 3
       allowedWritePaths:
         - src/**
       allowedReadPaths:
         - src/**
         - test/**
         - package.json
       localTestCommand: npm test
   ```

   Supported provider values are `openai-responses`, `anthropic-messages`, and `postman-agent-mode`.

2. Keep `allowedWritePaths` narrow. These are the only implementation paths the repair worker may patch. Do not include the OpenAPI spec, generated Postman files, workflow files, or secret-like files.

3. Add provider credentials:

   | Provider | Config value | Workflow input | Secret |
   | --- | --- | --- | --- |
   | OpenAI Responses | `openai-responses` | `openai-api-key` | `OPENAI_API_KEY` |
   | Anthropic Messages | `anthropic-messages` | `anthropic-api-key` | `ANTHROPIC_API_KEY` |
   | Postman Agent Mode | `postman-agent-mode` | `postman-access-token` | `POSTMAN_ACCESS_TOKEN` |

4. Add `POSTMAN_TDD_REPAIR_TOKEN` so pushed repair commits can trigger the next preview run.

5. Add the repair workflow from [Repair Workflow](#repair-workflow). You can omit the action `repair-provider` input to use `tdd.repair.provider` from onboarding config. If you set the action input, it must match the config value.

6. Test repair with a small implementation-only contract failure. Done means the PR shows both `Postman TDD Repair (REPAIRED)` and a later `Postman TDD Preview (PASSED)` on the repair commit.

## Preview Workflow

Add `.github/workflows/postman-tdd-preview.yml`:

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
          ref: ${{ github.event.action == 'closed' && github.base_ref || github.head_ref }}
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

Adjust the `paths` list to match the customer repository. At minimum, include the OpenAPI spec, implementation code, startup script, and onboarding config.

On normal PR commits, `mode: run` creates/updates the PR-scoped Postman assets and runs the collection. On PR close, `mode: cleanup` deletes the PR-scoped spec and collection.

## PR Feedback

The preview workflow updates one sticky PR comment titled `Postman TDD Preview`.

On success, it records the passing PR head commit.

On failure, it includes:

- failure phase, such as `collection_run`, `service_startup`, or `health_check`,
- the PR commit that produced the failure,
- immutable paths, usually the OpenAPI spec path,
- a phase-aware next action section that explains what happened, what to do next, repair eligibility, and the success condition,
- current failures summarized before the JSON,
- compact failure JSON for humans and agents,
- a pointer to the optional `postman-tdd-agent-context` artifact.

Agents should use the sticky comment first. Artifacts are helpful but not required.

Example compact failure:

```json
{
  "operationId": "createWidget",
  "method": "POST",
  "path": "/v1/widgets",
  "assertion": "response body matches schema",
  "message": "Missing required property: owner"
}
```

The success criterion is always:

```text
The latest PR head commit has a passing GitHub check named Postman TDD Preview.
```

## Agent Instructions

Copy this file from this repository into the customer service repository:

```text
.postman-template/tdd-agent.md
```

Commit it to the default branch, usually `main`, so every future PR inherits the same generic instructions.

A human or agent can then use a very small prompt:

```text
Follow .postman-template/tdd-agent.md for this PR.
```

The instructions tell agents to:

- read the latest `Postman TDD Preview` sticky comment,
- compare the failure JSON `commit` to the current PR head SHA,
- fix implementation code only,
- treat `immutablePaths` as read-only,
- push changes,
- wait for the next preview run,
- stop when the latest PR head commit passes or the failure is genuinely blocked.

Do not commit generated `.postman-tdd/` files. Those are run-specific CI artifacts and can become stale after every commit.

## Immutable Spec Guard

Humans can submit OpenAPI spec changes in a PR. Once the TDD failure exists, implementation repair must treat the PR spec as the contract to satisfy.

The action enforces this at workflow level:

1. The preview run records a hash of `spec.path`.
2. The next preview run compares the current spec hash with the previous failure baseline.
3. If an implementation repair changed the spec, the action fails with `immutable_spec`.
4. If `immutable-state-signing-key` is set, the baseline is signed with HMAC-SHA256. A missing or invalid signature fails with `immutable_state_tampered`.

This message is used when the spec changes during implementation repair:

```text
The OpenAPI spec is immutable during implementation repair. Revert spec changes and fix code only.
```

The action also emits an optional CI artifact:

```text
.postman-tdd/
  agent-task.md
  failures.json
  immutable-spec-guard.mjs
```

Agents that can access the artifact may run:

```bash
node .postman-tdd/immutable-spec-guard.mjs snapshot
node .postman-tdd/immutable-spec-guard.mjs verify
```

If artifacts are unavailable, agents should use the inline failure JSON from the sticky comment.

## Optional Local Agent Policy

This repository includes optional templates for agent runtimes that support pre-tool-use hooks:

```text
.postman-template/agent-policy.json
.postman-template/hooks/codex-pre-tool-use.mjs
.postman-template/codex/hooks.json
```

These files are optional. They are local or harness-level prevention, not the final enforcement layer. The GitHub Action immutable-spec guard remains the required enforcement layer.

For Codex-compatible runtimes that execute project hooks, copy the hook config into the customer repository:

```bash
mkdir -p .codex
cp .postman-template/codex/hooks.json .codex/hooks.json
```

Then verify the runtime actually executes hooks before relying on them.

## Optional Automated Repair Worker

The repair worker is opt-in. It is useful when you want the workflow to attempt implementation repair automatically after a failed preview check.

The fastest setup path is the [Repair Setup Checklist](#repair-setup-checklist). The details below explain the repair boundaries and workflow shape.

Add or enable repair settings in `.postman-template/onboarding.yml`:

```yaml
tdd:
  repair:
    enabled: true
    provider: openai-responses # or anthropic-messages or postman-agent-mode
    maxAttempts: 3
    allowedWritePaths:
      - src/**
    allowedReadPaths:
      - src/**
      - package.json
      - package-lock.json
    localTestCommand: npm test # optional
```

`allowedWritePaths` is required when repair is enabled. Keep it as narrow as possible.

`allowedReadPaths` defaults to `allowedWritePaths` when omitted.

The worker will not write to:

- the OpenAPI spec path,
- `.postman-template/**`,
- `.postman-tdd/**`,
- `.github/workflows/**`,
- generated Postman files,
- secret-like files.

The selected repair model does not receive Postman secrets, GitHub tokens, the canonical spec file content, generated collection content, shell access, git access, or raw filesystem write tools. Claude repair mode uses the same guarded read/search/patch tools and the same allowed path policy as OpenAI repair mode.

### Repair Workflow

Add a second workflow, `.github/workflows/postman-tdd-repair.yml`:

For `workflow_run` triggers, GitHub uses the workflow definition from the default branch. Merge this repair workflow to the default branch before expecting it to run automatically for PR failures.

```yaml
name: Postman TDD Repair

on:
  workflow_run:
    workflows: [Postman TDD Preview]
    types: [completed]

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: postman-tdd-repair-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: true

jobs:
  repair:
    if: >
      github.event.workflow_run.conclusion == 'failure' &&
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.pull_requests[0].number
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.workflow_run.head_branch }}
          fetch-depth: 0

      - uses: postman-cs/postman-onboarding-tdd@main
        with:
          mode: repair
          pr-number: ${{ github.event.workflow_run.pull_requests[0].number }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repair-github-token: ${{ secrets.POSTMAN_TDD_REPAIR_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          immutable-state-signing-key: ${{ secrets.POSTMAN_TDD_SIGNING_KEY }}
          workspace-team-id: ${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}
```

The action uses `tdd.repair.provider` from onboarding config when `repair-provider` is omitted. You may still set `repair-provider` in the workflow as an explicit guard; when set, it must match the onboarding config value.

To use Claude instead, set the onboarding config provider to `anthropic-messages`, pass `anthropic-api-key`, and use a Claude Messages model:

```yaml
        with:
          mode: repair
          pr-number: ${{ github.event.workflow_run.pull_requests[0].number }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repair-github-token: ${{ secrets.POSTMAN_TDD_REPAIR_TOKEN }}
          repair-model: claude-sonnet-5
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          immutable-state-signing-key: ${{ secrets.POSTMAN_TDD_SIGNING_KEY }}
```

To use Postman Agent Mode instead, set the onboarding config provider to `postman-agent-mode` and pass `postman-access-token`. If `repair-model` is omitted, the action uses the Postman Agent Mode default `GPT_5`.

```yaml
        with:
          mode: repair
          pr-number: ${{ github.event.workflow_run.pull_requests[0].number }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repair-github-token: ${{ secrets.POSTMAN_TDD_REPAIR_TOKEN }}
          immutable-state-signing-key: ${{ secrets.POSTMAN_TDD_SIGNING_KEY }}
```

The repair worker:

1. Reads the latest preview sticky comment.
2. Blocks if the failure JSON is stale.
3. Blocks fork PRs.
4. Blocks unsupported phases such as config, workspace, immutable-state, or immutable-spec failures.
5. Allows repair for `collection_run`, `service_startup`, and `health_check`.
6. Lets the selected repair provider use guarded read/search/patch/finish tools only.
7. Runs `localTestCommand` when configured.
8. Starts the service and runs the Postman TDD collection locally.
9. Verifies immutable paths and allowed write paths.
10. Pushes one repair commit only after the local Postman collection passes.

The worker posts a separate sticky PR comment titled `Postman TDD Repair`. It does not overwrite the preview comment. The repair comment includes the attempts, blocked reason or commit when available, the original repair message, and a next-action section for skipped, blocked, failed, or repaired outcomes.

When repair accepts one or more implementation patches, the repair comment also includes a compact attempt timeline with the patch summary, touched paths, local test result, local Postman oracle result, and final outcome for each attempt. The full machine-readable repair summary is written to `.postman-tdd/repair-summary.json` and exposed through the `repair-summary-path` output.

Postman Agent Mode repair receives the same guarded repair tool definitions as the other providers: `list_files`, `read_file`, `search_files`, `propose_patch`, and `finish`. The action does not expose broad shell access, arbitrary file write tools, repository secrets, Postman workspace mutation tools, or generic Agent Mode tools to the repair provider.

## Action Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `mode` | no | `run` | `run`, `cleanup`, or `repair`. |
| `onboarding-config-path` | no | `.postman-template/onboarding.yml` | Service onboarding config path. |
| `project-name` | no | `service.name` | Optional service name override. |
| `spec-path` | no | `spec.path` | Optional OpenAPI spec path override. |
| `pr-number` | no | pull request event number | Optional PR number override. Recommended for `workflow_run` repair workflows. |
| `postman-api-key` | yes | | Postman API key. |
| `postman-access-token` | repair with Postman Agent Mode | | Postman access token for `mode: repair` when `repair-provider` is `postman-agent-mode`. Optional otherwise. |
| `github-token` | yes | | Token for PR comments and workspace ID config writeback. |
| `immutable-state-signing-key` | no | | HMAC key used to sign immutable spec baselines. Recommended value: `${{ secrets.POSTMAN_TDD_SIGNING_KEY }}`. |
| `workspace-team-id` | no | | Numeric Postman sub-team ID for org-mode workspace creation. |
| `config-write-mode` | no | `commit-and-push` | `commit-and-push`, `commit-only`, or `none`. |
| `committer-name` | no | `Postman` | Commit author name for workspace ID writeback. |
| `committer-email` | no | `support@postman.com` | Commit author email for workspace ID writeback. |
| `postman-region` | no | `us` | `us` or `eu`. |
| `postman-stack` | no | `prod` | `prod` or `beta`. |
| `openai-api-key` | repair with OpenAI | | OpenAI API key for `mode: repair` when `repair-provider` is `openai-responses`. |
| `anthropic-api-key` | repair with Claude | | Anthropic API key for `mode: repair` when `repair-provider` is `anthropic-messages`. |
| `repair-github-token` | repair recommended | `github-token` | Token used by `mode: repair` for pushing repair commits. Prefer a PAT or GitHub App token. |
| `repair-provider` | no | `tdd.repair.provider` | Optional repair provider guard. One of `openai-responses`, `anthropic-messages`, or `postman-agent-mode`. When omitted, repair uses onboarding config. When set, it must match `tdd.repair.provider`. |
| `repair-model` | no | provider default | Model used by `mode: repair`. Defaults to `gpt-5.5` for OpenAI, `claude-sonnet-5` for Claude, and `GPT_5` for Postman Agent Mode unless explicitly set. |
| `repair-max-attempts` | no | `3` | Maximum accepted implementation patch attempts. |
| `repair-commit-message` | no | `Postman TDD repair` | Commit message used for a passing repair commit. |

## Action Outputs

Important preview outputs:

| Output | Description |
| --- | --- |
| `status` | `passed`, `failed`, `skipped`, or `cleaned-up`. |
| `failure-phase` | Failure phase, such as `collection_run`, `service_startup`, `health_check`, `immutable_spec`, or `immutable_state_tampered`. |
| `workspace-id` | Shared TDD preview workspace ID. |
| `spec-id` | PR-scoped Spec Hub spec ID. |
| `tdd-collection-id` | PR-scoped generated collection ID. |
| `pr-comment-id` | Sticky preview PR comment ID. |
| `agent-context-artifact` | Uploaded agent context artifact name, when available. |

Important repair outputs:

| Output | Description |
| --- | --- |
| `repair-status` | `repaired`, `blocked`, `skipped`, or `failed`. |
| `repair-blocked-reason` | Machine-readable reason when repair is blocked. |
| `repair-attempts` | Number of accepted implementation patch attempts. |
| `repair-commit-sha` | Commit SHA pushed by the repair worker after a passing local collection run. |
| `repair-summary-path` | Local JSON summary path. |

## Development

For contributors to this action:

```bash
npm install
npm test
npm run typecheck
npm run build
npm run check:dist
```
