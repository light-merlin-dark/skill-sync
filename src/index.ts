#!/usr/bin/env node
import { cac } from 'cac';
import { mkdirSync, readFileSync } from 'node:fs';
import { createBackup, listBackups, restoreBackup } from './core/backup';
import { addHarness, addProjectsRoot, initConfig, loadConfig, loadState, removeHarness, removeProjectsRoot, saveState } from './core/config';
import { resolveHarnesses, filterHarnesses } from './core/harnesses';
import { discoverSkillSet, describeSkill } from './core/sources';
import { applySyncPlan, buildSyncPlan, countPlanActions, findPollutedSymlinks, cleanPollutedSymlinks, hasConflicts, hasDrift } from './core/sync';
import { buildRuntimeContext } from './core/utils';
import type {
  DiscoveredSkill,
  HarnessDefinition,
  HarnessTraversalDiagnostic,
  JsonValue,
  PlannedPollutedEntry,
  SourceDiagnostic,
  SyncPlan,
} from './core/types';

const cli = cac('skill-sync');
const version = readCliVersion();

function readCliVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

type GlobalOptions = {
  json?: boolean;
  verbose?: boolean;
  home?: string;
  dryRun?: boolean;
  continueOnConflict?: boolean;
  projectsRoot?: string | string[];
  harness?: string | string[];
};

