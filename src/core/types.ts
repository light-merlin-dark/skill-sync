export type Config = {
  version: 1;
  projectsRoots: string[];
  discovery: {
    ignorePathPrefixes: string[];
    preferPathPrefixes: string[];
  };
  harnesses: {
    custom: CustomHarnessConfig[];
  };
  aliases: Record<string, AliasOverride>;
};

export type CustomHarnessConfig = {
  id: string;
  rootPath: string;
  label?: string;
  enabled?: boolean;
};

export type AliasOverride = {
  default?: string;
  harnesses?: Record<string, string>;
};

export type State = {
  version: 1;
  managedEntries: Record<string, ManagedEntry>;
};

export type ManagedEntry = {
  harnessId: string;
  sourcePath: string;
  installName: string;
  updatedAt: string;
};

export type HarnessDefinition = {
  id: string;
  label: string;
  rootPath: string;
  kind: 'built-in' | 'custom';
  detected: boolean;
  enabled: boolean;
  aliases?: string[];
};

export type DiscoveredSkill = {
  sourceKey: string;
  sourcePath: string;
  skillFilePath: string;
  repoPath: string;
  projectsRoot: string;
  sourceType: 'repo-root' | 'nested';
  metadataName?: string;
  canonicalSlug: string;
  contentHash: string;
};

export type SourceDiagnostic = {
  slug: string;
  severity: 'warning' | 'error';
  resolution: 'resolved-by-preference' | 'unresolved';
  chosenSourcePath?: string;
  sourcePaths: string[];
};

export type SourceDiagnostics = {
  warnings: SourceDiagnostic[];
  errors: SourceDiagnostic[];
};

export type EntryInspection = {
  exists: boolean;
  type: 'missing' | 'symlink' | 'directory' | 'file';
  linkTarget?: string;
  resolvedTarget?: string;
};

export type PlannedAction =
  | 'ok'
  | 'create'
  | 'repair'
  | 'replace-managed'
  | 'remove-managed'
  | 'prune-state'
  | 'conflict';

export type PlannedEntry = {
  harnessId: string;
  harnessRoot: string;
  installName: string;
  destinationPath: string;
  action: PlannedAction;
  sourcePath?: string;
  sourceKey?: string;
  message: string;
};

export type PlannedHarness = {
  harness: HarnessDefinition;
  entries: PlannedEntry[];
};

export type SyncPlan = {
  harnesses: PlannedHarness[];
  changes: number;
  conflicts: number;
  ok: number;
  sourceDiagnostics: SourceDiagnostics;
};

export type BackupManifest = {
  version: 1;
  id: string;
  createdAt: string;
  homeDir: string;
  stateSnapshotIncluded: boolean;
  harnesses: BackupHarnessSnapshot[];
};

export type BackupHarnessSnapshot = {
  id: string;
  label: string;
  rootPath: string;
  exists: boolean;
  entries: BackupEntrySnapshot[];
};

export type BackupEntrySnapshot = {
  name: string;
  path: string;
  type: 'symlink' | 'directory' | 'file';
  linkTarget?: string;
  targetExists?: boolean;
  targetType?: 'directory' | 'file';
  skillFiles: BackupSkillFileSnapshot[];
};

export type BackupSkillFileSnapshot = {
  relativePath: string;
  content: string;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RuntimeContext = {
  homeDir: string;
  stateDir: string;
  configPath: string;
  statePath: string;
  json: boolean;
};
