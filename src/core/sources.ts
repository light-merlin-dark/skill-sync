import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
	BrokenNestedSkillLink,
	BrokenNestedSkillLinkRepairReport,
	Config,
	DiscoveredSkill,
	HarnessDefinition,
	SourceDiagnostic,
	SourceDiagnostics,
} from "./types";
import {
	hashContent,
	inspectEntry,
	listImmediateDirectories,
	parseSkillFrontmatterContent,
	pathOwnsEntry,
	removePath,
	slugify,
} from "./utils";

const POLLUTION_INDICATORS = [
	"node_modules",
	".worktrees",
	".refactor-backups",
];
const FANOUT_WARNING_THRESHOLD = 8;

function detectPollutionIndicators(repoPath: string): string[] {
	const indicators: string[] = [];
	for (const name of POLLUTION_INDICATORS) {
		if (existsSync(join(repoPath, name))) {
			indicators.push(name);
		}
	}
	return indicators;
}

export function discoverSkillSet(
	config: Config,
	harnesses: HarnessDefinition[] = [],
): { skills: DiscoveredSkill[]; sourceDiagnostics: SourceDiagnostics } {
	const discovered: DiscoveredSkill[] = [];
	const pollutionWarnings: SourceDiagnostic[] = [];
	const pollutionFrontmatterWarnings: SourceDiagnostic[] = [];
	const sourceErrors: SourceDiagnostic[] = [];
	const discovery = getDiscoveryConfig(config);

	for (const projectsRoot of config.projectsRoots) {
		for (const repoPath of listProjectRepoCandidates(projectsRoot)) {
			const topLevelSkill = join(repoPath, "SKILL.md");
			if (existsSync(topLevelSkill)) {
				const content = readFileSync(topLevelSkill, "utf8");
				const frontmatter = parseSkillFrontmatterContent(content);
				const fallbackName = basename(repoPath);
				const slug = slugify(frontmatter.name || fallbackName);
				const pollution = detectPollutionIndicators(repoPath);
				const pollutionDetail =
					pollution.length > 0 ? ` contains ${pollution.join(", ")}` : "";
				pollutionWarnings.push({
					kind: "repo-root-pollution",
					slug,
					severity: "warning",
					resolution: "move-to-skills-dir",
					sourcePaths: [topLevelSkill],
					message: `repo-root skill at ${repoPath}${pollutionDetail}. Symlinking an entire project directory causes CLIs to traverse node_modules and other unrelated files. Move SKILL.md into a skills/${slug}/ subdirectory so skill-sync can create a scoped symlink.`,
				});
				for (const issue of frontmatter.issues) {
					pollutionFrontmatterWarnings.push({
						kind: "invalid-frontmatter",
						slug,
						severity: "warning",
						resolution: "fix-skill-frontmatter",
						sourcePaths: [repoPath],
						message: `repo-root SKILL.md frontmatter issue: ${issue}`,
					});
				}
			}

			const nestedSkillsRoot = join(repoPath, "skills");
			for (const nestedSkillDir of listImmediateDirectories(nestedSkillsRoot)) {
				const nestedSkillFile = join(nestedSkillDir, "SKILL.md");
				if (!existsSync(nestedSkillFile)) {
					const brokenSkillLink = inspectBrokenNestedSkillFileLink(
						repoPath,
						nestedSkillDir,
						nestedSkillFile,
					);
					if (brokenSkillLink) {
						sourceErrors.push({
							kind: "broken-skill-link",
							slug: brokenSkillLink.slug,
							severity: "error",
							resolution: "restore-skill-file",
							sourcePaths: [
								brokenSkillLink.skillFilePath,
								brokenSkillLink.resolvedTargetPath,
								...(brokenSkillLink.backupPath
									? [brokenSkillLink.backupPath]
									: []),
							],
							message: brokenSkillLink.backupPath
								? `nested skill file is a broken symlink (${brokenSkillLink.linkTarget}) and the target no longer exists. Run "skill-sync repair-sources" to restore SKILL.md from ${brokenSkillLink.backupPath}.`
								: `nested skill file is a broken symlink (${brokenSkillLink.linkTarget}) and the target no longer exists. No pre-migration backup was found at ${brokenSkillLink.resolvedTargetPath}.pre-migration-backup.`,
						});
					}
					continue;
				}
				discovered.push(
					buildDiscoveredSkill(
						projectsRoot,
						repoPath,
						nestedSkillDir,
						nestedSkillFile,
						"nested",
					),
				);
			}
		}
	}

	if (discovery.includeHarnessRoots) {
		discovered.push(...discoverHarnessSkills(harnesses));
	}

	const filtered = discovered.filter(
		(skill) => !isIgnoredSource(skill.sourcePath, discovery.ignorePathPrefixes),
	);
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

	const { skills, sourceDiagnostics } = resolveGlobalDuplicates(
		[...deduped.values()],
		discovery.preferPathPrefixes,
	);
	return {
		skills: skills.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
		sourceDiagnostics: {
			warnings: [
				...pollutionWarnings,
				...pollutionFrontmatterWarnings,
				...sourceDiagnostics.warnings,
			].sort(compareDiagnostics),
			errors: [...sourceErrors, ...sourceDiagnostics.errors].sort(
				compareDiagnostics,
			),
		},
	};
}