function normalizeList(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function withRuntime<T>(options: GlobalOptions, fn: (runtime: ReturnType<typeof buildRuntimeContext>) => T): T {
  const runtime = buildRuntimeContext({ home: options.home, json: options.json });
  mkdirSync(runtime.stateDir, { recursive: true });
  return fn(runtime);
}

function resolveProjectsOverride(configProjectsRoots: string[], options: GlobalOptions): string[] {
  const override = normalizeList(options.projectsRoot);
  return override.length > 0 ? override : configProjectsRoots;
}

function resolveSelectedHarnesses(allHarnesses: HarnessDefinition[], options: GlobalOptions): HarnessDefinition[] {
  return filterHarnesses(allHarnesses, normalizeList(options.harness));
}

function print(value: JsonValue | string, json: boolean): void {
  if (json) {
    console.log(typeof value === 'string' ? JSON.stringify({ message: value }, null, 2) : JSON.stringify(value, null, 2));
    return;
  }
  console.log(value);
}

function renderLandingHelp(): string {
  return [
    'skill-sync',
    '',
    'High-signal commands:',
    '  skill-sync doctor           Inspect sources, drift, and orphan installs',
    '  skill-sync doctor --verbose Show the full per-entry plan',
    '  skill-sync execute          Apply symlink updates',
    '  skill-sync sync             Alias for execute',
    '  skill-sync clean            Remove polluted symlinks (repo-root targets)',
    '  skill-sync sources          List discovered source skills',
    '  skill-sync harnesses        List detected harness roots',
    '',
    'Short alias:',
    '  ss doctor',
    '  ss execute',
    '',
    'Safety:',
    '  skill-sync backup create',
    '  skill-sync backup list',
    '',
    'Use --help for the full command reference.',
  ].join('\n');
}

function renderDetailedPlan(plan: SyncPlan, options?: { includeOrphans?: boolean }): string {
  const lines: string[] = [];
  appendSourceDiagnostics(lines, plan.sourceDiagnostics);
  appendHarnessDiagnostics(lines, plan.harnessDiagnostics);
  if (options?.includeOrphans !== false && plan.orphanSkills && plan.orphanSkills.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Orphan installed skills:');
    for (const orphan of plan.orphanSkills) {
      const resolved = orphan.inspection.type === 'symlink' ? orphan.inspection.resolvedTarget || orphan.inspection.linkTarget : undefined;
      lines.push(`- ${orphan.harnessId}/${orphan.installName}  ${orphan.destinationPath}${resolved ? ` -> ${resolved}` : ''}`);
    }
  }
  const counts = countPlanActions(plan);
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push(`Summary: ${plan.ok} ok, ${plan.changes} change(s), ${plan.conflicts} conflict(s)`);
  lines.push(`Actions: ${Object.entries(counts).map(([action, count]) => `${action}=${count}`).join(', ')}`);
  for (const harnessPlan of plan.harnesses) {
    lines.push('');
    lines.push(`${harnessPlan.harness.id}  ${harnessPlan.harness.rootPath}`);
    const interestingEntries = harnessPlan.entries.filter((entry) => entry.action !== 'ok');
    const entriesToShow = interestingEntries.length > 0 ? interestingEntries : harnessPlan.entries;
    for (const entry of entriesToShow) {
      const sourceSuffix = entry.sourcePath ? ` <= ${entry.sourcePath}` : '';
      lines.push(`  ${entry.action.padEnd(14)} ${entry.installName}${sourceSuffix}`);
      if (entry.message !== 'already synced') {
        lines.push(`    ${entry.message}`);
      }
    }
  }
  return lines.join('\n');
}

function renderPlan(plan: SyncPlan, options: { verbose?: boolean; includeOrphans?: boolean }): string {
  if (options.verbose || hasConflicts(plan)) {
    return renderDetailedPlan(plan, options);
  }

  const lines: string[] = [];
  appendSourceDiagnostics(lines, plan.sourceDiagnostics);
  if (plan.harnessDiagnostics.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    const affectedHarnesses = new Set(plan.harnessDiagnostics.map((diagnostic) => diagnostic.harnessId)).size;
    lines.push(`Harness traversal warnings: ${plan.harnessDiagnostics.length} issue(s) across ${affectedHarnesses} harness(es)`);
    lines.push('Run `skill-sync doctor --verbose` to inspect recursive skill traversal hazards.');
  }
  if (options.includeOrphans !== false && plan.orphanSkills && plan.orphanSkills.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    const harnessCount = new Set(plan.orphanSkills.map((orphan) => orphan.harnessId)).size;
    lines.push(`Orphan installed skills: ${plan.orphanSkills.length} detected across ${harnessCount} harness(es)`);
    lines.push('Run `skill-sync doctor --verbose` to inspect orphan entries.');
  }

  const counts = countPlanActions(plan);
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push(`Summary: ${plan.ok} ok, ${plan.changes} change(s), ${plan.conflicts} conflict(s)`);
  lines.push(`Actions: ${Object.entries(counts).map(([action, count]) => `${action}=${count}`).join(', ')}`);

  const harnessLines = summarizeHarnessPlans(plan);
  if (harnessLines.length > 0) {
    lines.push('');
    lines.push('Harness changes:');
    lines.push(...harnessLines);
  }

  return lines.join('\n');
}

function summarizeHarnessPlans(plan: SyncPlan): string[] {
  const lines: string[] = [];
  for (const harnessPlan of plan.harnesses) {
    const interestingEntries = harnessPlan.entries.filter((entry) => entry.action !== 'ok');
    if (interestingEntries.length === 0) {
      continue;
    }
    const counts: Record<string, number> = {};
    for (const entry of interestingEntries) {
      counts[entry.action] = (counts[entry.action] || 0) + 1;
    }
    lines.push(`- ${harnessPlan.harness.id}: ${Object.entries(counts).map(([action, count]) => `${action}=${count}`).join(', ')}`);
  }
  return lines;
}

function renderDoctorReport(plan: SyncPlan, state: ReturnType<typeof loadState>, skills: DiscoveredSkill[], harnessCount: number, verbose?: boolean): string {
  if (verbose || hasConflicts(plan)) {
    return renderDetailedPlan(plan, { includeOrphans: true });
  }

  const totalExpectedInstalls = plan.harnesses
    .flatMap((harness) => harness.entries)
    .filter((entry) => entry.action !== 'remove-managed' && entry.action !== 'prune-state')
    .length;
  const trackedExpectedInstalls = plan.harnesses
    .flatMap((harness) => harness.entries)
    .filter((entry) => entry.action !== 'conflict' && Boolean(state.managedEntries[entry.destinationPath]))
    .length;
  const okButUntracked = plan.harnesses
    .flatMap((harness) => harness.entries)
    .filter((entry) => entry.action === 'ok' && !state.managedEntries[entry.destinationPath])
    .length;
  const compatibleCopies = plan.harnesses
    .flatMap((harness) => harness.entries)
    .filter((entry) => entry.message === 'matching install will be replaced with a symlink to the authoritative source')
    .length;
  const lines: string[] = [];
  appendSourceDiagnostics(lines, plan.sourceDiagnostics);
  if (plan.harnessDiagnostics.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    const groupedDiagnostics = new Map<string, number>();
    for (const diagnostic of plan.harnessDiagnostics) {
      groupedDiagnostics.set(diagnostic.harnessId, (groupedDiagnostics.get(diagnostic.harnessId) || 0) + 1);
    }
    const topHarnesses = [...groupedDiagnostics.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([harnessId, count]) => `${harnessId}=${count}`)
      .join(', ');
    lines.push(`Traversal hazards: ${plan.harnessDiagnostics.length} harness entry issue(s) could confuse recursive parsers like OpenCode`);
    lines.push(`Top affected harnesses: ${topHarnesses}`);
    lines.push('Diagnosis: these entries expose nested descendant SKILL.md paths, missing root SKILL.md files, or traversal errors that simple root-only sync checks will miss.');
    lines.push('Run `skill-sync doctor --verbose` to inspect traversal hazards.');
  }
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push('Doctor');
  lines.push(`Sources: ${skills.length} discovered skill source(s)`);
  const scopedSources = skills.filter((skill) => skill.installHarnessIds && skill.installHarnessIds.length > 0).length;
  if (scopedSources > 0) {
    lines.push(`Scope: ${skills.length - scopedSources} global, ${scopedSources} scoped`);
  }
  lines.push(`Harnesses: ${harnessCount} detected/enabled root(s)`);
  lines.push(`Expected installs: ${totalExpectedInstalls}`);
  lines.push(`State: ${trackedExpectedInstalls} tracked, ${okButUntracked} ok-but-untracked`);
  lines.push(`Sync: ${plan.changes} change(s), ${plan.conflicts} conflict(s), ${plan.ok} ok`);

  if (compatibleCopies > 0) {
    lines.push(`Copies: ${compatibleCopies} matching install(s) still need conversion from copied content to authoritative symlinks`);
  }

  if (plan.orphanSkills && plan.orphanSkills.length > 0) {
    const groupedOrphans = new Map<string, number>();
    for (const orphan of plan.orphanSkills) {
      groupedOrphans.set(orphan.harnessId, (groupedOrphans.get(orphan.harnessId) || 0) + 1);
    }
    const topHarnesses = [...groupedOrphans.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([harnessId, count]) => `${harnessId}=${count}`)
      .join(', ');
    lines.push(`Orphans: ${plan.orphanSkills.length} installed skill(s) exist outside the discovered source set`);
    lines.push(`Top orphan roots: ${topHarnesses}`);
    lines.push('Diagnosis: project-root skills are syncing correctly. The remaining orphans are typically slug mismatches, backup artifacts, or installed entries that do not yet map to a canonical source.');
    lines.push('Run `skill-sync doctor --verbose` to inspect orphan entries.');
  } else {
    lines.push('Orphans: 0');
  }

  const harnessLines = summarizeHarnessPlans(plan);
  if (harnessLines.length > 0) {
    lines.push('');
    lines.push('Harness changes:');
    lines.push(...harnessLines);
  }

  return lines.join('\n');
}

function appendSourceDiagnostics(lines: string[], sourceDiagnostics: SyncPlan['sourceDiagnostics']): void {
  if (sourceDiagnostics.errors.length === 0 && sourceDiagnostics.warnings.length === 0) {
    return;
  }
  if (sourceDiagnostics.errors.length > 0) {
    lines.push('Source errors:');
    for (const diagnostic of sourceDiagnostics.errors) {
      appendSourceDiagnostic(lines, diagnostic);
    }
  }
  if (sourceDiagnostics.warnings.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Source warnings:');
    for (const diagnostic of sourceDiagnostics.warnings) {
      appendSourceDiagnostic(lines, diagnostic);
    }
  }
}

function appendSourceDiagnostic(lines: string[], diagnostic: SourceDiagnostic): void {
  if (diagnostic.kind === 'invalid-frontmatter') {
    lines.push(`- invalid skill metadata: ${diagnostic.slug}`);
    for (const sourcePath of diagnostic.sourcePaths) {
      lines.push(`  ${sourcePath}`);
    }
    if (diagnostic.message) {
      lines.push(`  ${diagnostic.message}`);
    }
    lines.push('  Codex and other harnesses may fail to index this skill until the frontmatter is fixed');
    return;
  }

  if (diagnostic.kind === 'repo-root-pollution') {
    lines.push(`- polluted repo-root skill: ${diagnostic.slug}`);
    for (const sourcePath of diagnostic.sourcePaths) {
      lines.push(`  ${sourcePath}`);
    }
    if (diagnostic.message) {
      lines.push(`  ${diagnostic.message}`);
    }
    lines.push('  skipped to prevent other CLIs from discovering spurious skills');
    return;
  }

  lines.push(`- duplicate slug: ${diagnostic.slug}`);
  for (const sourcePath of diagnostic.sourcePaths) {
    lines.push(`  ${sourcePath}`);
  }
  if (diagnostic.resolution === 'resolved-by-preference' && diagnostic.chosenSourcePath) {
    lines.push(`  resolved by preference: ${diagnostic.chosenSourcePath}`);
    return;
  }
  lines.push('  sync blocked until one source is excluded or preferred');
}

function appendHarnessDiagnostics(lines: string[], diagnostics: HarnessTraversalDiagnostic[]): void {
  if (diagnostics.length === 0) {
    return;
  }
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push('Harness traversal warnings:');
  for (const diagnostic of diagnostics) {
    lines.push(`- ${diagnostic.kind}: ${diagnostic.harnessId}/${diagnostic.entryName}`);
    lines.push(`  ${diagnostic.entryPath}`);
    if (diagnostic.resolvedTarget) {
      lines.push(`  resolved target: ${diagnostic.resolvedTarget}`);
    }
    lines.push(`  ${diagnostic.message}`);
    for (const descendant of diagnostic.descendantSkillFiles || []) {
      lines.push(`  descendant: ${descendant}`);
    }
    if (diagnostic.rootSkillFile) {
      lines.push(`  root: ${diagnostic.rootSkillFile}`);
    }
    if (diagnostic.error) {
      lines.push(`  error: ${diagnostic.error}`);
    }
  }
}

function planSync(options: GlobalOptions): {
  runtime: ReturnType<typeof buildRuntimeContext>;
  plan: SyncPlan;
  harnesses: HarnessDefinition[];
  skills: DiscoveredSkill[];
  state: ReturnType<typeof loadState>;
} {
  return withRuntime(options, (runtime) => {
    const config = loadConfig(runtime);
    config.projectsRoots = resolveProjectsOverride(config.projectsRoots, options);
    const allHarnesses = resolveHarnesses(runtime.homeDir, config).filter((harness) => harness.enabled);
    const harnesses = resolveSelectedHarnesses(allHarnesses, options);
    const { skills, sourceDiagnostics } = discoverSkillSet(config, allHarnesses);
    const state = loadState(runtime);
    const plan = buildSyncPlan(skills, harnesses, config, state, sourceDiagnostics);
    return { runtime, plan, harnesses, skills, state };
  });
}

function printDoctorResult(
  plan: SyncPlan,
  options: GlobalOptions,
  state: ReturnType<typeof loadState>,
  skills: DiscoveredSkill[],
  harnessCount: number,
): never {
  print(
    options.json
      ? ({
        ...plan,
        summary: {
          sourcesDiscovered: skills.length,
          scopedSources: skills.filter((skill) => skill.installHarnessIds && skill.installHarnessIds.length > 0).length,
          harnessesDetected: harnessCount,
          expectedInstalls: plan.harnesses
            .flatMap((harness) => harness.entries)
            .filter((entry) => entry.action !== 'remove-managed' && entry.action !== 'prune-state')
            .length,
          changes: plan.changes,
          conflicts: plan.conflicts,
          ok: plan.ok,
          traversalHazards: plan.harnessDiagnostics.length,
          orphans: plan.orphanSkills?.length || 0,
        },
      } as unknown as JsonValue)
      : renderDoctorReport(plan, state, skills, harnessCount, options.verbose),
    Boolean(options.json),
  );
  process.exit(hasConflicts(plan) ? 3 : hasDrift(plan) ? 2 : 0);
}

cli
  .command('doctor', 'Inspect current sources, drift, and orphan installs')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Accepted for parity; check is always read-only')
  .option('--verbose', 'Show detailed plan output')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    const { plan, state, skills, harnesses } = planSync(options);
    printDoctorResult(plan, options, state, skills, harnesses.length);
  });

