import { afterEach, expect, test } from 'bun:test';
import { discoverSkillSet, discoverSkills, describeSkill } from '../../src/core/sources';
import type { Config, HarnessDefinition } from '../../src/core/types';
import { cleanup, linkPath, makeFakeProjectsRoot, makeHarnessRoot, makeNestedSkill, makeTopLevelSkill, writeText } from '../support';

function makeConfig(projectsRoot: string): Config {
  return {
    version: 1,
    projectsRoots: [projectsRoot],
    discovery: {
      ignorePathPrefixes: [],
      preferPathPrefixes: [],
      includeHarnessRoots: true,
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

test('discovers harness-installed skills and prefers project-root sources over harness fallbacks', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  makeTopLevelSkill(projectsRoot, 'skill-sync', 'skill-sync');
  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  makeTopLevelSkill(codexRoot, 'vendor-only', 'vendor-only');
  makeTopLevelSkill(codexRoot, 'skill-sync-shadow', 'skill-sync');
  writeText(`${codexRoot}/skill-sync-shadow/SKILL.md`, '---\nname: skill-sync\ndescription: stale harness copy\n---\n\n# Stale Copy\n');

  const harnesses: HarnessDefinition[] = [
    {
      id: 'codex',
      label: 'Codex',
      rootPath: codexRoot,
      kind: 'built-in',
      detected: true,
      enabled: true,
    },
  ];

  const { skills, sourceDiagnostics } = discoverSkillSet(makeConfig(projectsRoot), harnesses);
  expect(skills.map((skill) => skill.canonicalSlug)).toContain('vendor-only');
  expect(skills.find((skill) => skill.canonicalSlug === 'skill-sync')?.sourcePath).toContain('/projects/skill-sync');
  expect(sourceDiagnostics.warnings.some((warning) => warning.slug === 'skill-sync')).toBe(true);
});

test('does not warn when a harness install points back to the exact same project source path', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const paperCreationPath = makeNestedSkill(projectsRoot, 'rbeckner', 'paper-creation', 'rbeckner-paper-creation');
  const codexRoot = makeHarnessRoot(homeDir, '.codex/skills');
  linkPath(`${codexRoot}/rbeckner-paper-creation`, paperCreationPath);

  const harnesses: HarnessDefinition[] = [
    {
      id: 'codex',
      label: 'Codex',
      rootPath: codexRoot,
      kind: 'built-in',
      detected: true,
      enabled: true,
    },
  ];

  const { skills, sourceDiagnostics } = discoverSkillSet(makeConfig(projectsRoot), harnesses);
  expect(skills.filter((skill) => skill.canonicalSlug === 'rbeckner-paper-creation')).toHaveLength(1);
  expect(sourceDiagnostics.warnings.some((warning) => warning.slug === 'rbeckner-paper-creation')).toBe(false);
});

test('preserves the owning harness and local-only scope for mirrored harness-native skills', () => {
  const { homeDir, projectsRoot } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);

  const agentsRoot = makeHarnessRoot(homeDir, '.agents/skills');
  const hermesRoot = makeHarnessRoot(homeDir, '.hermes/skills');
  const dogfoodPath = makeTopLevelSkill(hermesRoot, 'dogfood', 'dogfood');
  writeText(
    `${dogfoodPath}/SKILL.md`,
    '---\nname: dogfood\ndescription: Hermes-only QA skill\nskill-sync-scope: local-only\n---\n\n# Dogfood\n',
  );
  linkPath(`${agentsRoot}/dogfood`, dogfoodPath);

  const harnesses: HarnessDefinition[] = [
    {
      id: 'agents',
      label: 'Agents',
      rootPath: agentsRoot,
      kind: 'built-in',
      detected: true,
      enabled: true,
    },
    {
      id: 'hermes',
      label: 'Hermes',
      rootPath: hermesRoot,
      kind: 'built-in',
      detected: true,
      enabled: true,
    },
  ];

  const { skills } = discoverSkillSet(makeConfig(projectsRoot), harnesses);
  const dogfood = skills.find((skill) => skill.canonicalSlug === 'dogfood');
  expect(dogfood?.harnessId).toBe('hermes');
  expect(dogfood?.installHarnessIds).toEqual(['hermes']);
  expect(describeSkill(dogfood!)).toContain('[local-only: hermes]');
});
