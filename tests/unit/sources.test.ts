import { afterEach, expect, test } from 'bun:test';
import { discoverSkillSet, discoverSkills } from '../../src/core/sources';
import type { Config } from '../../src/core/types';
import { cleanup, makeFakeProjectsRoot, makeNestedSkill, makeTopLevelSkill, writeText } from '../support';

function makeConfig(projectsRoot: string): Config {
  return {
    version: 1,
    projectsRoots: [projectsRoot],
    discovery: {
      ignorePathPrefixes: [],
      preferPathPrefixes: [],
    },
    harnesses: { custom: [] },
    aliases: {},
  };
}

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    cleanup(tempPaths.pop()!);
  }
});

test('discovers top-level and nested skills', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);
  makeTopLevelSkill(projectsRoot, 'prod-server', 'prod');
  makeNestedSkill(projectsRoot, 'packages', 'stack-foundation', 'StackFoundation');
  const config = makeConfig(projectsRoot);

  const skills = discoverSkills(config);
  expect(skills.map((skill) => skill.canonicalSlug)).toEqual(['stack-foundation', 'prod']);
  expect(skills.map((skill) => skill.sourceType)).toEqual(['nested', 'repo-root']);
});

test('prefers a top-level skill when a nested mirror has the same slug in the same repo', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);
  makeTopLevelSkill(projectsRoot, 'vssh', 'vssh');
  makeNestedSkill(projectsRoot, 'vssh', 'vssh', 'vssh');

  const config = makeConfig(projectsRoot);

  const skills = discoverSkills(config);
  expect(skills).toHaveLength(1);
  expect(skills[0]?.sourceType).toBe('repo-root');
});

test('collapses identical duplicate skills across repos to one canonical source', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);
  makeNestedSkill(projectsRoot, 'agent-browser-src', 'agent-browser', 'agent-browser');
  makeNestedSkill(projectsRoot, 'devh', 'agent-browser', 'agent-browser');

  const config = makeConfig(projectsRoot);

  const { skills, sourceDiagnostics } = discoverSkillSet(config);
  expect(skills).toHaveLength(1);
  expect(skills[0]?.sourcePath).toContain('/agent-browser-src/');
  expect(sourceDiagnostics.warnings).toHaveLength(1);
  expect(sourceDiagnostics.warnings[0]?.slug).toBe('agent-browser');
  expect(sourceDiagnostics.warnings[0]?.chosenSourcePath).toContain('/agent-browser-src/');
});

test('reports unresolved duplicate skills as source errors', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);
  makeNestedSkill(projectsRoot, 'agent-browser-src', 'agent-browser', 'agent-browser');
  makeNestedSkill(projectsRoot, 'devh', 'agent-browser', 'agent-browser');
  makeTopLevelSkill(projectsRoot, 'placeholder', 'placeholder');

  const config = makeConfig(projectsRoot);
  const customSkillPath = `${projectsRoot}/devh/skills/agent-browser/SKILL.md`;
  writeText(customSkillPath, '---\nname: agent-browser\ndescription: divergent\n---\n\n# Divergent Skill\n');

  const { skills, sourceDiagnostics } = discoverSkillSet(config);
  expect(skills.filter((skill) => skill.canonicalSlug === 'agent-browser')).toHaveLength(2);
  expect(sourceDiagnostics.errors).toHaveLength(1);
  expect(sourceDiagnostics.errors[0]?.slug).toBe('agent-browser');
  expect(sourceDiagnostics.errors[0]?.sourcePaths).toHaveLength(2);
});
