# postman-onboarding-tdd — Maintainer Router

You are coding agent hacking on THIS action's own codebase (published
GitHub Action `postman-cs/postman-onboarding-tdd`, npm `@postman-cse/onboarding-tdd`).
This is the MAINTAINER router. It is deliberately distinct from
`.postman-template/AGENTS.md`, the CUSTOMER harness router installed into
onboarded repos. Do not conflate two.

## Routing table

| Situation | Read this |
| --- | --- |
| Action entry + mode dispatch (validate/run/cleanup/repair) | `src/index.ts` |
| Postman oracle: spec -> collection -> run vs PR implementation | `src/contract.ts`, `src/runner.ts` |
| Repair loop, providers, breaker, escalation, checkpoint | `src/repair/` (`orchestrator.ts`, `checkpoint.ts`, `tools.ts`, `*-provider.ts`) |
| Ledger / ratchet (packet pass-fail state, fingerprints) | `src/ledger.ts` |
| Validate-mode setup checks + harness lint (imperative remediation) | `src/validation.ts`, `src/harness-lint.ts` |
| PR comment + check-run + AgentFailureDocument | `src/github/` |
| Postman API + base URLs (us/eu, prod/beta) | `src/postman/` |
| Action inputs/outputs contract (the public surface) | `action.yml` + `README.md` `## Action Inputs` / `## Action Outputs` |
| Customer-facing harness router (separate file, ships in tarball) | `.postman-template/AGENTS.md` |

## Gates

Local, in order, from repo root:

```
npm test            # vitest run (P1-P5, incl. tests/repo-drift.test.ts)
npm run typecheck   # tsc --noEmit -p tsconfig.json
npm run lint        # eslint .
npm run build       # typecheck + esbuild src/main.ts -> dist/action.mjs
npm run check:dist  # build + git diff --exit-code -- dist  (must be clean)
npm run lint:actions # actionlint over .github/workflows + .postman-template/workflows
```

CI: one pre-queue `npm run build` (sole mutator), then Linux/PowerShell queues of
read-only checks at max concurrency two, including `npm run check:dist:assert`
(post-build `git diff --exit-code -- dist` only; no rebuild).

## dist is committed

`dist/action.mjs` is checked in. `npm run check:dist` rebuilds and asserts
`git diff --exit-code -- dist` is clean. Never hand-edit `dist/`; change `src/`,
run `npm run build`, and commit regenerated `dist/` in same commit. A
docs/tests-only change must leave `dist/` byte-stable (final gate proves it).

## Release / tags

- Immutable `v0.x.y` tags + rolling v0 alias. Git tags are authoritative,
  not `package.json` `version`.
- Never force-push existing release tag.
- `dist/` rebuild is part of release integrity: rebuild from tagged commit.
- README `uses:` examples pin `@v0` (rolling alias), never `@main` or a
  bare `@vN.M.K`. Drift test enforces this.

## Test hermeticity

Tests that touch GitHub Actions runtime context use the `vi.hoisted`
event-scrub pattern (see `tests/index.test.ts`, `tests/check-run.test.ts`,
`tests/repair-orchestrator.test.ts`): delete `GITHUB_EVENT_PATH` /
`GITHUB_EVENT_NAME` inside `vi.hoisted(() => { ... })` so no module import
snapshots real CI event payload. Pure filesystem-read tests
(`tests/repo-drift.test.ts`, `tests/workflow-templates.test.ts`,
`tests/harness-templates.test.ts`) need no scrub. Never print or hardcode
secrets; mask with existing `createSecretMasker()` helpers in `src/`.

## PRD / ledger workflow

Long-horizon development is packet-driven. Master plan and per-phase PRDs
live in `../.plans/` (relative to this repo root, inside parent
`postman-actions` workspace): `long-horizon-development.md` is master plan,
and `pN-prd.json` files carry each phase's atomic packets with `passes:false`
flipped to `true` as each packet lands. When picking up phase, read the PRD
fully first — its `seamCorrections[]` are authoritative over plan prose.

## Non-conflation invariant

This root `AGENTS.md` is NOT in `package.json` `files` (D26): it is a
maintainer router, not shipped harness asset. Only the `.postman-template/`
tree ships to customers. `tests/repo-drift.test.ts` asserts both facts.
