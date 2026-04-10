import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { InstallMode } from "./types";
import { parseSkillFrontmatterContent, pathOwnsEntry } from "./utils";

type CodexSkillsConfigEntry = {
	startLine: number;
	endLine: number;
	path?: string;
	name?: string;
	enabled?: boolean;
	issues: string[];
	stale: boolean;
	rewritePath?: string;
};

type CodexInstalledSkillStatus = {
	harnessId: string;
	installMode?: InstallMode;
	installName: string;
	skillFilePath: string;
	resolvedSkillFilePath?: string;
	exists: boolean;
	isSymlink: boolean;
	skillFileMtimeMs?: number;
	managedBySkillSync: boolean;
	yamlValid: boolean;
	frontmatterName?: string;
	frontmatterIssues: string[];
	disabledByConfig: boolean;
};

type CodexRuntimeSkillSnapshot = {
	source: "thread-session" | "latest-session";
	sessionPath: string;
	sessionMtimeMs: number;
	threadId?: string;
	capturedAtMs: number;
	capturedAtIso?: string;
	ageHours: number;
	maxAgeHours: number;
	stale: boolean;
	availableSkills: string[];
};

type CodexAuditReport = {
	configPath: string;
	codexSkillsRoot: string;
	configExists: boolean;
	entries: CodexSkillsConfigEntry[];
	installed: CodexInstalledSkillStatus[];
	invalidEntries: CodexSkillsConfigEntry[];
	staleEntries: CodexSkillsConfigEntry[];
	rewriteCandidates: CodexSkillsConfigEntry[];
	runtimeSnapshot?: CodexRuntimeSkillSnapshot;
	runtimeMissingSkills: string[];
	runtimeMissingSkillsUncertain: string[];
	runtimeMissingSkillsInstalledAfterSnapshot: string[];
};

type CodexWorkspaceVisibilityStatus =
	| "ok"
	| "codex-binary-missing"
	| "probe-error";

type CodexWorkspaceVisibilityReport = {
	cwd: string;
	status: CodexWorkspaceVisibilityStatus;
	codexBinaryPath?: string;
	directAvailableSkills: string[];
	directErrors: string[];
	extraUserRoots: string[];
	extraRootAvailableSkills: string[];
	extraRootErrors: string[];
	missingManagedSkills: string[];
	missingManagedSkillsRecoveredWithExtraRoots: string[];
	missingManagedSkillsStillMissing: string[];
	error?: string;
};

type CodexConfigRepairReport = {
	dryRun: boolean;
	updated: boolean;
	removedInvalid: number;
	removedStale: number;
	rewrittenLegacy: number;
	kept: number;
};

type Block = {
	start: number;
	end: number;
	lines: string[];
	entry: CodexSkillsConfigEntry;
};

const LEGACY_ALIAS_PATH_REWRITES: Record<string, string> = {
	"/skills/dev-control/SKILL.md": "/skills/dev/SKILL.md",
	"/skills/prod-control/SKILL.md": "/skills/prod/SKILL.md",
};
const DEFAULT_RUNTIME_MAX_AGE_HOURS = 12;
const CODEX_APP_SERVER_TIMEOUT_MS = 10_000;

export function auditCodex(
	homeDir: string,
	options?: {
		threadId?: string;
		includeRuntimeSnapshot?: boolean;
		runtimeMaxAgeHours?: number;
	},
): CodexAuditReport {
	const configPath = join(homeDir, ".codex", "config.toml");
	const codexSkillsRoot = join(homeDir, ".codex", "skills");
	const configExists = existsSync(configPath);
	const entries = configExists
		? parseCodexSkillsConfig(readFileSync(configPath, "utf8"))
		: [];
	const managedCodexEntries = loadManagedCodexTrackedEntries(homeDir);
	const installed = collectInstalledCodexSkills(
		homeDir,
		entries,
		managedCodexEntries,
	);
	const runtimeMaxAgeHours =
		options?.runtimeMaxAgeHours || DEFAULT_RUNTIME_MAX_AGE_HOURS;
	const runtimeSnapshot =
		options?.includeRuntimeSnapshot === false
			? undefined
			: findCodexRuntimeSkillSnapshot(
					homeDir,
					options?.threadId || process.env.CODEX_THREAD_ID,
					runtimeMaxAgeHours,
				);
	const runtimeMissingAnalysis = runtimeSnapshot
		? computeRuntimeMissingSkills(
				installed,
				runtimeSnapshot.availableSkills,
				runtimeSnapshot.capturedAtMs,
			)
		: { missingSkills: [], missingSkillsInstalledAfterSnapshot: [] };
	const runtimeMissingSkillsRaw = runtimeMissingAnalysis.missingSkills;
	const runtimeMissingSkillsInstalledAfterSnapshotRaw =
		runtimeMissingAnalysis.missingSkillsInstalledAfterSnapshot;
	const runtimeMissingSkills =
		runtimeSnapshot && !runtimeSnapshot.stale ? runtimeMissingSkillsRaw : [];
	const runtimeMissingSkillsUncertain = runtimeSnapshot?.stale
		? runtimeMissingSkillsRaw
		: [];
	const runtimeMissingSkillsInstalledAfterSnapshot = runtimeSnapshot
		? runtimeMissingSkillsInstalledAfterSnapshotRaw
		: [];
	return {
		configPath,
		codexSkillsRoot,
		configExists,
		entries,
		installed,
		invalidEntries: entries.filter((entry) => entry.issues.length > 0),
		staleEntries: entries.filter((entry) => entry.stale),
		rewriteCandidates: entries.filter((entry) => Boolean(entry.rewritePath)),
		runtimeSnapshot,
		runtimeMissingSkills,
		runtimeMissingSkillsUncertain,
		runtimeMissingSkillsInstalledAfterSnapshot,
	};
}