cli
  .command('check', 'Alias for doctor')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Accepted for parity; check is always read-only')
  .option('--verbose', 'Show detailed plan output')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    const { plan, state, skills, harnesses } = planSync(options);
    printDoctorResult(plan, options, state, skills, harnesses.length);
  });

function runExecute(options: GlobalOptions): void {
  const { runtime, plan, state } = planSync(options);
  const hasPlanConflicts = hasConflicts(plan);
  if (hasPlanConflicts && !options.continueOnConflict) {
    print(
      options.json
        ? (plan as unknown as JsonValue)
        : renderPlan(plan, { verbose: true, includeOrphans: true }),
      Boolean(options.json),
    );
    process.exit(3);
  }
  const nextState = applySyncPlan(plan, state, Boolean(options.dryRun));
  if (!options.dryRun) {
    saveState(runtime, nextState);
  }
  print(
    options.json
      ? (plan as unknown as JsonValue)
      : renderPlan(plan, { verbose: options.verbose, includeOrphans: false }),
    Boolean(options.json),
  );
  if (hasPlanConflicts) {
    process.exit(3);
  }
}

cli
  .command('execute', 'Apply the desired symlink state')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Show changes without mutating')
  .option('--continue-on-conflict', 'Apply non-conflicting changes and still exit non-zero if conflicts remain')
  .option('--verbose', 'Show detailed plan output')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action(runExecute);

