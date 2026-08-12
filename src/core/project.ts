import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify } from "yaml";
import { listProjectRepoCandidates } from "./sources";
import type {
	Config,
	DiscoveredSkill,
	JsonValue,
	PlannedEntry,
	SourceDiagnostic,
	State,
	SyncPlan,
} from "./types";
import {
	directoriesMatchMaterialized,
	ensureDir,
	inspectEntry,
	hashContent,
	slugify,
} from "./utils";

export const PROJECT_MANIFEST_RELATIVE_PATH = ".agents/skill-sync.yaml";

export type ProjectSkillManifest = {
	version: 1;
	entrypoints: string[];
};

export type ProjectManifestResult = {
	projectRoot: string;
	manifestPath: string;
	exists: boolean;
	manifest?: ProjectSkillManifest;
	diagnostics: SourceDiagnostic[];
};

export type ProjectSyncPlanOptions = {
	requestedAdapters?: string[];
};

const SUPPORTED_PROJECT_ADAPTERS = new Set(["agents", "pi", "codex"]);

export function findProjectRoot(startPath: string): string {
	let current = resolve(startPath);
	try {
		if (!lstatSync(current).isDirectory()) current = dirname(current);
	} catch {
		// Let the caller receive the normalized requested path; manifest validation
		// will provide the actionable error.
	}
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(startPath);
		current = parent;
	}
}

export function loadProjectManifest(projectRoot: string): ProjectManifestResult {
	const normalizedRoot = resolve(projectRoot);
	const manifestPath = join(normalizedRoot, PROJECT_MANIFEST_RELATIVE_PATH);
	if (!existsSync(manifestPath)) {
		return {
			projectRoot: normalizedRoot,
			manifestPath,
			exists: false,
			diagnostics: [],
		};
	}

	const diagnostics: SourceDiagnostic[] = [];
	const diagnostic = (message: string): void => {
		diagnostics.push({
			kind: "invalid-frontmatter",
			slug: `project:${normalizedRoot}`,
			severity: "error",
			resolution: "fix-skill-frontmatter",
			sourcePaths: [manifestPath],
			message,
		});
	};

	const document = parseDocument(readFileSync(manifestPath, "utf8"), {
		prettyErrors: true,
	});
	if (document.errors.length > 0) {
		diagnostic(
			`invalid project manifest YAML: ${document.errors[0]?.message.split("\n")[0] || "unknown parse error"}`,
		);
		return {
			projectRoot: normalizedRoot,
			manifestPath,
			exists: true,
			diagnostics,
		};
	}

	const raw = document.toJS() as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostic("project manifest must be a YAML mapping/object");
		return {
			projectRoot: normalizedRoot,
			manifestPath,
			exists: true,
			diagnostics,
		};
	}
	const mapping = raw as Record<string, unknown>;
	if (mapping.version !== 1) {
		diagnostic("project manifest `version` must be 1");
	}
	if (!Array.isArray(mapping.entrypoints)) {
		diagnostic("project manifest `entrypoints` must be a list of canonical skill slugs");
	}
	const rawEntrypoints = Array.isArray(mapping.entrypoints)
		? mapping.entrypoints
		: [];
	if (rawEntrypoints.some((entry) => typeof entry !== "string" || !entry.trim())) {
		diagnostic("every project entrypoint must be a non-empty string");
	}
	const entrypoints = [
		...new Set(
			rawEntrypoints
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => slugify(entry.trim()))
				.filter(Boolean),
		),
	].sort();
	return {
		projectRoot: normalizedRoot,
		manifestPath,
		exists: true,
		manifest: { version: 1, entrypoints },
		diagnostics,
	};
}

export function discoverProjectManifests(config: Config): ProjectManifestResult[] {
	const results: ProjectManifestResult[] = [];
	const seen = new Set<string>();
	for (const projectsRoot of config.projectsRoots) {
		for (const projectRoot of listProjectRepoCandidates(projectsRoot)) {
			const normalized = resolve(projectRoot);
			if (seen.has(normalized)) continue;
			// Dedicated worktree holding directories are transient execution lanes,
			// not additional consumers. A named project may itself be a linked
			// worktree, so exclude by holding-directory convention rather than by
			// the shape of its .git entry.
			const relativePath = relative(resolve(projectsRoot), normalized);
			const segments = relativePath.split(sep);
			if (
				segments[0] === "worktrees" ||
				segments.includes(".worktrees") ||
				(segments.includes(".claude") && segments.includes("worktrees"))
			) {
				continue;
			}
			seen.add(normalized);
			const result = loadProjectManifest(normalized);
			if (result.exists) results.push(result);
		}
	}
	return results.sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
}