export function repairCodexSkillsConfig(
	homeDir: string,
	dryRun: boolean,
): CodexConfigRepairReport {
	const configPath = join(homeDir, ".codex", "config.toml");
	if (!existsSync(configPath)) {
		return {
			dryRun,
			updated: false,
			removedInvalid: 0,
			removedStale: 0,
			rewrittenLegacy: 0,
			kept: 0,
		};
	}

	const content = readFileSync(configPath, "utf8");
	const lines = content.split(/\r?\n/);
	const blocks = parseCodexConfigBlocks(content);

	const byStart = new Map<number, Block>();
	for (const block of blocks) {
		byStart.set(block.start, block);
	}

	let removedInvalid = 0;
	let removedStale = 0;
	let rewrittenLegacy = 0;
	let kept = 0;

	const output: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const block = byStart.get(index);
		if (!block) {
			output.push(lines[index] ?? "");
			index += 1;
			continue;
		}

		const hasInvalidIssue = block.entry.issues.length > 0;
		if (hasInvalidIssue) {
			removedInvalid += 1;
			index = block.end;
			continue;
		}
		if (block.entry.stale && !block.entry.rewritePath) {
			removedStale += 1;
			index = block.end;
			continue;
		}
		if (block.entry.rewritePath && block.entry.path) {
			rewrittenLegacy += 1;
			kept += 1;
			output.push(
				...rewriteBlockPath(
					block.lines,
					block.entry.path,
					block.entry.rewritePath,
				),
			);
			index = block.end;
			continue;
		}

		kept += 1;
		output.push(...block.lines);
		index = block.end;
	}

	const nextContent = `${output.join("\n").replace(/\n+$/, "\n")}`;
	const updated = nextContent !== content;
	if (!dryRun && updated) {
		writeFileSync(configPath, nextContent, "utf8");
	}

	return {
		dryRun,
		updated,
		removedInvalid,
		removedStale,
		rewrittenLegacy,
		kept,
	};
}

function collectInstalledCodexSkills(
	homeDir: string,
	entries: CodexSkillsConfigEntry[],
	managedCodexEntries: Map<
		string,
		{ harnessId: string; installMode?: InstallMode }
	>,
): CodexInstalledSkillStatus[] {
	const disabledPathSet = new Set(
		entries
			.filter(
				(
					entry,
				): entry is CodexSkillsConfigEntry & {
					path: string;
				} => Boolean(entry.path) && entry.enabled === false,
			)
			.map((entry) => entry.path),
	);

	return [
		...collectInstalledSkillStatuses(
			join(homeDir, ".codex", "skills"),
			"codex",
			true,
			disabledPathSet,
			managedCodexEntries,
		),
		...collectInstalledSkillStatuses(
			join(homeDir, ".agents", "skills"),
			"agents",
			false,
			disabledPathSet,
			managedCodexEntries,
		),
	].sort(
		(a, b) =>
			a.installName.localeCompare(b.installName) ||
			a.harnessId.localeCompare(b.harnessId),
	);
}

function collectInstalledSkillStatuses(
	skillsRoot: string,
	defaultHarnessId: string,
	includeUnmanagedChildren: boolean,
	disabledPathSet: Set<string>,
	managedEntries: Map<string, { harnessId: string; installMode?: InstallMode }>,
): CodexInstalledSkillStatus[] {
	const candidateDirs = new Set<string>();
	if (includeUnmanagedChildren && existsSync(skillsRoot)) {
		try {
			for (const child of readdirSync(skillsRoot)) {
				if (child.startsWith(".")) {
					continue;
				}
				candidateDirs.add(join(skillsRoot, child));
			}
		} catch {}
	}

	for (const managedPath of managedEntries.keys()) {
		if (pathOwnsEntry(skillsRoot, managedPath)) {
			candidateDirs.add(managedPath);
		}
	}

	const statuses: CodexInstalledSkillStatus[] = [];
	for (const skillDir of [...candidateDirs].sort((a, b) =>
		a.localeCompare(b),
	)) {
		let dirStats: ReturnType<typeof lstatSync> | undefined;
		try {
			dirStats = lstatSync(skillDir);
		} catch {
			dirStats = undefined;
		}
		if (dirStats && !dirStats.isDirectory()) {
			continue;
		}
		const managedEntry = managedEntries.get(skillDir);
		const skillFilePath = join(skillDir, "SKILL.md");
		const exists = existsSync(skillFilePath);
		let resolvedSkillFilePath: string | undefined;
		let isSymlink = false;
		let skillFileMtimeMs: number | undefined;
		let yamlValid = false;
		let frontmatterName: string | undefined;
		let frontmatterIssues: string[] = [];
		if (exists) {
			try {
				isSymlink = lstatSync(skillFilePath).isSymbolicLink();
			} catch {
				isSymlink = false;
			}
			try {
				resolvedSkillFilePath = realpathSync(skillFilePath);
			} catch {
				resolvedSkillFilePath = undefined;
			}
			const mtimeCandidates: number[] = [];
			try {
				mtimeCandidates.push(lstatSync(skillFilePath).mtimeMs);
			} catch {}
			try {
				mtimeCandidates.push(statSync(skillFilePath).mtimeMs);
			} catch {}
			if (mtimeCandidates.length > 0) {
				skillFileMtimeMs = Math.max(...mtimeCandidates);
			}
			const frontmatter = parseSkillFrontmatterContent(
				readFileSync(skillFilePath, "utf8"),
			);
			frontmatterName = frontmatter.name;
			frontmatterIssues = frontmatter.issues;
			yamlValid = frontmatter.issues.every(
				(issue) => !issue.startsWith("invalid YAML frontmatter:"),
			);
		}

		statuses.push({
			harnessId: managedEntry?.harnessId || defaultHarnessId,
			installMode: managedEntry?.installMode,
			installName: basename(skillDir),
			skillFilePath,
			resolvedSkillFilePath,
			exists,
			isSymlink,
			skillFileMtimeMs,
			managedBySkillSync: Boolean(managedEntry),
			yamlValid,
			frontmatterName,
			frontmatterIssues,
			disabledByConfig: disabledPathSet.has(skillFilePath),
		});
	}
	return statuses;
}

