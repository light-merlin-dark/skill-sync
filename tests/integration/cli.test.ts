import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeFakeProjectsRoot, makeHarnessRoot, makeNestedSkill, makeTopLevelSkill, readSkillFile, writeText } from '../support';

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    cleanup(tempPaths.pop()!);
  }
});

function runCli(cwd: string, args: string[], env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ['bun', 'run', 'src/index.ts', ...args],
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

test('syncs, backs up, and restores inside a fake home', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  makeHarnessRoot(homeDir, '.claude/skills');
  makeTopLevelSkill(projectsRoot, 'prod-control', 'prod');
  makeNestedSkill(projectsRoot, 'packages-stack', 'stack-foundation', 'StackFoundation');

  const baseArgs = ['--home', homeDir, '--projects-root', projectsRoot];

  const checkBefore = runCli(repoRoot, ['check', ...baseArgs], {});
  expect(checkBefore.exitCode).toBe(2);
  expect(checkBefore.stdout.toString()).toContain('create');

  const syncResult = runCli(repoRoot, ['execute', ...baseArgs], {});
  expect(syncResult.exitCode).toBe(0);
  expect(lstatSync(join(codexRoot, 'prod')).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(codexRoot, 'stack-foundation')).isSymbolicLink()).toBe(true);

  const backupCreate = runCli(repoRoot, ['backup', 'create', '--home', homeDir, '--harness', 'codex'], {});
  expect(backupCreate.exitCode).toBe(0);
  const backupId = backupCreate.stdout.toString().match(/Created backup ([^\n]+)/)?.[1];
  expect(Boolean(backupId)).toBe(true);

  rmSync(join(codexRoot, 'prod'), { recursive: true, force: true });
  rmSync(join(projectsRoot, 'prod-control'), { recursive: true, force: true });

  const restoreResult = runCli(repoRoot, ['backup', 'restore', backupId!, '--home', homeDir, '--harness', 'codex'], {});
  expect(restoreResult.exitCode).toBe(0);
  expect(existsSync(join(codexRoot, 'prod', 'SKILL.md'))).toBe(true);
  expect(lstatSync(join(codexRoot, 'prod')).isDirectory()).toBe(true);
  expect(readSkillFile(join(codexRoot, 'prod', 'SKILL.md'))).toContain('name: prod');
  const manifestPath = join(homeDir, '.skill-sync', 'backups', backupId!, 'manifest.json');
  const manifest = JSON.parse(readSkillFile(manifestPath));
  expect(JSON.stringify(manifest)).not.toContain('materialized');
});

test('reports unmanaged conflicts instead of clobbering them', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  makeTopLevelSkill(projectsRoot, 'coolify-helper', 'coolify-helper');
  mkdirSync(join(codexRoot, 'coolify-helper'), { recursive: true });
  writeText(join(codexRoot, 'coolify-helper', 'README.txt'), 'unmanaged');

  const checkResult = runCli(repoRoot, ['check', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(checkResult.exitCode).toBe(3);
  expect(checkResult.stdout.toString()).toContain('conflict');
});

test('execute can continue applying non-conflicting changes when conflicts exist', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  makeTopLevelSkill(projectsRoot, 'coolify-helper', 'coolify-helper');
  makeTopLevelSkill(projectsRoot, 'prod-control', 'prod');
  mkdirSync(join(codexRoot, 'coolify-helper'), { recursive: true });
  writeText(join(codexRoot, 'coolify-helper', 'README.txt'), 'unmanaged');

  const result = runCli(
    repoRoot,
    ['execute', '--continue-on-conflict', '--home', homeDir, '--projects-root', projectsRoot],
    {},
  );
  expect(result.exitCode).toBe(3);
  expect(result.stdout.toString()).toContain('conflict');
  expect(lstatSync(join(codexRoot, 'prod')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(codexRoot, 'prod'))).toContain('/prod-control');
});

