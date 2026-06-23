# Postman TDD Agent Instructions

Use these instructions when a pull request has a failing `Postman TDD Preview` check.

## Goal

Update implementation code so the latest PR head commit passes the `Postman TDD Preview` check.

## Source Of Truth

Read the latest sticky PR comment titled `Postman TDD Preview`.

Use the inline failure JSON in that comment as the primary task input. If a `postman-tdd-agent-context` workflow artifact is available to your environment, you may also use it, but do not depend on artifact access.

Only act on failure context for the latest PR head commit. Compare the inline failure JSON `commit` value with the current PR head SHA before making changes. If they differ, the sticky comment is stale; wait for the workflow to finish and for the comment to update.

## Rules

- Fix implementation code only.
- Treat every path listed in the latest failure JSON `immutablePaths` array as read-only.
- Do not edit, reformat, move, regenerate, or weaken immutable OpenAPI spec files.
- Do not edit generated Postman assertions.
- Do not change test expectations just to make the check pass.
- Prefer the smallest implementation change that satisfies the contract.
- Push implementation changes to the PR branch and let CI rerun.
- Wait for the next `Postman TDD Preview` run on the latest PR head commit before deciding whether to continue.

## Immutable Spec Rule

Humans may submit OpenAPI spec changes in the PR. Once the `Postman TDD Preview` failure exists and you are acting as an implementation-fix agent, the PR spec is the contract to satisfy.

Use the `immutablePaths` array from the inline failure JSON, for example:

```json
{
  "immutablePaths": ["api/openapi.yaml"]
}
```

At agent start, record the hash of every immutable path. If the `.postman-tdd` artifact is available, run:

```bash
node .postman-tdd/immutable-spec-guard.mjs snapshot
```

Before committing or pushing, verify the spec hash is unchanged:

```bash
node .postman-tdd/immutable-spec-guard.mjs verify
```

If verification fails, stop with:

```text
The OpenAPI spec is immutable during implementation repair. Revert spec changes and fix code only.
```

If the artifact is unavailable, compute and record `sha256` hashes for `immutablePaths` yourself at the start, then compare them before commit/push. If the only reasonable fix requires changing the spec, stop and report that the API intent or spec is unclear instead of editing the spec.

## Iteration Loop

After each implementation push:

1. Wait for the `Postman TDD Preview` workflow to complete on the new PR head commit.
2. If the check passes, stop.
3. If the check fails, read the updated sticky PR comment.
4. Confirm the inline failure JSON references the new PR head commit.
5. Use only the updated failure context for the next implementation attempt.

Do not continue fixing from a stale sticky comment or a failure JSON document from an older commit.
Continue this loop until the latest-head check passes or a stop condition applies.

## Success Criteria

You are done only when the latest PR head commit has a passing GitHub check named `Postman TDD Preview`.

## Stop Conditions

Stop and report back if:

- the API intent is unclear,
- the OpenAPI spec appears incorrect or internally inconsistent,
- required secrets, services, or infrastructure are missing,
- the service cannot be started by the configured TDD command,
- the fix requires unrelated architectural work,
- the same failure remains after two reasonable implementation attempts.
