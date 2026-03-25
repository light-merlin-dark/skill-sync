import { afterEach, expect, test } from 'bun:test';
import { discoverSkills } from '../../src/core/sources';
import type { Config } from '../../src/core/types';
import { cleanup, makeFakeProjectsRoot, makeNestedSkill, makeTopLevelSkill } from '../support';

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
  const config: Config = {
    version: 1,
    projectsRoots: [projectsRoot],
    harnesses: { custom: [] },
    aliases: {},
  };

  const skills = discoverSkills(config);
  expect(skills.map((skill) => skill.canonicalSlug)).toEqual(['stack-foundation', 'prod']);
  expect(skills.map((skill) => skill.sourceType)).toEqual(['nested', 'repo-root']);
});

test('prefers a top-level skill when a nested mirror has the same slug in the same repo', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);
  makeTopLevelSkill(projectsRoot, 'vssh', 'vssh');
  makeNestedSkill(projectsRoot, 'vssh', 'vssh', 'vssh');

  const config: Config = {
    version: 1,
    projectsRoots: [projectsRoot],
    harnesses: { custom: [] },
    aliases: {},
  };

  const skills = discoverSkills(config);
  expect(skills).toHaveLength(1);
  expect(skills[0]?.sourceType).toBe('repo-root');
});
