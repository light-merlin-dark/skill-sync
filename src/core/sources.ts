import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Config, DiscoveredSkill } from './types';
import { listImmediateDirectories, parseSkillFrontmatterName, slugify } from './utils';

export function discoverSkills(config: Config): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];

  for (const projectsRoot of config.projectsRoots) {
    for (const repoPath of listImmediateDirectories(projectsRoot)) {
      const topLevelSkill = join(repoPath, 'SKILL.md');
      if (existsSync(topLevelSkill)) {
        discovered.push(buildDiscoveredSkill(projectsRoot, repoPath, repoPath, topLevelSkill, 'repo-root'));
      }

      const nestedSkillsRoot = join(repoPath, 'skills');
      for (const nestedSkillDir of listImmediateDirectories(nestedSkillsRoot)) {
        const nestedSkillFile = join(nestedSkillDir, 'SKILL.md');
        if (!existsSync(nestedSkillFile)) {
          continue;
        }
        discovered.push(buildDiscoveredSkill(projectsRoot, repoPath, nestedSkillDir, nestedSkillFile, 'nested'));
      }
    }
  }

  const deduped = new Map<string, DiscoveredSkill>();
  for (const skill of discovered) {
    const key = `${skill.repoPath}::${skill.canonicalSlug}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, skill);
      continue;
    }
    if (existing.sourceType === 'nested' && skill.sourceType === 'repo-root') {
      deduped.set(key, skill);
    }
  }

  return [...deduped.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

function buildDiscoveredSkill(
  projectsRoot: string,
  repoPath: string,
  sourcePath: string,
  skillFilePath: string,
  sourceType: 'repo-root' | 'nested',
): DiscoveredSkill {
  const metadataName = parseSkillFrontmatterName(skillFilePath);
  const fallbackName = sourceType === 'repo-root' ? basename(repoPath) : basename(sourcePath);
  const canonicalSlug = slugify(metadataName || fallbackName);
  const sourceKey = resolve(sourcePath);
  return {
    sourceKey,
    sourcePath: resolve(sourcePath),
    skillFilePath: resolve(skillFilePath),
    repoPath: resolve(repoPath),
    projectsRoot: resolve(projectsRoot),
    sourceType,
    metadataName,
    canonicalSlug,
  };
}

export function describeSkill(skill: DiscoveredSkill): string {
  const repoRelative = relative(skill.projectsRoot, skill.sourcePath) || basename(skill.sourcePath);
  return `${skill.canonicalSlug} <= ${repoRelative}`;
}
