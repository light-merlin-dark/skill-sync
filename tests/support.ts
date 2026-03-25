import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

export function makeSkillFile(path: string, name?: string): void {
  const frontmatter = name
    ? `---\nname: ${name}\ndescription: Test skill\n---\n\n`
    : '';
  writeText(path, `${frontmatter}# Test Skill\n`);
}

export function makeFakeProjectsRoot(): { homeDir: string; projectsRoot: string } {
  const homeDir = makeTempDir('skill-sync-home-');
  const projectsRoot = join(homeDir, 'projects');
  mkdirSync(projectsRoot, { recursive: true });
  return { homeDir, projectsRoot };
}

export function makeHarnessRoot(homeDir: string, relativePath: string): string {
  const rootPath = join(homeDir, relativePath);
  mkdirSync(rootPath, { recursive: true });
  return rootPath;
}

export function makeTopLevelSkill(projectsRoot: string, repoName: string, skillName?: string): string {
  const repoPath = join(projectsRoot, repoName);
  mkdirSync(repoPath, { recursive: true });
  makeSkillFile(join(repoPath, 'SKILL.md'), skillName);
  return repoPath;
}

export function makeNestedSkill(projectsRoot: string, repoName: string, nestedName: string, skillName?: string): string {
  const repoPath = join(projectsRoot, repoName);
  const nestedPath = join(repoPath, 'skills', nestedName);
  mkdirSync(nestedPath, { recursive: true });
  makeSkillFile(join(nestedPath, 'SKILL.md'), skillName);
  return nestedPath;
}

export function readDirNames(path: string): string[] {
  return readdirSync(path).sort();
}

export function linkPath(path: string, target: string): void {
  symlinkSync(target, path);
}

export function readSkillFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