test('surfaces source duplicate diagnostics before harness sync', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  makeHarnessRoot(homeDir, '.codex/skills');
  makeNestedSkill(projectsRoot, 'agent-browser-src', 'agent-browser', 'agent-browser');
  makeNestedSkill(projectsRoot, 'devh', 'agent-browser', 'agent-browser');

  const warningResult = runCli(repoRoot, ['check', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(warningResult.exitCode).toBe(2);
  expect(warningResult.stdout.toString()).toContain('Source warnings:');
  expect(warningResult.stdout.toString()).toContain('duplicate slug: agent-browser');

  writeText(
    join(projectsRoot, 'devh', 'skills', 'agent-browser', 'SKILL.md'),
    '---\nname: agent-browser\ndescription: Divergent agent-browser\n---\n\n# Divergent Skill\n',
  );

  const errorResult = runCli(repoRoot, ['check', '--home', homeDir, '--projects-root', projectsRoot, '--json'], {});
  expect(errorResult.exitCode).toBe(3);
  const parsed = JSON.parse(errorResult.stdout.toString());
  expect(parsed.sourceDiagnostics.errors).toHaveLength(1);
  expect(parsed.sourceDiagnostics.errors[0]?.slug).toBe('agent-browser');
});

test('backup create tolerates symlink loops inside a skill source', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  const prodRepo = makeTopLevelSkill(projectsRoot, 'prod-control', 'prod');
  symlinkSync('.', join(prodRepo, 'loop'));

  const baseArgs = ['--home', homeDir, '--projects-root', projectsRoot];
  const syncResult = runCli(repoRoot, ['execute', ...baseArgs], {});
  expect(syncResult.exitCode).toBe(0);
  expect(lstatSync(join(codexRoot, 'prod')).isSymbolicLink()).toBe(true);

  const backupCreate = runCli(repoRoot, ['backup', 'create', '--home', homeDir, '--harness', 'codex', '--json'], {});
  expect(backupCreate.exitCode).toBe(0);
  const manifest = JSON.parse(backupCreate.stdout.toString());
  const prodEntry = manifest.harnesses[0]?.entries.find((entry: { name: string }) => entry.name === 'prod');
  expect(prodEntry.skillFiles).toHaveLength(1);
  expect(prodEntry.skillFiles[0]?.relativePath).toBe('SKILL.md');
});

test('default command shows landing help while execute mutates and doctor diagnoses', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  makeHarnessRoot(homeDir, '.claude/skills');
  makeTopLevelSkill(projectsRoot, 'skill-sync', 'skill-sync');
  mkdirSync(join(codexRoot, 'legacy-skill'), { recursive: true });
  writeText(join(codexRoot, 'legacy-skill', 'SKILL.md'), '---\nname: legacy-skill\ndescription: Legacy skill\n---\n\n# Legacy\n');

  const baseArgs = ['--home', homeDir, '--projects-root', projectsRoot];

  const helpResult = runCli(repoRoot, [], {});
  expect(helpResult.exitCode).toBe(0);
  const helpStdout = helpResult.stdout.toString();
  expect(helpStdout).toContain('High-signal commands:');
  expect(helpStdout).toContain('skill-sync doctor');
  expect(helpStdout).toContain('skill-sync execute');

  const syncResult = runCli(repoRoot, ['execute', ...baseArgs], {});
  expect(syncResult.exitCode).toBe(0);
  const syncStdout = syncResult.stdout.toString();
  expect(syncStdout).toContain('Summary:');
  expect(syncStdout).toContain('Harness changes:');
  expect(syncStdout).not.toContain('Orphan installed skills:');
  expect(syncStdout).not.toContain('missing entry will be created');

  const doctorResult = runCli(repoRoot, ['doctor', ...baseArgs], {});
  expect(doctorResult.exitCode).toBe(0);
  const doctorStdout = doctorResult.stdout.toString();
  expect(doctorStdout).toContain('Doctor');
  expect(doctorStdout).toContain('Orphans: 0');

  const verboseCheck = runCli(repoRoot, ['doctor', '--verbose', ...baseArgs], {});
  expect(verboseCheck.exitCode).toBe(0);
  const verboseStdout = verboseCheck.stdout.toString();
  expect(verboseStdout).toContain('codex  ');
  expect(verboseStdout).toContain('legacy-skill');

  const jsonSync = runCli(repoRoot, ['execute', '--json', ...baseArgs], {});
  expect(jsonSync.exitCode).toBe(0);
  const parsed = JSON.parse(jsonSync.stdout.toString());
  expect(parsed.changes).toBe(0);
  expect(parsed.orphanSkills || []).toHaveLength(0);
});

