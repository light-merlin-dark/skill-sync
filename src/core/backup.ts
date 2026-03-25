import { cpSync, existsSync, lstatSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { BackupEntrySnapshot, BackupHarnessSnapshot, BackupManifest, HarnessDefinition, RuntimeContext, State } from './types';
import { copyMaterialized, ensureDir, inspectEntry, pathOwnsEntry, readJsonFile, removePath, timestampId, writeJsonFile } from './utils';

export function createBackup(runtime: RuntimeContext, harnesses: HarnessDefinition[], state: State): BackupManifest {
  const id = timestampId();
  const backupDir = join(runtime.stateDir, 'backups', id);
  const materializedRoot = join(backupDir, 'materialized');
  ensureDir(materializedRoot);

  const harnessSnapshots = harnesses.map((harness) => snapshotHarness(backupDir, harness));
  const manifest: BackupManifest = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    homeDir: runtime.homeDir,
    stateSnapshotIncluded: true,
    harnesses: harnessSnapshots,
  };

  writeJsonFile(join(backupDir, 'manifest.json'), manifest);
  writeJsonFile(join(backupDir, 'state.json'), state);
  return manifest;
}

function snapshotHarness(backupDir: string, harness: HarnessDefinition): BackupHarnessSnapshot {
  const exists = existsSync(harness.rootPath);
  const entries: BackupEntrySnapshot[] = [];
  if (exists) {
    for (const name of readdirSync(harness.rootPath).sort()) {
      const entryPath = join(harness.rootPath, name);
      const stats = lstatSync(entryPath);
      const materializedPath = join('materialized', harness.id, name);
      const materializedAbsolute = join(backupDir, materializedPath);
      const snapshot: BackupEntrySnapshot = {
        name,
        path: entryPath,
        type: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file',
      };
      if (stats.isSymbolicLink()) {
        snapshot.linkTarget = readlinkSync(entryPath);
        snapshot.targetExists = inspectEntry(entryPath).resolvedTarget !== undefined;
      }
      try {
        copyMaterialized(entryPath, materializedAbsolute);
        snapshot.materializedPath = materializedPath;
      } catch {
        snapshot.materializedPath = undefined;
      }
      entries.push(snapshot);
    }
  }

  return {
    id: harness.id,
    label: harness.label,
    rootPath: harness.rootPath,
    exists,
    entries,
  };
}

export function listBackups(runtime: RuntimeContext): BackupManifest[] {
  const backupsDir = join(runtime.stateDir, 'backups');
  if (!existsSync(backupsDir)) {
    return [];
  }
  return readdirSync(backupsDir)
    .sort()
    .reverse()
    .map((id) => readJsonFile<BackupManifest>(join(backupsDir, id, 'manifest.json')))
    .filter((manifest): manifest is BackupManifest => manifest !== null);
}

export function restoreBackup(
  runtime: RuntimeContext,
  backupId: string,
  selectedHarnessIds: string[],
  dryRun: boolean,
  currentState: State,
): { manifest: BackupManifest; nextState: State } {
  const backupDir = join(runtime.stateDir, 'backups', backupId);
  const manifest = readJsonFile<BackupManifest>(join(backupDir, 'manifest.json'));
  if (!manifest) {
    throw new Error(`Backup not found: ${backupId}`);
  }
  const backupState = readJsonFile<State>(join(backupDir, 'state.json'));
  const selected = selectedHarnessIds.length > 0
    ? manifest.harnesses.filter((harness) => selectedHarnessIds.includes(harness.id))
    : manifest.harnesses;

  for (const harness of selected) {
    if (!dryRun) {
      ensureDir(harness.rootPath);
    }
    const currentEntries = existsSync(harness.rootPath) ? readdirSync(harness.rootPath) : [];
    const desiredEntries = new Set(harness.entries.map((entry) => entry.name));

    for (const name of currentEntries) {
      if (desiredEntries.has(name)) {
        continue;
      }
      if (!dryRun) {
        removePath(join(harness.rootPath, name));
      }
    }

    for (const entry of harness.entries) {
      restoreEntry(backupDir, harness, entry, dryRun);
    }
  }

  let nextState = currentState;
  if (backupState) {
    const selectedRoots = selected.map((harness) => harness.rootPath);
    const managedEntries = { ...currentState.managedEntries };
    for (const key of Object.keys(managedEntries)) {
      if (selectedRoots.some((root) => pathOwnsEntry(root, key))) {
        delete managedEntries[key];
      }
    }
    for (const [entryPath, managed] of Object.entries(backupState.managedEntries)) {
      if (selectedRoots.some((root) => pathOwnsEntry(root, entryPath))) {
        managedEntries[entryPath] = managed;
      }
    }
    nextState = {
      version: backupState.version,
      managedEntries,
    };
  }

  return { manifest, nextState };
}

function restoreEntry(
  backupDir: string,
  harness: BackupHarnessSnapshot,
  entry: BackupEntrySnapshot,
  dryRun: boolean,
): void {
  const destinationPath = join(harness.rootPath, entry.name);
  if (dryRun) {
    return;
  }

  removePath(destinationPath);
  const materializedAbsolute = entry.materializedPath ? join(backupDir, entry.materializedPath) : undefined;
  const linkTargetExists = entry.linkTarget
    ? existsSync(resolve(dirname(destinationPath), entry.linkTarget))
    : false;

  if (entry.type === 'symlink' && entry.linkTarget && linkTargetExists) {
    symlinkSync(entry.linkTarget, destinationPath);
    return;
  }
  if (materializedAbsolute && existsSync(materializedAbsolute)) {
    cpSync(materializedAbsolute, destinationPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: false,
    });
    return;
  }
  throw new Error(`Cannot restore ${relative(harness.rootPath, destinationPath)}: no valid link target or materialized copy`);
}