function loadManagedCodexTrackedEntries(
	homeDir: string,
): Map<string, { harnessId: string; installMode?: InstallMode }> {
	const statePath = join(homeDir, ".skill-sync", "state.json");
	if (!existsSync(statePath)) {
		return new Map<string, { harnessId: string; installMode?: InstallMode }>();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
	} catch {
		return new Map<string, { harnessId: string; installMode?: InstallMode }>();
	}

	if (!parsed || typeof parsed !== "object" || !("managedEntries" in parsed)) {
		return new Map<string, { harnessId: string; installMode?: InstallMode }>();
	}
	const managedEntries = (
		parsed as {
			managedEntries?: Record<
				string,
				{ harnessId?: string; installMode?: InstallMode }
			>;
		}
	).managedEntries;
	if (!managedEntries || typeof managedEntries !== "object") {
		return new Map<string, { harnessId: string; installMode?: InstallMode }>();
	}

	const codexSkillsRoot = join(homeDir, ".codex", "skills");
	const agentsSkillsRoot = join(homeDir, ".agents", "skills");
	const managed = new Map<
		string,
		{ harnessId: string; installMode?: InstallMode }
	>();
	for (const [path, entry] of Object.entries(managedEntries)) {
		if (!entry) {
			continue;
		}
		if (entry.harnessId === "codex" && pathOwnsEntry(codexSkillsRoot, path)) {
			managed.set(path, {
				harnessId: entry.harnessId,
				installMode: entry.installMode,
			});
			continue;
		}
		if (entry.harnessId === "agents" && pathOwnsEntry(agentsSkillsRoot, path)) {
			managed.set(path, {
				harnessId: entry.harnessId,
				installMode: entry.installMode,
			});
		}
	}
	return managed;
}

export function parseCodexSkillsConfig(
	content: string,
): CodexSkillsConfigEntry[] {
	return parseCodexConfigBlocks(content).map((block) => block.entry);
}

function parseCodexConfigBlocks(content: string): Block[] {
	const lines = content.split(/\r?\n/);
	const blocks: Block[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.trim() !== "[[skills.config]]") {
			continue;
		}
		const start = index;
		let end = lines.length;
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			const line = lines[cursor];
			if (line === undefined) {
				continue;
			}
			const trimmed = line.trim();
			if (trimmed === "[[skills.config]]") {
				end = cursor;
				break;
			}
			if (trimmed.startsWith("[") && trimmed !== "[[skills.config]]") {
				end = cursor;
				break;
			}
		}
		const blockLines = lines.slice(start, end);
		blocks.push({
			start,
			end,
			lines: blockLines,
			entry: parseCodexSkillsConfigBlock(blockLines, start),
		});
		index = end - 1;
	}
	return blocks;
}

function parseCodexSkillsConfigBlock(
	lines: string[],
	startIndex: number,
): CodexSkillsConfigEntry {
	const raw = lines.join("\n");
	const pathMatch = raw.match(/^\s*path\s*=\s*"([^"]+)"\s*$/m);
	const nameMatch = raw.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m);
	const enabledMatch = raw.match(/^\s*enabled\s*=\s*(true|false)\s*$/m);
	const path = pathMatch?.[1];
	const name = nameMatch?.[1];
	const enabled = enabledMatch ? enabledMatch[1] === "true" : undefined;

	const issues: string[] = [];
	if (!path && name) {
		issues.push(
			"skills.config entry uses name without path (invalid for Codex parser)",
		);
	}
	if (!path && !name) {
		issues.push("skills.config entry is missing both path and name");
	}
	if (!enabledMatch) {
		issues.push("skills.config entry is missing enabled");
	}

	const stale = Boolean(path?.startsWith("/") && !existsSync(path));
	let rewritePath: string | undefined;
	if (path) {
		for (const [fromSuffix, toSuffix] of Object.entries(
			LEGACY_ALIAS_PATH_REWRITES,
		)) {
			if (!path.endsWith(fromSuffix)) {
				continue;
			}
			const candidate = `${path.slice(0, -fromSuffix.length)}${toSuffix}`;
			if (existsSync(candidate)) {
				rewritePath = candidate;
			}
			break;
		}
	}

	return {
		startLine: startIndex + 1,
		endLine: startIndex + lines.length,
		path,
		name,
		enabled,
		issues,
		stale,
		rewritePath,
	};
}

