#!/usr/bin/env node
import { cac } from 'cac';
import { mkdirSync } from 'node:fs';
import { createBackup, listBackups, restoreBackup } from './core/backup';
import { addHarness, addProjectsRoot, initConfig, loadConfig, loadState, removeHarness, removeProjectsRoot, saveState } from './core/config';
import { resolveHarnesses, filterHarnesses } from './core/harnesses';
import { discoverSkillSet, describeSkill } from './core/sources';
import { applySyncPlan, buildSyncPlan, countPlanActions, hasConflicts, hasDrift } from './core/sync';
import { buildRuntimeContext } from './core/utils';
import type { HarnessDefinition, JsonValue, SourceDiagnostic, SyncPlan } from './core/types';

const cli = cac('skill-sync');
const version = '0.1.1';

type GlobalOptions = {
  json?: boolean;
  home?: string;
  dryRun?: boolean;
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

function renderPlan(plan: SyncPlan): string {
  const lines: string[] = [];
  appendSourceDiagnostics(lines, plan.sourceDiagnostics);
  if (plan.orphanSkills && plan.orphanSkills.length > 0) {
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

function planSync(options: GlobalOptions): { runtime: ReturnType<typeof buildRuntimeContext>; plan: SyncPlan; harnesses: HarnessDefinition[]; skillsCount: number } {
  return withRuntime(options, (runtime) => {
    const config = loadConfig(runtime);
    config.projectsRoots = resolveProjectsOverride(config.projectsRoots, options);
    const harnesses = resolveSelectedHarnesses(resolveHarnesses(runtime.homeDir, config), options);
    const { skills, sourceDiagnostics } = discoverSkillSet(config);
    const state = loadState(runtime);
    const plan = buildSyncPlan(skills, harnesses, config, state, sourceDiagnostics);
    return { runtime, plan, harnesses, skillsCount: skills.length };
  });
}

function printCheckResult(plan: SyncPlan, json: boolean): never {
  print(json ? (plan as unknown as JsonValue) : renderPlan(plan), json);
  process.exit(hasConflicts(plan) ? 3 : hasDrift(plan) ? 2 : 0);
}

cli
  .command('check', 'Show drift without changing anything')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Accepted for parity; check is always read-only')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    const { plan } = planSync(options);
    printCheckResult(plan, Boolean(options.json));
  });

cli
  .command('sync', 'Apply the desired symlink state')
  .option('--json', 'Output JSON')
  .option('--dry-run', 'Show changes without mutating')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--harness <id>', 'Filter to one or more harness ids')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    const { runtime, plan } = planSync(options);
    if (hasConflicts(plan)) {
      print(options.json ? (plan as unknown as JsonValue) : renderPlan(plan), Boolean(options.json));
      process.exit(3);
    }
    const state = loadState(runtime);
    const nextState = applySyncPlan(plan, state, Boolean(options.dryRun));
    if (!options.dryRun) {
      saveState(runtime, nextState);
    }
    print(options.json ? (plan as unknown as JsonValue) : renderPlan(plan), Boolean(options.json));
  });

cli
  .command('sources', 'List discovered source skills')
  .option('--json', 'Output JSON')
  .option('--projects-root <path>', 'Override configured projects root')
  .option('--home <path>', 'Override HOME for skill-sync state and harness resolution')
  .action((options: GlobalOptions) => {
    withRuntime(options, (runtime) => {
      const config = loadConfig(runtime);
      config.projectsRoots = resolveProjectsOverride(config.projectsRoots, options);
      const { skills, sourceDiagnostics } = discoverSkillSet(config);
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

cli.help();
cli.version(version);
cli.option('--json', 'Output JSON');
cli.option('--dry-run', 'Show changes without mutating');
cli.option('--projects-root <path>', 'Override configured projects root');
cli.option('--harness <id>', 'Filter to one or more harness ids');
cli.option('--home <path>', 'Override HOME for skill-sync state and harness resolution');
const rawArgs = process.argv.slice(2);
cli.parse();

const shouldRunDefaultSync =
  !rawArgs.includes('--help') &&
  !rawArgs.includes('-h') &&
  !rawArgs.includes('--version') &&
  !rawArgs.includes('-v') &&
  !cli.matchedCommand;

if (shouldRunDefaultSync) {
  const options = cli.options as GlobalOptions;
  const { runtime, plan } = planSync(options);
  if (hasConflicts(plan)) {
    console.log(renderPlan(plan));
    process.exit(3);
  }
  const nextState = applySyncPlan(plan, loadState(runtime), Boolean(options.dryRun));
  if (!options.dryRun) {
    saveState(runtime, nextState);
  }
  console.log(renderPlan(plan));
}
