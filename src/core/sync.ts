import { ensureDir, inspectEntry, nowIso, removePath } from './utils';
import type {
  Config,
  DiscoveredSkill,
  HarnessDefinition,
  HarnessTraversalDiagnostic,
  OrphanSkill,
  PlannedEntry,
  PlannedPollutedEntry,
  SourceDiagnostics,
  State,
  SyncPlan,
} from './types';
import { join, resolve } from 'node:path';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';

export function buildSyncPlan(
  skills: DiscoveredSkill[],
  harnesses: HarnessDefinition[],
  config: Config,
  state: State,
  sourceDiagnostics?: SourceDiagnostics,
): SyncPlan {
  const harnessPlans = harnesses.map((harness) => ({
    harness,
    entries: [] as PlannedEntry[],
  }));

  const desiredByHarness = new Map<string, Set<string>>();
  let conflicts = 0;
  let changes = 0;
  let ok = 0;

  for (const harnessPlan of harnessPlans) {
    desiredByHarness.set(harnessPlan.harness.id, new Set());
    const pathClaims = new Map<string, DiscoveredSkill>();

    for (const skill of skills) {
      if (!shouldInstallOnHarness(skill, harnessPlan.harness.id)) {
        continue;
      }
      const installName = resolveInstallName(skill, harnessPlan.harness.id, config);
      const destinationPath = join(harnessPlan.harness.rootPath, installName);
      const existingClaim = pathClaims.get(destinationPath);
      if (existingClaim) {
        harnessPlan.entries.push({
          harnessId: harnessPlan.harness.id,
          harnessRoot: harnessPlan.harness.rootPath,
          installName,
          destinationPath,
          action: 'conflict',
          sourcePath: skill.sourcePath,
          sourceKey: skill.sourceKey,
          message: `slug collision between ${existingClaim.sourcePath} and ${skill.sourcePath}`,
        });
        conflicts += 1;
        continue;
      }
      pathClaims.set(destinationPath, skill);
      desiredByHarness.get(harnessPlan.harness.id)?.add(destinationPath);
      const planned = buildPlannedEntry(skill, harnessPlan.harness, installName, destinationPath, state, config);
      harnessPlan.entries.push(planned);
      if (planned.action === 'conflict') {
        conflicts += 1;
      } else if (planned.action === 'ok') {
        ok += 1;
      } else {
        changes += 1;
      }
    }

    for (const [entryPath, managed] of Object.entries(state.managedEntries)) {
      if (managed.harnessId !== harnessPlan.harness.id) {
        continue;
      }
      if (desiredByHarness.get(harnessPlan.harness.id)?.has(entryPath)) {
        continue;
      }
      const inspection = inspectEntry(entryPath);
      harnessPlan.entries.push({
        harnessId: harnessPlan.harness.id,
        harnessRoot: harnessPlan.harness.rootPath,
        installName: managed.installName,
        destinationPath: entryPath,
        action: inspection.exists ? 'remove-managed' : 'prune-state',
        sourcePath: managed.sourcePath,
        message: inspection.exists ? 'managed entry is stale and will be removed' : 'stale state entry will be pruned',
      });
      changes += 1;
    }

    harnessPlan.entries.sort((a, b) => a.destinationPath.localeCompare(b.destinationPath));
  }

  // Orphan reporting: skills that exist inside harness roots (have a SKILL.md)
  // but are neither part of the desired/discovered set nor tracked in state.managedEntries.
  const orphanSkills: OrphanSkill[] = [];
  for (const harnessPlan of harnessPlans) {
    const desiredSet = desiredByHarness.get(harnessPlan.harness.id) || new Set<string>();
    let children: string[] = [];
    try {
      children = readdirSync(harnessPlan.harness.rootPath);
    } catch {
      continue;
    }

    for (const child of children) {
      const destinationPath = join(harnessPlan.harness.rootPath, child);

      // If the skill is desired (or already managed), don't call it an orphan.
      if (desiredSet.has(destinationPath)) {
        continue;
      }
      if (state.managedEntries[destinationPath]) {
        continue;
      }

      const inspection = inspectEntry(destinationPath);
      if (!inspection.exists) {
        continue;
      }

      let hasSkillMd = false;
      if (inspection.type === 'directory') {
        hasSkillMd = existsSync(join(destinationPath, 'SKILL.md'));
      } else if (inspection.type === 'symlink' && inspection.resolvedTarget) {
        hasSkillMd = existsSync(join(inspection.resolvedTarget, 'SKILL.md'));
      }

      if (!hasSkillMd) {
        continue;
      }

      orphanSkills.push({
        harnessId: harnessPlan.harness.id,
        harnessRoot: harnessPlan.harness.rootPath,
        installName: child,
        destinationPath,
        inspection,
      });
    }
  }

  const harnessDiagnostics = findHarnessTraversalDiagnostics(harnesses);

  return {
    harnesses: harnessPlans,
    changes,
    conflicts,
    ok,
    sourceDiagnostics: sourceDiagnostics || { warnings: [], errors: [] },
    harnessDiagnostics,
    orphanSkills: orphanSkills.length ? orphanSkills : undefined,
  };
}

