import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Config, DiscoveredSkill, HarnessDefinition, SourceDiagnostic, SourceDiagnostics } from './types';
import { hashContent, inspectEntry, listImmediateDirectories, parseSkillFrontmatterContent, pathOwnsEntry, slugify } from './utils';

export function discoverSkills(config: Config): DiscoveredSkill[] {
  return discoverSkillSet(config).skills;
}

export function discoverSkillSet(config: Config, harnesses: HarnessDefinition[] = []): { skills: DiscoveredSkill[]; sourceDiagnostics: SourceDiagnostics } {
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

  if (discovery.includeHarnessRoots) {
    discovered.push(...discoverHarnessSkills(harnesses));
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
    if (compareEquivalentSourcePreference(skill, existing) < 0) {
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
  sourceType: 'repo-root' | 'nested' | 'harness-root',
  harnessId?: string,
): DiscoveredSkill {
  const normalizedProjectsRoot = normalizeExistingPath(projectsRoot);
  const normalizedRepoPath = normalizeExistingPath(repoPath);
  const normalizedSourcePath = normalizeExistingPath(sourcePath);
  const normalizedSkillFilePath = normalizeExistingPath(skillFilePath);
  const skillContent = readFileSync(normalizedSkillFilePath, 'utf8');
  const frontmatter = parseSkillFrontmatterContent(skillContent);
  const metadataName = frontmatter.name;
  const contentHash = hashContent(skillContent);
  const fallbackName = sourceType === 'repo-root' ? basename(repoPath) : basename(sourcePath);
  const canonicalSlug = slugify(metadataName || fallbackName);
  const sourceKey = normalizedSourcePath;
  return {
    sourceKey,
    sourcePath: normalizedSourcePath,
    skillFilePath: normalizedSkillFilePath,
    repoPath: normalizedRepoPath,
    projectsRoot: normalizedProjectsRoot,
    sourceType,
    harnessId,
    metadataName,
    frontmatterIssues: frontmatter.issues,
    installHarnessIds: resolveInstallHarnessIds(sourceType, harnessId, frontmatter),
    canonicalSlug,
    contentHash,
  };
}

export function describeSkill(skill: DiscoveredSkill): string {
  const scopeSuffix = describeInstallScope(skill);
  if (skill.sourceType === 'harness-root' && skill.harnessId) {
    return `${skill.canonicalSlug} <= ${skill.harnessId}:${skill.sourcePath}${scopeSuffix}`;
  }
  const repoRelative = relative(skill.projectsRoot, skill.sourcePath) || basename(skill.sourcePath);
  return `${skill.canonicalSlug} <= ${repoRelative}${scopeSuffix}`;
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
    const uniqueGroup = dedupeEquivalentSources(group);
    const projectBacked = uniqueGroup.filter((skill) => skill.sourceType !== 'harness-root');
    const preferredGroup = projectBacked.length > 0 ? projectBacked : uniqueGroup;
    if (preferredGroup.length === 1) {
      resolved.push(preferredGroup[0]!);
      if (uniqueGroup.length > preferredGroup.length) {
        warnings.push({
          kind: 'duplicate-slug',
          slug: uniqueGroup[0]!.canonicalSlug,
          severity: 'warning',
          resolution: 'resolved-by-preference',
          chosenSourcePath: preferredGroup[0]!.sourcePath,
          sourcePaths: uniqueGroup.map((skill) => skill.sourcePath).sort(),
        });
      }
      continue;
    }
    const distinctHashes = new Set(preferredGroup.map((skill) => skill.contentHash));
    if (distinctHashes.size !== 1) {
      resolved.push(...preferredGroup);
      errors.push({
        kind: 'duplicate-slug',
        slug: preferredGroup[0]!.canonicalSlug,
        severity: 'error',
        resolution: 'unresolved',
        sourcePaths: preferredGroup.map((skill) => skill.sourcePath).sort(),
      });
      continue;
    }
    const sorted = [...preferredGroup].sort((a, b) => compareDiscoveredSkills(a, b, preferPrefixes));
    resolved.push(sorted[0]!);
    warnings.push({
      kind: 'duplicate-slug',
      slug: preferredGroup[0]!.canonicalSlug,
      severity: 'warning',
      resolution: 'resolved-by-preference',
      chosenSourcePath: sorted[0]!.sourcePath,
      sourcePaths: uniqueGroup.map((skill) => skill.sourcePath).sort(),
    });
  }
  for (const skill of resolved) {
    for (const issue of skill.frontmatterIssues) {
      warnings.push({
        kind: 'invalid-frontmatter',
        slug: skill.canonicalSlug,
        severity: 'warning',
        resolution: 'fix-skill-frontmatter',
        sourcePaths: [skill.sourcePath],
        message: issue,
      });
    }
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
    includeHarnessRoots: config.discovery?.includeHarnessRoots !== false,
  };
}

function compareDiscoveredSkills(a: DiscoveredSkill, b: DiscoveredSkill, preferPrefixes: string[]): number {
  const typePriority = compareSourceTypePriority(a, b);
  if (typePriority !== 0) {
    return typePriority;
  }
  const rankA = getPreferenceRank(a.sourcePath, preferPrefixes);
  const rankB = getPreferenceRank(b.sourcePath, preferPrefixes);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a.sourcePath.localeCompare(b.sourcePath);
}

function compareSourceTypePriority(a: DiscoveredSkill, b: DiscoveredSkill): number {
  return getSourceTypePriority(a.sourceType) - getSourceTypePriority(b.sourceType);
}

function getSourceTypePriority(sourceType: DiscoveredSkill['sourceType']): number {
  if (sourceType === 'repo-root') {
    return 0;
  }
  if (sourceType === 'nested') {
    return 1;
  }
  return 2;
}

function getPreferenceRank(sourcePath: string, preferPrefixes: string[]): number {
  const matchIndex = preferPrefixes.findIndex((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`));
  return matchIndex === -1 ? Number.MAX_SAFE_INTEGER : matchIndex;
}

function compareDiagnostics(a: SourceDiagnostic, b: SourceDiagnostic): number {
  return a.slug.localeCompare(b.slug) || a.sourcePaths.join('\n').localeCompare(b.sourcePaths.join('\n'));
}

function discoverHarnessSkills(harnesses: HarnessDefinition[]): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  for (const harness of harnesses) {
    if (!harness.detected) {
      continue;
    }
    let children: string[] = [];
    try {
      children = readdirSync(harness.rootPath);
    } catch {
      continue;
    }
    for (const child of children) {
      if (shouldIgnoreHarnessSkillName(child)) {
        continue;
      }
      const entryPath = join(harness.rootPath, child);
      const resolved = resolveHarnessSkillSource(entryPath);
      if (!resolved) {
        continue;
      }
      const ownerHarnessId = resolveSourceHarnessId(resolved.sourcePath, harnesses) || harness.id;
      const ownerHarnessRoot = harnesses.find((candidate) => candidate.id === ownerHarnessId)?.rootPath || harness.rootPath;
      discovered.push(buildDiscoveredSkill(ownerHarnessRoot, resolved.sourcePath, resolved.sourcePath, resolved.skillFilePath, 'harness-root', ownerHarnessId));
    }
  }
  return discovered;
}

function resolveHarnessSkillSource(entryPath: string): { sourcePath: string; skillFilePath: string } | null {
  const inspection = inspectEntry(entryPath);
  if (!inspection.exists) {
    return null;
  }
  if (inspection.type === 'directory') {
    const skillFilePath = join(entryPath, 'SKILL.md');
    if (!existsSync(skillFilePath)) {
      return null;
    }
    return {
      sourcePath: resolve(entryPath),
      skillFilePath: resolve(skillFilePath),
    };
  }
  if (inspection.type === 'symlink' && inspection.resolvedTarget) {
    const skillFilePath = join(inspection.resolvedTarget, 'SKILL.md');
    if (!existsSync(skillFilePath)) {
      return null;
    }
    return {
      sourcePath: resolve(inspection.resolvedTarget),
      skillFilePath: resolve(skillFilePath),
    };
  }
  return null;
}

function shouldIgnoreHarnessSkillName(name: string): boolean {
  return name.startsWith('.') || name.includes('.backup-');
}

function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function dedupeEquivalentSources(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const unique = new Map<string, DiscoveredSkill>();
  for (const skill of skills) {
    const key = `${skill.canonicalSlug}::${skill.sourcePath}`;
    const existing = unique.get(key);
    if (!existing || compareEquivalentSourcePreference(skill, existing) < 0) {
      unique.set(key, skill);
    }
  }
  return [...unique.values()];
}

function resolveInstallHarnessIds(
  sourceType: DiscoveredSkill['sourceType'],
  harnessId: string | undefined,
  frontmatter: ReturnType<typeof parseSkillFrontmatterContent>,
): string[] | undefined {
  if (frontmatter.skillSyncInstallOn && frontmatter.skillSyncInstallOn.length > 0) {
    return frontmatter.skillSyncInstallOn;
  }
  if (sourceType === 'harness-root' && harnessId && frontmatter.skillSyncScope === 'local-only') {
    return [harnessId];
  }
  return undefined;
}

function describeInstallScope(skill: DiscoveredSkill): string {
  if (!skill.installHarnessIds || skill.installHarnessIds.length === 0) {
    return '';
  }
  if (
    skill.sourceType === 'harness-root' &&
    skill.harnessId &&
    skill.installHarnessIds.length === 1 &&
    skill.installHarnessIds[0] === skill.harnessId
  ) {
    return ` [local-only: ${skill.harnessId}]`;
  }
  return ` [install-on: ${skill.installHarnessIds.join(', ')}]`;
}

function resolveSourceHarnessId(sourcePath: string, harnesses: HarnessDefinition[]): string | undefined {
  return harnesses
    .filter((harness) => pathOwnsEntry(harness.rootPath, sourcePath))
    .sort((a, b) => b.rootPath.length - a.rootPath.length || a.id.localeCompare(b.id))[0]?.id;
}

function compareEquivalentSourcePreference(a: DiscoveredSkill, b: DiscoveredSkill): number {
  const sourceTypePriority = compareSourceTypePriority(a, b);
  if (sourceTypePriority !== 0) {
    return sourceTypePriority;
  }
  const ownerPriorityA = a.harnessId ? 0 : 1;
  const ownerPriorityB = b.harnessId ? 0 : 1;
  if (ownerPriorityA !== ownerPriorityB) {
    return ownerPriorityA - ownerPriorityB;
  }
  const scopePriorityA = a.installHarnessIds ? 0 : 1;
  const scopePriorityB = b.installHarnessIds ? 0 : 1;
  if (scopePriorityA !== scopePriorityB) {
    return scopePriorityA - scopePriorityB;
  }
  return a.sourcePath.localeCompare(b.sourcePath);
}