function findBrokenNestedSkillLinks(config: Config): BrokenNestedSkillLink[] {
	const brokenLinks: BrokenNestedSkillLink[] = [];
	for (const projectsRoot of config.projectsRoots) {
		for (const repoPath of listProjectRepoCandidates(projectsRoot)) {
			const nestedSkillsRoot = join(repoPath, "skills");
			for (const nestedSkillDir of listImmediateDirectories(nestedSkillsRoot)) {
				const nestedSkillFile = join(nestedSkillDir, "SKILL.md");
				const brokenSkillLink = inspectBrokenNestedSkillFileLink(
					repoPath,
					nestedSkillDir,
					nestedSkillFile,
				);
				if (!brokenSkillLink) {
					continue;
				}
				brokenLinks.push(brokenSkillLink);
			}
		}
	}
	return brokenLinks.sort((a, b) =>
		a.skillFilePath.localeCompare(b.skillFilePath),
	);
}

const NESTED_REPO_IGNORED_NAMES = new Set([
	"node_modules",
	".git",
	".worktrees",
	".refactor-backups",
]);

function listProjectRepoCandidates(projectsRoot: string): string[] {
	const candidates = new Set<string>();
	const rootRepos = listImmediateDirectories(projectsRoot);
	for (const repoPath of rootRepos) {
		candidates.add(repoPath);
		for (const nestedRepoPath of listNestedRepoCandidates(repoPath)) {
			candidates.add(nestedRepoPath);
		}
	}
	return [...candidates].sort((a, b) => a.localeCompare(b));
}

function listNestedRepoCandidates(repoPath: string): string[] {
	const candidates: string[] = [];
	for (const childPath of listImmediateDirectories(repoPath)) {
		const childName = basename(childPath);
		if (shouldIgnoreNestedRepo(childName)) {
			continue;
		}
		if (!looksLikeSkillRepo(childPath)) {
			continue;
		}
		candidates.push(childPath);
	}
	return candidates;
}

function shouldIgnoreNestedRepo(name: string): boolean {
	return name.startsWith(".") || NESTED_REPO_IGNORED_NAMES.has(name);
}

function looksLikeSkillRepo(path: string): boolean {
	return existsSync(join(path, "SKILL.md")) || existsSync(join(path, "skills"));
}

