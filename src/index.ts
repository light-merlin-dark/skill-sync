#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { cac } from "cac";
import { createBackup, listBackups, restoreBackup } from "./core/backup";
import { applyCacheBust, collectCacheBustTargets } from "./core/cache";
import {
	applyClassificationLedger,
	classificationReportToJson,
	lockClassificationLedger,
} from "./core/classification";
import {
	auditCodex,
	hasCodexInstallLayoutMismatch,
	probeCodexWorkspaceVisibility,
	repairCodexSkillsConfig,
	summarizeCodexAudit,
	summarizeCodexConfigRepair,
	summarizeCodexWorkspaceVisibilityReport,
} from "./core/codex";
import {
	addHarness,
	addProjectsRoot,
	initConfig,
	loadConfig,
	loadState,
	removeHarness,
	removeProjectsRoot,
	saveState,
	setVisibilityBaseline,
	setStrictVisibility,
	setVisibilityBudgets,
} from "./core/config";
import { filterHarnesses, resolveHarnesses } from "./core/harnesses";
import {
	buildProjectSyncPlan,
	discoverProjectManifests,
	findProjectRoot,
	loadProjectManifest,
	projectManifestToJson,
	writeProjectManifest,
} from "./core/project";
import {
	describeSkill,
	discoverSkillSet,
	repairBrokenNestedSkillLinks,
} from "./core/sources";
import {
	applySyncPlan,
	buildSyncPlan,
	cleanPollutedSymlinks,
	countPlanActions,
	findPollutedSymlinks,
	hasConflicts,
	hasDrift,
} from "./core/sync";
import type {
	DiscoveredSkill,
	HarnessDefinition,
	HarnessTraversalDiagnostic,
	JsonValue,
	SourceDiagnostic,
	SyncPlan,
} from "./core/types";
import {
	buildRuntimeContext,
	readJsonFile,
	slugify,
	writeJsonFile,
} from "./core/utils";
import {
	buildVisibilityReport,
	createVisibilityBaseline,
	type VisibilityBaseline,
	type VisibilityReport,
} from "./core/visibility";

const cli = cac("skill-sync");
const version = readCliVersion();

function readCliVersion(): string {
	try {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: string };
		return packageJson.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}

type GlobalOptions = {
	json?: boolean;
	verbose?: boolean;
	home?: string;
	dryRun?: boolean;
	projectsRoot?: string | string[];
	harness?: string | string[];
	skill?: string | string[];
	project?: string;
	strictVisibility?: boolean;
	writeBaseline?: string;
	baseline?: string;
};

function loadConfiguredBaseline(
	path: string | undefined,
): VisibilityBaseline | undefined {
	return path ? readJsonFile<VisibilityBaseline>(path) || undefined : undefined;
}

function normalizeList(value: string | string[] | undefined): string[] {
	if (!value) {
		return [];
	}
	const raw = Array.isArray(value) ? value : [value];
	return raw
		.flatMap((item) => item.split(","))
		.map((item) => item.trim())
		.filter(Boolean);
}

function resolveWorkspaceProbeCwds(
	value: string | string[] | undefined,
): string[] {
	const parsed = normalizeList(value);
	if (parsed.length === 0) {
		return [process.cwd()];
	}
	return parsed.map((cwd) => resolvePath(cwd));
}

function parsePositiveNumber(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return parsed;
}

function withRuntime<T>(
	options: GlobalOptions,
	fn: (runtime: ReturnType<typeof buildRuntimeContext>) => T,
): T {
	const runtime = buildRuntimeContext({
		home: options.home,
		json: options.json,
	});
	mkdirSync(runtime.stateDir, { recursive: true });
	return fn(runtime);
}

async function withRuntimeAsync<T>(
	options: GlobalOptions,
	fn: (runtime: ReturnType<typeof buildRuntimeContext>) => Promise<T>,
): Promise<T> {
	const runtime = buildRuntimeContext({
		home: options.home,
		json: options.json,
	});
	mkdirSync(runtime.stateDir, { recursive: true });
	return fn(runtime);
}

function resolveProjectsOverride(
	configProjectsRoots: string[],
	options: GlobalOptions,
): string[] {
	const override = normalizeList(options.projectsRoot);
	return override.length > 0 ? override : configProjectsRoots;
}

function expandSelectedHarnessIds(
	selectedIds: string[],
	harnesses: HarnessDefinition[] = [],
): string[] {
	const expanded = new Set(selectedIds);
	for (const harness of harnesses) {
		if (harness.aliases?.some((alias) => expanded.has(alias))) {
			expanded.add(harness.id);
		}
	}
	if (expanded.has("codex")) {
		expanded.add("agents");
	}
	return [...expanded];
}

function resolveSelectedHarnesses(
	allHarnesses: HarnessDefinition[],
	options: GlobalOptions,
): HarnessDefinition[] {
	return filterHarnesses(
		allHarnesses,
		expandSelectedHarnessIds(normalizeList(options.harness), allHarnesses),
	);
}

function resolveSyncPlanOptions(
	harnesses: HarnessDefinition[],
	options: GlobalOptions,
): {
	codexVisibilityBridge: boolean;
	rawSelectedHarnessIds: string[];
	targeted: boolean;
} {
	const harnessIds = new Set(harnesses.map((harness) => harness.id));
	return {
		codexVisibilityBridge: harnessIds.has("codex") && harnessIds.has("agents"),
		rawSelectedHarnessIds: normalizeList(options.harness),
		targeted: requestedSkillSlugs(options).length > 0,
	};
}

function requestedSkillSlugs(options: GlobalOptions): string[] {
	return [...new Set(normalizeList(options.skill).map(slugify))];
}

function selectDiscoveredSkills(
	skills: DiscoveredSkill[],
	options: GlobalOptions,
): DiscoveredSkill[] {
	const requested = requestedSkillSlugs(options);
	if (requested.length === 0) {
		return skills;
	}
	const requestedSet = new Set(requested);
	const selected = skills.filter((skill) =>
		requestedSet.has(skill.canonicalSlug),
	);
	const found = new Set(selected.map((skill) => skill.canonicalSlug));
	const missing = requested.filter((slug) => !found.has(slug));
	if (missing.length > 0) {
		throw new Error(
			`No discovered skill matches --skill ${missing.join(", ")}. Run: skill-sync sources`,
		);
	}
	return selected;
}

function filterPlanToSelectedSkills(
	plan: SyncPlan,
	selectedSkills: DiscoveredSkill[],
	options: GlobalOptions,
): SyncPlan {
	const requested = requestedSkillSlugs(options);
	if (requested.length === 0) {
		return plan;
	}
	const requestedSet = new Set(requested);
	const sourceKeys = new Set(selectedSkills.map((skill) => skill.sourceKey));
	const sourcePaths = new Set(selectedSkills.map((skill) => skill.sourcePath));
	const selectedInstallNames = new Set(requested);
	for (const skill of selectedSkills) {
		selectedInstallNames.add(skill.canonicalSlug);
	}

	const harnesses = plan.harnesses.map((harnessPlan) => {
		const entries = harnessPlan.entries.filter((entry) => {
			const selected =
				Boolean(entry.sourceKey && sourceKeys.has(entry.sourceKey)) ||
				Boolean(entry.sourcePath && sourcePaths.has(entry.sourcePath)) ||
				selectedInstallNames.has(entry.installName);
			if (selected) selectedInstallNames.add(entry.installName);
			return selected;
		});
		return { ...harnessPlan, entries };
	});

	const entries = harnesses.flatMap((harness) => harness.entries);
	const changes = entries.filter(
		(entry) => entry.action !== "ok" && entry.action !== "conflict",
	).length;
	const conflicts = entries.filter((entry) => entry.action === "conflict").length;
	const ok = entries.filter((entry) => entry.action === "ok").length;
	const filterDiagnostics = <T extends { slug: string }>(items: T[]): T[] =>
		items.filter((item) => requestedSet.has(item.slug));

	return {
		...plan,
		harnesses,
		changes,
		conflicts,
		ok,
		sourceDiagnostics: {
			warnings: filterDiagnostics(plan.sourceDiagnostics.warnings),
			errors: filterDiagnostics(plan.sourceDiagnostics.errors),
		},
		harnessDiagnostics: plan.harnessDiagnostics.filter((diagnostic) =>
			selectedInstallNames.has(diagnostic.entryName),
		),
		orphanSkills: plan.orphanSkills?.filter((orphan) =>
			selectedInstallNames.has(orphan.installName),
		),
	};
}

function selectSourceDiagnostics(
	diagnostics: SyncPlan["sourceDiagnostics"],
	options: GlobalOptions,
): SyncPlan["sourceDiagnostics"] {
	const requested = new Set(requestedSkillSlugs(options));
	if (requested.size === 0) return diagnostics;
	return {
		warnings: diagnostics.warnings.filter((item) => requested.has(item.slug)),
		errors: diagnostics.errors.filter((item) => requested.has(item.slug)),
	};
}