function buildPlannedEntry(
  skill: DiscoveredSkill,
  harness: HarnessDefinition,
  installName: string,
  destinationPath: string,
  state: State,
  config: Config,
): PlannedEntry {
  const inspection = inspectEntry(destinationPath);
  const stateEntry = state.managedEntries[destinationPath];
  const sameSource =
    normalizeComparablePath(destinationPath) === normalizeComparablePath(skill.sourcePath) ||
    (inspection.type === 'symlink' && inspection.resolvedTarget === resolve(skill.sourcePath));
  const compatibility = inspectCompatibility(destinationPath, skill);

  if (!inspection.exists) {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'create', 'missing entry will be created');
  }
  if (sameSource) {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'ok', 'already synced');
  }
  if (compatibility === 'matching-skill') {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'repair', 'matching install will be replaced with a symlink to the authoritative source');
  }
  if (stateEntry) {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'repair', 'managed entry drift will be repaired');
  }
  if (compatibility === 'empty-directory') {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'repair', 'empty directory will be replaced');
  }
  return makePlannedEntry(
    skill,
    harness,
    installName,
    destinationPath,
    'conflict',
    inspection.type === 'symlink'
      ? `existing symlink points elsewhere: ${inspection.linkTarget || 'unknown target'}`
      : `existing ${inspection.type} is unmanaged`,
  );
}

function inspectCompatibility(destinationPath: string, skill: DiscoveredSkill): 'matching-skill' | 'empty-directory' | 'none' {
  const inspection = inspectEntry(destinationPath);
  if (!inspection.exists) {
    return 'none';
  }
  const sourceSkillText = readFileSync(skill.skillFilePath, 'utf8');

  if (inspection.type === 'directory') {
    if (readdirSync(destinationPath).length === 0) {
      return 'empty-directory';
    }
    const installedSkillPath = join(destinationPath, 'SKILL.md');
    if (existsSync(installedSkillPath) && readFileSync(installedSkillPath, 'utf8') === sourceSkillText) {
      return 'matching-skill';
    }
    return 'none';
  }

  if (inspection.type === 'file') {
    return readFileSync(destinationPath, 'utf8') === sourceSkillText ? 'matching-skill' : 'none';
  }

  if (inspection.type === 'symlink' && inspection.resolvedTarget) {
    const installedSkillPath = join(inspection.resolvedTarget, 'SKILL.md');
    if (existsSync(installedSkillPath) && readFileSync(installedSkillPath, 'utf8') === sourceSkillText) {
      return 'matching-skill';
    }
  }

  return 'none';
}

function normalizeComparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function makePlannedEntry(
  skill: DiscoveredSkill,
  harness: HarnessDefinition,
  installName: string,
  destinationPath: string,
  action: PlannedEntry['action'],
  message: string,
): PlannedEntry {
  return {
    harnessId: harness.id,
    harnessRoot: harness.rootPath,
    installName,
    destinationPath,
    action,
    sourcePath: skill.sourcePath,
    sourceKey: skill.sourceKey,
    message,
  };
}

function shouldInstallOnHarness(skill: DiscoveredSkill, harnessId: string): boolean {
  if (!skill.installHarnessIds || skill.installHarnessIds.length === 0) {
    return true;
  }
  return skill.installHarnessIds.includes(harnessId);
}

export function resolveInstallName(skill: DiscoveredSkill, harnessId: string, config: Config): string {
  const override = config.aliases[skill.sourceKey];
  if (override?.harnesses?.[harnessId]) {
    return override.harnesses[harnessId];
  }
  if (override?.default) {
    return override.default;
  }
  return skill.canonicalSlug;
}

