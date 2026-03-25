import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { BackupEntrySnapshot, BackupHarnessSnapshot, BackupManifest, BackupSkillFileSnapshot, HarnessDefinition, RuntimeContext, State } from './types';
import { ensureDir, inspectEntry, pathOwnsEntry, readJsonFile, removePath, timestampId, writeJsonFile } from './utils';

export function createBackup(runtime: RuntimeContext, harnesses: HarnessDefinition[], state: State): BackupManifest {
  const id = timestampId();
  const backupDir = join(runtime.stateDir, 'backups', id);
  ensureDir(backupDir);

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

function snapshotHarness(_backupDir: string, harness: HarnessDefinition): BackupHarnessSnapshot {
  const exists = existsSync(harness.rootPath);
  const entries: BackupEntrySnapshot[] = [];
  if (exists) {
    for (const name of readdirSync(harness.rootPath).sort()) {
      const entryPath = join(harness.rootPath, name);
      const stats = lstatSync(entryPath);
      const snapshot: BackupEntrySnapshot = {
        name,
        path: entryPath,
        type: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file',
        skillFiles: [],
      };
      if (stats.isSymbolicLink()) {
        snapshot.linkTarget = readlinkSync(entryPath);
        const inspection = inspectEntry(entryPath);
        snapshot.targetExists = inspection.resolvedTarget !== undefined;
        if (inspection.resolvedTarget) {
          snapshot.targetType = lstatSync(inspection.resolvedTarget).isDirectory() ? 'directory' : 'file';
          snapshot.skillFiles = collectSkillFiles(inspection.resolvedTarget, snapshot.targetType);
        }
      } else {
        snapshot.targetType = stats.isDirectory() ? 'directory' : 'file';
        snapshot.skillFiles = collectSkillFiles(entryPath, snapshot.type);
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
  _backupDir: string,
  harness: BackupHarnessSnapshot,
  entry: BackupEntrySnapshot,
  dryRun: boolean,
): void {
  const destinationPath = join(harness.rootPath, entry.name);
  if (dryRun) {
    return;
  }

  removePath(destinationPath);
  const linkTargetExists = entry.linkTarget
    ? existsSync(resolve(dirname(destinationPath), entry.linkTarget))
    : false;

  if (entry.type === 'symlink' && entry.linkTarget && linkTargetExists) {
    symlinkSync(entry.linkTarget, destinationPath);
    return;
  }
  if (entry.skillFiles.length > 0) {
    restoreSkillFiles(destinationPath, entry);
    return;
  }
  throw new Error(`Cannot restore ${relative(harness.rootPath, destinationPath)}: no valid link target or backed-up SKILL.md files`);
}

function restoreSkillFiles(destinationPath: string, entry: BackupEntrySnapshot): void {
  const treatAsDirectory = entry.type === 'directory' || entry.type === 'symlink' || entry.targetType === 'directory' || entry.skillFiles.some((file) => file.relativePath.includes('/'));
  if (treatAsDirectory) {
    mkdirSync(destinationPath, { recursive: true });
    for (const skillFile of entry.skillFiles) {
      const targetPath = join(destinationPath, skillFile.relativePath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, skillFile.content, 'utf8');
    }
    return;
  }
  const skillFile = entry.skillFiles[0]!;
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, skillFile.content, 'utf8');
}

function collectSkillFiles(entryPath: string, entryType: 'symlink' | 'directory' | 'file'): BackupSkillFileSnapshot[] {
  if (!existsSync(entryPath)) {
    return [];
  }
  if (entryType === 'file') {
    if (!entryPath.endsWith('SKILL.md')) {
      return [];
    }
    return [{ relativePath: 'SKILL.md', content: readFileSync(entryPath, 'utf8') }];
  }
  return walkForSkillFiles(entryPath, '', new Set<string>());
}

function walkForSkillFiles(absoluteCurrent: string, currentRelative: string, visited: Set<string>): BackupSkillFileSnapshot[] {
  const stats = lstatSync(absoluteCurrent);
  const canonicalPath = getCanonicalPath(absoluteCurrent);
  if (canonicalPath && visited.has(canonicalPath)) {
    return [];
  }
  if (stats.isSymbolicLink()) {
    const inspection = inspectEntry(absoluteCurrent);
    if (!inspection.resolvedTarget) {
      return [];
    }
    if (canonicalPath) {
      visited.add(canonicalPath);
    }
    const resolvedStats = lstatSync(inspection.resolvedTarget);
    if (resolvedStats.isDirectory()) {
      return walkForSkillFiles(inspection.resolvedTarget, currentRelative, visited);
    }
    if (absoluteCurrent.endsWith('SKILL.md')) {
      return [{ relativePath: currentRelative || 'SKILL.md', content: readFileSync(absoluteCurrent, 'utf8') }];
    }
    return [];
  }
  if (stats.isFile()) {
    if (absoluteCurrent.endsWith('SKILL.md')) {
      return [{ relativePath: currentRelative || 'SKILL.md', content: readFileSync(absoluteCurrent, 'utf8') }];
    }
    return [];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  if (canonicalPath) {
    visited.add(canonicalPath);
  }
  const snapshots: BackupSkillFileSnapshot[] = [];
  for (const name of readdirSync(absoluteCurrent).sort()) {
    if (IGNORED_BACKUP_DIR_NAMES.has(name)) {
      continue;
    }
    const nextRelative = currentRelative ? join(currentRelative, name) : name;
    snapshots.push(...walkForSkillFiles(join(absoluteCurrent, name), nextRelative, visited));
  }
  return snapshots;
}

function getCanonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

const IGNORED_BACKUP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'tmp',
  'temp',
]);
