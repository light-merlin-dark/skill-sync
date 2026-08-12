import type { DiscoveredSkill, JsonValue } from "./types";
import type { ProjectManifestResult } from "./project";
import { validateProjectManifest } from "./project";

export type VisibilityReport = {
	schemaVersion: 1;
	summary: {
		totalSkills: number;
		global: number;
		project: number;
		routed: number;
		unclassified: number;
		projectManifests: number;
		coverageTotal: number;
		coverageReachable: number;
		coveragePercent: number;
		coverageUsesBaseline: boolean;
	};
	missingBaselineSlugs: string[];
	policy: {
		maxGlobalIndexTokens: number;
		maxProjectIndexTokens: number;
		globalWithinBudget: boolean;
		projectsWithinBudget: boolean;
		overBudgetProjects: string[];
	};
	globalBudget: SkillIndexBudget;
	projectBudgets: Array<{
		projectRoot: string;
		entrypoints: string[];
		budget: SkillIndexBudget;
	}>;
	skills: Array<{
		slug: string;
		visibility: DiscoveredSkill["visibility"];
		explicit: boolean;
		routes: string[];
		routedFrom: string[];
		declaredBy: string[];
		deprecatedBy?: string;
		installOn?: string[];
		reachable: boolean;
		sourcePath: string;
		indexCharacters: number;
		estimatedIndexTokens: number;
	}>;
	diagnostics: {
		warnings: JsonValue[];
		errors: JsonValue[];
	};
};

export type SkillIndexBudget = {
	skills: number;
	characters: number;
	estimatedTokens: number;
};

export type VisibilityBaseline = {
	schemaVersion: 1;
	capturedAt: string;
	skills: Array<{
		slug: string;
		sourcePath: string;
		contentHash: string;
		visibility: DiscoveredSkill["visibility"];
	}>;
};

export function estimateSkillIndex(skills: DiscoveredSkill[]): SkillIndexBudget {
	if (skills.length === 0) {
		return { skills: 0, characters: 0, estimatedTokens: 0 };
	}
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of skills) {
		lines.push(...renderSkillIndexEntry(skill));
	}
	lines.push("</available_skills>");
	const characters = lines.join("\n").length;
	return {
		skills: skills.length,
		characters,
		estimatedTokens: Math.ceil(characters / 4),
	};
}

export function estimateSkillIndexEntry(skill: DiscoveredSkill): {
	characters: number;
	estimatedTokens: number;
} {
	// One separator newline precedes every entry in the complete index.
	const characters = renderSkillIndexEntry(skill).join("\n").length + 1;
	return { characters, estimatedTokens: Math.ceil(characters / 4) };
}