function rewriteBlockPath(
	lines: string[],
	fromPath: string,
	toPath: string,
): string[] {
	return lines.map((line) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("path =")) {
			return line;
		}
		return line.replace(fromPath, toPath);
	});
}

export function summarizeCodexAudit(report: CodexAuditReport): string {
	const lines: string[] = [];
	lines.push("Codex audit");
	lines.push(
		`- config: ${report.configExists ? "present" : "missing"} (${report.configPath})`,
	);
	lines.push(`- installed skills: ${report.installed.length}`);
	const managedInstalls = report.installed.filter(
		(item) => item.managedBySkillSync,
	);
	const managedMissingFiles = managedInstalls.filter(
		(item) => !item.exists,
	).length;
	const managedLayoutMismatch = managedInstalls.filter(
		(item) => item.exists && hasCodexInstallLayoutMismatch(item),
	).length;
	const managedInvalidYaml = managedInstalls.filter(
		(item) => item.exists && !item.yamlValid,
	).length;
	const managedDisabledByConfig = managedInstalls.filter(
		(item) => item.disabledByConfig,
	).length;
	const unmanagedInstalls = report.installed.length - managedInstalls.length;
	lines.push(
		`- install integrity (managed=${managedInstalls.length}, unmanaged=${unmanagedInstalls}): missing=${managedMissingFiles}, layout-mismatch=${managedLayoutMismatch}, invalid-yaml=${managedInvalidYaml}, disabled-by-config=${managedDisabledByConfig}`,
	);
	lines.push(
		`- codex config entries: total=${report.entries.length}, invalid=${report.invalidEntries.length}, stale=${report.staleEntries.length}, rewrite-candidates=${report.rewriteCandidates.length}`,
	);
	if (report.runtimeSnapshot) {
		const freshness = report.runtimeSnapshot.stale ? "stale" : "fresh";
		const capturedAt =
			report.runtimeSnapshot.capturedAtIso ||
			new Date(report.runtimeSnapshot.capturedAtMs).toISOString();
		lines.push(
			`- runtime snapshot: ${report.runtimeSnapshot.availableSkills.length} skill(s) from ${report.runtimeSnapshot.source} (${freshness}, age=${report.runtimeSnapshot.ageHours.toFixed(1)}h, captured=${capturedAt}, file=${report.runtimeSnapshot.sessionPath})`,
		);
		lines.push(
			`- runtime visibility gaps (confirmed): ${report.runtimeMissingSkills.length}`,
		);
		if (report.runtimeMissingSkills.length > 0) {
			lines.push(
				`  missing in runtime: ${report.runtimeMissingSkills.join(", ")}`,
			);
		}
		if (report.runtimeMissingSkillsUncertain.length > 0) {
			lines.push(
				`- runtime visibility gaps (uncertain, stale snapshot): ${report.runtimeMissingSkillsUncertain.length}`,
			);
			lines.push(
				`  missing in stale snapshot: ${report.runtimeMissingSkillsUncertain.join(", ")}`,
			);
		}
		if (report.runtimeMissingSkillsInstalledAfterSnapshot.length > 0) {
			lines.push(
				`- runtime/install snapshot drift: ${report.runtimeMissingSkillsInstalledAfterSnapshot.length} missing skill(s) were installed or updated after snapshot capture`,
			);
			lines.push(
				`  likely requires Codex thread refresh/new thread: ${report.runtimeMissingSkillsInstalledAfterSnapshot.join(", ")}`,
			);
		}
	} else {
		lines.push(
			"- runtime snapshot: unavailable (no parsable Codex session snapshot found)",
		);
	}
	return lines.join("\n");
}

export function hasCodexInstallLayoutMismatch(
	item: CodexInstalledSkillStatus,
): boolean {
	if (!item.managedBySkillSync || !item.exists) {
		return false;
	}
	if (item.installMode === "wrapper-symlink") {
		return !item.isSymlink;
	}
	return item.isSymlink;
}

export function summarizeCodexConfigRepair(
	report: CodexConfigRepairReport,
): string {
	return [
		`Codex config repair (${report.dryRun ? "dry-run" : "apply"})`,
		`- updated: ${report.updated ? "yes" : "no"}`,
		`- removed invalid entries: ${report.removedInvalid}`,
		`- removed stale entries: ${report.removedStale}`,
		`- rewritten legacy aliases: ${report.rewrittenLegacy}`,
		`- kept entries: ${report.kept}`,
	].join("\n");
}

