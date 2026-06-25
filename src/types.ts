export type ActionMode = 'run' | 'cleanup' | 'repair';

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
  | 'cleanup';

export type RepairStatus = 'repaired' | 'blocked' | 'skipped' | 'failed';

export type RepairProvider = 'openai-responses';

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

export interface PreviewAssetState {
  collectionId?: string;
  immutableState?: SignedImmutableState;
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
  repairModel: string;
  repairProvider: RepairProvider;
  specPath?: string;
  workspaceTeamId?: string;
}

export type PostmanStack = 'prod' | 'beta';
export type PostmanRegion = 'us' | 'eu';