export function buildVisibilityReport(
	skills: DiscoveredSkill[],
	projectResults: ProjectManifestResult[],
	baseline?: VisibilityBaseline,
	policy: {
		maxGlobalIndexTokens?: number;
		maxProjectIndexTokens?: number;
	} = {},
): VisibilityReport {
	const maxGlobalIndexTokens = policy.maxGlobalIndexTokens ?? 4_000;
	const maxProjectIndexTokens = policy.maxProjectIndexTokens ?? 500;
	const bySlug = new Map(skills.map((skill) => [skill.canonicalSlug, skill]));
	const reverseRoutes = new Map<string, string[]>();
	for (const skill of skills) {
		for (const route of skill.routes) {
			const parents = reverseRoutes.get(route) || [];
			parents.push(skill.canonicalSlug);
			reverseRoutes.set(route, parents);
		}
	}
	const declaredBy = new Map<string, string[]>();
	const manifestDiagnostics = [];
	for (const result of projectResults) {
		manifestDiagnostics.push(...validateProjectManifest(result, skills));
		for (const slug of result.manifest?.entrypoints || []) {
			const projects = declaredBy.get(slug) || [];
			projects.push(result.projectRoot);
			declaredBy.set(slug, projects);
		}
	}

	const reachable = new Set<string>();
	for (const skill of skills) {
		if (skill.visibility === "global") reachable.add(skill.canonicalSlug);
		if ((declaredBy.get(skill.canonicalSlug) || []).length > 0) {
			reachable.add(skill.canonicalSlug);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const skill of skills) {
			if (!reachable.has(skill.canonicalSlug)) continue;
			for (const route of skill.routes) {
				if (bySlug.has(route) && !reachable.has(route)) {
					reachable.add(route);
					changed = true;
				}
			}
		}
		for (const skill of skills) {
			if (
				skill.deprecatedBy &&
				reachable.has(skill.deprecatedBy) &&
				!reachable.has(skill.canonicalSlug)
			) {
				reachable.add(skill.canonicalSlug);
				changed = true;
			}
		}
	}

	// Pi consumes the shared `agents` projection. Harness-native skills whose
	// metadata deliberately limits them to another adapter do not contribute to
	// Pi's startup index and must not distort this acceptance budget.
	const globalSkills = skills.filter(
		(skill) =>
			(skill.visibility === "global" ||
				skill.visibility === "unclassified") &&
			(!skill.installHarnessIds || skill.installHarnessIds.includes("agents")),
	);
	const projectBudgets = projectResults.map((result) => {
		const entrypoints = result.manifest?.entrypoints || [];
		return {
			projectRoot: result.projectRoot,
			entrypoints,
			budget: estimateSkillIndex(
				entrypoints
					.map((slug) => bySlug.get(slug))
					.filter((skill): skill is DiscoveredSkill => Boolean(skill)),
			),
		};
	});
	const counts = {
		global: skills.filter((skill) => skill.visibility === "global").length,
		project: skills.filter((skill) => skill.visibility === "project").length,
		routed: skills.filter((skill) => skill.visibility === "routed").length,
		unclassified: skills.filter((skill) => skill.visibility === "unclassified")
			.length,
	};
	const coverageSlugs = baseline
		? baseline.skills.map((skill) => skill.slug).sort()
		: skills.map((skill) => skill.canonicalSlug).sort();
	const coverageReachable = coverageSlugs.filter((slug) =>
		reachable.has(slug),
	).length;
	const missingBaselineSlugs = baseline
		? [...new Set(coverageSlugs.filter((slug) => !bySlug.has(slug)))].sort()
		: [];
	const globalBudget = estimateSkillIndex(globalSkills);
	const overBudgetProjects = projectBudgets
		.filter((project) => project.budget.estimatedTokens > maxProjectIndexTokens)
		.map((project) => project.projectRoot);
	if (globalBudget.estimatedTokens > maxGlobalIndexTokens) {
		manifestDiagnostics.push({
			kind: "visibility-budget-exceeded",
			slug: "global",
			severity: "error",
			resolution: "reduce-visibility-budget",
			sourcePaths: globalSkills.map((skill) => skill.sourcePath),
			message: `global skill index is ~${globalBudget.estimatedTokens} tokens; limit is ${maxGlobalIndexTokens}`,
		});
	}
	for (const project of projectBudgets.filter(
		(item) => item.budget.estimatedTokens > maxProjectIndexTokens,
	)) {
		manifestDiagnostics.push({
			kind: "visibility-budget-exceeded",
			slug: `project:${project.projectRoot}`,
			severity: "error",
			resolution: "reduce-visibility-budget",
			sourcePaths: [
				projectResults.find((result) => result.projectRoot === project.projectRoot)
					?.manifestPath || project.projectRoot,
			],
			message: `project entrypoint index is ~${project.budget.estimatedTokens} tokens; limit is ${maxProjectIndexTokens}`,
		});
	}
	return {
		schemaVersion: 1,
		summary: {
			totalSkills: skills.length,
			...counts,
			projectManifests: projectResults.length,
			coverageTotal: coverageSlugs.length,
			coverageReachable,
			coveragePercent:
				coverageSlugs.length === 0
					? 100
					: Number(
							((coverageReachable / coverageSlugs.length) * 100).toFixed(2),
						),
			coverageUsesBaseline: Boolean(baseline),
		},
		missingBaselineSlugs,
		policy: {
			maxGlobalIndexTokens,
			maxProjectIndexTokens,
			globalWithinBudget: globalBudget.estimatedTokens <= maxGlobalIndexTokens,
			projectsWithinBudget: overBudgetProjects.length === 0,
			overBudgetProjects,
		},
		globalBudget,
		projectBudgets,
		skills: skills.map((skill) => {
			const indexBudget = estimateSkillIndexEntry(skill);
			return {
				slug: skill.canonicalSlug,
				visibility: skill.visibility,
				explicit: skill.visibilityExplicit,
				routes: skill.routes,
				routedFrom: (reverseRoutes.get(skill.canonicalSlug) || []).sort(),
				declaredBy: (declaredBy.get(skill.canonicalSlug) || []).sort(),
				deprecatedBy: skill.deprecatedBy,
				installOn: skill.installHarnessIds,
				reachable: reachable.has(skill.canonicalSlug),
				sourcePath: skill.sourcePath,
				indexCharacters: indexBudget.characters,
				estimatedIndexTokens: indexBudget.estimatedTokens,
			};
		}),
		diagnostics: {
			warnings: manifestDiagnostics
				.filter((item) => item.severity === "warning")
				.map((item) => item as unknown as JsonValue),
			errors: manifestDiagnostics
				.filter((item) => item.severity === "error")
				.map((item) => item as unknown as JsonValue),
		},
	};
}

function renderSkillIndexEntry(skill: DiscoveredSkill): string[] {
	return [
		"  <skill>",
		`    <name>${escapeXml(skill.canonicalSlug)}</name>`,
		`    <description>${escapeXml(skill.description || "")}</description>`,
		`    <location>${escapeXml(skill.skillFilePath)}</location>`,
		"  </skill>",
	];
}

export function createVisibilityBaseline(
	skills: DiscoveredSkill[],
	now = new Date(),
): VisibilityBaseline {
	return {
		schemaVersion: 1,
		capturedAt: now.toISOString(),
		skills: skills
			.map((skill) => ({
				slug: skill.canonicalSlug,
				sourcePath: skill.sourcePath,
				contentHash: skill.contentHash,
				visibility: skill.visibility,
			}))
			.sort(
				(a, b) =>
					a.slug.localeCompare(b.slug) ||
					a.sourcePath.localeCompare(b.sourcePath),
			),
	};
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