function print(value: JsonValue | string, json: boolean): void {
	if (json) {
		console.log(
			typeof value === "string"
				? JSON.stringify({ message: value }, null, 2)
				: JSON.stringify(value, null, 2),
		);
		return;
	}
	console.log(value);
}

function setExitCode(code: number): void {
	process.exitCode = Math.max(Number(process.exitCode) || 0, code);
}

function renderLandingHelp(): string {
	return [
		"skill-sync",
		"",
		"High-signal commands:",
		"  skill-sync doctor           Inspect sources, drift, and orphan installs",
		"  skill-sync doctor --verbose Show the full per-entry plan",
		"  skill-sync stabilize        Safe end-to-end remediation (dry run by default)",
		"  skill-sync codex-audit      Verify codex install integrity, config validity, and workspace visibility",
		"  skill-sync execute          Apply sync updates",
		"  skill-sync sync             Alias for execute",
		"  skill-sync clean            Remove polluted symlinks (repo-root targets)",
		"  skill-sync repair-sources   Restore broken nested SKILL.md symlinks",
		"  skill-sync cache-bust       Force skill reload signals (no app restart)",
		"  skill-sync sources          List discovered source skills",
		"  skill-sync harnesses        List detected harness roots",
		"",
		"Short alias:",
		"  ss doctor",
		"  ss execute",
		"",
		"Safety:",
		"  skill-sync backup create",
		"  skill-sync backup list",
		"",
		"Use --help for the full command reference.",
	].join("\n");
}

function renderDetailedPlan(
	plan: SyncPlan,
	options?: { includeOrphans?: boolean },
): string {
	const lines: string[] = [];
	appendSourceDiagnostics(lines, plan.sourceDiagnostics);
	appendHarnessDiagnostics(lines, plan.harnessDiagnostics);
	if (
		options?.includeOrphans !== false &&
		plan.orphanSkills &&
		plan.orphanSkills.length > 0
	) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push("Orphan installed skills:");
		for (const orphan of plan.orphanSkills) {
			const resolved =
				orphan.inspection.type === "symlink"
					? orphan.inspection.resolvedTarget || orphan.inspection.linkTarget
					: undefined;
			lines.push(
				`- ${orphan.harnessId}/${orphan.installName}  ${orphan.destinationPath}${resolved ? ` -> ${resolved}` : ""}`,
			);
		}
	}
	const counts = countPlanActions(plan);
	if (lines.length > 0) {
		lines.push("");
	}
	lines.push(
		`Summary: ${plan.ok} ok, ${plan.changes} change(s), ${plan.conflicts} conflict(s)`,
	);
	lines.push(
		`Actions: ${Object.entries(counts)
			.map(([action, count]) => `${action}=${count}`)
			.join(", ")}`,
	);
	for (const harnessPlan of plan.harnesses) {
		lines.push("");
		lines.push(`${harnessPlan.harness.id}  ${harnessPlan.harness.rootPath}`);
		const interestingEntries = harnessPlan.entries.filter(
			(entry) => entry.action !== "ok",
		);
		const entriesToShow =
			interestingEntries.length > 0 ? interestingEntries : harnessPlan.entries;
		for (const entry of entriesToShow) {
			const sourceSuffix = entry.sourcePath ? ` <= ${entry.sourcePath}` : "";
			lines.push(
				`  ${entry.action.padEnd(14)} ${entry.installName}${sourceSuffix}`,
			);
			if (entry.message !== "already synced") {
				lines.push(`    ${entry.message}`);
			}
		}
	}
	return lines.join("\n");
}

function renderPlan(
	plan: SyncPlan,
	options: { verbose?: boolean; includeOrphans?: boolean },
): string {
	if (options.verbose || hasConflicts(plan)) {
		return renderDetailedPlan(plan, options);
	}

	const lines: string[] = [];
	appendSourceDiagnostics(lines, plan.sourceDiagnostics);
	if (plan.harnessDiagnostics.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		const affectedHarnesses = new Set(
			plan.harnessDiagnostics.map((diagnostic) => diagnostic.harnessId),
		).size;
		lines.push(
			`Harness traversal warnings: ${plan.harnessDiagnostics.length} issue(s) across ${affectedHarnesses} harness(es)`,
		);
		lines.push(
			"Run `skill-sync doctor --verbose` to inspect recursive skill traversal hazards.",
		);
	}
	if (
		options.includeOrphans !== false &&
		plan.orphanSkills &&
		plan.orphanSkills.length > 0
	) {
		if (lines.length > 0) {
			lines.push("");
		}
		const harnessCount = new Set(
			plan.orphanSkills.map((orphan) => orphan.harnessId),
		).size;
		lines.push(
			`Orphan installed skills: ${plan.orphanSkills.length} detected across ${harnessCount} harness(es)`,
		);
		lines.push("Run `skill-sync doctor --verbose` to inspect orphan entries.");
	}

	const counts = countPlanActions(plan);
	if (lines.length > 0) {
		lines.push("");
	}
	lines.push(
		`Summary: ${plan.ok} ok, ${plan.changes} change(s), ${plan.conflicts} conflict(s)`,
	);
	lines.push(
		`Actions: ${Object.entries(counts)
			.map(([action, count]) => `${action}=${count}`)
			.join(", ")}`,
	);

	const harnessLines = summarizeHarnessPlans(plan);
	if (harnessLines.length > 0) {
		lines.push("");
		lines.push("Harness changes:");
		lines.push(...harnessLines);
	}

	return lines.join("\n");
}

function summarizeHarnessPlans(plan: SyncPlan): string[] {
	const lines: string[] = [];
	for (const harnessPlan of plan.harnesses) {
		const interestingEntries = harnessPlan.entries.filter(
			(entry) => entry.action !== "ok",
		);
		if (interestingEntries.length === 0) {
			continue;
		}
		const counts: Record<string, number> = {};
		for (const entry of interestingEntries) {
			counts[entry.action] = (counts[entry.action] || 0) + 1;
		}
		lines.push(
			`- ${harnessPlan.harness.id}: ${Object.entries(counts)
				.map(([action, count]) => `${action}=${count}`)
				.join(", ")}`,
		);
	}
	return lines;
}