cli
  .command('sync', 'Alias for execute')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Show changes without mutating')
  .option('--continue-on-conflict', 'Apply non-conflicting changes and still exit non-zero if conflicts remain')
  .option('--verbose', 'Show detailed plan output')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action(runExecute);

cli
  .command('sources', 'List discovered source skills')
  .option('--json', 'Output JSON')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    withRuntime(options, (runtime) => {
      const config = loadConfig(runtime);
      config.projectsRoots = resolveProjectsOverride(config.projectsRoots, options);
      const harnesses = resolveHarnesses(runtime.homeDir, config).filter((harness) => harness.enabled);
      const { skills, sourceDiagnostics } = discoverSkillSet(config, harnesses);
      if (options.json) {
        print({ skills, sourceDiagnostics } as unknown as JsonValue, true);
        return;
      }
      console.log(`Discovered ${skills.length} skill source(s)`);
      const sourceLines: string[] = [];
      appendSourceDiagnostics(sourceLines, sourceDiagnostics);
      if (sourceLines.length > 0) {
        console.log(sourceLines.join('\n'));
        console.log('');
      }
      for (const skill of skills) {
        console.log(`- ${describeSkill(skill)}`);
      }
    });
  });

cli
  .command('harnesses', 'List known harness roots and detection status')
  .option('--json', 'Output JSON')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    withRuntime(options, (runtime) => {
      const harnesses = resolveHarnesses(runtime.homeDir, loadConfig(runtime));
      if (options.json) {
        print(harnesses as unknown as JsonValue, true);
        return;
      }
      for (const harness of harnesses) {
        console.log(`${harness.id}  ${harness.rootPath}`);
        console.log(`  kind: ${harness.kind}`);
        console.log(`  detected: ${harness.detected ? 'yes' : 'no'}`);
        console.log(`  enabled: ${harness.enabled ? 'yes' : 'no'}`);
      }
    });
  });

