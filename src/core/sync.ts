import { ensureDir, inspectEntry, nowIso, pathOwnsEntry, removePath } from './utils';
import type { Config, DiscoveredSkill, HarnessDefinition, PlannedEntry, SourceDiagnostics, State, SyncPlan } from './types';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';

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

  return {
    harnesses: harnessPlans,
    changes,
    conflicts,
    ok,
    sourceDiagnostics: sourceDiagnostics || { warnings: [], errors: [] },
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
  const sameSource = inspection.type === 'symlink' && inspection.resolvedTarget === resolve(skill.sourcePath);
  const compatibility = inspectCompatibility(destinationPath, skill);

  if (!inspection.exists) {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'create', 'missing entry will be created');
  }
  if (sameSource) {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'ok', 'already synced');
  }
  if (compatibility === 'matching-skill') {
    return makePlannedEntry(skill, harness, installName, destinationPath, 'ok', 'compatible existing install');
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
  return plan.changes > 0;
}

export function pruneStateForRoots(state: State, roots: string[]): State {
  const nextEntries: State['managedEntries'] = {};
  for (const [entryPath, managed] of Object.entries(state.managedEntries)) {
    if (roots.some((root) => pathOwnsEntry(root, entryPath))) {
      continue;
    }
    nextEntries[entryPath] = managed;
  }
  return {
    version: state.version,
    managedEntries: nextEntries,
  };
}