function renderDoctorReport(
	plan: SyncPlan,
	state: ReturnType<typeof loadState>,
	skills: DiscoveredSkill[],
	harnessCount: number,
	visibilityReport: VisibilityReport,
	verbose?: boolean,
): string {
	if (verbose || hasConflicts(plan)) {
		return renderDetailedPlan(plan, { includeOrphans: true });
	}

	const totalExpectedInstalls = plan.harnesses
		.flatMap((harness) => harness.entries)
		.filter(
			(entry) =>
				entry.action !== "remove-managed" && entry.action !== "prune-state",
		).length;
	const trackedExpectedInstalls = plan.harnesses
		.flatMap((harness) => harness.entries)
		.filter(
			(entry) =>
				entry.action !== "conflict" &&
				Boolean(state.managedEntries[entry.destinationPath]),
		).length;
	const okButUntracked = plan.harnesses
		.flatMap((harness) => harness.entries)
		.filter(
			(entry) =>
				entry.action === "ok" && !state.managedEntries[entry.destinationPath],
		).length;
	const compatibleCopies = plan.harnesses
		.flatMap((harness) => harness.entries)
		.filter((entry) =>
			entry.message.startsWith(
				"matching install will be replaced with the managed ",
			),
		).length;
	const actionCounts = countPlanActions(plan);
	const topLevelDirSymlinkRemovals = actionCounts["remove-dir-symlink"] || 0;
	const lines: string[] = [];
	appendSourceDiagnostics(lines, plan.sourceDiagnostics);
	if (plan.harnessDiagnostics.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		const groupedDiagnostics = new Map<string, number>();
		for (const diagnostic of plan.harnessDiagnostics) {
			groupedDiagnostics.set(
				diagnostic.harnessId,
				(groupedDiagnostics.get(diagnostic.harnessId) || 0) + 1,
			);
		}
		const topHarnesses = [...groupedDiagnostics.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 5)
			.map(([harnessId, count]) => `${harnessId}=${count}`)
			.join(", ");
		lines.push(
			`Traversal hazards: ${plan.harnessDiagnostics.length} harness entry issue(s) could confuse recursive parsers like OpenCode`,
		);
		lines.push(`Top affected harnesses: ${topHarnesses}`);
		lines.push(
			"Diagnosis: these entries expose nested descendant SKILL.md paths, missing root SKILL.md files, broken root symlinks, cross-harness symlink fanout, or traversal errors that simple root-only sync checks will miss.",
		);
		lines.push(
			"Run `skill-sync doctor --verbose` to inspect traversal hazards.",
		);
	}
	if (lines.length > 0) {
		lines.push("");
	}
	lines.push("Doctor");
	lines.push(`Sources: ${skills.length} discovered skill source(s)`);
	lines.push(
		`Visibility: global=${visibilityReport.summary.global}, project=${visibilityReport.summary.project}, routed=${visibilityReport.summary.routed}, unclassified=${visibilityReport.summary.unclassified}`,
	);
	lines.push(
		`Global index budget: ${visibilityReport.globalBudget.skills} skill(s), ${visibilityReport.globalBudget.characters} character(s), ~${visibilityReport.globalBudget.estimatedTokens} token(s)`,
	);
	lines.push(
		`Coverage: ${visibilityReport.summary.coverageReachable}/${visibilityReport.summary.coverageTotal} reachable (${visibilityReport.summary.coveragePercent}%) across ${visibilityReport.summary.projectManifests} project manifest(s)`,
	);
	const scopedSources = skills.filter(
		(skill) => skill.installHarnessIds && skill.installHarnessIds.length > 0,
	).length;
	if (scopedSources > 0) {
		lines.push(
			`Scope: ${skills.length - scopedSources} global, ${scopedSources} scoped`,
		);
	}
	lines.push(`Harnesses: ${harnessCount} detected/enabled root(s)`);
	lines.push(`Expected installs: ${totalExpectedInstalls}`);
	lines.push(
		`State: ${trackedExpectedInstalls} tracked, ${okButUntracked} ok-but-untracked`,
	);
	lines.push(
		`Sync: ${plan.changes} change(s), ${plan.conflicts} conflict(s), ${plan.ok} ok`,
	);
	if (topLevelDirSymlinkRemovals > 0) {
		lines.push(
			`Top-level directory symlinks: ${topLevelDirSymlinkRemovals} will be removed or replaced with harness-native managed installs`,
		);
	}

	if (compatibleCopies > 0) {
		lines.push(
			`Copies: ${compatibleCopies} matching install(s) still need conversion into the managed harness-native layout`,
		);
	}

	if (plan.orphanSkills && plan.orphanSkills.length > 0) {
		const groupedOrphans = new Map<string, number>();
		for (const orphan of plan.orphanSkills) {
			groupedOrphans.set(
				orphan.harnessId,
				(groupedOrphans.get(orphan.harnessId) || 0) + 1,
			);
		}
		const topHarnesses = [...groupedOrphans.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 5)
			.map(([harnessId, count]) => `${harnessId}=${count}`)
			.join(", ");
		lines.push(
			`Orphans: ${plan.orphanSkills.length} installed skill(s) exist outside the discovered source set`,
		);
		lines.push(`Top orphan roots: ${topHarnesses}`);
		lines.push(
			"Diagnosis: project-root skills are syncing correctly. The remaining orphans are typically slug mismatches, backup artifacts, or installed entries that do not yet map to a canonical source.",
		);
		lines.push("Run `skill-sync doctor --verbose` to inspect orphan entries.");
	} else {
		lines.push("Orphans: 0");
	}

	const harnessLines = summarizeHarnessPlans(plan);
	if (harnessLines.length > 0) {
		lines.push("");
		lines.push("Harness changes:");
		lines.push(...harnessLines);
	}

	return lines.join("\n");
}

function appendSourceDiagnostics(
	lines: string[],
	sourceDiagnostics: SyncPlan["sourceDiagnostics"],
): void {
	if (
		sourceDiagnostics.errors.length === 0 &&
		sourceDiagnostics.warnings.length === 0
	) {
		return;
	}
	if (sourceDiagnostics.errors.length > 0) {
		lines.push("Source errors:");
		for (const diagnostic of sourceDiagnostics.errors) {
			appendSourceDiagnostic(lines, diagnostic);
		}
	}
	if (sourceDiagnostics.warnings.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push("Source warnings:");
		for (const diagnostic of sourceDiagnostics.warnings) {
			appendSourceDiagnostic(lines, diagnostic);
		}
	}
}

function appendSourceDiagnostic(
	lines: string[],
	diagnostic: SourceDiagnostic,
): void {
	if (diagnostic.kind === "invalid-frontmatter") {
		lines.push(`- invalid skill metadata: ${diagnostic.slug}`);
		for (const sourcePath of diagnostic.sourcePaths) {
			lines.push(`  ${sourcePath}`);
		}
		if (diagnostic.message) {
			lines.push(`  ${diagnostic.message}`);
		}
		if (diagnostic.severity === "error") {
			lines.push(
				"  Codex/OpenCode-compatible YAML parsing will fail for this skill until the frontmatter is fixed",
			);
		} else {
			lines.push(
				"  Codex and other harnesses may fail to index this skill until the frontmatter is fixed",
			);
		}
		return;
	}

	if (diagnostic.kind === "repo-root-pollution") {
		lines.push(`- polluted repo-root skill: ${diagnostic.slug}`);
		for (const sourcePath of diagnostic.sourcePaths) {
			lines.push(`  ${sourcePath}`);
		}
		if (diagnostic.message) {
			lines.push(`  ${diagnostic.message}`);
		}
		lines.push(
			"  skipped to prevent other CLIs from discovering spurious skills",
		);
		return;
	}

	if (diagnostic.kind === "broken-skill-link") {
		lines.push(`- broken nested skill file: ${diagnostic.slug}`);
		for (const sourcePath of diagnostic.sourcePaths) {
			lines.push(`  ${sourcePath}`);
		}
		if (diagnostic.message) {
			lines.push(`  ${diagnostic.message}`);
		}
		lines.push("  this source is blocked until SKILL.md is restored");
		return;
	}

	if (diagnostic.kind === "fanout-high") {
		lines.push(
			`- high source fanout: ${diagnostic.slug} (${diagnostic.sourcePaths.length} paths)`,
		);
		for (const sourcePath of diagnostic.sourcePaths) {
			lines.push(`  ${sourcePath}`);
		}
		if (diagnostic.chosenSourcePath) {
			lines.push(`  selected source: ${diagnostic.chosenSourcePath}`);
		}
		if (diagnostic.message) {
			lines.push(`  ${diagnostic.message}`);
		}
		lines.push(
			"  non-blocking warning: reduce mirrors to keep harness indexing stable",
		);
		return;
	}

	lines.push(`- duplicate slug: ${diagnostic.slug}`);
	for (const sourcePath of diagnostic.sourcePaths) {
		lines.push(`  ${sourcePath}`);
	}
	if (
		diagnostic.resolution === "resolved-by-preference" &&
		diagnostic.chosenSourcePath
	) {
		lines.push(`  resolved by preference: ${diagnostic.chosenSourcePath}`);
		return;
	}
	lines.push("  sync blocked until one source is excluded or preferred");
}

function appendHarnessDiagnostics(
	lines: string[],
	diagnostics: HarnessTraversalDiagnostic[],
): void {
	if (diagnostics.length === 0) {
		return;
	}
	if (lines.length > 0) {
		lines.push("");
	}
	lines.push("Harness traversal warnings:");
	for (const diagnostic of diagnostics) {
		lines.push(
			`- ${diagnostic.kind}: ${diagnostic.harnessId}/${diagnostic.entryName}`,
		);
		lines.push(`  ${diagnostic.entryPath}`);
		if (diagnostic.resolvedTarget) {
			lines.push(`  resolved target: ${diagnostic.resolvedTarget}`);
		}
		lines.push(`  ${diagnostic.message}`);
		for (const descendant of diagnostic.descendantSkillFiles || []) {
			lines.push(`  descendant: ${descendant}`);
		}
		if (diagnostic.rootSkillFile) {
			lines.push(`  root: ${diagnostic.rootSkillFile}`);
		}
		if (diagnostic.error) {
			lines.push(`  error: ${diagnostic.error}`);
		}
	}
}