cli
  .command('backup <action> [target]', 'Backup commands: create, list, restore')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Show what would happen without mutating')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .action((action: string, target: string | undefined, options: GlobalOptions) => {
    withRuntime(options, (runtime) => {
      if (action === 'create') {
        const config = loadConfig(runtime);
        const harnesses = resolveSelectedHarnesses(resolveHarnesses(runtime.homeDir, config), options);
        const manifest = createBackup(runtime, harnesses, loadState(runtime));
        if (options.json) {
          print(manifest as unknown as JsonValue, true);
          return;
        }
        console.log(`Created backup ${manifest.id}`);
        for (const harness of manifest.harnesses) {
          console.log(`- ${harness.id}: ${harness.entries.length} entr${harness.entries.length === 1 ? 'y' : 'ies'}`);
        }
        return;
      }
      if (action === 'list') {
        const backups = listBackups(runtime);
        if (options.json) {
          print(backups as unknown as JsonValue, true);
          return;
        }
        if (backups.length === 0) {
          console.log('No backups found');
          return;
        }
        for (const backupEntry of backups) {
          console.log(`${backupEntry.id}  ${backupEntry.createdAt}`);
          console.log(`  harnesses: ${backupEntry.harnesses.map((harness) => harness.id).join(', ') || '-'}`);
        }
        return;
      }
      if (action === 'restore') {
        if (!target) {
          throw new Error('backup restore requires a backup id');
        }
        const { manifest, nextState } = restoreBackup(
          runtime,
          target,
          normalizeList(options.harness),
          Boolean(options.dryRun),
          loadState(runtime),
        );
        if (!options.dryRun) {
          saveState(runtime, nextState);
        }
        if (options.json) {
          print(manifest as unknown as JsonValue, true);
          return;
        }
        console.log(`${options.dryRun ? 'Would restore' : 'Restored'} backup ${manifest.id}`);
        const selectedIds = normalizeList(options.harness);
        for (const harness of manifest.harnesses) {
          if (selectedIds.length > 0 && !selectedIds.includes(harness.id)) {
            continue;
          }
          console.log(`- ${harness.id}: ${harness.entries.length} entr${harness.entries.length === 1 ? 'y' : 'ies'}`);
        }
        return;
      }
      throw new Error(`Unknown backup action: ${action}`);
    });
  });