export function repairBrokenNestedSkillLinks(
	config: Config,
	dryRun: boolean,
): BrokenNestedSkillLinkRepairReport {
	const brokenLinks = findBrokenNestedSkillLinks(config);
	const repairedLinks: BrokenNestedSkillLink[] = [];
	const skipped: BrokenNestedSkillLinkRepairReport["skipped"] = [];

	for (const brokenLink of brokenLinks) {
		if (!brokenLink.backupPath || !existsSync(brokenLink.backupPath)) {
			skipped.push({
				link: brokenLink,
				reason: `missing pre-migration backup at ${brokenLink.resolvedTargetPath}.pre-migration-backup`,
			});
			continue;
		}

		if (!dryRun) {
			const backupContent = readFileSync(brokenLink.backupPath, "utf8");
			removePath(brokenLink.skillFilePath);
			writeFileSync(brokenLink.skillFilePath, backupContent, "utf8");
		}
		repairedLinks.push(brokenLink);
	}

	return {
		dryRun,
		brokenLinks,
		repairedLinks,
		skipped,
	};
}

function buildDiscoveredSkill(
	projectsRoot: string,
	repoPath: string,
	sourcePath: string,
	skillFilePath: string,
	sourceType: "repo-root" | "nested" | "harness-root",
	harnessId?: string,
): DiscoveredSkill {
	const normalizedProjectsRoot = normalizeExistingPath(projectsRoot);
	const normalizedRepoPath = normalizeExistingPath(repoPath);
	const normalizedSourcePath = normalizeExistingPath(sourcePath);
	const normalizedSkillFilePath = normalizeExistingPath(skillFilePath);
	const skillContent = readFileSync(normalizedSkillFilePath, "utf8");
	const frontmatter = parseSkillFrontmatterContent(skillContent);
	const metadataName = frontmatter.name;
	const contentHash = hashContent(skillContent);
	const fallbackName =
		sourceType === "repo-root" ? basename(repoPath) : basename(sourcePath);
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
		installHarnessIds: resolveInstallHarnessIds(
			sourceType,
			harnessId,
			frontmatter,
		),
		canonicalSlug,
		contentHash,
	};
}

export function describeSkill(skill: DiscoveredSkill): string {
	const scopeSuffix = describeInstallScope(skill);
	if (skill.sourceType === "harness-root" && skill.harnessId) {
		return `${skill.canonicalSlug} <= ${skill.harnessId}:${skill.sourcePath}${scopeSuffix}`;
	}
	const repoRelative =
		relative(skill.projectsRoot, skill.sourcePath) ||
		basename(skill.sourcePath);
	return `${skill.canonicalSlug} <= ${repoRelative}${scopeSuffix}`;
}