function planSync(options: GlobalOptions): {
	runtime: ReturnType<typeof buildRuntimeContext>;
	plan: SyncPlan;
	harnesses: HarnessDefinition[];
	skills: DiscoveredSkill[];
	state: ReturnType<typeof loadState>;
	visibilityReport: VisibilityReport;
	strictVisibility: boolean;
} {
	return withRuntime(options, (runtime) => {
		const config = loadConfig(runtime);
		config.projectsRoots = resolveProjectsOverride(
			config.projectsRoots,
			options,
		);
		const allHarnesses = resolveHarnesses(runtime.homeDir, config);
		const harnesses = resolveSelectedHarnesses(allHarnesses, options);
		const { skills: allSkills, sourceDiagnostics } = discoverSkillSet(
			config,
			allHarnesses,
		);
		let skills = selectDiscoveredSkills(allSkills, options);
		let selectedSourceDiagnostics = selectSourceDiagnostics(
			sourceDiagnostics,
			options,
		);
		const strictVisibility =
			Boolean(options.strictVisibility) || config.visibility.strict === true;
		if (strictVisibility) {
			const unclassified = selectedSourceDiagnostics.warnings.filter(
				(item) => item.kind === "unclassified-visibility",
			);
			selectedSourceDiagnostics = {
				warnings: selectedSourceDiagnostics.warnings.filter(
					(item) => item.kind !== "unclassified-visibility",
				),
				errors: [
					...selectedSourceDiagnostics.errors,
					...unclassified.map((item) => ({ ...item, severity: "error" as const })),
				],
			};
			// Strict mode is preventive, not merely diagnostic: an unclassified
			// source is never included in a desired harness plan and therefore
			// cannot silently recreate the historical global fan-out.
			skills = skills.filter((skill) => skill.visibility !== "unclassified");
		}
		const state = loadState(runtime);
		const fullPlan = buildSyncPlan(
			skills,
			harnesses,
			config,
			state,
			selectedSourceDiagnostics,
			resolveSyncPlanOptions(harnesses, options),
		);
		const plan = filterPlanToSelectedSkills(
			fullPlan,
			skills,
			options,
		);
		const visibilityReport = buildVisibilityReport(
			allSkills,
			discoverProjectManifests(config),
			loadConfiguredBaseline(options.baseline || config.visibility.baselinePath),
			config.visibility,
		);
		if (strictVisibility && !visibilityReport.policy.globalWithinBudget) {
			plan.sourceDiagnostics.errors.push(
				...(visibilityReport.diagnostics.errors as unknown as SourceDiagnostic[]).filter(
					(item) =>
						item.kind === "visibility-budget-exceeded" && item.slug === "global",
				),
			);
		}
		return {
			runtime,
			plan,
			harnesses,
			skills,
			state,
			visibilityReport,
			strictVisibility,
		};
	});
}

function printDoctorResult(
	plan: SyncPlan,
	options: GlobalOptions,
	state: ReturnType<typeof loadState>,
	skills: DiscoveredSkill[],
	harnessCount: number,
	visibilityReport: VisibilityReport,
	strictVisibility: boolean,
): void {
	print(
		options.json
			? ({
					...plan,
					summary: {
						sourcesDiscovered: skills.length,
						scopedSources: skills.filter(
							(skill) =>
								skill.installHarnessIds && skill.installHarnessIds.length > 0,
						).length,
						strictVisibility,
						harnessesDetected: harnessCount,
						expectedInstalls: plan.harnesses
							.flatMap((harness) => harness.entries)
							.filter(
								(entry) =>
									entry.action !== "remove-managed" &&
									entry.action !== "prune-state",
							).length,
						changes: plan.changes,
						conflicts: plan.conflicts,
						ok: plan.ok,
						traversalHazards: plan.harnessDiagnostics.length,
						orphans: plan.orphanSkills?.length || 0,
						visibility: visibilityReport.summary,
						globalBudget: visibilityReport.globalBudget,
					},
				} as unknown as JsonValue)
			: renderDoctorReport(
					plan,
					state,
					skills,
					harnessCount,
					visibilityReport,
					options.verbose,
				),
		Boolean(options.json),
	);
	setExitCode(hasConflicts(plan) ? 3 : hasDrift(plan) ? 2 : 0);
}

cli
	.command("doctor", "Inspect current sources, drift, and orphan installs")
	.option("--json", "Output JSON")
	.option("--dry-run", "Accepted for parity; check is always read-only")
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option("--skill <slug>", "Filter to one or more skill slugs")
	.option("--strict-visibility", "Treat unclassified visibility as an error")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		const {
			plan,
			state,
			skills,
			harnesses,
			visibilityReport,
			strictVisibility,
		} = planSync(options);
		printDoctorResult(
			plan,
			options,
			state,
			skills,
			harnesses.length,
			visibilityReport,
			strictVisibility,
		);
	});

cli
	.command("check", "Alias for doctor")
	.option("--json", "Output JSON")
	.option("--dry-run", "Accepted for parity; check is always read-only")
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option("--skill <slug>", "Filter to one or more skill slugs")
	.option("--strict-visibility", "Treat unclassified visibility as an error")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		const {
			plan,
			state,
			skills,
			harnesses,
			visibilityReport,
			strictVisibility,
		} = planSync(options);
		printDoctorResult(
			plan,
			options,
			state,
			skills,
			harnesses.length,
			visibilityReport,
			strictVisibility,
		);
	});

cli
	.command(
		"codex-audit",
		"Verify Codex skill install integrity and codex skills.config validity",
	)
	.option("--json", "Output JSON")
	.option("--dry-run", "Show config repairs without writing")
	.option(
		"--fix-config",
		"Repair invalid/stale codex skills.config blocks and legacy alias paths",
	)
	.option(
		"--cwd <path>",
		"Probe Codex app-server skill visibility for one or more workspace directories (comma-separated, default: current working directory)",
	)
	.option(
		"--runtime-max-age-hours <hours>",
		"Treat runtime snapshots older than this as stale (default: 12)",
	)
	.option(
		"--strict-runtime",
		"Fail when runtime gaps are seen even from stale snapshots",
	)
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(
		async (
			options: GlobalOptions & {
				fixConfig?: boolean;
				strictRuntime?: boolean;
				runtimeMaxAgeHours?: string | number;
				cwd?: string | string[];
			},
		) => {
			await withRuntimeAsync(options, async (runtime) => {
				const repair = options.fixConfig
					? repairCodexSkillsConfig(runtime.homeDir, Boolean(options.dryRun))
					: undefined;
				const audit = auditCodex(runtime.homeDir, {
					runtimeMaxAgeHours: parsePositiveNumber(options.runtimeMaxAgeHours),
				});
				const workspaceProbeCwds = resolveWorkspaceProbeCwds(options.cwd);
				const workspaceProbes = await Promise.all(
					workspaceProbeCwds.map((cwd) =>
						probeCodexWorkspaceVisibility(
							runtime.homeDir,
							cwd,
							audit.installed,
						),
					),
				);

				if (options.json) {
					print(
						{ audit, repair, workspaceProbes } as unknown as JsonValue,
						true,
					);
				} else {
					console.log(summarizeCodexAudit(audit));
					for (const probe of workspaceProbes) {
						console.log("");
						console.log(summarizeCodexWorkspaceVisibilityReport(probe));
					}
					if (repair) {
						console.log("");
						console.log(summarizeCodexConfigRepair(repair));
					}
				}

				const hasInstallIssues = audit.installed
					.filter((item) => item.managedBySkillSync)
					.some(
						(item) =>
							!item.exists ||
							hasCodexInstallLayoutMismatch(item) ||
							!item.yamlValid ||
							item.disabledByConfig,
					);
				const hasConfigIssues =
					audit.invalidEntries.length > 0 || audit.staleEntries.length > 0;
				const hasRuntimeIssues =
					audit.runtimeMissingSkills.length > 0 ||
					(Boolean(options.strictRuntime) &&
						audit.runtimeMissingSkillsUncertain.length > 0);
				const hasRuntimeSnapshotDrift =
					audit.runtimeMissingSkillsInstalledAfterSnapshot.length > 0;
				const hasWorkspaceIssues = workspaceProbes.some(
					(probe) =>
						probe.status === "ok" && probe.missingManagedSkills.length > 0,
				);
				if (
					hasInstallIssues ||
					hasConfigIssues ||
					hasRuntimeIssues ||
					hasRuntimeSnapshotDrift ||
					hasWorkspaceIssues
				) {
					setExitCode(2);
				}
			});
		},
	);

function runExecute(options: GlobalOptions): void {
	if (options.project) {
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			config.projectsRoots = resolveProjectsOverride(
				config.projectsRoots,
				options,
			);
			const harnesses = resolveHarnesses(runtime.homeDir, config);
			const { skills } = discoverSkillSet(config, harnesses);
			const projectRoot = findProjectRoot(options.project || process.cwd());
			const manifest = loadProjectManifest(projectRoot);
			const state = loadState(runtime);
			const plan = buildProjectSyncPlan(manifest, skills, state, {
				requestedAdapters: normalizeList(options.harness),
			});
			const report = buildVisibilityReport(
				skills,
				[manifest],
				undefined,
				config.visibility,
			);
			if (config.visibility.strict === true) {
				plan.sourceDiagnostics.errors.push(
					...(report.diagnostics.errors as unknown as SourceDiagnostic[]).filter(
						(item) =>
							item.kind === "visibility-budget-exceeded" &&
							item.slug === `project:${projectRoot}`,
					),
				);
			}
			const blocked = hasConflicts(plan);
			const nextState = blocked
				? state
				: applySyncPlan(plan, state, Boolean(options.dryRun));
			if (!options.dryRun && !blocked) saveState(runtime, nextState);
			print(
				options.json
					? (plan as unknown as JsonValue)
					: renderPlan(plan, {
							verbose: options.verbose || hasConflicts(plan),
							includeOrphans: false,
						}),
				Boolean(options.json),
			);
			if (hasConflicts(plan)) setExitCode(3);
		});
		return;
	}
	const { runtime, plan, state } = planSync(options);
	const hasPlanConflicts = hasConflicts(plan);
	const blockedByBudget = plan.sourceDiagnostics.errors.some(
		(diagnostic) => diagnostic.kind === "visibility-budget-exceeded",
	);
	const nextState = blockedByBudget
		? state
		: applySyncPlan(plan, state, Boolean(options.dryRun));
	if (!options.dryRun && !blockedByBudget) {
		saveState(runtime, nextState);
	}
	print(
		options.json
			? (plan as unknown as JsonValue)
			: renderPlan(plan, { verbose: options.verbose || hasPlanConflicts, includeOrphans: false }),
		Boolean(options.json),
	);
	if (hasPlanConflicts) {
		setExitCode(3);
	}
}