export function summarizeCodexWorkspaceVisibilityReport(
	report: CodexWorkspaceVisibilityReport,
): string {
	const lines: string[] = [];
	if (report.status === "codex-binary-missing") {
		lines.push(`Codex workspace visibility (${report.cwd})`);
		lines.push("- app-server probe: unavailable (codex binary not found)");
		return lines.join("\n");
	}

	if (report.status === "probe-error") {
		lines.push(`Codex workspace visibility (${report.cwd})`);
		lines.push(
			`- app-server probe: failed${report.codexBinaryPath ? ` (${report.codexBinaryPath})` : ""}`,
		);
		if (report.error) {
			lines.push(`  ${report.error}`);
		}
		return lines.join("\n");
	}

	lines.push(`Codex workspace visibility (${report.cwd})`);
	lines.push(
		`- direct skills/list: ${report.directAvailableSkills.length} visible skill(s), missing-managed=${report.missingManagedSkills.length}`,
	);
	if (report.missingManagedSkills.length === 0) {
		lines.push(
			"- managed codex installs are visible in direct app-server workspace listing",
		);
	}
	if (report.missingManagedSkillsRecoveredWithExtraRoots.length > 0) {
		lines.push(
			`- root-recognition gap: ${report.missingManagedSkillsRecoveredWithExtraRoots.length} managed skill(s) only appear when extra user roots are supplied`,
		);
		lines.push(
			`  recovered with extra roots: ${report.missingManagedSkillsRecoveredWithExtraRoots.join(", ")}`,
		);
	}
	if (report.missingManagedSkillsStillMissing.length > 0) {
		lines.push(
			`- still missing after extra roots: ${report.missingManagedSkillsStillMissing.join(", ")}`,
		);
	}
	if (report.extraUserRoots.length > 0) {
		lines.push(`- candidate extra user roots: ${report.extraUserRoots.length}`);
		for (const root of report.extraUserRoots) {
			lines.push(`  ${root}`);
		}
	}
	if (report.directErrors.length > 0) {
		lines.push(`- direct probe errors: ${report.directErrors.join(" | ")}`);
	}
	if (report.extraRootErrors.length > 0) {
		lines.push(
			`- extra-root probe errors: ${report.extraRootErrors.join(" | ")}`,
		);
	}
	return lines.join("\n");
}

export async function probeCodexWorkspaceVisibility(
	homeDir: string,
	cwd: string,
	installed: CodexInstalledSkillStatus[],
): Promise<CodexWorkspaceVisibilityReport> {
	const codexBinaryPath = resolveCodexBinary(homeDir);
	if (!codexBinaryPath) {
		return {
			cwd,
			status: "codex-binary-missing",
			directAvailableSkills: [],
			directErrors: [],
			extraUserRoots: [],
			extraRootAvailableSkills: [],
			extraRootErrors: [],
			missingManagedSkills: [],
			missingManagedSkillsRecoveredWithExtraRoots: [],
			missingManagedSkillsStillMissing: [],
		};
	}

	try {
		const directListing = await requestCodexSkillsList(
			codexBinaryPath,
			homeDir,
			cwd,
		);
		const directlyMissingStatuses = collectMissingManagedSkillStatuses(
			installed,
			directListing.availableSkills,
		);
		const extraUserRoots = deriveCandidateExtraUserRoots(
			directlyMissingStatuses,
			homeDir,
		);
		let extraRootListing = directListing;
		if (extraUserRoots.length > 0) {
			extraRootListing = await requestCodexSkillsList(
				codexBinaryPath,
				homeDir,
				cwd,
				extraUserRoots,
			);
		}

		const recoveredSet = new Set(
			extraRootListing.availableSkills.map(normalizeRuntimeSkillName),
		);
		const missingManagedSkills = uniqueInstallNames(directlyMissingStatuses);
		const missingManagedSkillsRecoveredWithExtraRoots = uniqueInstallNames(
			directlyMissingStatuses.filter((status) =>
				isSkillStatusVisible(status, recoveredSet),
			),
		);
		const recoveredInstallNames = new Set(
			missingManagedSkillsRecoveredWithExtraRoots,
		);
		const missingManagedSkillsStillMissing = missingManagedSkills
			.filter((installName) => !recoveredInstallNames.has(installName))
			.sort((a, b) => a.localeCompare(b));

		return {
			cwd,
			status: "ok",
			codexBinaryPath,
			directAvailableSkills: directListing.availableSkills,
			directErrors: directListing.errors,
			extraUserRoots,
			extraRootAvailableSkills: extraRootListing.availableSkills,
			extraRootErrors: extraRootListing.errors,
			missingManagedSkills,
			missingManagedSkillsRecoveredWithExtraRoots,
			missingManagedSkillsStillMissing,
		};
	} catch (error) {
		return {
			cwd,
			status: "probe-error",
			codexBinaryPath,
			directAvailableSkills: [],
			directErrors: [],
			extraUserRoots: [],
			extraRootAvailableSkills: [],
			extraRootErrors: [],
			missingManagedSkills: [],
			missingManagedSkillsRecoveredWithExtraRoots: [],
			missingManagedSkillsStillMissing: [],
			error: formatProbeError(error),
		};
	}
}

function computeRuntimeMissingSkills(
	installed: CodexInstalledSkillStatus[],
	runtimeSkills: string[],
	runtimeCapturedAtMs?: number,
): {
	missingSkills: string[];
	missingSkillsInstalledAfterSnapshot: string[];
} {
	const available = new Set(runtimeSkills.map(normalizeRuntimeSkillName));
	const missingStatuses = installed
		.filter(
			(skill) => skill.exists && skill.yamlValid && !skill.disabledByConfig,
		)
		.filter((skill) => !isSkillStatusVisible(skill, available));

	const missingSkills = [
		...new Set(missingStatuses.map((skill) => skill.installName)),
	].sort((a, b) => a.localeCompare(b));

	const missingSkillsInstalledAfterSnapshot =
		runtimeCapturedAtMs === undefined
			? []
			: [
					...new Set(
						missingStatuses
							.filter(
								(skill) =>
									skill.skillFileMtimeMs !== undefined &&
									skill.skillFileMtimeMs > runtimeCapturedAtMs,
							)
							.map((skill) => skill.installName),
					),
				].sort((a, b) => a.localeCompare(b));

	return {
		missingSkills,
		missingSkillsInstalledAfterSnapshot,
	};
}

