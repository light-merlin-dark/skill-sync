import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Config, DiscoveredSkill, SourceDiagnostic, SourceDiagnostics } from './types';
import { hashContent, listImmediateDirectories, parseSkillFrontmatterName, slugify } from './utils';

export function discoverSkills(config: Config): DiscoveredSkill[] {
  return discoverSkillSet(config).skills;
}

export function discoverSkillSet(config: Config): { skills: DiscoveredSkill[]; sourceDiagnostics: SourceDiagnostics } {
  const discovered: DiscoveredSkill[] = [];
  const discovery = getDiscoveryConfig(config);

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

  const filtered = discovered.filter((skill) => !isIgnoredSource(skill.sourcePath, discovery.ignorePathPrefixes));
  const deduped = new Map<string, DiscoveredSkill>();
  for (const skill of filtered) {
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

  const { skills, sourceDiagnostics } = resolveGlobalDuplicates([...deduped.values()], discovery.preferPathPrefixes);
  return {
    skills: skills.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
    sourceDiagnostics,
  };
}

function buildDiscoveredSkill(
  projectsRoot: string,
  repoPath: string,
  sourcePath: string,
  skillFilePath: string,
  sourceType: 'repo-root' | 'nested',
): DiscoveredSkill {
  const metadataName = parseSkillFrontmatterName(skillFilePath);
  const contentHash = hashContent(readFileSync(skillFilePath, 'utf8'));
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
    contentHash,
  };
}

export function describeSkill(skill: DiscoveredSkill): string {
  const repoRelative = relative(skill.projectsRoot, skill.sourcePath) || basename(skill.sourcePath);
  return `${skill.canonicalSlug} <= ${repoRelative}`;
}

function isIgnoredSource(sourcePath: string, ignorePrefixes: string[]): boolean {
  return ignorePrefixes.some((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`));
}

function resolveGlobalDuplicates(
  skills: DiscoveredSkill[],
  preferPrefixes: string[],
): { skills: DiscoveredSkill[]; sourceDiagnostics: SourceDiagnostics } {
  const grouped = new Map<string, DiscoveredSkill[]>();
  for (const skill of skills) {
    const group = grouped.get(skill.canonicalSlug) || [];
    group.push(skill);
    grouped.set(skill.canonicalSlug, group);
  }

  const resolved: DiscoveredSkill[] = [];
  const warnings: SourceDiagnostic[] = [];
  const errors: SourceDiagnostic[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      resolved.push(group[0]!);
      continue;
    }
    const distinctHashes = new Set(group.map((skill) => skill.contentHash));
    if (distinctHashes.size !== 1) {
      resolved.push(...group);
      errors.push({
        slug: group[0]!.canonicalSlug,
        severity: 'error',
        resolution: 'unresolved',
        sourcePaths: group.map((skill) => skill.sourcePath).sort(),
      });
      continue;
    }
    const sorted = [...group].sort((a, b) => compareDiscoveredSkills(a, b, preferPrefixes));
    resolved.push(sorted[0]!);
    warnings.push({
      slug: group[0]!.canonicalSlug,
      severity: 'warning',
      resolution: 'resolved-by-preference',
      chosenSourcePath: sorted[0]!.sourcePath,
      sourcePaths: group.map((skill) => skill.sourcePath).sort(),
    });
  }
  return {
    skills: resolved,
    sourceDiagnostics: {
      warnings: warnings.sort(compareDiagnostics),
      errors: errors.sort(compareDiagnostics),
    },
  };
}

function getDiscoveryConfig(config: Config): Config['discovery'] {
  return {
    ignorePathPrefixes: config.discovery?.ignorePathPrefixes ?? [],
    preferPathPrefixes: config.discovery?.preferPathPrefixes ?? [],
  };
}

function compareDiscoveredSkills(a: DiscoveredSkill, b: DiscoveredSkill, preferPrefixes: string[]): number {
  const rankA = getPreferenceRank(a.sourcePath, preferPrefixes);
  const rankB = getPreferenceRank(b.sourcePath, preferPrefixes);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a.sourcePath.localeCompare(b.sourcePath);
}

function getPreferenceRank(sourcePath: string, preferPrefixes: string[]): number {
  const matchIndex = preferPrefixes.findIndex((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`));
  return matchIndex === -1 ? Number.MAX_SAFE_INTEGER : matchIndex;
}

function compareDiagnostics(a: SourceDiagnostic, b: SourceDiagnostic): number {
  return a.slug.localeCompare(b.slug) || a.sourcePaths.join('\n').localeCompare(b.sourcePaths.join('\n'));
}
