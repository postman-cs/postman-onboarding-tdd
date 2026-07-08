# Postman TDD Agent Router

You are a coding agent fixing a failing `Postman TDD Preview` check. This file
routes every situation to the one focused reference doc that owns it. Read the
named doc before acting, then act.

## Install

Copy `.postman-template/AGENTS.md` to the repository root as `AGENTS.md`, and
copy `.postman-template/agents/` to `.agents/`. The routing-table paths below
use the post-copy layout (`.agents/references/<doc>.md`); resolve them against
the repository root. Running `mode: validate` lints this router and the
referenced docs for internal consistency.

## Routing table

| Situation | Read this |
| --- | --- |
| How does the Postman TDD Preview check decide pass/fail? | `.agents/references/tdd-check.md` |
| Where are the failures and what do the fields mean? | `.agents/references/failure-document.md` |
| What is the preview -> repair contract and which failures are actionable? | `.agents/references/repair-loop.md` |
| May I edit the OpenAPI spec during repair? | `.agents/references/immutable-spec-guard.md` |
| Which branch prefix and commit rules apply to fix pushes? | `.agents/references/branch-and-commit.md` |
| How do I track multi-step progress across attempts? | `.agents/references/execplan-skeleton.md` |

## Operating order

1. Read `.agents/references/tdd-check.md` so the oracle, not your opinion, is
   the judge of done.
2. Read the latest sticky `Postman TDD Preview` comment; confirm its `commit`
   matches the current PR head before doing anything (`.agents/references/failure-document.md`).
3. If the failure JSON is stale, stop and wait for the next run
   (`.agents/references/repair-loop.md`).
4. Snapshot every `immutablePaths` entry before editing
   (`.agents/references/immutable-spec-guard.md`).
5. Push fixes to a `postman-tdd-fix-` branch with clean commits
   (`.agents/references/branch-and-commit.md`).
6. Track each packet's pass/fail state in an ExecPlan ledger
   (`.agents/references/execplan-skeleton.md`).

Never edit the spec, generated assertions, or test expectations to force a
pass. Never act on a failure document whose `commit` is not the PR head.