type CodexSkillsListResponse = {
	availableSkills: string[];
	errors: string[];
};

async function requestCodexSkillsList(
	codexBinaryPath: string,
	homeDir: string,
	cwd: string,
	extraUserRoots?: string[],
): Promise<CodexSkillsListResponse> {
	return new Promise<CodexSkillsListResponse>((resolve, reject) => {
		const child = spawn(
			codexBinaryPath,
			["app-server", "--listen", "stdio://"],
			{
				cwd,
				env: {
					...process.env,
					HOME: homeDir,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		let stdoutBuffer = "";
		let stderrBuffer = "";
		let settled = false;
		let initialized = false;
		const timeout = setTimeout(() => {
			finishError(
				new Error(
					`timed out waiting for Codex app-server skills/list response for ${cwd}`,
				),
			);
		}, CODEX_APP_SERVER_TIMEOUT_MS);

		const initializeRequest = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				clientInfo: {
					name: "skill-sync",
					title: "Skill Sync",
					version: "0.0.0",
				},
				capabilities: {
					experimentalApi: true,
				},
			},
		};

		const listRequest = {
			jsonrpc: "2.0",
			id: 2,
			method: "skills/list",
			params: {
				cwds: [cwd],
				forceReload: true,
				...(extraUserRoots && extraUserRoots.length > 0
					? {
							perCwdExtraUserRoots: [
								{
									cwd,
									extraUserRoots,
								},
							],
						}
					: {}),
			},
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			processStdout();
		});
		child.stderr.on("data", (chunk: string) => {
			stderrBuffer += chunk;
		});
		child.on("error", (error) => {
			finishError(error);
		});
		child.on("exit", (code, signal) => {
			if (settled) {
				return;
			}
			const details = stderrBuffer.trim();
			finishError(
				new Error(
					`Codex app-server exited before returning skills/list response (code=${code ?? "null"}, signal=${signal ?? "null"})${details ? `: ${details}` : ""}`,
				),
			);
		});

		writeJsonLine(initializeRequest);

		function processStdout(): void {
			while (true) {
				const newlineIndex = stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}
				const line = stdoutBuffer.slice(0, newlineIndex).trim();
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				if (!line) {
					continue;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(line) as unknown;
				} catch {
					continue;
				}
				if (!parsed || typeof parsed !== "object") {
					continue;
				}
				const response = parsed as {
					id?: number;
					result?: unknown;
					error?: unknown;
				};
				if (response.error) {
					finishError(
						new Error(
							`Codex app-server returned an error for ${cwd}: ${JSON.stringify(response.error)}`,
						),
					);
					return;
				}
				if (response.id === 1 && !initialized) {
					initialized = true;
					writeJsonLine(listRequest);
					continue;
				}
				if (response.id === 2) {
					finishSuccess(parseCodexSkillsListResponse(response.result));
					return;
				}
			}
		}

		function writeJsonLine(value: unknown): void {
			if (settled || child.stdin.destroyed) {
				return;
			}
			child.stdin.write(`${JSON.stringify(value)}\n`);
		}

		function finishSuccess(result: CodexSkillsListResponse): void {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			child.kill();
			resolve(result);
		}

		function finishError(error: unknown): void {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			child.kill();
			reject(error);
		}
	});
}

function parseCodexSkillsListResponse(
	result: unknown,
): CodexSkillsListResponse {
	const available = new Set<string>();
	const errors: string[] = [];
	if (!result || typeof result !== "object" || !("data" in result)) {
		return {
			availableSkills: [],
			errors: ["skills/list response missing data array"],
		};
	}
	const data = (result as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		return {
			availableSkills: [],
			errors: ["skills/list response data is not an array"],
		};
	}

	for (const item of data) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const entry = item as {
			skills?: Array<{ name?: unknown }>;
			errors?: Array<{ message?: unknown; path?: unknown }>;
		};
		for (const skill of entry.skills || []) {
			if (typeof skill?.name === "string" && skill.name.trim().length > 0) {
				available.add(skill.name.trim());
			}
		}
		for (const error of entry.errors || []) {
			const message =
				typeof error?.message === "string" ? error.message.trim() : "";
			const path = typeof error?.path === "string" ? error.path.trim() : "";
			if (message || path) {
				errors.push(
					path
						? `${path}: ${message || "unknown error"}`
						: message || "unknown error",
				);
			}
		}
	}

	return {
		availableSkills: [...available].sort((a, b) => a.localeCompare(b)),
		errors: [...new Set(errors)],
	};
}

function collectMissingManagedSkillStatuses(
	installed: CodexInstalledSkillStatus[],
	availableSkills: string[],
): CodexInstalledSkillStatus[] {
	const available = new Set(availableSkills.map(normalizeRuntimeSkillName));
	return installed
		.filter(
			(skill) =>
				skill.managedBySkillSync &&
				skill.exists &&
				skill.yamlValid &&
				!skill.disabledByConfig,
		)
		.filter((skill) => !isSkillStatusVisible(skill, available))
		.sort((a, b) => a.installName.localeCompare(b.installName));
}

function uniqueInstallNames(statuses: CodexInstalledSkillStatus[]): string[] {
	return [...new Set(statuses.map((status) => status.installName))].sort(
		(a, b) => a.localeCompare(b),
	);
}

