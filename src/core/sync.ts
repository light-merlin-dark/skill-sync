import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
	Config,
	DiscoveredSkill,
	HarnessDefinition,
	HarnessTraversalDiagnostic,
	InstallMode,
	OrphanSkill,
	PlannedEntry,
	PlannedPollutedEntry,
	SourceDiagnostics,
	State,
	SyncPlan,
} from "./types";
import {
	copyMaterializedDirectory,
	directoriesMatchMaterialized,
	ensureDir,
	inspectEntry,
	nowIso,
	pathOwnsEntry,
	removePath,
} from "./utils";

const DIRECTORY_SYMLINK_INSTALL_HARNESSES = new Set<string>();
const MATERIALIZED_DIRECTORY_INSTALL_HARNESSES = new Set<string>(["codex"]);

type SyncPlanOptions = {
	codexVisibilityBridge?: boolean;
	rawSelectedHarnessIds?: string[];
};

export function buildSyncPlan(
	skills: DiscoveredSkill[],
	harnesses: HarnessDefinition[],
	config: Config,
	state: State,
	sourceDiagnostics?: SourceDiagnostics,
	options: SyncPlanOptions = {},
): SyncPlan {
	const harnessPlans = harnesses.map((harness) => ({
		harness,
		entries: [] as PlannedEntry[],
	}));

	const desiredByHarness = new Map<string, Set<string>>();
	let conflicts = 0;
	let changes = 0;
	let ok = 0;

	for (const harnessPlan of harnessPlans) {
		desiredByHarness.set(harnessPlan.harness.id, new Set());
		const pathClaims = new Map<string, DiscoveredSkill>();
		const plannedDestinations = new Set<string>();

		for (const skill of skills) {
			if (!shouldInstallOnHarness(skill, harnessPlan.harness.id, options)) {
				continue;
			}
			const installName = resolveInstallName(
				skill,
				harnessPlan.harness.id,
				config,
			);
			const destinationPath = join(harnessPlan.harness.rootPath, installName);
			const existingClaim = pathClaims.get(destinationPath);
			if (existingClaim) {
				harnessPlan.entries.push({
					harnessId: harnessPlan.harness.id,
					harnessRoot: harnessPlan.harness.rootPath,
					installName,
					destinationPath,
					action: "conflict",
					sourcePath: skill.sourcePath,
					sourceKey: skill.sourceKey,
					message: `slug collision between ${existingClaim.sourcePath} and ${skill.sourcePath}`,
				});
				conflicts += 1;
				continue;
			}
			pathClaims.set(destinationPath, skill);
			desiredByHarness.get(harnessPlan.harness.id)?.add(destinationPath);
			const planned = buildPlannedEntry(
				skill,
				harnessPlan.harness,
				installName,
				destinationPath,
				state,
				options,
			);
			harnessPlan.entries.push(planned);
			plannedDestinations.add(destinationPath);
			if (planned.action === "conflict") {
				conflicts += 1;
			} else if (planned.action === "ok") {
				ok += 1;
			} else {
				changes += 1;
			}
		}

		for (const [entryPath, managed] of Object.entries(state.managedEntries)) {
			if (managed.harnessId !== harnessPlan.harness.id) {
				continue;
			}
			if (desiredByHarness.get(harnessPlan.harness.id)?.has(entryPath)) {
				continue;
			}
			const inspection = inspectEntry(entryPath);
			harnessPlan.entries.push({
				harnessId: harnessPlan.harness.id,
				harnessRoot: harnessPlan.harness.rootPath,
				installName: managed.installName,
				destinationPath: entryPath,
				action: inspection.exists ? "remove-managed" : "prune-state",
				sourcePath: managed.sourcePath,
				message: inspection.exists
					? "managed entry is stale and will be removed"
					: "stale state entry will be pruned",
			});
			plannedDestinations.add(entryPath);
			changes += 1;
		}

		if (harnessPlan.harness.detected) {
			let children: string[] = [];
			try {
				children = readdirSync(harnessPlan.harness.rootPath);
			} catch {
				children = [];
			}
			for (const child of children) {
				const entryPath = join(harnessPlan.harness.rootPath, child);
				if (plannedDestinations.has(entryPath)) {
					continue;
				}
				let stats: ReturnType<typeof lstatSync>;
				try {
					stats = lstatSync(entryPath);
				} catch {
					continue;
				}
				if (!stats.isSymbolicLink()) {
					continue;
				}
				if (!existsSync(entryPath)) {
					harnessPlan.entries.push({
						harnessId: harnessPlan.harness.id,
						harnessRoot: harnessPlan.harness.rootPath,
						installName: child,
						destinationPath: entryPath,
						action: "remove-broken",
						message: "broken symlink will be removed",
					});
					plannedDestinations.add(entryPath);
					changes += 1;
					continue;
				}

				if (isSymlinkToDirectory(entryPath)) {
					harnessPlan.entries.push({
						harnessId: harnessPlan.harness.id,
						harnessRoot: harnessPlan.harness.rootPath,
						installName: child,
						destinationPath: entryPath,
						action: "remove-dir-symlink",
						message:
							"top-level symlink to a directory will be removed to prevent recursive parser pollution",
					});
					plannedDestinations.add(entryPath);
					changes += 1;
				}
			}
		}

		harnessPlan.entries.sort((a, b) =>
			a.destinationPath.localeCompare(b.destinationPath),
		);
	}

	// Orphan reporting: skills that exist inside harness roots (have a SKILL.md)
	// but are neither part of the desired/discovered set nor tracked in state.managedEntries.
	const orphanSkills: OrphanSkill[] = [];
	for (const harnessPlan of harnessPlans) {
		const desiredSet =
			desiredByHarness.get(harnessPlan.harness.id) || new Set<string>();
		let children: string[] = [];
		try {
			children = readdirSync(harnessPlan.harness.rootPath);
		} catch {
			continue;
		}

		for (const child of children) {
			const destinationPath = join(harnessPlan.harness.rootPath, child);

			// If the skill is desired (or already managed), don't call it an orphan.
			if (desiredSet.has(destinationPath)) {
				continue;
			}
			if (state.managedEntries[destinationPath]) {
				continue;
			}

			const inspection = inspectEntry(destinationPath);
			if (!inspection.exists) {
				continue;
			}

			let hasSkillMd = false;
			if (inspection.type === "directory") {
				hasSkillMd = existsSync(join(destinationPath, "SKILL.md"));
			} else if (inspection.type === "symlink" && inspection.resolvedTarget) {
				hasSkillMd = existsSync(join(inspection.resolvedTarget, "SKILL.md"));
			}

			if (!hasSkillMd) {
				continue;
			}

			orphanSkills.push({
				harnessId: harnessPlan.harness.id,
				harnessRoot: harnessPlan.harness.rootPath,
				installName: child,
				destinationPath,
				inspection,
			});
		}
	}

	const harnessDiagnostics = findHarnessTraversalDiagnostics(harnesses);

	return {
		harnesses: harnessPlans,
		changes,
		conflicts,
		ok,
		sourceDiagnostics: sourceDiagnostics || { warnings: [], errors: [] },
		harnessDiagnostics,
		orphanSkills: orphanSkills.length ? orphanSkills : undefined,
	};
}

