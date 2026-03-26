import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSyncPlan, resolveInstallName } from '../../src/core/sync';
import type { Config, DiscoveredSkill, HarnessDefinition, State } from '../../src/core/types';
import { cleanup, makeFakeProjectsRoot, writeText } from '../support';

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    cleanup(tempPaths.pop()!);
  }
});

test('uses alias overrides and reports collisions', () => {
  const { homeDir } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);
  const harness: HarnessDefinition = {
    id: 'codex',
    label: 'Codex',
    rootPath: `${homeDir}/.codex/skills`,
    kind: 'built-in',
    detected: true,
    enabled: true,
  };
  const skillA: DiscoveredSkill = {
    sourceKey: '/tmp/a',
    sourcePath: '/tmp/a',
    skillFilePath: '/tmp/a/SKILL.md',
    repoPath: '/tmp/a',
    projectsRoot: '/tmp',
    sourceType: 'repo-root',
    metadataName: 'Alpha',
    canonicalSlug: 'alpha',
  };
  const skillB: DiscoveredSkill = {
    sourceKey: '/tmp/b',
    sourcePath: '/tmp/b',
    skillFilePath: '/tmp/b/SKILL.md',
    repoPath: '/tmp/b',
    projectsRoot: '/tmp',
    sourceType: 'repo-root',
    metadataName: 'Beta',
    canonicalSlug: 'beta',
  };
  const config: Config = {
    version: 1,
    projectsRoots: ['/tmp'],
    discovery: {
      ignorePathPrefixes: [],
      preferPathPrefixes: [],
      includeHarnessRoots: true,
    },
    harnesses: { custom: [] },
    aliases: {
      '/tmp/a': { harnesses: { codex: 'shared' } },
      '/tmp/b': { harnesses: { codex: 'shared' } },
    },
  };
  const state: State = { version: 1, managedEntries: {} };

  expect(resolveInstallName(skillA, 'codex', config)).toBe('shared');
  const plan = buildSyncPlan([skillA, skillB], [harness], config, state);
  expect(plan.conflicts).toBe(1);
});

test('repairs an unmanaged directory with matching SKILL.md into a symlinked install', () => {
  const { homeDir } = makeFakeProjectsRoot();
  tempPaths.push(homeDir);
  const harnessRoot = `${homeDir}/.hermes/skills`;
  const destination = join(harnessRoot, 'prod');
  mkdirSync(destination, { recursive: true });
  writeText(join(destination, 'SKILL.md'), '---\nname: prod\ndescription: Test\n---\n\n# Prod\n');

  const harness: HarnessDefinition = {
    id: 'hermes',
    label: 'Hermes',
    rootPath: harnessRoot,
    kind: 'built-in',
    detected: true,
    enabled: true,
  };
  const skill: DiscoveredSkill = {
    sourceKey: `${homeDir}/prod-server`,
    sourcePath: `${homeDir}/prod-server`,
    skillFilePath: join(destination, 'SKILL.md'),
    repoPath: `${homeDir}/prod-server`,
    projectsRoot: homeDir,
    sourceType: 'repo-root',
    metadataName: 'prod',
    canonicalSlug: 'prod',
    contentHash: 'hash',
  };
  const config: Config = {
    version: 1,
    projectsRoots: [homeDir],
    discovery: {
      ignorePathPrefixes: [],
      preferPathPrefixes: [],
      includeHarnessRoots: true,
    },
    harnesses: { custom: [] },
    aliases: {},
  };
  const state: State = { version: 1, managedEntries: {} };
  const plan = buildSyncPlan([skill], [harness], config, state);
  expect(plan.conflicts).toBe(0);
  expect(plan.changes).toBe(1);
  expect(plan.harnesses[0]?.entries[0]?.action).toBe('repair');
});