function isSkillStatusVisible(
	skill: CodexInstalledSkillStatus,
	available: Set<string>,
): boolean {
	const candidates = [
		normalizeRuntimeSkillName(skill.installName),
		skill.frontmatterName
			? normalizeRuntimeSkillName(skill.frontmatterName)
			: undefined,
	].filter((value): value is string => Boolean(value));
	return candidates.some((candidate) => available.has(candidate));
}

function deriveCandidateExtraUserRoots(
	statuses: CodexInstalledSkillStatus[],
	homeDir: string,
): string[] {
	const codexSkillsRoot = join(homeDir, ".codex", "skills");
	const roots = new Set<string>();
	for (const status of statuses) {
		const sourceSkillFilePath =
			status.resolvedSkillFilePath || status.skillFilePath;
		const candidateRoot =
			deriveExtraUserRootFromSkillFilePath(sourceSkillFilePath);
		if (!candidateRoot) {
			continue;
		}
		if (candidateRoot === codexSkillsRoot) {
			continue;
		}
		roots.add(candidateRoot);
	}
	return [...roots].sort((a, b) => a.localeCompare(b));
}

function deriveExtraUserRootFromSkillFilePath(
	skillFilePath: string,
): string | undefined {
	if (!skillFilePath.endsWith("/SKILL.md")) {
		return undefined;
	}
	const skillDir = dirname(skillFilePath);
	const maybeSkillsRoot = dirname(skillDir);
	if (basename(maybeSkillsRoot) !== "skills") {
		return undefined;
	}
	return maybeSkillsRoot;
}

function resolveCodexBinary(homeDir: string): string | undefined {
	if (process.env.SKILL_SYNC_SKIP_CODEX_APP_SERVER === "1") {
		return undefined;
	}
	const explicit = process.env.SKILL_SYNC_CODEX_BIN || process.env.CODEX_BIN;
	if (explicit) {
		if (existsSync(explicit)) {
			return explicit;
		}
		const explicitPathMatch = findExecutableOnPath(explicit);
		if (explicitPathMatch) {
			return explicitPathMatch;
		}
	}

	const pathMatch = findExecutableOnPath("codex");
	if (pathMatch) {
		return pathMatch;
	}

	const candidates = [
		"/Applications/Codex.app/Contents/Resources/codex",
		join(
			homeDir,
			"Applications",
			"Codex.app",
			"Contents",
			"Resources",
			"codex",
		),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

function findExecutableOnPath(command: string): string | undefined {
	const pathValue = process.env.PATH;
	if (!pathValue) {
		return undefined;
	}
	for (const pathEntry of pathValue.split(delimiter)) {
		const candidate = join(pathEntry, command);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function formatProbeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function normalizeRuntimeSkillName(value: string): string {
	return value.trim().toLowerCase();
}

function findCodexRuntimeSkillSnapshot(
	homeDir: string,
	threadId: string | undefined,
	runtimeMaxAgeHours: number,
): CodexRuntimeSkillSnapshot | undefined {
	const sessionsRoot = join(homeDir, ".codex", "sessions");
	if (!existsSync(sessionsRoot)) {
		return undefined;
	}
	const sessionFiles = listCodexSessionFiles(sessionsRoot);
	if (sessionFiles.length === 0) {
		return undefined;
	}

	const collectCandidates = (
		matchThreadId: string | undefined,
	): Array<{
		session: SessionFile;
		parsedSnapshot: ParsedSessionSkillSnapshot;
		recencyMs: number;
	}> => {
		const candidates: Array<{
			session: SessionFile;
			parsedSnapshot: ParsedSessionSkillSnapshot;
			recencyMs: number;
		}> = [];

		for (const session of sessionFiles) {
			if (
				matchThreadId &&
				!sessionFileContainsThreadId(session.path, matchThreadId)
			) {
				continue;
			}
			const parsedSnapshot = parseAvailableSkillsFromSession(session.path);
			if (!parsedSnapshot || parsedSnapshot.availableSkills.length === 0) {
				continue;
			}
			candidates.push({
				session,
				parsedSnapshot,
				recencyMs: parsedSnapshot.capturedAtMs || session.mtimeMs,
			});
		}
		return candidates;
	};

	const threadCandidates = threadId ? collectCandidates(threadId) : [];
	const source: CodexRuntimeSkillSnapshot["source"] =
		threadCandidates.length > 0 ? "thread-session" : "latest-session";
	const candidates =
		threadCandidates.length > 0
			? threadCandidates
			: collectCandidates(undefined);
	if (candidates.length === 0) {
		return undefined;
	}

	candidates.sort((a, b) => {
		if (a.recencyMs !== b.recencyMs) {
			return b.recencyMs - a.recencyMs;
		}
		if (a.session.mtimeMs !== b.session.mtimeMs) {
			return b.session.mtimeMs - a.session.mtimeMs;
		}
		return a.session.path.localeCompare(b.session.path);
	});

	const [best] = candidates;
	if (!best) {
		return undefined;
	}
	return materializeRuntimeSnapshot(
		source,
		best.session,
		best.parsedSnapshot,
		runtimeMaxAgeHours,
		source === "thread-session" ? threadId : undefined,
	);
}

type SessionFile = {
	path: string;
	mtimeMs: number;
};

function listCodexSessionFiles(sessionsRoot: string): SessionFile[] {
	const files: SessionFile[] = [];
	const pending = [sessionsRoot];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) {
			continue;
		}
		let names: string[] = [];
		try {
			names = readdirSync(current);
		} catch {
			continue;
		}
		for (const name of names) {
			const candidate = join(current, name);
			let stats: ReturnType<typeof lstatSync>;
			try {
				stats = lstatSync(candidate);
			} catch {
				continue;
			}
			if (stats.isSymbolicLink()) {
				continue;
			}
			if (stats.isDirectory()) {
				pending.push(candidate);
				continue;
			}
			if (!stats.isFile() || !candidate.endsWith(".jsonl")) {
				continue;
			}
			let mtimeMs = stats.mtimeMs;
			try {
				mtimeMs = statSync(candidate).mtimeMs;
			} catch {}
			files.push({ path: candidate, mtimeMs });
		}
	}
	return files.sort(
		(a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path),
	);
}

function sessionFileContainsThreadId(
	sessionPath: string,
	threadId: string,
): boolean {
	return basename(sessionPath).includes(threadId);
}

type SessionLine = {
	timestamp?: string;
	type?: string;
	payload?: {
		type?: string;
		role?: string;
		content?: Array<{
			type?: string;
			text?: string;
		}>;
	};
};

type ParsedSessionSkillSnapshot = {
	availableSkills: string[];
	capturedAtMs?: number;
	capturedAtIso?: string;
};

function parseAvailableSkillsFromSession(
	sessionPath: string,
): ParsedSessionSkillSnapshot | undefined {
	let content = "";
	try {
		content = readFileSync(sessionPath, "utf8");
	} catch {
		return undefined;
	}
	let best:
		| {
				availableSkills: string[];
				capturedAtMs?: number;
				capturedAtIso?: string;
				lineIndex: number;
		  }
		| undefined;

	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) {
			continue;
		}
		if (!line.includes("### Available skills")) {
			continue;
		}
		let parsed: SessionLine;
		try {
			parsed = JSON.parse(line) as SessionLine;
		} catch {
			continue;
		}
		if (
			parsed.type !== "response_item" ||
			parsed.payload?.type !== "message" ||
			parsed.payload.role !== "developer"
		) {
			continue;
		}
		const discovered = new Set<string>();
		for (const item of parsed.payload.content || []) {
			if (
				item.type !== "input_text" ||
				!item.text ||
				!item.text.includes("### Available skills")
			) {
				continue;
			}
			for (const name of parseSkillNamesFromInstructionText(item.text)) {
				discovered.add(name);
			}
		}
		if (discovered.size === 0) {
			continue;
		}
		const capturedAtIso =
			typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
		const capturedAtMs = parseTimestampMs(capturedAtIso);
		const candidate = {
			availableSkills: [...discovered].sort((a, b) => a.localeCompare(b)),
			capturedAtMs,
			capturedAtIso,
			lineIndex: index,
		};
		if (!best || compareSessionSnapshotCandidate(candidate, best) > 0) {
			best = candidate;
		}
	}
	if (!best) {
		return undefined;
	}
	return {
		availableSkills: best.availableSkills,
		capturedAtMs: best.capturedAtMs,
		capturedAtIso: best.capturedAtIso,
	};
}