type StabilizeOptions = GlobalOptions & {
	execute?: boolean;
	fixCodexConfig?: boolean;
};

async function runStabilize(options: StabilizeOptions): Promise<void> {
	if (options.execute && options.dryRun) {
		throw new Error("stabilize cannot combine --execute with --dry-run");
	}

	const applyChanges = Boolean(options.execute) && !options.dryRun;

	await withRuntimeAsync(options, async (runtime) => {
		const config = loadConfig(runtime);
		config.projectsRoots = resolveProjectsOverride(
			config.projectsRoots,
			options,
		);
		const allHarnesses = resolveHarnesses(runtime.homeDir, config);
		const harnesses = resolveSelectedHarnesses(allHarnesses, options);
		const state = loadState(runtime);

		const repairReport = repairBrokenNestedSkillLinks(config, !applyChanges);
		const { skills, sourceDiagnostics } = discoverSkillSet(
			config,
			allHarnesses,
		);
		const planOptions = resolveSyncPlanOptions(harnesses, options);
		const plan = buildSyncPlan(
			skills,
			harnesses,
			config,
			state,
			sourceDiagnostics,
			planOptions,
		);

		const hasPlanConflicts = hasConflicts(plan);
		let appliedSync = false;
		let nextState = state;
		if (applyChanges) {
			nextState = applySyncPlan(plan, state, false);
			saveState(runtime, nextState);
			appliedSync = true;
		}

		const includeCodexHarness = harnesses.some(
			(harness) => harness.id === "codex",
		);
		const fixCodexConfig = options.fixCodexConfig || false;
		const codexConfigRepair =
			includeCodexHarness && fixCodexConfig
				? repairCodexSkillsConfig(
						runtime.homeDir,
						!applyChanges || !appliedSync,
					)
				: undefined;

		const cacheTargets = collectCacheBustTargets(harnesses, runtime.homeDir);
		const cacheResult = applyCacheBust(
			cacheTargets,
			!applyChanges || !appliedSync,
		);

		const postState = appliedSync ? nextState : loadState(runtime);
		const postDiscovery = discoverSkillSet(config, allHarnesses);
		const postPlan = buildSyncPlan(
			postDiscovery.skills,
			harnesses,
			config,
			postState,
			postDiscovery.sourceDiagnostics,
			planOptions,
		);
		const postCodexAudit = includeCodexHarness
			? auditCodex(runtime.homeDir)
			: undefined;
		const postCodexWorkspaceProbes =
			includeCodexHarness && postCodexAudit
				? [
						await probeCodexWorkspaceVisibility(
							runtime.homeDir,
							resolvePath(process.cwd()),
							postCodexAudit.installed,
						),
					]
				: [];
		const summary = {
			mode: applyChanges ? "execute" : "dry-run",
			harnesses: harnesses.length,
			sourcesDiscovered: skills.length,
			sourceWarnings: plan.sourceDiagnostics.warnings.length,
			sourceErrors: plan.sourceDiagnostics.errors.length,
			repairedSources: repairReport.repairedLinks.length,
			repairSkipped: repairReport.skipped.length,
			syncChanges: plan.changes,
			syncConflicts: plan.conflicts,
			syncOk: plan.ok,
			cacheTouched: cacheResult.touched.length,
			cacheSkipped: cacheResult.skipped.length,
			postChanges: postPlan.changes,
			postConflicts: postPlan.conflicts,
			postWarnings: postPlan.sourceDiagnostics.warnings.length,
			postTraversalHazards: postPlan.harnessDiagnostics.length,
			codexConfigUpdated: codexConfigRepair?.updated || false,
			codexConfigRemovedInvalid: codexConfigRepair?.removedInvalid || 0,
			codexConfigRemovedStale: codexConfigRepair?.removedStale || 0,
			codexConfigRewrittenLegacy: codexConfigRepair?.rewrittenLegacy || 0,
			postCodexInvalidConfigEntries: postCodexAudit?.invalidEntries.length || 0,
			postCodexStaleConfigEntries: postCodexAudit?.staleEntries.length || 0,
			postCodexRuntimeMissing: postCodexAudit?.runtimeMissingSkills.length || 0,
			postCodexRuntimeMissingUncertain:
				postCodexAudit?.runtimeMissingSkillsUncertain.length || 0,
			postCodexRuntimeSnapshotDrift:
				postCodexAudit?.runtimeMissingSkillsInstalledAfterSnapshot.length || 0,
			postCodexWorkspaceMissingManaged: postCodexWorkspaceProbes.reduce(
				(sum, probe) => sum + probe.missingManagedSkills.length,
				0,
			),
		};

		if (options.json) {
			print(
				{
					schemaVersion: 1,
					summary,
					repair: repairReport,
					prePlan: plan,
					codexConfigRepair,
					cache: cacheResult,
					postPlan,
					postCodexAudit,
					postCodexWorkspaceProbes,
				} as unknown as JsonValue,
				true,
			);
		} else {
			console.log(`Stabilize (${summary.mode})`);
			console.log(
				`- repair-sources: ${summary.repairedSources} ${applyChanges ? "repaired" : "repairable"}, ${summary.repairSkipped} skipped`,
			);
			console.log(
				`- sync: ${summary.syncChanges} change(s), ${summary.syncConflicts} conflict(s), ${summary.syncOk} ok`,
			);
			if (!applyChanges && summary.syncChanges > 0) {
				console.log(
					"  run `skill-sync stabilize --execute` to apply this plan",
				);
			}
			if (codexConfigRepair) {
				console.log(
					`- codex-config: updated=${summary.codexConfigUpdated ? "yes" : "no"}, removed-invalid=${summary.codexConfigRemovedInvalid}, removed-stale=${summary.codexConfigRemovedStale}, rewritten-legacy=${summary.codexConfigRewrittenLegacy}`,
				);
			}
			console.log(
				`- cache-bust: ${summary.cacheTouched}/${cacheResult.totalTargets} ${applyChanges ? "touched" : "targeted"}`,
			);
			if (
				summary.postChanges === 0 &&
				summary.postConflicts === 0 &&
				summary.postTraversalHazards === 0 &&
				summary.postWarnings === 0
			) {
				console.log("- post-check: stable");
			} else {
				console.log(
					`- post-check: ${summary.postChanges} change(s), ${summary.postConflicts} conflict(s), ${summary.postTraversalHazards} traversal hazard(s), ${summary.postWarnings} warning(s)`,
				);
			}
			if (postCodexAudit) {
				console.log(
					`- post-codex: invalid-config=${summary.postCodexInvalidConfigEntries}, stale-config=${summary.postCodexStaleConfigEntries}, runtime-missing=${summary.postCodexRuntimeMissing}, runtime-missing-uncertain=${summary.postCodexRuntimeMissingUncertain}, runtime-snapshot-drift=${summary.postCodexRuntimeSnapshotDrift}`,
				);
			}
			for (const probe of postCodexWorkspaceProbes) {
				console.log("");
				console.log(summarizeCodexWorkspaceVisibilityReport(probe));
			}
		}

		if (postPlan.conflicts > 0) {
			setExitCode(3);
		}
		if (
			postCodexAudit &&
			(postCodexAudit.invalidEntries.length > 0 ||
				postCodexAudit.staleEntries.length > 0 ||
				postCodexAudit.runtimeMissingSkills.length > 0 ||
				postCodexAudit.runtimeMissingSkillsInstalledAfterSnapshot.length > 0)
		) {
			setExitCode(2);
		}
		if (
			postCodexWorkspaceProbes.some(
				(probe) =>
					probe.status === "ok" && probe.missingManagedSkills.length > 0,
			)
		) {
			setExitCode(2);
		}
		if (
			hasDrift(postPlan) ||
			repairReport.skipped.length > 0 ||
			cacheResult.skipped.length > 0
		) {
			setExitCode(2);
		}
	});
}

