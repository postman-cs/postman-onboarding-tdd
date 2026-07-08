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

export interface AgentFailureDocument {
  baseUrl?: string;
  collectionName?: string;
  commit?: string;
  contractHints?: AgentContractHint[];
  failures: AgentFailure[];
  healthUrl?: string;
  immutablePathHashes: ImmutablePathHash[];
  immutablePaths: string[];
  immutableState?: SignedImmutableState;
  message: string;
  phase: FailurePhase;
  schemaVersion: 1;
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
  repairModel?: string;
  repairProvider?: RepairProvider;
  specPath?: string;
  workspaceTeamId?: string;
}

export type PostmanStack = 'prod' | 'beta';
export type PostmanRegion = 'us' | 'eu';
