# Immutable spec guard

`spec.path` (the OpenAPI file, e.g. `api/openapi.yaml`) is immutable during
repair. The PR spec is the contract you must satisfy; you do not edit it.

## What you may not do

- Edit, reformat, move, regenerate, or weaken the OpenAPI spec.
- Edit generated Postman assertions.
- Change test expectations just to make the check pass.
- Edit any path listed in the failure document `immutablePaths` array.

## What you must do

At the start of every repair attempt, snapshot the hash of every
`immutablePaths` entry. Before committing, verify the hashes are unchanged. If
the `.postman-tdd` artifact is available:

```bash
node .postman-tdd/immutable-spec-guard.mjs snapshot
node .postman-tdd/immutable-spec-guard.mjs verify
```

If verification fails, stop and revert the spec change — fix implementation
code only. If the only reasonable fix requires changing the spec, stop and
report that the API intent or spec is unclear instead of editing the spec.
