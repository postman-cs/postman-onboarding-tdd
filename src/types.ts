export type ActionMode = 'run' | 'cleanup' | 'repair' | 'validate';

export type ConfigWriteMode = 'commit-and-push' | 'commit-only' | 'none';

export type FailurePhase =
  | 'none'
  | 'config'
  | 'workspace'
  | 'asset_upsert'
  | 'immutable_state_tampered'
  | 'immutable_spec'
  | 'service_startup'
  | 'health_check'
  | 'collection_run'
  | 'test_ratchet'
  | 'cleanup';

export type RepairStatus = 'repaired' | 'blocked' | 'skipped' | 'failed';

export type RepairProvider = 'openai-responses' | 'anthropic-messages' | 'postman-agent-mode';

export type ActionStatus = 'passed' | 'failed' | 'skipped' | 'cleaned-up';

export interface TddWorkspaceConfig {
  id?: string;
  name: string;
}

export interface TddRuntimeConfig {
  baseUrl: string;
  healthUrl: string;
  startCommand: string;
  stopCommand?: string;
  timeoutSeconds: number;
}

export interface TddRepairConfig {
  allowedReadPaths: string[];
  allowedWritePaths: string[];
  enabled: boolean;
  escalationModel?: string;
  localTestCommand?: string;
  maxAttempts: number;
  provider: RepairProvider;
}

export interface ResolvedOnboardingConfig {
  configPath: string;
  projectName: string;
  specPath: string;
  tddEnabled: boolean;
  workspace: TddWorkspaceConfig;
  runtime: TddRuntimeConfig;
  repair: TddRepairConfig;
}

export interface PrMetadata {
  branch?: string;
  number: number;
  repository: string;
  sha?: string;
}

export interface LedgerAcceptance {
  assertion: string;
  criterion: string;
}

export interface LedgerPacket {
  acceptance: LedgerAcceptance[];
  attempts: number;
  firstSeenCommit?: string;
  key: string;
  lastFailureFingerprint?: string;
  lastVerifiedCommit?: string;
  method: string;
  operationId?: string;
  passes: boolean;
  path: string;
  title: string;
}

export interface Ledger {
  generatedAtCommit?: string;
  packets: LedgerPacket[];
  schemaVersion: 1;
}

export interface LedgerSummaryPacket {
  key: string;
  lastFailureFingerprint?: string;
  passes: boolean;
  title: string;
}

export interface LedgerSummary {
  failing: number;
  packets: LedgerSummaryPacket[];
  passing: number;
  total: number;
}

export interface PreviewAssetState {
  collectionId?: string;
  immutableState?: SignedImmutableState;
  ledger?: LedgerSummary;
  prNumber: number;
  schemaVersion: 1;
  specId?: string;
  workspaceId?: string;
}

export interface AgentFailure {
  actual?: string;
  assertion?: string;
  expected?: string;
  logExcerpt?: string;
  message: string;
  method?: string;
  operationId?: string;
  path?: string;
}

export interface AgentContractHint {
  method?: string;
  operationId?: string;
  path?: string;
  responses: AgentContractResponseHint[];
}

export interface AgentContractResponseHint {
  content: Record<string, { schema?: unknown }>;
  description?: string;
  status: string;
}

export interface ImmutablePathHash {
  path: string;
  sha256: string;
}

export interface ImmutableStatePayload {
  commit?: string;
  immutablePathHashes: ImmutablePathHash[];
  prNumber: number;
  repository: string;
  schemaVersion: 1;
  specPath?: string;
}

export interface SignedImmutableState {
  algorithm: 'hmac-sha256';
  payload: ImmutableStatePayload;
  schemaVersion: 1;
  signature: string;
}

export interface RepairCheckpointPayload {
  attempts: number;
  attemptFingerprints: string[];
  breakerReason?: string;
  commit: string;
  escalated: boolean;
  provider: RepairProvider;
  schemaVersion: 1;
}