function isIgnoredSource(
	sourcePath: string,
	ignorePrefixes: string[],
): boolean {
	return ignorePrefixes.some(
		(prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`),
	);
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
		const projectBacked = uniqueGroup.filter(
			(skill) => skill.sourceType !== "harness-root",
		);
		const preferredGroup =
			projectBacked.length > 0 ? projectBacked : uniqueGroup;
		const fanoutGroup = projectBacked;
		const preferredSkill = preferredGroup[0];
		const uniqueSkill = uniqueGroup[0];
		if (preferredGroup.length === 1) {
			if (!preferredSkill || !uniqueSkill) {
				continue;
			}
			resolved.push(preferredSkill);
			if (uniqueGroup.length > preferredGroup.length) {
				warnings.push({
					kind: "duplicate-slug",
					slug: uniqueSkill.canonicalSlug,
					severity: "warning",
					resolution: "resolved-by-preference",
					chosenSourcePath: preferredSkill.sourcePath,
					sourcePaths: uniqueGroup.map((skill) => skill.sourcePath).sort(),
				});
			}
			if (fanoutGroup.length >= FANOUT_WARNING_THRESHOLD) {
				warnings.push({
					kind: "fanout-high",
					slug: uniqueSkill.canonicalSlug,
					severity: "warning",
					resolution: "reduce-fanout",
					chosenSourcePath: preferredSkill.sourcePath,
					sourcePaths: fanoutGroup.map((skill) => skill.sourcePath).sort(),
					message: `slug is mirrored across ${fanoutGroup.length} paths; high fanout can destabilize harness skill indexing and cache invalidation`,
				});
			}
			continue;
		}
		const distinctHashes = new Set(
			preferredGroup.map((skill) => skill.contentHash),
		);
		if (distinctHashes.size !== 1) {
			if (!preferredSkill) {
				continue;
			}
			resolved.push(...preferredGroup);
			errors.push({
				kind: "duplicate-slug",
				slug: preferredSkill.canonicalSlug,
				severity: "error",
				resolution: "unresolved",
				sourcePaths: preferredGroup.map((skill) => skill.sourcePath).sort(),
			});
			if (fanoutGroup.length >= FANOUT_WARNING_THRESHOLD) {
				warnings.push({
					kind: "fanout-high",
					slug: preferredSkill.canonicalSlug,
					severity: "warning",
					resolution: "reduce-fanout",
					sourcePaths: fanoutGroup.map((skill) => skill.sourcePath).sort(),
					message: `slug is mirrored across ${fanoutGroup.length} paths; high fanout can destabilize harness skill indexing and cache invalidation`,
				});
			}
			continue;
		}
		const sorted = [...preferredGroup].sort((a, b) =>
			compareDiscoveredSkills(a, b, preferPrefixes),
		);
		const preferredSorted = sorted[0];
		if (!preferredSkill || !preferredSorted) {
			continue;
		}
		resolved.push(preferredSorted);
		warnings.push({
			kind: "duplicate-slug",
			slug: preferredSkill.canonicalSlug,
			severity: "warning",
			resolution: "resolved-by-preference",
			chosenSourcePath: preferredSorted.sourcePath,
			sourcePaths: uniqueGroup.map((skill) => skill.sourcePath).sort(),
		});
		if (fanoutGroup.length >= FANOUT_WARNING_THRESHOLD) {
			warnings.push({
				kind: "fanout-high",
				slug: preferredSkill.canonicalSlug,
				severity: "warning",
				resolution: "reduce-fanout",
				chosenSourcePath: preferredSorted.sourcePath,
				sourcePaths: fanoutGroup.map((skill) => skill.sourcePath).sort(),
				message: `slug is mirrored across ${fanoutGroup.length} paths; high fanout can destabilize harness skill indexing and cache invalidation`,
			});
		}
	}
	for (const skill of resolved) {
		for (const issue of skill.frontmatterIssues) {
			const diagnostic: SourceDiagnostic = {
				kind: "invalid-frontmatter",
				slug: skill.canonicalSlug,
				severity: isBlockingFrontmatterIssue(issue) ? "error" : "warning",
				resolution: "fix-skill-frontmatter",
				sourcePaths: [skill.sourcePath],
				message: issue,
			};
			if (diagnostic.severity === "error") {
				errors.push(diagnostic);
			} else {
				warnings.push(diagnostic);
			}
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

function getDiscoveryConfig(config: Config): Config["discovery"] {
	return {
		ignorePathPrefixes: config.discovery?.ignorePathPrefixes ?? [],
		preferPathPrefixes: config.discovery?.preferPathPrefixes ?? [],
		includeHarnessRoots: config.discovery?.includeHarnessRoots !== false,
	};
}

function compareDiscoveredSkills(
	a: DiscoveredSkill,
	b: DiscoveredSkill,
	preferPrefixes: string[],
): number {
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

function compareSourceTypePriority(
	a: DiscoveredSkill,
	b: DiscoveredSkill,
): number {
	return (
		getSourceTypePriority(a.sourceType) - getSourceTypePriority(b.sourceType)
	);
}

function getSourceTypePriority(
	sourceType: DiscoveredSkill["sourceType"],
): number {
	if (sourceType === "repo-root") {
		return 0;
	}
	if (sourceType === "nested") {
		return 1;
	}
	return 2;
}

function getPreferenceRank(
	sourcePath: string,
	preferPrefixes: string[],
): number {
	const matchIndex = preferPrefixes.findIndex(
		(prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`),
	);
	return matchIndex === -1 ? Number.MAX_SAFE_INTEGER : matchIndex;
}

