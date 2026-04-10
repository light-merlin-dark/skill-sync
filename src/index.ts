#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { cac } from "cac";
import { createBackup, listBackups, restoreBackup } from "./core/backup";
import { applyCacheBust, collectCacheBustTargets } from "./core/cache";
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
} from "./core/config";
import { filterHarnesses, resolveHarnesses } from "./core/harnesses";
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
import { buildRuntimeContext } from "./core/utils";

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
	continueOnConflict?: boolean;
	projectsRoot?: string | string[];
	harness?: string | string[];
};

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

function expandSelectedHarnessIds(selectedIds: string[]): string[] {
	const expanded = new Set(selectedIds);
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
		expandSelectedHarnessIds(normalizeList(options.harness)),
	);
}

function resolveSyncPlanOptions(
	harnesses: HarnessDefinition[],
	options: GlobalOptions,
): { codexVisibilityBridge: boolean; rawSelectedHarnessIds: string[] } {
	const harnessIds = new Set(harnesses.map((harness) => harness.id));
	return {
		codexVisibilityBridge: harnessIds.has("codex") && harnessIds.has("agents"),
		rawSelectedHarnessIds: normalizeList(options.harness),
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
} {
	return withRuntime(options, (runtime) => {
		const config = loadConfig(runtime);
		config.projectsRoots = resolveProjectsOverride(
			config.projectsRoots,
			options,
		);
		const allHarnesses = resolveHarnesses(runtime.homeDir, config);
		const harnesses = resolveSelectedHarnesses(allHarnesses, options);
		const { skills, sourceDiagnostics } = discoverSkillSet(
			config,
			allHarnesses,
		);
		const state = loadState(runtime);
		const plan = buildSyncPlan(
			skills,
			harnesses,
			config,
			state,
			sourceDiagnostics,
			resolveSyncPlanOptions(harnesses, options),
		);
		return { runtime, plan, harnesses, skills, state };
	});
}

function printDoctorResult(
	plan: SyncPlan,
	options: GlobalOptions,
	state: ReturnType<typeof loadState>,
	skills: DiscoveredSkill[],
	harnessCount: number,
): never {
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
					},
				} as unknown as JsonValue)
			: renderDoctorReport(plan, state, skills, harnessCount, options.verbose),
		Boolean(options.json),
	);
	process.exit(hasConflicts(plan) ? 3 : hasDrift(plan) ? 2 : 0);
}

cli
	.command("doctor", "Inspect current sources, drift, and orphan installs")
	.option("--json", "Output JSON")
	.option("--dry-run", "Accepted for parity; check is always read-only")
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		const { plan, state, skills, harnesses } = planSync(options);
		printDoctorResult(plan, options, state, skills, harnesses.length);
	});

cli
	.command("check", "Alias for doctor")
	.option("--json", "Output JSON")
	.option("--dry-run", "Accepted for parity; check is always read-only")
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((options: GlobalOptions) => {
		const { plan, state, skills, harnesses } = planSync(options);
		printDoctorResult(plan, options, state, skills, harnesses.length);
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
					process.exit(2);
				}
			});
		},
	);

function runExecute(options: GlobalOptions): void {
	const { runtime, plan, state } = planSync(options);
	const hasPlanConflicts = hasConflicts(plan);
	if (hasPlanConflicts && !options.continueOnConflict) {
		print(
			options.json
				? (plan as unknown as JsonValue)
				: renderPlan(plan, { verbose: true, includeOrphans: true }),
			Boolean(options.json),
		);
		process.exit(3);
	}
	const nextState = applySyncPlan(plan, state, Boolean(options.dryRun));
	if (!options.dryRun) {
		saveState(runtime, nextState);
	}
	print(
		options.json
			? (plan as unknown as JsonValue)
			: renderPlan(plan, { verbose: options.verbose, includeOrphans: false }),
		Boolean(options.json),
	);
	if (hasPlanConflicts) {
		process.exit(3);
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
		if (applyChanges && (!hasPlanConflicts || options.continueOnConflict)) {
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
			process.exit(3);
		}
		if (
			postCodexAudit &&
			(postCodexAudit.invalidEntries.length > 0 ||
				postCodexAudit.staleEntries.length > 0 ||
				postCodexAudit.runtimeMissingSkills.length > 0 ||
				postCodexAudit.runtimeMissingSkillsInstalledAfterSnapshot.length > 0)
		) {
			process.exit(2);
		}
		if (
			postCodexWorkspaceProbes.some(
				(probe) =>
					probe.status === "ok" && probe.missingManagedSkills.length > 0,
			)
		) {
			process.exit(2);
		}
		if (
			hasDrift(postPlan) ||
			repairReport.skipped.length > 0 ||
			cacheResult.skipped.length > 0
		) {
			process.exit(2);
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
	.option(
		"--continue-on-conflict",
		"Apply non-conflicting changes and still exit non-zero if conflicts remain",
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
	.option(
		"--continue-on-conflict",
		"Apply non-conflicting changes and still exit non-zero if conflicts remain",
	)
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(runExecute);

cli
	.command("sync", "Alias for execute")
	.option("--json", "Output JSON")
	.option("--dry-run", "Show changes without mutating")
	.option(
		"--continue-on-conflict",
		"Apply non-conflicting changes and still exit non-zero if conflicts remain",
	)
	.option("--verbose", "Show detailed plan output")
	.option("--projects-root <path>", "Override configured projects root")
	.option("--harness <id>", "Filter to one or more harness ids")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action(runExecute);

cli
	.command("sources", "List discovered source skills")
	.option("--json", "Output JSON")
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
			const harnesses = resolveHarnesses(runtime.homeDir, config).filter(
				(harness) => harness.enabled,
			);
			const { skills, sourceDiagnostics } = discoverSkillSet(config, harnesses);
			if (options.json) {
				print({ skills, sourceDiagnostics } as unknown as JsonValue, true);
				return;
			}
			console.log(`Discovered ${skills.length} skill source(s)`);
			const sourceLines: string[] = [];
			appendSourceDiagnostics(sourceLines, sourceDiagnostics);
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
					const { manifest, nextState } = restoreBackup(
						runtime,
						target,
						expandSelectedHarnessIds(normalizeList(options.harness)),
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
					const selectedIds = expandSelectedHarnessIds(
						normalizeList(options.harness),
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
	.command("config <action>", "Config commands: init")
	.option("--json", "Output JSON")
	.option(
		"--home <path>",
		"Override HOME for skill-sync state and harness resolution",
	)
	.action((action: string, options: GlobalOptions) => {
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
				process.exit(2);
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
				process.exit(2);
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
