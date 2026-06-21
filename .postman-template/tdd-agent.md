# Postman TDD Agent Instructions

Use these instructions when a pull request has a failing `Postman TDD Preview` check.

## Goal

Update implementation code so the latest PR commit passes the `Postman TDD Preview` check.

## Source Of Truth

Read the latest sticky PR comment titled `Postman TDD Preview`.

Use the inline failure JSON in that comment as the primary task input. If a `postman-tdd-agent-context` workflow artifact is available to your environment, you may also use it, but do not depend on artifact access.

Only act on failure context for the latest PR head commit. If the sticky comment still references an older commit, wait for the workflow to finish and for the comment to update.

## Rules

- Fix implementation code only.
- Do not weaken the OpenAPI spec.
- Do not edit generated Postman assertions.
- Do not change test expectations just to make the check pass.
- Prefer the smallest implementation change that satisfies the contract.
- Push changes to the PR branch and let CI rerun.

## Iteration Loop

After each implementation push:

1. Wait for the `Postman TDD Preview` workflow to complete on the new PR head commit.
2. If the check passes, stop.
3. If the check fails, read the updated sticky PR comment.
4. Confirm the inline failure JSON references the new PR head commit.
5. Use only the updated failure context for the next implementation attempt.

Do not continue fixing from a stale sticky comment or a failure JSON document from an older commit.

## Success Criteria

You are done only when the latest PR commit has a passing GitHub check named `Postman TDD Preview`.

## Stop Conditions

Stop and report back if:

- the API intent is unclear,
- the OpenAPI spec appears incorrect or internally inconsistent,
- required secrets, services, or infrastructure are missing,
- the fix requires unrelated architectural work,
- the same failure remains after two reasonable implementation attempts.