function inspectBrokenNestedSkillFileLink(
	repoPath: string,
	nestedSkillPath: string,
	skillFilePath: string,
): BrokenNestedSkillLink | null {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(skillFilePath);
	} catch {
		return null;
	}
	if (!stats.isSymbolicLink()) {
		return null;
	}

	let linkTarget: string;
	try {
		linkTarget = readlinkSync(skillFilePath);
	} catch {
		return null;
	}
	const resolvedTargetPath = resolve(dirname(skillFilePath), linkTarget);
	if (existsSync(resolvedTargetPath)) {
		return null;
	}

	const backupPathCandidate = `${resolvedTargetPath}.pre-migration-backup`;
	const backupPath = existsSync(backupPathCandidate)
		? resolve(backupPathCandidate)
		: undefined;
	return {
		slug: slugify(basename(nestedSkillPath)),
		repoPath: normalizeExistingPath(repoPath),
		nestedSkillPath: normalizeExistingPath(nestedSkillPath),
		skillFilePath: resolve(skillFilePath),
		linkTarget,
		resolvedTargetPath: resolve(resolvedTargetPath),
		backupPath,
	};
}

function compareDiagnostics(a: SourceDiagnostic, b: SourceDiagnostic): number {
	return (
		a.slug.localeCompare(b.slug) ||
		a.sourcePaths.join("\n").localeCompare(b.sourcePaths.join("\n"))
	);
}

function discoverHarnessSkills(
	harnesses: HarnessDefinition[],
): DiscoveredSkill[] {
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
			const ownerHarnessId = resolveSourceHarnessId(
				resolved.sourcePath,
				harnesses,
			);
			if (ownerHarnessId && ownerHarnessId !== harness.id) {
				// Mirror from another harness root; the owning harness will discover it.
				continue;
			}
			if (!ownerHarnessId && !isPortableHarnessRoot(harness.id)) {
				// External source mirrored into a non-portable harness root.
				// Treat as an install mirror, not a harness-native source.
				continue;
			}
			const effectiveHarnessId = ownerHarnessId || harness.id;
			const ownerHarnessRoot =
				harnesses.find((candidate) => candidate.id === effectiveHarnessId)
					?.rootPath || harness.rootPath;
			discovered.push(
				buildDiscoveredSkill(
					ownerHarnessRoot,
					resolved.sourcePath,
					resolved.sourcePath,
					resolved.skillFilePath,
					"harness-root",
					effectiveHarnessId,
				),
			);
		}
	}
	return discovered;
}

function resolveHarnessSkillSource(
	entryPath: string,
): { sourcePath: string; skillFilePath: string } | null {
	const inspection = inspectEntry(entryPath);
	if (!inspection.exists) {
		return null;
	}
	if (inspection.type === "directory") {
		return resolveSkillSourceFromPath(entryPath);
	}
	if (inspection.type === "symlink" && inspection.resolvedTarget) {
		return resolveSkillSourceFromPath(inspection.resolvedTarget, entryPath);
	}
	return null;
}

