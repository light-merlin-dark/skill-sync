import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
  makeTopLevelSkill(projectsRoot, 'prod-server', 'prod');
  makeNestedSkill(projectsRoot, 'packages-stack', 'stack-foundation', 'StackFoundation');

  const baseArgs = ['--home', homeDir, '--projects-root', projectsRoot];

  const checkBefore = runCli(repoRoot, ['check', ...baseArgs], {});
  expect(checkBefore.exitCode).toBe(2);
  expect(checkBefore.stdout.toString()).toContain('create');

  const syncResult = runCli(repoRoot, [...baseArgs], {});
  expect(syncResult.exitCode).toBe(0);
  expect(lstatSync(join(codexRoot, 'prod')).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(codexRoot, 'stack-foundation')).isSymbolicLink()).toBe(true);

  const backupCreate = runCli(repoRoot, ['backup', 'create', '--home', homeDir, '--harness', 'codex'], {});
  expect(backupCreate.exitCode).toBe(0);
  const backupId = backupCreate.stdout.toString().match(/Created backup ([^\n]+)/)?.[1];
  expect(Boolean(backupId)).toBe(true);

  rmSync(join(codexRoot, 'prod'), { recursive: true, force: true });
  rmSync(join(projectsRoot, 'prod-server'), { recursive: true, force: true });

  const restoreResult = runCli(repoRoot, ['backup', 'restore', backupId!, '--home', homeDir, '--harness', 'codex'], {});
  expect(restoreResult.exitCode).toBe(0);
  expect(existsSync(join(codexRoot, 'prod', 'SKILL.md'))).toBe(true);
  expect(lstatSync(join(codexRoot, 'prod')).isDirectory()).toBe(true);
  expect(readSkillFile(join(codexRoot, 'prod', 'SKILL.md'))).toContain('name: prod');
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