cli
	.command(
		"stabilize",
		"Repair broken sources, apply sync, and cache-bust in one safe flow (dry run by default)",
	)
	.option("--json", "Output JSON")
	.option("--dry-run", "Force dry-run mode (default unless --execute is set)")
	.option("--execute", "Apply changes after planning")
	.option(
		"--fix-codex-config",
		"Also repair invalid/stale codex skills.config entries when codex harness is selected",
	)
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(async (options: StabilizeOptions) => runStabilize(options));

cli
	.command("execute", "Apply the desired managed install state")
	.option("--json", "Output JSON")
	.option("--dry-run", "Show changes without mutating")
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option("--skill <slug>", "Apply only one or more skill slugs")
	.option("--project <path>", "Apply the declared entrypoints for one project")
	.option("--strict-visibility", "Refuse unclassified source visibility")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(runExecute);

cli
	.command("sync", "Alias for execute")
	.option("--json", "Output JSON")
	.option("--dry-run", "Show changes without mutating")
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option("--skill <slug>", "Apply only one or more skill slugs")
	.option("--project <path>", "Apply the declared entrypoints for one project")
	.option("--strict-visibility", "Refuse unclassified source visibility")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(runExecute);

cli
	.command("audit <action>", "Audit visibility and progressive-disclosure coverage")
	.option("--json", "Output JSON")
	.option(
		"--write-baseline <path>",
		"Persist a value-blind inventory ledger for migration coverage proof",
	)
	.option("--baseline <path>", "Compare coverage against a baseline ledger")
	.option("--projects-root <path>", "Override configured projects root")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((action: string, options: GlobalOptions) => {
		if (action !== "visibility") {
			throw new Error(`Unknown audit action: ${action}`);
		}
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			config.projectsRoots = resolveProjectsOverride(
				config.projectsRoots,
				options,
			);
			const harnesses = resolveHarnesses(runtime.homeDir, config);
			const { skills, sourceDiagnostics } = discoverSkillSet(config, harnesses);
			const report = buildVisibilityReport(
				skills,
				discoverProjectManifests(config),
				loadConfiguredBaseline(
					options.baseline || config.visibility.baselinePath,
				),
				config.visibility,
			);
			const output = {
				...report,
				sourceDiagnostics,
			};
			if (options.writeBaseline) {
				writeJsonFile(
					resolvePath(options.writeBaseline),
					createVisibilityBaseline(skills),
				);
			}
			if (options.json) {
				print(output as unknown as JsonValue, true);
			} else {
				console.log("Visibility audit");
				console.log(
					`- skills: ${report.summary.totalSkills} total; ${report.summary.global} global, ${report.summary.project} project, ${report.summary.routed} routed, ${report.summary.unclassified} unclassified`,
				);
				console.log(
					`- global index: ${report.globalBudget.characters} characters, ~${report.globalBudget.estimatedTokens} tokens`,
				);
				console.log(
					`- coverage: ${report.summary.coverageReachable}/${report.summary.coverageTotal} (${report.summary.coveragePercent}%)`,
				);
				console.log(
					`- projects: ${report.summary.projectManifests} manifest(s)`,
				);
			}
			if (
				report.summary.unclassified > 0 ||
				report.summary.coverageReachable < report.summary.coverageTotal ||
				sourceDiagnostics.errors.length > 0 ||
				report.diagnostics.errors.length > 0
			) {
				setExitCode(sourceDiagnostics.errors.length > 0 ? 3 : 2);
			}
		});
	});

cli
	.command(
		"baseline <action> [path]",
		"Capture, configure, or inspect the visibility coverage baseline",
	)
	.option("--json", "Output JSON")
	.option("--projects-root <path>", "Override configured projects root")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((action: string, path: string | undefined, options: GlobalOptions) => {
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			if (action === "show") {
				const baselinePath = config.visibility.baselinePath;
				print(
					{
						schemaVersion: 1,
						baselinePath,
						baseline: loadConfiguredBaseline(baselinePath),
					} as unknown as JsonValue,
					Boolean(options.json),
				);
				return;
			}
			if (action === "set") {
				if (!path) throw new Error("baseline set requires a path");
				const next = setVisibilityBaseline(runtime, resolvePath(path));
				print(next as unknown as JsonValue, Boolean(options.json));
				return;
			}
			if (action !== "capture") {
				throw new Error(`Unknown baseline action: ${action}`);
			}
			const baselinePath = resolvePath(
				path || `${runtime.stateDir}/visibility-baseline.json`,
			);
			config.projectsRoots = resolveProjectsOverride(
				config.projectsRoots,
				options,
			);
			const harnesses = resolveHarnesses(runtime.homeDir, config);
			const { skills } = discoverSkillSet(config, harnesses);
			const baseline = createVisibilityBaseline(skills);
			writeJsonFile(baselinePath, baseline);
			setVisibilityBaseline(runtime, baselinePath);
			print(
				{
					schemaVersion: 1,
					baselinePath,
					skills: baseline.skills.length,
					capturedAt: baseline.capturedAt,
				} as unknown as JsonValue,
				Boolean(options.json),
			);
		});
	});

cli
	.command(
		"classify <action> <ledger>",
		"Plan or apply a hash-guarded visibility classification ledger",
	)
	.option("--json", "Output JSON")
	.option("--execute", "Write metadata changes (plan is the default)")
	.option(
		"--rewrite-source-prefix <mapping>",
		"Rewrite FROM=TO source prefixes when applying in an isolated worktree",
	)
	.action(
		(
			action: string,
			ledger: string,
			options: GlobalOptions & {
				execute?: boolean;
				rewriteSourcePrefix?: string;
			},
		) => {
			if (action !== "plan" && action !== "apply" && action !== "lock") {
				throw new Error(`Unknown classify action: ${action}`);
			}
			if (action === "lock") {
				const locked = lockClassificationLedger(resolvePath(ledger));
				print(
					{
						schemaVersion: 1,
						ledgerPath: resolvePath(ledger),
						entries: locked.entries.length,
					} as unknown as JsonValue,
					Boolean(options.json),
				);
				return;
			}
			const execute = action === "apply" && Boolean(options.execute);
			let sourceRewrite: { from: string; to: string } | undefined;
			if (options.rewriteSourcePrefix) {
				const separator = options.rewriteSourcePrefix.indexOf("=");
				if (separator < 1) {
					throw new Error("--rewrite-source-prefix must be FROM=TO");
				}
				sourceRewrite = {
					from: options.rewriteSourcePrefix.slice(0, separator),
					to: options.rewriteSourcePrefix.slice(separator + 1),
				};
			}
			const report = applyClassificationLedger(
				resolvePath(ledger),
				!execute,
				sourceRewrite,
			);
			print(
				options.json
					? classificationReportToJson(report)
					: [
							`Classification ${execute ? "apply" : "plan"}`,
							`- entries: ${report.summary.entries}`,
							`- changes: ${report.summary.changes}`,
							`- unchanged: ${report.summary.unchanged}`,
							`- errors: ${report.summary.errors}`,
						].join("\n"),
				Boolean(options.json),
			);
			if (report.summary.errors > 0) setExitCode(3);
		},
	);

cli
	.command(
		"project <action> [entrypoint]",
		"Manage or inspect one project's declared skill entrypoints",
	)
	.option("--json", "Output JSON")
	.option("--dry-run", "Show changes without mutating")
	.option("--root <path>", "Project root (default: current git repository)")
	.option("--projects-root <path>", "Override configured projects root")
	.option(
		"--harness <id>",
		"Project adapter to validate (agents, pi, or codex; others fail closed)",
	)
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(
		(
			action: string,
			entrypoint: string | undefined,
			options: GlobalOptions & { root?: string },
		) => {
			withRuntime(options, (runtime) => {
				const projectRoot = findProjectRoot(options.root || process.cwd());
				const current = loadProjectManifest(projectRoot);
				if (action === "add" || action === "remove") {
					if (!entrypoint) {
						throw new Error(`project ${action} requires an entrypoint slug`);
					}
					const slug = slugify(entrypoint);
					const next = new Set(current.manifest?.entrypoints || []);
					if (action === "add") next.add(slug);
					else next.delete(slug);
					const manifest = {
						version: 1 as const,
						entrypoints: [...next].sort(),
					};
					if (!options.dryRun) {
						writeProjectManifest(projectRoot, manifest.entrypoints);
					}
					print(
						{
							schemaVersion: 1,
							projectRoot,
							manifestPath: current.manifestPath,
							manifest,
							dryRun: Boolean(options.dryRun),
						} as unknown as JsonValue,
						Boolean(options.json),
					);
					return;
				}
				if (action !== "doctor") {
					throw new Error(`Unknown project action: ${action}`);
				}
				const config = loadConfig(runtime);
				config.projectsRoots = resolveProjectsOverride(
					config.projectsRoots,
					options,
				);
				const harnesses = resolveHarnesses(runtime.homeDir, config);
				const { skills } = discoverSkillSet(config, harnesses);
				const plan = buildProjectSyncPlan(current, skills, loadState(runtime), {
					requestedAdapters: normalizeList(options.harness),
				});
				if (options.json) {
					print(
						{
							schemaVersion: 1,
							planHash: plan.planHash,
							manifest: projectManifestToJson(current),
							plan,
						} as unknown as JsonValue,
						true,
					);
				} else {
					console.log(`Project: ${projectRoot}`);
					console.log(renderPlan(plan, { verbose: true, includeOrphans: false }));
				}
				setExitCode(hasConflicts(plan) ? 3 : hasDrift(plan) ? 2 : 0);
			});
		},
	);