function buildPlannedEntry(
	skill: DiscoveredSkill,
	harness: HarnessDefinition,
	installName: string,
	destinationPath: string,
	state: State,
	options: SyncPlanOptions,
): PlannedEntry {
	const inspection = inspectEntry(destinationPath);
	const stateEntry = state.managedEntries[destinationPath];
	const installMode = resolveInstallMode(harness.id, options);
	const sameSource = isDesiredInstallPresent(
		installMode,
		destinationPath,
		inspection,
		skill,
		Boolean(stateEntry),
	);
	const compatibility = inspectCompatibility(
		installMode,
		destinationPath,
		skill,
		installName,
	);

	if (!inspection.exists) {
		return makePlannedEntry(
			skill,
			harness,
			installName,
			destinationPath,
			"create",
			"missing entry will be created",
			installMode,
		);
	}
	if (sameSource) {
		return makePlannedEntry(
			skill,
			harness,
			installName,
			destinationPath,
			"ok",
			"already synced",
			installMode,
		);
	}
	if (compatibility === "matching-skill") {
		return makePlannedEntry(
			skill,
			harness,
			installName,
			destinationPath,
			"repair",
			`matching install will be replaced with the managed ${describeInstallMode(installMode)} layout`,
			installMode,
		);
	}
	if (stateEntry) {
		return makePlannedEntry(
			skill,
			harness,
			installName,
			destinationPath,
			"repair",
			"managed entry drift will be repaired",
			installMode,
		);
	}
	if (inspection.type === "symlink" && isSymlinkToDirectory(destinationPath)) {
		return makePlannedEntry(
			skill,
			harness,
			installName,
			destinationPath,
			"repair",
			`top-level directory symlink will be replaced with the managed ${describeInstallMode(installMode)} layout to prevent recursive parser pollution`,
			installMode,
		);
	}
	if (compatibility === "empty-directory") {
		return makePlannedEntry(
			skill,
			harness,
			installName,
			destinationPath,
			"repair",
			"empty directory will be replaced",
			installMode,
		);
	}
	return makePlannedEntry(
		skill,
		harness,
		installName,
		destinationPath,
		"conflict",
		inspection.type === "symlink"
			? `existing symlink points elsewhere: ${inspection.linkTarget || "unknown target"}`
			: `existing ${inspection.type} is unmanaged`,
		installMode,
	);
}

