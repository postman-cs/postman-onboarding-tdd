# ExecPlan skeleton

Track each packet's pass/fail state across repair attempts in a progress
ledger. Copy this skeleton into your working notes and fill it in as you go.

## Ledger template

```text
# ExecPlan — <service> TDD repair

pr: <number>
head: <sha>
spec: <spec.path>
started: <ISO timestamp>

## Packets

- [ ] <operationId or method+path> — <assertion>
      attempts: 0
      last failure: <fingerprint or short summary>
      status: open | fixed | blocked

- [ ] GET /v1/health — responds 200
      attempts: 0
      last failure: (none)
      status: open
```

## Rules

- One row per failing packet (use `operationId` when present, else
  `method+path`).
- Increment `attempts` each time you push a fix for that packet.
- Mark `status: fixed` only after the latest-head `Postman TDD Preview` run
  passes that packet (the oracle is the judge — see
  `.agents/references/tdd-check.md`).
- Mark `status: blocked` if a stop condition applies (see
  `.agents/references/repair-loop.md`).
- Keep the ledger pruned to open and recently-fixed packets; archive closed
  rows.