cli
	.command("resolve <slug>", "Resolve a canonical skill and its route parents")
	.option("--json", "Output JSON")
	.option("--projects-root <path>", "Override configured projects root")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((rawSlug: string, options: GlobalOptions) => {
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			config.projectsRoots = resolveProjectsOverride(
				config.projectsRoots,
				options,
			);
			const harnesses = resolveHarnesses(runtime.homeDir, config);
			const { skills } = discoverSkillSet(config, harnesses);
			const requestedSlug = slugify(rawSlug);
			const deprecationChain: string[] = [];
			const visited = new Set<string>();
			let resolvedSlug = requestedSlug;
			let skill: DiscoveredSkill | undefined;
			while (true) {
				if (visited.has(resolvedSlug)) {
					throw new Error(
						`Deprecation cycle while resolving ${requestedSlug}: ${[
							...deprecationChain,
							resolvedSlug,
						].join(" -> ")}`,
					);
				}
				visited.add(resolvedSlug);
				deprecationChain.push(resolvedSlug);
				const matches = skills.filter(
					(candidate) => candidate.canonicalSlug === resolvedSlug,
				);
				if (matches.length !== 1) {
					throw new Error(
						matches.length === 0
							? `No discovered skill matches ${resolvedSlug}`
							: `Skill ${resolvedSlug} is ambiguous across ${matches.length} sources`,
					);
				}
				skill = matches[0];
				if (!skill) {
					throw new Error(`No discovered skill matches ${resolvedSlug}`);
				}
				if (!skill.deprecatedBy) break;
				resolvedSlug = skill.deprecatedBy;
			}
			const routedFrom = skills
				.filter((candidate) => candidate.routes.includes(resolvedSlug))
				.map((candidate) => candidate.canonicalSlug)
				.sort();
			print(
				{
					schemaVersion: 1,
					requestedSlug,
					slug: resolvedSlug,
					deprecatedAliases: deprecationChain.slice(0, -1),
					visibility: skill.visibility,
					skillFilePath: skill.skillFilePath,
					sourcePath: skill.sourcePath,
					routes: skill.routes,
					routedFrom,
					deprecatedBy: skill.deprecatedBy,
				} as unknown as JsonValue,
				Boolean(options.json),
			);
		});
	});

cli
	.command("sources", "List discovered source skills")
	.option("--json", "Output JSON")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--skill <slug>", "Filter to one or more skill slugs")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			config.projectsRoots = resolveProjectsOverride(
				config.projectsRoots,
				options,
			);
			const harnesses = resolveHarnesses(runtime.homeDir, config).filter(
				(harness) => harness.enabled,
			);
			const { skills: allSkills, sourceDiagnostics } = discoverSkillSet(config, harnesses);
			const skills = selectDiscoveredSkills(allSkills, options);
			const selectedDiagnostics = selectSourceDiagnostics(sourceDiagnostics, options);
			if (options.json) {
				print({ skills, sourceDiagnostics: selectedDiagnostics } as unknown as JsonValue, true);
				return;
			}
			console.log(`Discovered ${skills.length} skill source(s)`);
			const sourceLines: string[] = [];
			appendSourceDiagnostics(sourceLines, selectedDiagnostics);
			if (sourceLines.length > 0) {
				console.log(sourceLines.join("\n"));
				console.log("");
			}
			for (const skill of skills) {
				console.log(`- ${describeSkill(skill)}`);
			}
		});
	});

cli
	.command("harnesses", "List known harness roots and detection status")
	.option("--json", "Output JSON")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		withRuntime(options, (runtime) => {
			const harnesses = resolveHarnesses(runtime.homeDir, loadConfig(runtime));
			if (options.json) {
				print(harnesses as unknown as JsonValue, true);
				return;
			}
			for (const harness of harnesses) {
				console.log(`${harness.id}  ${harness.rootPath}`);
				console.log(`  kind: ${harness.kind}`);
				console.log(`  detected: ${harness.detected ? "yes" : "no"}`);
				console.log(`  enabled: ${harness.enabled ? "yes" : "no"}`);
			}
		});
	});

cli
	.command("backup <action> [target]", "Backup commands: create, list, restore")
	.option("--json", "Output JSON")
	.option("--dry-run", "Show what would happen without mutating")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.option("--harness <id>", "Filter to one or more harness ids")
	.action(
		(action: string, target: string | undefined, options: GlobalOptions) => {
			withRuntime(options, (runtime) => {
				if (action === "create") {
					const config = loadConfig(runtime);
					const harnesses = resolveSelectedHarnesses(
						resolveHarnesses(runtime.homeDir, config),
						options,
					);
					const manifest = createBackup(runtime, harnesses, loadState(runtime));
					if (options.json) {
						print(manifest as unknown as JsonValue, true);
						return;
					}
					console.log(`Created backup ${manifest.id}`);
					for (const harness of manifest.harnesses) {
						console.log(
							`- ${harness.id}: ${harness.entries.length} entr${harness.entries.length === 1 ? "y" : "ies"}`,
						);
					}
					return;
				}
				if (action === "list") {
					const backups = listBackups(runtime);
					if (options.json) {
						print(backups as unknown as JsonValue, true);
						return;
					}
					if (backups.length === 0) {
						console.log("No backups found");
						return;
					}
					for (const backupEntry of backups) {
						console.log(`${backupEntry.id}  ${backupEntry.createdAt}`);
						console.log(
							`  harnesses: ${backupEntry.harnesses.map((harness) => harness.id).join(", ") || "-"}`,
						);
					}
					return;
				}
				if (action === "restore") {
					if (!target) {
						throw new Error("backup restore requires a backup id");
					}
					const config = loadConfig(runtime);
					const harnesses = resolveHarnesses(runtime.homeDir, config);
					const selectedIds = expandSelectedHarnessIds(
						normalizeList(options.harness),
						harnesses,
					);
					const { manifest, nextState } = restoreBackup(
						runtime,
						target,
						selectedIds,
						Boolean(options.dryRun),
						loadState(runtime),
					);
					if (!options.dryRun) {
						saveState(runtime, nextState);
					}
					if (options.json) {
						print(manifest as unknown as JsonValue, true);
						return;
					}
					console.log(
						`${options.dryRun ? "Would restore" : "Restored"} backup ${manifest.id}`,
					);
					for (const harness of manifest.harnesses) {
						if (selectedIds.length > 0 && !selectedIds.includes(harness.id)) {
							continue;
						}
						console.log(
							`- ${harness.id}: ${harness.entries.length} entr${harness.entries.length === 1 ? "y" : "ies"}`,
						);
					}
					return;
				}
				throw new Error(`Unknown backup action: ${action}`);
			});
		},
	);

cli
	.command("config <action>", "Config commands: init, strict-visibility, visibility-budget")
	.option("--json", "Output JSON")
	.option("--enable", "Enable the selected policy")
	.option("--disable", "Disable the selected policy")
	.option("--global <tokens>", "Maximum global skill-index tokens")
	.option("--project <tokens>", "Maximum project entrypoint-index tokens")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((action: string, options: GlobalOptions & { enable?: boolean; disable?: boolean; global?: string; project?: string }) => {
		if (action === "strict-visibility") {
			if (options.enable && options.disable) {
				throw new Error("config strict-visibility cannot combine --enable and --disable");
			}
			withRuntime(options, (runtime) => {
				const strict = !options.disable;
				const config = setStrictVisibility(runtime, strict);
				print(
					{
						schemaVersion: 1,
						strictVisibility: config.visibility.strict === true,
						configPath: runtime.configPath,
					} as unknown as JsonValue,
					Boolean(options.json),
				);
			});
			return;
		}
		if (action === "visibility-budget") {
			const parseBudget = (value: string | undefined, label: string) => {
				if (value === undefined) return undefined;
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed <= 0) {
					throw new Error(`${label} visibility budget must be a positive integer`);
				}
				return parsed;
			};
			withRuntime(options, (runtime) => {
				const global = parseBudget(options.global, "global");
				const project = parseBudget(options.project, "project");
				if (global === undefined && project === undefined) {
					throw new Error("config visibility-budget requires --global and/or --project");
				}
				const config = setVisibilityBudgets(runtime, { global, project });
				print(
					{
						schemaVersion: 1,
						maxGlobalIndexTokens: config.visibility.maxGlobalIndexTokens,
						maxProjectIndexTokens: config.visibility.maxProjectIndexTokens,
						configPath: runtime.configPath,
					} as unknown as JsonValue,
					Boolean(options.json),
				);
			});
			return;
		}
		if (action !== "init") {
			throw new Error(`Unknown config action: ${action}`);
		}
		withRuntime(options, (runtime) => {
			const config = initConfig(runtime);
			print(config as unknown as JsonValue, Boolean(options.json));
		});
	});

