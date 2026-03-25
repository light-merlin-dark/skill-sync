import { afterEach, expect, test } from 'bun:test';
import { buildSyncPlan, resolveInstallName } from '../../src/core/sync';
import type { Config, DiscoveredSkill, HarnessDefinition, State } from '../../src/core/types';
import { cleanup, makeFakeProjectsRoot } from '../support';

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