export interface SignedRepairCheckpoint {
  algorithm: 'hmac-sha256';
  payload: RepairCheckpointPayload;
  schemaVersion: 1;
  signature: string;
}

export interface AgentFailureDocument {
  /**
   * D5/D13-reserved artifact names carried by the published document. The
   * JUnit report is written to `.postman-tdd/junit.xml` (D16); SARIF is
   * deferred. Both are optional and additive in schemaVersion 2.
   */
  artifact?: { junit?: string; sarif?: string };
  baseUrl?: string;
  /**
   * D9-reserved authoritative repair resume state. A SignedRepairCheckpoint
   * when immutable-state-signing-key is set (signature-verified resume), or
   * a bare RepairCheckpointPayload when it is not (advisory-only resume).
   * Additive in schemaVersion 2; absent on v1 documents.
   */
  checkpointRef?: SignedRepairCheckpoint | RepairCheckpointPayload;
  collectionName?: string;
  commit?: string;
  contractHints?: AgentContractHint[];
  /**
   * D13: phase-keyed job identifiers that failed in the triggering run, so
   * an agent can fetch the right logs. Additive optional in schemaVersion 2.
   */
  failedJobs?: string[];
  failures: AgentFailure[];
  healthUrl?: string;
  immutablePathHashes: ImmutablePathHash[];
  immutablePaths: string[];
  immutableState?: SignedImmutableState;
  /**
   * Compact per-packet verification ledger, ≤20 packets (`toLedgerSummary`
   * cap, D8). Packet `key` is `operationId` when present else `method+path`;
   * an `operationId` rename is non-breaking metadata per oasdiff, so
   * `method+path` is the stable identity (D1).
   */
  ledger?: LedgerSummary;
  message: string;
  /**
   * D13/D14: RFC 9457-style triage flag. `true` means the failure is
   * transient (service_startup/health_check) and the agent should re-run
   * before touching code. Computed authoritatively from `phase` inside
   * `createFailureDocument`; an explicit caller value overrides the default.
   * Additive optional in schemaVersion 2.
   */
  ownerActionRequired?: boolean;
  phase: FailurePhase;
  /**
   * D13/D14: RFC 9457-style triage flag. `true` means the failure is
   * transient (service_startup/health_check) and the agent should re-run
   * before touching code. Computed authoritatively from `phase` inside
   * `createFailureDocument`; an explicit caller value overrides the default.
   * Additive optional in schemaVersion 2.
   */
  retryable?: boolean;
  /**
   * D13: canonical GitHub Actions run URL assembled from runner env
   * (GITHUB_SERVER_URL + GITHUB_REPOSITORY + /actions/runs/ + GITHUB_RUN_ID),
   * undefined when those env vars are absent (local/test). Additive optional
   * in schemaVersion 2.
   */
  runUrl?: string;
  schemaVersion: 1 | 2;
  specPath?: string;
  startCommand?: string;
  status: 'failed';
  successCriteria: {
    doneWhen: string;
    failureContextMustMatchPrHeadCommit: boolean;
    latestHeadOnly: boolean;
    requiredCheck: string;
  };
  timeoutSeconds?: number;
}

export interface ActionInputs {
  anthropicApiKey?: string;
  committerEmail: string;
  committerName: string;
  configWriteMode: ConfigWriteMode;
  githubToken: string;
  immutableStateSigningKey?: string;
  mode: ActionMode;
  onboardingConfigPath: string;
  openaiApiKey?: string;
  postmanAccessToken?: string;
  postmanApiKey: string;
  postmanRegion: PostmanRegion;
  postmanStack: PostmanStack;
  prNumber?: number;
  projectName?: string;
  repairCommitMessage: string;
  repairGithubToken?: string;
  repairMaxAttempts: number;
  repairMaxToolRounds: number;
  repairBreakerThreshold: number;
  repairEscalationModel?: string;
  repairModel?: string;
  repairProvider?: RepairProvider;
  specPath?: string;
  workspaceTeamId?: string;
}

export type PostmanStack = 'prod' | 'beta';
export type PostmanRegion = 'us' | 'eu';