function inspectCompatibility(
	installMode: InstallMode,
	destinationPath: string,
	skill: DiscoveredSkill,
	installName: string,
): "matching-skill" | "empty-directory" | "none" {
	const inspection = inspectEntry(destinationPath);
	if (!inspection.exists) {
		return "none";
	}
	const sourceSkillText = readFileSync(skill.skillFilePath, "utf8");

	if (inspection.type === "directory") {
		if (readdirSync(destinationPath).length === 0) {
			return "empty-directory";
		}
		if (installMode === "materialized-directory") {
			return directoriesMatchMaterialized(skill.sourcePath, destinationPath)
				? "matching-skill"
				: "none";
		}
		if (
			hasMatchingInstalledSkillFile(
				destinationPath,
				installName,
				sourceSkillText,
				skill.canonicalSlug,
			)
		) {
			return "matching-skill";
		}
		return "none";
	}

	if (inspection.type === "file") {
		return readFileSync(destinationPath, "utf8") === sourceSkillText
			? "matching-skill"
			: "none";
	}

	if (inspection.type === "symlink" && inspection.resolvedTarget) {
		if (
			installMode === "materialized-directory" &&
			directoriesMatchMaterialized(skill.sourcePath, inspection.resolvedTarget)
		) {
			return "matching-skill";
		}
		if (
			hasMatchingInstalledSkillFile(
				inspection.resolvedTarget,
				installName,
				sourceSkillText,
				skill.canonicalSlug,
			)
		) {
			return "matching-skill";
		}
	}

	return "none";
}

function hasMatchingInstalledSkillFile(
	rootPath: string,
	installName: string,
	sourceSkillText: string,
	canonicalSlug: string,
): boolean {
	for (const candidatePath of resolveInstalledSkillCandidates(
		rootPath,
		installName,
		canonicalSlug,
	)) {
		if (!existsSync(candidatePath)) {
			continue;
		}
		if (readFileSync(candidatePath, "utf8") === sourceSkillText) {
			return true;
		}
	}
	return false;
}

function resolveInstalledSkillCandidates(
	rootPath: string,
	installName: string,
	canonicalSlug: string,
): string[] {
	const names = [...new Set([installName, canonicalSlug])];
	const candidates = [join(rootPath, "SKILL.md")];
	for (const name of names) {
		candidates.push(join(rootPath, "skills", name, "SKILL.md"));
	}
	return candidates;
}

function isDesiredInstallPresent(
	installMode: InstallMode,
	destinationPath: string,
	inspection: ReturnType<typeof inspectEntry>,
	skill: DiscoveredSkill,
	managed: boolean,
): boolean {
	// Harness-root-owned sources can legitimately live at the destination path itself.
	// Restrict this to directory entries so top-level symlinked directories still get normalized.
	if (
		inspection.type === "directory" &&
		normalizeComparablePath(destinationPath) ===
			normalizeComparablePath(skill.sourcePath)
	) {
		return true;
	}

	if (installMode === "materialized-directory") {
		if (!managed || inspection.type !== "directory") {
			return false;
		}
		return directoriesMatchMaterialized(skill.sourcePath, destinationPath);
	}

	if (usesSkillFileWrapperInstall(installMode)) {
		if (inspection.type !== "directory") {
			return false;
		}
		const entryNames = readdirSync(destinationPath).filter(
			(name) => !name.startsWith("."),
		);
		if (entryNames.length !== 1 || entryNames[0] !== "SKILL.md") {
			return false;
		}
		const installedSkillPath = join(destinationPath, "SKILL.md");
		if (!existsSync(installedSkillPath)) {
			return false;
		}
		let installedStats: ReturnType<typeof lstatSync>;
		try {
			installedStats = lstatSync(installedSkillPath);
		} catch {
			return false;
		}
		if (!installedStats.isSymbolicLink()) {
			return false;
		}
		return (
			normalizeComparablePath(installedSkillPath) ===
			normalizeComparablePath(skill.skillFilePath)
		);
	}

	return (
		normalizeComparablePath(destinationPath) ===
			normalizeComparablePath(skill.sourcePath) ||
		(inspection.type === "symlink" &&
			inspection.resolvedTarget === resolve(skill.sourcePath))
	);
}

function normalizeComparablePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function makePlannedEntry(
	skill: DiscoveredSkill,
	harness: HarnessDefinition,
	installName: string,
	destinationPath: string,
	action: PlannedEntry["action"],
	message: string,
	installMode: InstallMode,
): PlannedEntry {
	return {
		harnessId: harness.id,
		harnessRoot: harness.rootPath,
		installName,
		destinationPath,
		action,
		installMode,
		sourcePath: skill.sourcePath,
		sourceSkillFilePath: skill.skillFilePath,
		sourceKey: skill.sourceKey,
		message,
	};
}

function shouldInstallOnHarness(
	skill: DiscoveredSkill,
	harnessId: string,
	options: SyncPlanOptions,
): boolean {
	const baseAllowed = shouldInstallOnHarnessBase(skill, harnessId);
	const bridgeCandidate = shouldRouteThroughCodexVisibilityBridge(
		skill,
		options,
	);

	if (harnessId === "codex" && bridgeCandidate) {
		return false;
	}

	if (harnessId === "agents") {
		const rawSelectedHarnessIds = new Set(options.rawSelectedHarnessIds || []);
		const agentsAutoIncludedForCodex =
			rawSelectedHarnessIds.has("codex") &&
			!rawSelectedHarnessIds.has("agents");
		if (agentsAutoIncludedForCodex) {
			return bridgeCandidate;
		}
		if (bridgeCandidate) {
			return true;
		}
	}

	return baseAllowed;
}

function shouldInstallOnHarnessBase(
	skill: DiscoveredSkill,
	harnessId: string,
): boolean {
	if (!skill.installHarnessIds || skill.installHarnessIds.length === 0) {
		return true;
	}
	return skill.installHarnessIds.includes(harnessId);
}

function shouldRouteThroughCodexVisibilityBridge(
	skill: DiscoveredSkill,
	options: SyncPlanOptions,
): boolean {
	if (!options.codexVisibilityBridge) {
		return false;
	}
	if (!shouldInstallOnHarnessBase(skill, "codex")) {
		return false;
	}
	if (skill.sourceType === "harness-root" && skill.harnessId === "codex") {
		return false;
	}
	if (!skill.installHarnessIds || skill.installHarnessIds.length === 0) {
		return true;
	}
	return skill.installHarnessIds.includes("agents");
}

export function resolveInstallName(
	skill: DiscoveredSkill,
	harnessId: string,
	config: Config,
): string {
	const override = config.aliases[skill.sourceKey];
	if (override?.harnesses?.[harnessId]) {
		return override.harnesses[harnessId];
	}
	if (override?.default) {
		return override.default;
	}
	return skill.canonicalSlug;
}

export function applySyncPlan(
	plan: SyncPlan,
	state: State,
	dryRun: boolean,
): State {
	const nextState: State = {
		version: state.version,
		managedEntries: { ...state.managedEntries },
	};

	for (const harnessPlan of plan.harnesses) {
		ensureDir(harnessPlan.harness.rootPath);
		for (const entry of harnessPlan.entries) {
			if (entry.action === "ok" || entry.action === "conflict") {
				continue;
			}
			if (entry.action === "prune-state") {
				delete nextState.managedEntries[entry.destinationPath];
				continue;
			}
			if (dryRun) {
				continue;
			}
			if (entry.action === "remove-managed") {
				removePath(entry.destinationPath);
				delete nextState.managedEntries[entry.destinationPath];
				continue;
			}
			if (entry.action === "remove-broken") {
				removePath(entry.destinationPath);
				delete nextState.managedEntries[entry.destinationPath];
				continue;
			}
			if (entry.action === "remove-dir-symlink") {
				removePath(entry.destinationPath);
				delete nextState.managedEntries[entry.destinationPath];
				continue;
			}
			removePath(entry.destinationPath);
			installPlannedEntry(entry);
			if (!entry.sourcePath) {
				throw new Error(`missing sourcePath for ${entry.destinationPath}`);
			}
			nextState.managedEntries[entry.destinationPath] = {
				harnessId: entry.harnessId,
				sourcePath: entry.sourcePath,
				installName: entry.installName,
				updatedAt: nowIso(),
				installMode: entry.installMode,
			};
		}
	}
	return nextState;
}

