# Repair loop

The preview -> repair contract: the `Postman TDD Preview` workflow runs first
and publishes a failure document; a repair agent acts on it; the workflow
re-runs on the pushed fix. The loop ends when the latest head passes.

## Only the latest head is actionable

Act only on the failure document whose `commit` equals the current PR head
SHA. If a newer push has landed, the document is stale — wait for the workflow
to finish and the sticky comment to update. Never patch from a stale document.

## Loop

1. Read the latest failure document.
2. Confirm `commit` === current PR head.
3. Snapshot `immutablePaths`.
4. Make the smallest implementation change that satisfies the failing
   assertion.
5. Push to a `postman-tdd-fix-` branch (see
   `.agents/references/branch-and-commit.md`).
6. Wait for `Postman TDD Preview` to re-run on the new head.
7. If it passes, stop. If it fails, read the updated document and repeat.

## Stop conditions

Stop and report if the API intent is unclear, the spec is internally
inconsistent, required infrastructure is missing, the service cannot start, or
the same failure persists after two reasonable attempts. Do not loop forever.