export function applySyncPlan(plan: SyncPlan, state: State, dryRun: boolean): State {
  const nextState: State = {
    version: state.version,
    managedEntries: { ...state.managedEntries },
  };

  for (const harnessPlan of plan.harnesses) {
    ensureDir(harnessPlan.harness.rootPath);
    for (const entry of harnessPlan.entries) {
      if (entry.action === 'ok' || entry.action === 'conflict') {
        continue;
      }
      if (entry.action === 'prune-state') {
        delete nextState.managedEntries[entry.destinationPath];
        continue;
      }
      if (dryRun) {
        continue;
      }
      if (entry.action === 'remove-managed') {
        removePath(entry.destinationPath);
        delete nextState.managedEntries[entry.destinationPath];
        continue;
      }
      removePath(entry.destinationPath);
      symlinkSync(entry.sourcePath!, entry.destinationPath);
      nextState.managedEntries[entry.destinationPath] = {
        harnessId: entry.harnessId,
        sourcePath: entry.sourcePath!,
        installName: entry.installName,
        updatedAt: nowIso(),
      };
    }
  }
  return nextState;
}

export function countPlanActions(plan: SyncPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const harness of plan.harnesses) {
    for (const entry of harness.entries) {
      counts[entry.action] = (counts[entry.action] || 0) + 1;
    }
  }
  return counts;
}

export function hasConflicts(plan: SyncPlan): boolean {
  return plan.conflicts > 0 || plan.sourceDiagnostics.errors.length > 0;
}

export function hasDrift(plan: SyncPlan): boolean {
  return plan.changes > 0 ||
    plan.harnessDiagnostics.length > 0 ||
    plan.sourceDiagnostics.warnings.some((diagnostic) => diagnostic.kind === 'invalid-frontmatter');
}

export function findPollutedSymlinks(harnesses: HarnessDefinition[], state: State): PlannedPollutedEntry[] {
  const polluted: PlannedPollutedEntry[] = [];
  for (const harness of harnesses) {
    if (!harness.detected) {
      continue;
    }
    const stateEntries = Object.entries(state.managedEntries).filter(
      ([, entry]) => entry.harnessId === harness.id,
    );
    for (const [destinationPath, managed] of stateEntries) {
      const inspection = inspectEntry(destinationPath);
      if (inspection.type !== 'symlink' || !inspection.resolvedTarget) {
        continue;
      }
      if (isPollutedTarget(inspection.resolvedTarget)) {
        polluted.push({
          harnessId: harness.id,
          harnessRoot: harness.rootPath,
          installName: managed.installName,
          destinationPath,
          resolvedTarget: inspection.resolvedTarget,
          reason: describePollutionReason(inspection.resolvedTarget),
        });
      }
    }
  }
  return polluted;
}

export function cleanPollutedSymlinks(
  polluted: PlannedPollutedEntry[],
  state: State,
  dryRun: boolean,
): State {
  const nextState: State = {
    version: state.version,
    managedEntries: { ...state.managedEntries },
  };
  for (const entry of polluted) {
    if (!dryRun) {
      removePath(entry.destinationPath);
    }
    delete nextState.managedEntries[entry.destinationPath];
  }
  return nextState;
}

function isPollutedTarget(resolvedTarget: string): boolean {
  return existsSync(join(resolvedTarget, 'SKILL.md')) && directoryLooksLikeProjectRoot(resolvedTarget);
}

function directoryLooksLikeProjectRoot(dirPath: string): boolean {
  const indicators = [
    'package.json',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
    'Makefile',
    'node_modules',
    '.git',
    '.worktrees',
  ];
  for (const indicator of indicators) {
    if (existsSync(join(dirPath, indicator))) {
      return true;
    }
  }
  return false;
}

function describePollutionReason(resolvedTarget: string): string {
  const found: string[] = [];
  for (const indicator of ['node_modules', '.git', '.worktrees', 'package.json', 'Cargo.toml', 'go.mod']) {
    if (existsSync(join(resolvedTarget, indicator))) {
      found.push(indicator);
    }
  }
  if (found.length > 0) {
    return `symlink target is a project root containing ${found.join(', ')}`;
  }
  return 'symlink target is a project root, not a scoped skills/ directory';
}