function installPlannedEntry(entry: PlannedEntry): void {
	if (!entry.sourcePath) {
		throw new Error(`missing sourcePath for ${entry.destinationPath}`);
	}
	const installMode = entry.installMode || resolveInstallMode(entry.harnessId);
	if (installMode === "materialized-directory") {
		copyMaterializedDirectory(entry.sourcePath, entry.destinationPath);
		return;
	}
	if (installMode === "wrapper-symlink") {
		const sourceSkillFilePath =
			entry.sourceSkillFilePath || join(entry.sourcePath, "SKILL.md");
		ensureDir(entry.destinationPath);
		symlinkSync(sourceSkillFilePath, join(entry.destinationPath, "SKILL.md"));
		return;
	}
	symlinkSync(entry.sourcePath, entry.destinationPath);
}

function usesSkillFileWrapperInstall(installMode: InstallMode): boolean {
	return installMode === "wrapper-symlink";
}

function resolveInstallMode(
	harnessId: string,
	options: SyncPlanOptions = {},
): InstallMode {
	if (MATERIALIZED_DIRECTORY_INSTALL_HARNESSES.has(harnessId)) {
		return "materialized-directory";
	}
	if (harnessId === "agents" && options.codexVisibilityBridge) {
		return "materialized-directory";
	}
	if (DIRECTORY_SYMLINK_INSTALL_HARNESSES.has(harnessId)) {
		return "directory-symlink";
	}
	return "wrapper-symlink";
}

function describeInstallMode(installMode: InstallMode): string {
	if (installMode === "materialized-directory") {
		return "materialized-directory";
	}
	if (installMode === "directory-symlink") {
		return "directory-symlink";
	}
	return "wrapper-symlink";
}

function isSymlinkToDirectory(path: string): boolean {
	try {
		const resolvedPath = realpathSync(path);
		return lstatSync(resolvedPath).isDirectory();
	} catch {
		return false;
	}
}

export function countPlanActions(plan: SyncPlan): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const harness of plan.harnesses) {
		for (const entry of harness.entries) {
			counts[entry.action] = (counts[entry.action] || 0) + 1;
		}
	}
	return counts;
}

export function hasConflicts(plan: SyncPlan): boolean {
	return plan.conflicts > 0 || plan.sourceDiagnostics.errors.length > 0;
}

export function hasDrift(plan: SyncPlan): boolean {
	return (
		plan.changes > 0 ||
		plan.harnessDiagnostics.length > 0 ||
		plan.sourceDiagnostics.warnings.some(
			(diagnostic) =>
				diagnostic.kind === "invalid-frontmatter" ||
				diagnostic.kind === "repo-root-pollution" ||
				diagnostic.kind === "fanout-high",
		)
	);
}

export function findPollutedSymlinks(
	harnesses: HarnessDefinition[],
	state: State,
): PlannedPollutedEntry[] {
	const polluted: PlannedPollutedEntry[] = [];
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
			if (shouldIgnoreHarnessEntryName(child)) {
				continue;
			}
			const destinationPath = join(harness.rootPath, child);
			const managed = state.managedEntries[destinationPath];
			const inspection = inspectEntry(destinationPath);
			if (inspection.type !== "symlink" || !inspection.resolvedTarget) {
				continue;
			}
			if (!isSymlinkDirectoryTarget(inspection.resolvedTarget)) {
				continue;
			}

			polluted.push({
				harnessId: harness.id,
				harnessRoot: harness.rootPath,
				installName: managed?.installName || child,
				destinationPath,
				resolvedTarget: inspection.resolvedTarget,
				managedBySkillSync: Boolean(managed),
				reason: describePollutionReason(inspection.resolvedTarget),
			});
		}
	}
	return polluted.sort(
		(a, b) =>
			a.harnessId.localeCompare(b.harnessId) ||
			a.destinationPath.localeCompare(b.destinationPath),
	);
}