function parseSkillNamesFromInstructionText(text: string): string[] {
	const start = text.indexOf("### Available skills");
	if (start === -1) {
		return [];
	}
	const endMarker = text.indexOf("### How to use skills", start);
	const segment =
		endMarker === -1 ? text.slice(start) : text.slice(start, endMarker);
	const names: string[] = [];
	for (const rawLine of segment.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith("- ")) {
			continue;
		}
		const body = line.slice(2).trim();
		const separator = body.indexOf(": ");
		if (separator <= 0) {
			continue;
		}
		const rawName = body.slice(0, separator).trim();
		if (!rawName) {
			continue;
		}
		const normalizedName = rawName.replace(/^`|`$/g, "").trim();
		if (!normalizedName) {
			continue;
		}
		names.push(normalizedName);
	}
	return names;
}

function materializeRuntimeSnapshot(
	source: CodexRuntimeSkillSnapshot["source"],
	session: SessionFile,
	parsedSnapshot: ParsedSessionSkillSnapshot,
	runtimeMaxAgeHours: number,
	threadId?: string,
): CodexRuntimeSkillSnapshot {
	const capturedAtMs = parsedSnapshot.capturedAtMs || session.mtimeMs;
	const ageMs = Math.max(0, Date.now() - capturedAtMs);
	const maxAgeMs = runtimeMaxAgeHours * 60 * 60 * 1000;
	return {
		source,
		sessionPath: session.path,
		sessionMtimeMs: session.mtimeMs,
		threadId,
		capturedAtMs,
		capturedAtIso: parsedSnapshot.capturedAtIso,
		ageHours: ageMs / (60 * 60 * 1000),
		maxAgeHours: runtimeMaxAgeHours,
		stale: ageMs > maxAgeMs,
		availableSkills: parsedSnapshot.availableSkills,
	};
}

function compareSessionSnapshotCandidate(
	a: { capturedAtMs?: number; lineIndex: number },
	b: { capturedAtMs?: number; lineIndex: number },
): number {
	if (a.capturedAtMs !== undefined && b.capturedAtMs !== undefined) {
		if (a.capturedAtMs !== b.capturedAtMs) {
			return a.capturedAtMs - b.capturedAtMs;
		}
		return a.lineIndex - b.lineIndex;
	}
	if (a.capturedAtMs !== undefined) {
		return 1;
	}
	if (b.capturedAtMs !== undefined) {
		return -1;
	}
	return a.lineIndex - b.lineIndex;
}

function parseTimestampMs(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