export function findHarnessTraversalDiagnostics(harnesses: HarnessDefinition[]): HarnessTraversalDiagnostic[] {
  const diagnostics: HarnessTraversalDiagnostic[] = [];
  for (const harness of harnesses) {
    if (!harness.detected) {
      continue;
    }
    let children: string[] = [];
    try {
      children = readdirSync(harness.rootPath);
    } catch {
      continue;
    }

    for (const child of children) {
      if (shouldIgnoreHarnessEntryName(child)) {
        continue;
      }
      const entryPath = join(harness.rootPath, child);
      const scan = scanHarnessEntryForSkillTraversal(entryPath);
      if (scan.descendantSkillFiles.length === 0 && scan.errors.length === 0) {
        continue;
      }

      if (!scan.rootSkillFile && scan.descendantSkillFiles.length > 0) {
        diagnostics.push({
          harnessId: harness.id,
          harnessRoot: harness.rootPath,
          entryName: child,
          entryPath,
          kind: 'missing-root-skill',
          severity: 'warning',
          message: `entry has no root SKILL.md but exposes ${scan.descendantSkillFiles.length} descendant skill file(s) to recursive scanners`,
          resolvedTarget: scan.resolvedTarget,
          descendantSkillFiles: scan.descendantSkillFiles,
        });
      }

      const nestedSkillFiles = scan.rootSkillFile
        ? scan.descendantSkillFiles.filter((path) => path !== scan.rootSkillFile)
        : scan.descendantSkillFiles;
      if (nestedSkillFiles.length > 0) {
        diagnostics.push({
          harnessId: harness.id,
          harnessRoot: harness.rootPath,
          entryName: child,
          entryPath,
          kind: 'nested-skill-descendants',
          severity: 'warning',
          message: `entry exposes nested descendant skill file(s) that recursive harnesses like OpenCode will also parse`,
          resolvedTarget: scan.resolvedTarget,
          rootSkillFile: scan.rootSkillFile,
          descendantSkillFiles: nestedSkillFiles,
        });
      }

      for (const error of scan.errors) {
        diagnostics.push({
          harnessId: harness.id,
          harnessRoot: harness.rootPath,
          entryName: child,
          entryPath,
          kind: 'traversal-error',
          severity: 'warning',
          message: `recursive traversal hit ${error.code || 'an error'} while inspecting descendant skill paths`,
          resolvedTarget: scan.resolvedTarget,
          error: error.message,
        });
      }
    }
  }

  return diagnostics.sort((a, b) =>
    a.harnessId.localeCompare(b.harnessId) ||
    a.entryPath.localeCompare(b.entryPath) ||
    a.kind.localeCompare(b.kind),
  );
}

type TraversalScan = {
  resolvedTarget?: string;
  rootSkillFile?: string;
  descendantSkillFiles: string[];
  errors: Array<{ code?: string; message: string }>;
};

function scanHarnessEntryForSkillTraversal(entryPath: string): TraversalScan {
  const inspection = inspectEntry(entryPath);
  if (!inspection.exists) {
    return { descendantSkillFiles: [], errors: [] };
  }
  if (inspection.type !== 'directory' && inspection.type !== 'symlink') {
    return { descendantSkillFiles: [], errors: [] };
  }

  const walkRoot = inspection.type === 'symlink' ? inspection.resolvedTarget || entryPath : entryPath;
  const descendantSkillFiles = new Set<string>();
  const errors: Array<{ code?: string; message: string }> = [];
  const pending = [walkRoot];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    let realCurrent: string;
    try {
      realCurrent = realpathSync(current);
    } catch (error) {
      errors.push(formatTraversalError(current, error));
      continue;
    }
    if (visited.has(realCurrent)) {
      continue;
    }
    visited.add(realCurrent);

    let names: string[] = [];
    try {
      names = readdirSync(current);
    } catch (error) {
      errors.push(formatTraversalError(current, error));
      continue;
    }

    for (const name of names) {
      const child = join(current, name);
      if (name === 'SKILL.md') {
        descendantSkillFiles.add(resolve(child));
        continue;
      }

      try {
        const stats = lstatSync(child);
        if (stats.isDirectory()) {
          pending.push(child);
          continue;
        }
        if (!stats.isSymbolicLink()) {
          continue;
        }

        let resolvedChild: string;
        try {
          resolvedChild = realpathSync(child);
        } catch (error) {
          if (getErrorCode(error) === 'ELOOP') {
            errors.push(formatTraversalError(child, error));
          }
          continue;
        }

        try {
          const targetStats = lstatSync(resolvedChild);
          if (targetStats.isDirectory()) {
            pending.push(child);
          }
        } catch {}
      } catch {}
    }
  }

  const rootSkillCandidate = join(walkRoot, 'SKILL.md');
  const rootSkillFile = existsSync(rootSkillCandidate) ? resolve(rootSkillCandidate) : undefined;
  return {
    resolvedTarget: inspection.resolvedTarget,
    rootSkillFile,
    descendantSkillFiles: [...descendantSkillFiles].sort(),
    errors,
  };
}

function formatTraversalError(path: string, error: unknown): { code?: string; message: string } {
  const code = getErrorCode(error);
  const message = error instanceof Error ? `${path}: ${error.message}` : `${path}: ${String(error)}`;
  return { code, message };
}

function shouldIgnoreHarnessEntryName(name: string): boolean {
  return name.startsWith('.') || name.includes('.backup-');
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : undefined;
}
