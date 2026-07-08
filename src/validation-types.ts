/**
 * P4 (D22): ValidationState + ValidationIssue extracted here so
 * src/harness-lint.ts can type its `state` parameter without importing
 * src/validation.ts (which would create a cycle once validation.ts imports
 * validateHarness from harness-lint.ts in P4-4). This module has no runtime
 * imports — it is types only — so the dependency graph stays acyclic:
 *
 *   validation.ts -> validation-types.ts (types)
 *   validation.ts -> harness-lint.ts     (validateHarness call, P4-4)
 *   harness-lint.ts -> validation-types.ts (types)
 *
 * No module imports validation.ts, so there is no cycle.
 */

export interface ValidationIssue {
  message: string;
}

export interface ValidationState {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