function resolveSkillSourceFromPath(
	targetPath: string,
	_linkPath?: string,
): { sourcePath: string; skillFilePath: string } | null {
	const skillFilePath = join(targetPath, "SKILL.md");
	if (!existsSync(skillFilePath)) {
		return null;
	}

	const resolvedSkillFilePath = resolveLinkedSkillFile(skillFilePath);
	if (resolvedSkillFilePath) {
		return {
			sourcePath: resolve(dirname(resolvedSkillFilePath)),
			skillFilePath: resolvedSkillFilePath,
		};
	}

	if (directoryLooksLikeProjectRoot(targetPath)) {
		const nested = resolveNestedSkillForProjectRoot(targetPath);
		if (nested) {
			return nested;
		}
	}
	return {
		sourcePath: resolve(targetPath),
		skillFilePath: resolve(skillFilePath),
	};
}

function resolveLinkedSkillFile(skillFilePath: string): string | undefined {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(skillFilePath);
	} catch {
		return undefined;
	}
	if (!stats.isSymbolicLink()) {
		return undefined;
	}
	try {
		return resolve(realpathSync(skillFilePath));
	} catch {
		return undefined;
	}
}

const PROJECT_ROOT_INDICATORS = [
	"package.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"Makefile",
	"node_modules",
	".git",
	".worktrees",
];

function directoryLooksLikeProjectRoot(dirPath: string): boolean {
	for (const indicator of PROJECT_ROOT_INDICATORS) {
		if (existsSync(join(dirPath, indicator))) {
			return true;
		}
	}
	return false;
}

function resolveNestedSkillForProjectRoot(
	repoPath: string,
): { sourcePath: string; skillFilePath: string } | null {
	const skillsRoot = join(repoPath, "skills");
	if (!existsSync(skillsRoot)) {
		return null;
	}
	const entries = listImmediateDirectories(skillsRoot);
	for (const entry of entries) {
		const nestedSkill = join(entry, "SKILL.md");
		if (existsSync(nestedSkill)) {
			return {
				sourcePath: resolve(entry),
				skillFilePath: resolve(nestedSkill),
			};
		}
	}
	return null;
}

function shouldIgnoreHarnessSkillName(name: string): boolean {
	return name.startsWith(".") || name.includes(".backup-");
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
	sourceType: DiscoveredSkill["sourceType"],
	harnessId: string | undefined,
	frontmatter: ReturnType<typeof parseSkillFrontmatterContent>,
): string[] | undefined {
	if (
		frontmatter.skillSyncInstallOn &&
		frontmatter.skillSyncInstallOn.length > 0
	) {
		return frontmatter.skillSyncInstallOn;
	}
	if (sourceType === "harness-root" && harnessId) {
		if (frontmatter.skillSyncScope === "global") {
			return undefined;
		}
		if (frontmatter.skillSyncScope === "local-only") {
			return [harnessId];
		}
		if (isPortableHarnessRoot(harnessId)) {
			return undefined;
		}
		return [harnessId];
	}
	return undefined;
}

function isPortableHarnessRoot(harnessId: string): boolean {
	return harnessId === "agents" || harnessId === "skills";
}

function describeInstallScope(skill: DiscoveredSkill): string {
	if (!skill.installHarnessIds || skill.installHarnessIds.length === 0) {
		return "";
	}
	if (
		skill.sourceType === "harness-root" &&
		skill.harnessId &&
		skill.installHarnessIds.length === 1 &&
		skill.installHarnessIds[0] === skill.harnessId
	) {
		return ` [local-only: ${skill.harnessId}]`;
	}
	return ` [install-on: ${skill.installHarnessIds.join(", ")}]`;
}

function resolveSourceHarnessId(
	sourcePath: string,
	harnesses: HarnessDefinition[],
): string | undefined {
	return harnesses
		.filter((harness) => pathOwnsEntry(harness.rootPath, sourcePath))
		.sort(
			(a, b) =>
				b.rootPath.length - a.rootPath.length || a.id.localeCompare(b.id),
		)[0]?.id;
}

function isBlockingFrontmatterIssue(issue: string): boolean {
	return issue.startsWith("invalid YAML frontmatter:");
}

function compareEquivalentSourcePreference(
	a: DiscoveredSkill,
	b: DiscoveredSkill,
): number {
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