test('execute syncs harness-native skills across other detected harness roots', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  const hermesRoot = makeHarnessRoot(homeDir, '.hermes/skills');
  mkdirSync(join(codexRoot, 'vendor-only'), { recursive: true });
  writeText(join(codexRoot, 'vendor-only', 'SKILL.md'), '---\nname: vendor-only\ndescription: Vendor skill\n---\n\n# Vendor\n');

  const result = runCli(repoRoot, ['execute', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(result.exitCode).toBe(0);
  expect(lstatSync(join(hermesRoot, 'vendor-only')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(hermesRoot, 'vendor-only'))).toContain('/.codex/skills/vendor-only');

  const doctorResult = runCli(repoRoot, ['doctor', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(doctorResult.exitCode).toBe(0);
  expect(doctorResult.stdout.toString()).toContain('Sources: 1 discovered skill source(s)');
});

test('execute keeps harness-local skills on their owning harness only', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const agentsRoot = makeHarnessRoot(homeDir, '.agents/skills');
  const hermesRoot = makeHarnessRoot(homeDir, '.hermes/skills');
  mkdirSync(join(hermesRoot, 'dogfood'), { recursive: true });
  writeText(
    join(hermesRoot, 'dogfood', 'SKILL.md'),
    '---\nname: dogfood\ndescription: Hermes-only skill\nskill-sync-scope: local-only\n---\n\n# Dogfood\n',
  );

  const result = runCli(repoRoot, ['execute', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(agentsRoot, 'dogfood'))).toBe(false);
  expect(lstatSync(join(hermesRoot, 'dogfood')).isDirectory()).toBe(true);

  const doctorResult = runCli(repoRoot, ['doctor', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(doctorResult.exitCode).toBe(0);
  const doctorStdout = doctorResult.stdout.toString();
  expect(doctorStdout).toContain('Scope: 0 global, 1 scoped');
  expect(doctorStdout).toContain('Expected installs: 1');

  const sourcesResult = runCli(repoRoot, ['sources', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(sourcesResult.exitCode).toBe(0);
  expect(sourcesResult.stdout.toString()).toContain('dogfood <= hermes:');
  expect(sourcesResult.stdout.toString()).toContain('[local-only: hermes]');
});

test('doctor flags malformed skill metadata even when sync layout is otherwise fine', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  makeHarnessRoot(homeDir, '.codex/skills');
  const brokenSkillPath = makeTopLevelSkill(projectsRoot, 'db-cli');
  writeText(
    join(brokenSkillPath, 'SKILL.md'),
    'name: db\ndescription: Broken frontmatter example\n---\n\n# DB\n',
  );

  const result = runCli(repoRoot, ['doctor', '--home', homeDir, '--projects-root', projectsRoot], {});
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toContain('Source warnings:');
  expect(result.stdout.toString()).toContain('invalid skill metadata: db');
  expect(result.stdout.toString()).toContain('frontmatter');
});

test('version command matches package.json', () => {
  const repoRoot = '/Users/merlin/_dev/skill-sync';
  const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

  const result = runCli(repoRoot, ['--version'], {});
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`skill-sync/${packageVersion}`);
});