cli
  .command('config <action>', 'Config commands: init')
  .option('--json', 'Output JSON')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((action: string, options: GlobalOptions) => {
    if (action !== 'init') {
      throw new Error(`Unknown config action: ${action}`);
    }
    withRuntime(options, (runtime) => {
      const config = initConfig(runtime);
      print(config as unknown as JsonValue, Boolean(options.json));
    });
  });

cli
  .command('harness <action> [id] [rootPath]', 'Harness commands: list, add, remove')
  .option('--json', 'Output JSON')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((action: string, id: string | undefined, rootPath: string | undefined, options: GlobalOptions) => {
    if (action === 'list') {
      withRuntime(options, (runtime) => {
        const harnesses = resolveHarnesses(runtime.homeDir, loadConfig(runtime));
        print(options.json ? (harnesses as unknown as JsonValue) : harnesses.map((item: HarnessDefinition) => `${item.id} ${item.rootPath}`).join('\n'), Boolean(options.json));
      });
      return;
    }
    if (!id) {
      throw new Error(`harness ${action} requires an id`);
    }
    if (action === 'add') {
      if (!rootPath) {
        throw new Error('harness add requires a root path');
      }
      const config = withRuntime(options, (runtime) => addHarness(runtime, id, rootPath));
      print(config as unknown as JsonValue, Boolean(options.json));
      return;
    }
    if (action === 'remove') {
      const config = withRuntime(options, (runtime) => removeHarness(runtime, id));
      print(config as unknown as JsonValue, Boolean(options.json));
      return;
    }
    throw new Error(`Unknown harness action: ${action}`);
  });