export function writeProjectManifest(
	projectRoot: string,
	entrypoints: string[],
): ProjectSkillManifest {
	const normalizedRoot = resolve(projectRoot);
	const manifest: ProjectSkillManifest = {
		version: 1,
		entrypoints: [...new Set(entrypoints.map(slugify).filter(Boolean))].sort(),
	};
	const manifestPath = join(normalizedRoot, PROJECT_MANIFEST_RELATIVE_PATH);
	ensureDir(dirname(manifestPath));
	writeFileSync(manifestPath, stringify(manifest), "utf8");
	return manifest;
}

export function validateProjectManifest(
	result: ProjectManifestResult,
	skills: DiscoveredSkill[],
): SourceDiagnostic[] {
	const diagnostics = [...result.diagnostics];
	if (!result.exists) {
		diagnostics.push({
			kind: "missing-route",
			slug: `project:${result.projectRoot}`,
			severity: "error",
			resolution: "fix-route-graph",
			sourcePaths: [result.manifestPath],
			message: `project manifest is missing; create ${PROJECT_MANIFEST_RELATIVE_PATH}`,
		});
	}
	if (!result.manifest) return diagnostics;
	const bySlug = new Map<string, DiscoveredSkill[]>();
	for (const skill of skills) {
		const group = bySlug.get(skill.canonicalSlug) || [];
		group.push(skill);
		bySlug.set(skill.canonicalSlug, group);
	}
	for (const slug of result.manifest.entrypoints) {
		const matches = bySlug.get(slug) || [];
		if (matches.length !== 1) {
			diagnostics.push({
				kind: "missing-route",
				slug,
				severity: "error",
				resolution: "fix-route-graph",
				sourcePaths: [
					result.manifestPath,
					...matches.map((skill) => skill.sourcePath),
				],
				message:
					matches.length === 0
						? `project entrypoint ${slug} does not resolve`
						: `project entrypoint ${slug} is ambiguous across ${matches.length} sources`,
			});
			continue;
		}
		const skill = matches[0];
		if (skill?.visibility === "routed") {
			diagnostics.push({
				kind: "invalid-route-visibility",
				slug,
				severity: "error",
				resolution: "fix-route-graph",
				sourcePaths: [result.manifestPath, skill.sourcePath],
				message: `project manifests must declare an entrypoint, not routed leaf ${slug}`,
			});
		}
	}
	if (result.manifest.entrypoints.length > 0) {
		const guidancePath = join(result.projectRoot, "AGENTS.md");
		const guidance = existsSync(guidancePath)
			? readFileSync(guidancePath, "utf8")
			: "";
		const sectionHeading = guidance.match(/^## Skill entrypoints\s*$/m);
		const section = sectionHeading
			? (() => {
					const afterHeading = guidance.slice(
						(sectionHeading.index || 0) + sectionHeading[0].length,
					);
					const nextHeading = afterHeading.search(/^##\s/m);
					return nextHeading === -1
						? afterHeading
						: afterHeading.slice(0, nextHeading);
				})()
			: undefined;
		const missing = result.manifest.entrypoints.filter(
			(slug) => !section?.includes(`\$${slug}`),
		);
		if (missing.length > 0) {
			diagnostics.push({
				kind: "missing-project-guidance",
				slug: `project:${result.projectRoot}`,
				severity: "warning",
				resolution: "add-project-guidance",
				sourcePaths: [result.manifestPath, guidancePath],
				message: `AGENTS.md needs an explicit ## Skill entrypoints section naming ${missing.map((slug) => `$${slug}`).join(", ")}`,
			});
		}
	}
	return diagnostics;
}

export function buildProjectSyncPlan(
	result: ProjectManifestResult,
	skills: DiscoveredSkill[],
	state: State,
	options: ProjectSyncPlanOptions = {},
): SyncPlan {
	const requestedAdapters = [
		...new Set(options.requestedAdapters?.length ? options.requestedAdapters : ["agents"]),
	].sort();
	const unsupportedAdapters = requestedAdapters.filter(
		(adapter) => !SUPPORTED_PROJECT_ADAPTERS.has(adapter),
	);
	const harnessId = `project:${result.projectRoot}`;
	const harnessRoot = join(result.projectRoot, ".agents", "skills");
	const harness = {
		id: harnessId,
		label: `Project (${result.projectRoot})`,
		rootPath: harnessRoot,
		kind: "custom" as const,
		detected: existsSync(harnessRoot),
		enabled: true,
	};
	const diagnostics = validateProjectManifest(result, skills);
	for (const adapter of unsupportedAdapters) {
		diagnostics.push({
			kind: "unsupported-project-scope",
			slug: `project:${result.projectRoot}`,
			severity: "error",
			resolution: "add-project-adapter",
			sourcePaths: [result.manifestPath],
			message: `project adapter ${adapter} is unsupported; no global fallback will be created`,
		});
	}
	const errors = diagnostics.filter((item) => item.severity === "error");
	const warnings = diagnostics.filter((item) => item.severity === "warning");
	const bySlug = new Map(skills.map((skill) => [skill.canonicalSlug, skill]));
	const entries: PlannedEntry[] = [];
	const desired = new Set<string>();
	let changes = 0;
	let conflicts = 0;
	let ok = 0;

	for (const slug of unsupportedAdapters.length > 0
		? []
		: result.manifest?.entrypoints || []) {
		const skill = bySlug.get(slug);
		if (!skill || skill.visibility === "routed") continue;
		const destinationPath = join(harnessRoot, slug);
		desired.add(destinationPath);
		const inspection = inspectEntry(destinationPath);
		const managed = state.managedEntries[destinationPath];
		let action: PlannedEntry["action"];
		let message: string;
		if (!inspection.exists) {
			action = "create";
			message = "missing project entrypoint will be materialized";
		} else if (
			inspection.type === "directory" &&
			directoriesMatchMaterialized(skill.sourcePath, destinationPath)
		) {
			action = "ok";
			message = "already projected";
		} else if (managed?.harnessId === harnessId) {
			action = "repair";
			message = "managed project entrypoint drift will be repaired";
		} else if (
			inspection.type === "directory" &&
			readdirSync(destinationPath).length === 0
		) {
			action = "repair";
			message = "empty project entrypoint directory will be replaced";
		} else {
			action = "conflict";
			message = `existing ${inspection.type} is unmanaged`;
		}
		entries.push({
			harnessId,
			harnessRoot,
			installName: slug,
			destinationPath,
			action,
			installMode: "materialized-directory",
			sourcePath: skill.sourcePath,
			sourceSkillFilePath: skill.skillFilePath,
			sourceKey: skill.sourceKey,
			message,
		});
		if (action === "ok") ok += 1;
		else if (action === "conflict") conflicts += 1;
		else changes += 1;
	}

	for (const [destinationPath, managed] of Object.entries(state.managedEntries)) {
		if (managed.harnessId !== harnessId || desired.has(destinationPath)) continue;
		const inspection = inspectEntry(destinationPath);
		entries.push({
			harnessId,
			harnessRoot,
			installName: managed.installName,
			destinationPath,
			action: inspection.exists ? "remove-managed" : "prune-state",
			sourcePath: managed.sourcePath,
			message: inspection.exists
				? "stale managed project entrypoint will be removed"
				: "stale project state entry will be pruned",
		});
		changes += 1;
	}

	entries.sort((a, b) => a.destinationPath.localeCompare(b.destinationPath));
	const projectProjection = {
		projectRoot: result.projectRoot,
		manifestPath: result.manifestPath,
		requestedAdapters,
		adapter: "agents" as const,
	};
	const plan = {
		projectProjection,
		harnesses: [{ harness, entries }],
		changes,
		conflicts,
		ok,
		sourceDiagnostics: { warnings, errors },
		harnessDiagnostics: [],
	};
	const declaredSources = (result.manifest?.entrypoints || [])
		.map((slug) => bySlug.get(slug))
		.filter((skill): skill is DiscoveredSkill => Boolean(skill))
		.map((skill) => ({
			slug: skill.canonicalSlug,
			sourcePath: skill.sourcePath,
			contentHash: skill.contentHash,
			visibility: skill.visibility,
			routes: skill.routes,
			deprecatedBy: skill.deprecatedBy,
			installOn: skill.installHarnessIds,
		}));
	const planHash = hashContent(
		JSON.stringify({
			kind: "project",
			manifest: result.manifest,
			projectProjection,
			sources: declaredSources,
			plan,
		}),
	);
	return { schemaVersion: 1, planHash, ...plan };
}

export function projectManifestToJson(
	result: ProjectManifestResult,
): JsonValue {
	return result as unknown as JsonValue;
}
