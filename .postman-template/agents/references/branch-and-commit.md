# Branch and commit

Repair pushes go to a branch prefixed `postman-tdd-fix-` so the agent dispatch
workflows can recognise them and skip recursive runs (the `workflow_run`
trigger guards on `!startsWith(head_branch, 'postman-tdd-fix-')`).

## Branch naming

Use `postman-tdd-fix-<short-slug>`, for example
`postman-tdd-fix-health-endpoint`. One fix branch per PR is fine; do not pile
unrelated work onto a long-lived fix branch.

## Commit hygiene

- One logical change per commit (the failing assertion's fix + any directly
  required supporting code).
- Commit messages state what failed and what changed, e.g.
  `fix: return 200 from /v1/health to satisfy TDD preview`.
- Do not bundle spec edits, generated-assertion edits, or test-expectation
  changes into a fix commit — those are forbidden (see
  `.agents/references/immutable-spec-guard.md`).
- Push to the PR branch (or the `postman-tdd-fix-` branch wired into the
  repair workflow) and let CI rerun the oracle.

## Recursion guard

Because the head branch starts with `postman-tdd-fix-`, the agent dispatch
workflows (claude/codex/cursor/devin `*-ci-fix.yml`) skip it, preventing an
infinite preview -> repair -> dispatch loop. Keep the prefix.