cli
  .command('roots <action> [rootPath]', 'Projects root commands: list, add, remove')
  .option('--json', 'Output JSON')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((action: string, rootPath: string | undefined, options: GlobalOptions) => {
    if (action === 'list') {
      withRuntime(options, (runtime) => {
        const config = loadConfig(runtime);
        print(config.projectsRoots as unknown as JsonValue, Boolean(options.json));
      });
      return;
    }
    if (!rootPath) {
      throw new Error(`roots ${action} requires a path`);
    }
    if (action === 'add') {
      const config = withRuntime(options, (runtime) => addProjectsRoot(runtime, rootPath));
      print(config as unknown as JsonValue, Boolean(options.json));
      return;
    }
    if (action === 'remove') {
      const config = withRuntime(options, (runtime) => removeProjectsRoot(runtime, rootPath));
      print(config as unknown as JsonValue, Boolean(options.json));
      return;
    }
    throw new Error(`Unknown roots action: ${action}`);
  });

cli
  .command('clean', 'Find and remove polluted symlinks pointing to entire project directories')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Show polluted entries without removing them')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    withRuntime(options, (runtime) => {
      const config = loadConfig(runtime);
      const allHarnesses = resolveHarnesses(runtime.homeDir, config).filter((h) => h.enabled);
      const harnesses = resolveSelectedHarnesses(allHarnesses, options);
      const state = loadState(runtime);
      const polluted = findPollutedSymlinks(harnesses, state);

      if (options.json) {
        if (options.dryRun) {
          print({ polluted, count: polluted.length, dryRun: true } as unknown as JsonValue, true);
        } else {
          const nextState = cleanPollutedSymlinks(polluted, state, false);
          saveState(runtime, nextState);
          print({ removed: polluted.length } as unknown as JsonValue, true);
        }
        return;
      }

      if (polluted.length === 0) {
        console.log('No polluted symlinks found.');
        return;
      }

      console.log(`Found ${polluted.length} polluted symlink(s):`);
      for (const entry of polluted) {
        console.log(`  ${entry.destinationPath}`);
        console.log(`    target: ${entry.resolvedTarget}`);
        console.log(`    reason: ${entry.reason}`);
      }

      if (options.dryRun) {
        console.log(`\n(dry run) ${polluted.length} symlink(s) would be removed`);
        return;
      }

      const nextState = cleanPollutedSymlinks(polluted, state, false);
      saveState(runtime, nextState);
      console.log(`\nRemoved ${polluted.length} polluted symlink(s). Re-run 'skill-sync execute' to restore clean links.`);
    });
  });

cli.help();
cli.version(version);
cli.option('--json', 'Output JSON');
cli.option('--dry-run', 'Show changes without mutating');
cli.option('--verbose', 'Show detailed plan output');
cli.option('--projects-root <path>', 'Override configured projects root');
cli.option('--harness <id>', 'Filter to one or more harness ids');
cli.option('--home <path>', 'Override HOME for skill-sync state and harness resolution');
const rawArgs = process.argv.slice(2);
cli.parse();

const shouldRunDefaultSync =
  rawArgs.length > 0 &&
  !rawArgs.includes('--help') &&
  !rawArgs.includes('-h') &&
  !rawArgs.includes('--version') &&
  !rawArgs.includes('-v') &&
  !cli.matchedCommand;

if (shouldRunDefaultSync) {
  print(renderLandingHelp(), false);
}

if (rawArgs.length === 0) {
  print(renderLandingHelp(), false);
}
