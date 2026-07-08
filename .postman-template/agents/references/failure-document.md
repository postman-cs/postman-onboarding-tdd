# Failure document

The sticky `Postman TDD Preview` PR comment carries an inline failure JSON.
That document is your task input.

## Fields that matter

- `commit`: the PR head SHA the run exercised. If it does not match the current
  PR head, the document is stale — wait for the next run.
- `phase`: where the run failed (`collection_run`, `health_check`,
  `service_startup`, ...). Only `collection_run` failures are implementation
  bugs worth patching; `service_startup`/`health_check` are transient or
  environmental.
- `failures[]`: each entry has `path`, `method`, `operationId`, `assertion`,
  `expected`, `actual`, and `message`. These are the per-assertion failures.
- `ledger`: a compact per-packet pass/fail summary (see
  `.agents/references/execplan-skeleton.md`).
- `immutablePaths`: paths that are read-only during repair (see
  `.agents/references/immutable-spec-guard.md`).
- `retryable` / `ownerActionRequired`: triage flags. `retryable: true` means
  re-run before touching code.

## Rule

Always compare the failure document `commit` to the current PR head SHA before
reading any failure. A stale document leads to fixing the wrong thing.