export function cleanPollutedSymlinks(
	polluted: PlannedPollutedEntry[],
	state: State,
	dryRun: boolean,
): State {
	const nextState: State = {
		version: state.version,
		managedEntries: { ...state.managedEntries },
	};
	for (const entry of polluted) {
		if (!dryRun) {
			removePath(entry.destinationPath);
		}
		delete nextState.managedEntries[entry.destinationPath];
	}
	return nextState;
}

function isSymlinkDirectoryTarget(resolvedTarget: string): boolean {
	try {
		return lstatSync(resolvedTarget).isDirectory();
	} catch {
		return false;
	}
}

function describePollutionReason(resolvedTarget: string): string {
	if (!existsSync(join(resolvedTarget, "SKILL.md"))) {
		return "top-level harness symlink points to a directory; managed installs must use harness-native layouts instead of directory symlink fanout";
	}
	const found: string[] = [];
	for (const indicator of [
		"node_modules",
		".git",
		".worktrees",
		"package.json",
		"Cargo.toml",
		"go.mod",
	]) {
		if (existsSync(join(resolvedTarget, indicator))) {
			found.push(indicator);
		}
	}
	if (found.length > 0) {
		return `symlink target is a project root containing ${found.join(", ")}`;
	}
	return "symlink target is a project root, not a scoped skills/ directory";
}

export function findHarnessTraversalDiagnostics(
	harnesses: HarnessDefinition[],
): HarnessTraversalDiagnostic[] {
	const diagnostics: HarnessTraversalDiagnostic[] = [];
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
			if (shouldIgnoreHarnessEntryName(child)) {
				continue;
			}
			const entryPath = join(harness.rootPath, child);
			let entryStats: ReturnType<typeof lstatSync>;
			try {
				entryStats = lstatSync(entryPath);
			} catch {
				continue;
			}
			if (entryStats.isSymbolicLink() && !existsSync(entryPath)) {
				let linkTarget: string | undefined;
				try {
					linkTarget = readlinkSync(entryPath);
				} catch {
					linkTarget = undefined;
				}
				diagnostics.push({
					harnessId: harness.id,
					harnessRoot: harness.rootPath,
					entryName: child,
					entryPath,
					kind: "broken-root-symlink",
					severity: "warning",
					message:
						"entry is a broken symlink; recursive parsers may skip or truncate valid skills after repeated ENOENT errors",
					resolvedTarget: linkTarget
						? resolve(harness.rootPath, linkTarget)
						: undefined,
					error: linkTarget ? `${entryPath} -> ${linkTarget}` : undefined,
				});
				continue;
			}
			if (entryStats.isSymbolicLink()) {
				const inspection = inspectEntry(entryPath);
				if (inspection.type === "symlink" && inspection.resolvedTarget) {
					const targetHarness = findOwningHarness(
						inspection.resolvedTarget,
						harnesses,
					);
					if (targetHarness && targetHarness.id !== harness.id) {
						diagnostics.push({
							harnessId: harness.id,
							harnessRoot: harness.rootPath,
							entryName: child,
							entryPath,
							kind: "cross-harness-symlink",
							severity: "warning",
							message: `entry resolves into ${targetHarness.id} harness root; cross-harness top-level symlinks create stale and duplicate skill states when either harness mutates`,
							resolvedTarget: inspection.resolvedTarget,
						});
					}
				}
			}
			const scan = scanHarnessEntryForSkillTraversal(entryPath);
			if (scan.descendantSkillFiles.length === 0 && scan.errors.length === 0) {
				continue;
			}

			if (!scan.rootSkillFile && scan.descendantSkillFiles.length > 0) {
				diagnostics.push({
					harnessId: harness.id,
					harnessRoot: harness.rootPath,
					entryName: child,
					entryPath,
					kind: "missing-root-skill",
					severity: "warning",
					message: `entry has no root SKILL.md but exposes ${scan.descendantSkillFiles.length} descendant skill file(s) to recursive scanners`,
					resolvedTarget: scan.resolvedTarget,
					descendantSkillFiles: scan.descendantSkillFiles,
				});
			}

			const nestedSkillFiles = scan.rootSkillFile
				? scan.descendantSkillFiles.filter(
						(path) => path !== scan.rootSkillFile,
					)
				: scan.descendantSkillFiles;
			if (nestedSkillFiles.length > 0) {
				diagnostics.push({
					harnessId: harness.id,
					harnessRoot: harness.rootPath,
					entryName: child,
					entryPath,
					kind: "nested-skill-descendants",
					severity: "warning",
					message: `entry exposes nested descendant skill file(s) that recursive harnesses like OpenCode will also parse`,
					resolvedTarget: scan.resolvedTarget,
					rootSkillFile: scan.rootSkillFile,
					descendantSkillFiles: nestedSkillFiles,
				});
			}

			for (const error of scan.errors) {
				diagnostics.push({
					harnessId: harness.id,
					harnessRoot: harness.rootPath,
					entryName: child,
					entryPath,
					kind: "traversal-error",
					severity: "warning",
					message: `recursive traversal hit ${error.code || "an error"} while inspecting descendant skill paths`,
					resolvedTarget: scan.resolvedTarget,
					error: error.message,
				});
			}
		}
	}

	return diagnostics.sort(
		(a, b) =>
			a.harnessId.localeCompare(b.harnessId) ||
			a.entryPath.localeCompare(b.entryPath) ||
			a.kind.localeCompare(b.kind),
	);
}