cli
	.command(
		"harness <action> [id] [rootPath]",
		"Harness commands: list, add, remove",
	)
	.option("--json", "Output JSON")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(
		(
			action: string,
			id: string | undefined,
			rootPath: string | undefined,
			options: GlobalOptions,
		) => {
			if (action === "list") {
				withRuntime(options, (runtime) => {
					const harnesses = resolveHarnesses(
						runtime.homeDir,
						loadConfig(runtime),
					);
					print(
						options.json
							? (harnesses as unknown as JsonValue)
							: harnesses
									.map(
										(item: HarnessDefinition) => `${item.id} ${item.rootPath}`,
									)
									.join("\n"),
						Boolean(options.json),
					);
				});
				return;
			}
			if (!id) {
				throw new Error(`harness ${action} requires an id`);
			}
			if (action === "add") {
				if (!rootPath) {
					throw new Error("harness add requires a root path");
				}
				const config = withRuntime(options, (runtime) =>
					addHarness(runtime, id, rootPath),
				);
				print(config as unknown as JsonValue, Boolean(options.json));
				return;
			}
			if (action === "remove") {
				const config = withRuntime(options, (runtime) =>
					removeHarness(runtime, id),
				);
				print(config as unknown as JsonValue, Boolean(options.json));
				return;
			}
			throw new Error(`Unknown harness action: ${action}`);
		},
	);

cli
	.command(
		"roots <action> [rootPath]",
		"Projects root commands: list, add, remove",
	)
	.option("--json", "Output JSON")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(
		(action: string, rootPath: string | undefined, options: GlobalOptions) => {
			if (action === "list") {
				withRuntime(options, (runtime) => {
					const config = loadConfig(runtime);
					print(
						config.projectsRoots as unknown as JsonValue,
						Boolean(options.json),
					);
				});
				return;
			}
			if (!rootPath) {
				throw new Error(`roots ${action} requires a path`);
			}
			if (action === "add") {
				const config = withRuntime(options, (runtime) =>
					addProjectsRoot(runtime, rootPath),
				);
				print(config as unknown as JsonValue, Boolean(options.json));
				return;
			}
			if (action === "remove") {
				const config = withRuntime(options, (runtime) =>
					removeProjectsRoot(runtime, rootPath),
				);
				print(config as unknown as JsonValue, Boolean(options.json));
				return;
			}
			throw new Error(`Unknown roots action: ${action}`);
		},
	);

cli
	.command(
		"clean",
		"Find and remove polluted symlinks pointing to entire project directories",
	)
	.option("--json", "Output JSON")
	.option("--dry-run", "Show polluted entries without removing them")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			const allHarnesses = resolveHarnesses(runtime.homeDir, config);
			const harnesses = resolveSelectedHarnesses(allHarnesses, options);
			const state = loadState(runtime);
			const polluted = findPollutedSymlinks(harnesses, state);

			if (options.json) {
				if (options.dryRun) {
					print(
						{
							polluted,
							count: polluted.length,
							dryRun: true,
						} as unknown as JsonValue,
						true,
					);
				} else {
					const nextState = cleanPollutedSymlinks(polluted, state, false);
					saveState(runtime, nextState);
					print({ removed: polluted.length } as unknown as JsonValue, true);
				}
				return;
			}

			if (polluted.length === 0) {
				console.log("No polluted symlinks found.");
				return;
			}

			console.log(`Found ${polluted.length} polluted symlink(s):`);
			for (const entry of polluted) {
				console.log(`  ${entry.destinationPath}`);
				console.log(`    target: ${entry.resolvedTarget}`);
				console.log(`    reason: ${entry.reason}`);
			}

			if (options.dryRun) {
				console.log(
					`\n(dry run) ${polluted.length} symlink(s) would be removed`,
				);
				return;
			}

			const nextState = cleanPollutedSymlinks(polluted, state, false);
			saveState(runtime, nextState);
			console.log(
				`\nRemoved ${polluted.length} polluted symlink(s). Re-run 'skill-sync execute' to restore clean links.`,
			);
		});
	});

cli
	.command(
		"repair-sources",
		"Repair broken nested SKILL.md symlinks from pre-migration backups",
	)
	.option("--json", "Output JSON")
	.option("--dry-run", "Show what would be repaired without mutating")
	.option("--projects-root <path>", "Override configured projects root")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			config.projectsRoots = resolveProjectsOverride(
				config.projectsRoots,
				options,
			);
			const report = repairBrokenNestedSkillLinks(
				config,
				Boolean(options.dryRun),
			);
			const summary = {
				broken: report.brokenLinks.length,
				repairable: report.repairedLinks.length,
				skipped: report.skipped.length,
			};

			if (options.json) {
				print({ ...report, summary } as unknown as JsonValue, true);
			} else if (summary.broken === 0) {
				console.log("No broken nested SKILL.md symlinks found.");
			} else {
				console.log(
					`${options.dryRun ? "Found" : "Processed"} ${summary.broken} broken nested SKILL.md symlink(s).`,
				);
				for (const link of report.repairedLinks) {
					const verb = options.dryRun ? "would restore" : "restored";
					console.log(`  ${verb}: ${link.skillFilePath}`);
					if (link.backupPath) {
						console.log(`    backup: ${link.backupPath}`);
					}
				}
				for (const skipped of report.skipped) {
					console.log(`  skipped: ${skipped.link.skillFilePath}`);
					console.log(`    reason: ${skipped.reason}`);
				}
				console.log(
					`\nSummary: ${summary.repairable} ${options.dryRun ? "would repair" : "repaired"}, ${summary.skipped} skipped`,
				);
			}

			if (summary.broken > 0 && (options.dryRun || summary.skipped > 0)) {
				setExitCode(2);
			}
		});
	});

cli
	.command(
		"cache-bust",
		"Touch skill files/config to trigger harness reload watchers",
	)
	.option("--json", "Output JSON")
	.option("--dry-run", "Show cache-bust targets without mutating")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		withRuntime(options, (runtime) => {
			const config = loadConfig(runtime);
			const allHarnesses = resolveHarnesses(runtime.homeDir, config);
			const harnesses = resolveSelectedHarnesses(allHarnesses, options);
			const targets = collectCacheBustTargets(harnesses, runtime.homeDir);
			const result = applyCacheBust(targets, Boolean(options.dryRun));

			if (options.json) {
				print(result as unknown as JsonValue, true);
				return;
			}

			if (result.totalTargets === 0) {
				console.log("No cache-bust targets found for selected harnesses.");
				return;
			}

			console.log(
				`${options.dryRun ? "Would touch" : "Touched"} ${result.touched.length}/${result.totalTargets} cache-bust target(s).`,
			);
			for (const target of result.touched) {
				console.log(`  ${target.path}`);
			}
			for (const skipped of result.skipped) {
				console.log(`  skipped: ${skipped.target.path}`);
				console.log(`    reason: ${skipped.reason}`);
			}

			if (result.skipped.length > 0) {
				setExitCode(2);
			}
		});
	});

cli.help();
cli.version(version);
cli.option("--json", "Output JSON");
cli.option("--dry-run", "Show changes without mutating");
cli.option("--verbose", "Show detailed plan output");
cli.option("--projects-root <path>", "Override configured projects root");
cli.option("--harness <id>", "Filter to one or more harness ids");
cli.option(
	"--home <path>",
	"Override HOME for skill-sync state and harness resolution",
);
const rawArgs = process.argv.slice(2);
cli.parse();

const shouldRunDefaultSync =
	rawArgs.length > 0 &&
	!rawArgs.includes("--help") &&
	!rawArgs.includes("-h") &&
	!rawArgs.includes("--version") &&
	!rawArgs.includes("-v") &&
	!cli.matchedCommand;

if (shouldRunDefaultSync) {
	print(renderLandingHelp(), false);
}

if (rawArgs.length === 0) {
	print(renderLandingHelp(), false);
}
