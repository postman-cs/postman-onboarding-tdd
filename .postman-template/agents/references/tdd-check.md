# Postman TDD Preview check

The `Postman TDD Preview` GitHub check is the single source of truth. It runs a
real Postman collection against the service started by `tdd.startCommand` and
publishes pass/fail from that run. No local assertion, linter, or model
judgement overrides it.

## What the check does

1. Starts the service with `tdd.startCommand`.
2. Waits for `tdd.healthUrl` to return success.
3. Runs the Postman TDD collection generated from `spec.path`.
4. Publishes a sticky PR comment titled `Postman TDD Preview` with an inline
   failure JSON when assertions fail.
5. Stops the service (or runs `tdd.stopCommand`).

## Done

You are done only when the latest PR head commit has a passing `Postman TDD
Preview` check. Re-run the workflow after every implementation push; do not
declare success from a local run.