function findOwningHarness(
	path: string,
	harnesses: HarnessDefinition[],
): HarnessDefinition | undefined {
	return harnesses
		.filter((harness) => pathOwnsEntry(harness.rootPath, path))
		.sort(
			(a, b) =>
				b.rootPath.length - a.rootPath.length || a.id.localeCompare(b.id),
		)[0];
}

type TraversalScan = {
	resolvedTarget?: string;
	rootSkillFile?: string;
	descendantSkillFiles: string[];
	errors: Array<{ code?: string; message: string }>;
};

function scanHarnessEntryForSkillTraversal(entryPath: string): TraversalScan {
	const inspection = inspectEntry(entryPath);
	if (!inspection.exists) {
		return { descendantSkillFiles: [], errors: [] };
	}
	if (inspection.type !== "directory" && inspection.type !== "symlink") {
		return { descendantSkillFiles: [], errors: [] };
	}

	const walkRoot =
		inspection.type === "symlink"
			? inspection.resolvedTarget || entryPath
			: entryPath;
	const descendantSkillFiles = new Set<string>();
	const errors: Array<{ code?: string; message: string }> = [];
	const pending = [walkRoot];
	const visited = new Set<string>();

	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) {
			continue;
		}
		let realCurrent: string;
		try {
			realCurrent = realpathSync(current);
		} catch (error) {
			errors.push(formatTraversalError(current, error));
			continue;
		}
		if (visited.has(realCurrent)) {
			continue;
		}
		visited.add(realCurrent);

		let names: string[] = [];
		try {
			names = readdirSync(current);
		} catch (error) {
			errors.push(formatTraversalError(current, error));
			continue;
		}

		for (const name of names) {
			const child = join(current, name);
			if (name === "SKILL.md") {
				descendantSkillFiles.add(resolve(child));
				continue;
			}

			try {
				const stats = lstatSync(child);
				if (stats.isDirectory()) {
					pending.push(child);
					continue;
				}
				if (!stats.isSymbolicLink()) {
					continue;
				}

				let resolvedChild: string;
				try {
					resolvedChild = realpathSync(child);
				} catch (error) {
					errors.push(formatTraversalError(child, error));
					continue;
				}

				try {
					const targetStats = lstatSync(resolvedChild);
					if (targetStats.isDirectory()) {
						pending.push(child);
					}
				} catch {}
			} catch {}
		}
	}

	const rootSkillCandidate = join(walkRoot, "SKILL.md");
	const rootSkillFile = existsSync(rootSkillCandidate)
		? resolve(rootSkillCandidate)
		: undefined;
	return {
		resolvedTarget: inspection.resolvedTarget,
		rootSkillFile,
		descendantSkillFiles: [...descendantSkillFiles].sort(),
		errors,
	};
}

function formatTraversalError(
	path: string,
	error: unknown,
): { code?: string; message: string } {
	const code = getErrorCode(error);
	const message =
		error instanceof Error
			? `${path}: ${error.message}`
			: `${path}: ${String(error)}`;
	return { code, message };
}

function shouldIgnoreHarnessEntryName(name: string): boolean {
	return name.startsWith(".") || name.includes(".backup-");
}

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error && "code" in error
		? String((error as { code?: string }).code)
		: undefined;
}
