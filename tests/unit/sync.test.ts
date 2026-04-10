import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	buildSyncPlan,
	findHarnessTraversalDiagnostics,
	resolveInstallName,
} from "../../src/core/sync";
import type {
	Config,
	DiscoveredSkill,
	HarnessDefinition,
	State,
} from "../../src/core/types";
import { cleanup, makeFakeProjectsRoot, writeText } from "../support";

const tempPaths: string[] = [];

afterEach(() => {
	while (tempPaths.length > 0) {
		const tempPath = tempPaths.pop();
		if (!tempPath) {
			continue;
		}
		cleanup(tempPath);
	}
});

test("uses alias overrides and reports collisions", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	const harness: HarnessDefinition = {
		id: "codex",
		label: "Codex",
		rootPath: `${homeDir}/.codex/skills`,
		kind: "built-in",
		detected: true,
		enabled: true,
	};
	const skillA: DiscoveredSkill = {
		sourceKey: "/tmp/a",
		sourcePath: "/tmp/a",
		skillFilePath: "/tmp/a/SKILL.md",
		repoPath: "/tmp/a",
		projectsRoot: "/tmp",
		sourceType: "repo-root",
		metadataName: "Alpha",
		frontmatterIssues: [],
		canonicalSlug: "alpha",
	};
	const skillB: DiscoveredSkill = {
		sourceKey: "/tmp/b",
		sourcePath: "/tmp/b",
		skillFilePath: "/tmp/b/SKILL.md",
		repoPath: "/tmp/b",
		projectsRoot: "/tmp",
		sourceType: "repo-root",
		metadataName: "Beta",
		frontmatterIssues: [],
		canonicalSlug: "beta",
	};
	const config: Config = {
		version: 1,
		projectsRoots: ["/tmp"],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {
			"/tmp/a": { harnesses: { codex: "shared" } },
			"/tmp/b": { harnesses: { codex: "shared" } },
		},
	};
	const state: State = { version: 1, managedEntries: {} };

	expect(resolveInstallName(skillA, "codex", config)).toBe("shared");
	const plan = buildSyncPlan([skillA, skillB], [harness], config, state);
	expect(plan.conflicts).toBe(1);
});

test("repairs an unmanaged directory with matching SKILL.md into a symlinked install", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	const harnessRoot = `${homeDir}/.hermes/skills`;
	const destination = join(harnessRoot, "prod");
	mkdirSync(destination, { recursive: true });
	writeText(
		join(destination, "SKILL.md"),
		"---\nname: prod\ndescription: Test\n---\n\n# Prod\n",
	);

	const harness: HarnessDefinition = {
		id: "hermes",
		label: "Hermes",
		rootPath: harnessRoot,
		kind: "built-in",
		detected: true,
		enabled: true,
	};
	const skill: DiscoveredSkill = {
		sourceKey: `${homeDir}/prod-control`,
		sourcePath: `${homeDir}/prod-control`,
		skillFilePath: join(destination, "SKILL.md"),
		repoPath: `${homeDir}/prod-control`,
		projectsRoot: homeDir,
		sourceType: "repo-root",
		metadataName: "prod",
		frontmatterIssues: [],
		canonicalSlug: "prod",
		contentHash: "hash",
	};
	const config: Config = {
		version: 1,
		projectsRoots: [homeDir],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
	const state: State = { version: 1, managedEntries: {} };
	const plan = buildSyncPlan([skill], [harness], config, state);
	expect(plan.conflicts).toBe(0);
	expect(plan.changes).toBe(1);
	expect(plan.harnesses[0]?.entries[0]?.action).toBe("repair");
});

test("repairs repo-root symlink installs when nested skills match the canonical source", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const harnessRoot = `${homeDir}/.factory/skills`;
	const destination = join(harnessRoot, "appcast");
	const repoRoot = join(homeDir, "appcast");
	const nestedSkillDir = join(repoRoot, "skills", "appcast");
	const nestedSkillFile = join(nestedSkillDir, "SKILL.md");

	mkdirSync(nestedSkillDir, { recursive: true });
	writeText(
		nestedSkillFile,
		"---\nname: appcast\ndescription: Nested skill\n---\n\n# Appcast\n",
	);
	writeText(
		join(repoRoot, "SKILL.md"),
		"---\nname: appcast\ndescription: Repo root skill\n---\n\n# Appcast Root\n",
	);
	mkdirSync(harnessRoot, { recursive: true });
	symlinkSync(repoRoot, destination);

	const harness: HarnessDefinition = {
		id: "droid",
		label: "Droid",
		rootPath: harnessRoot,
		kind: "built-in",
		detected: true,
		enabled: true,
	};
	const skill: DiscoveredSkill = {
		sourceKey: nestedSkillDir,
		sourcePath: nestedSkillDir,
		skillFilePath: nestedSkillFile,
		repoPath: repoRoot,
		projectsRoot: homeDir,
		sourceType: "nested",
		metadataName: "appcast",
		frontmatterIssues: [],
		canonicalSlug: "appcast",
		contentHash: "hash",
	};
	const config: Config = {
		version: 1,
		projectsRoots: [homeDir],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
	const state: State = { version: 1, managedEntries: {} };
	const plan = buildSyncPlan([skill], [harness], config, state);
	expect(plan.conflicts).toBe(0);
	expect(plan.changes).toBe(1);
	expect(plan.harnesses[0]?.entries[0]?.action).toBe("repair");
});

test("repairs unmanaged top-level directory symlink installs instead of reporting conflicts", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const harnessRoot = `${homeDir}/.codex/skills`;
	const destination = join(harnessRoot, "vssh");
	const legacySource = join(homeDir, "legacy-vssh");
	mkdirSync(legacySource, { recursive: true });
	writeText(
		join(legacySource, "SKILL.md"),
		"---\nname: legacy-vssh\ndescription: legacy\n---\n\n# Legacy\n",
	);
	mkdirSync(harnessRoot, { recursive: true });
	symlinkSync(legacySource, destination);

	const sourcePath = join(homeDir, "projects", "vssh", "skills", "vssh");
	const sourceSkillPath = join(sourcePath, "SKILL.md");
	writeText(
		sourceSkillPath,
		"---\nname: vssh\ndescription: canonical\n---\n\n# VSSH\n",
	);

	const harness: HarnessDefinition = {
		id: "codex",
		label: "Codex",
		rootPath: harnessRoot,
		kind: "built-in",
		detected: true,
		enabled: true,
	};
	const skill: DiscoveredSkill = {
		sourceKey: sourcePath,
		sourcePath,
		skillFilePath: sourceSkillPath,
		repoPath: join(homeDir, "projects", "vssh"),
		projectsRoot: join(homeDir, "projects"),
		sourceType: "nested",
		metadataName: "vssh",
		frontmatterIssues: [],
		canonicalSlug: "vssh",
		contentHash: "hash",
	};
	const config: Config = {
		version: 1,
		projectsRoots: [join(homeDir, "projects")],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
	const state: State = { version: 1, managedEntries: {} };

	const plan = buildSyncPlan([skill], [harness], config, state);
	expect(plan.conflicts).toBe(0);
	expect(plan.changes).toBe(1);
	expect(plan.harnesses[0]?.entries[0]?.action).toBe("repair");
});

test("treats tracked codex materialized skill directories as already synced", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const harnessRoot = `${homeDir}/.codex/skills`;
	const sourcePath = join(
		homeDir,
		"projects",
		"stack",
		"skills",
		"stack-foundation",
	);
	const sourceSkillPath = join(sourcePath, "SKILL.md");
	writeText(
		sourceSkillPath,
		"---\nname: stack-foundation\ndescription: canonical\n---\n\n# Stack\n",
	);
	writeText(join(sourcePath, "agents", "openai.yaml"), "model: gpt-5.4\n");

	const destination = join(harnessRoot, "stack-foundation");
	writeText(
		join(destination, "SKILL.md"),
		"---\nname: stack-foundation\ndescription: canonical\n---\n\n# Stack\n",
	);
	writeText(join(destination, "agents", "openai.yaml"), "model: gpt-5.4\n");

	const harness: HarnessDefinition = {
		id: "codex",
		label: "Codex",
		rootPath: harnessRoot,
		kind: "built-in",
		detected: true,
		enabled: true,
	};
	const skill: DiscoveredSkill = {
		sourceKey: sourcePath,
		sourcePath,
		skillFilePath: sourceSkillPath,
		repoPath: join(homeDir, "projects", "stack"),
		projectsRoot: join(homeDir, "projects"),
		sourceType: "nested",
		metadataName: "stack-foundation",
		frontmatterIssues: [],
		canonicalSlug: "stack-foundation",
		contentHash: "hash",
	};
	const config: Config = {
		version: 1,
		projectsRoots: [join(homeDir, "projects")],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
	const state: State = {
		version: 1,
		managedEntries: {
			[destination]: {
				harnessId: "codex",
				sourcePath,
				installName: "stack-foundation",
				updatedAt: "2026-04-10T00:00:00.000Z",
			},
		},
	};

	const plan = buildSyncPlan([skill], [harness], config, state);
	expect(plan.conflicts).toBe(0);
	expect(plan.changes).toBe(0);
	expect(plan.harnesses[0]?.entries[0]?.action).toBe("ok");
});

test("treats tracked agents materialized skill directories as already synced when codex visibility bridge is enabled", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const harnessRoot = `${homeDir}/.agents/skills`;
	const sourcePath = join(
		homeDir,
		"projects",
		"advising",
		"skills",
		"advising",
	);
	const sourceSkillPath = join(sourcePath, "SKILL.md");
	writeText(
		sourceSkillPath,
		"---\nname: advising\ndescription: canonical\n---\n\n# Advising\n",
	);

	const destination = join(harnessRoot, "advising");
	writeText(
		join(destination, "SKILL.md"),
		"---\nname: advising\ndescription: canonical\n---\n\n# Advising\n",
	);

	const harnesses: HarnessDefinition[] = [
		{
			id: "agents",
			label: "Agents",
			rootPath: harnessRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
		{
			id: "codex",
			label: "Codex",
			rootPath: `${homeDir}/.codex/skills`,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];
	const skill: DiscoveredSkill = {
		sourceKey: sourcePath,
		sourcePath,
		skillFilePath: sourceSkillPath,
		repoPath: join(homeDir, "projects", "advising"),
		projectsRoot: join(homeDir, "projects"),
		sourceType: "nested",
		metadataName: "advising",
		frontmatterIssues: [],
		canonicalSlug: "advising",
		contentHash: "hash",
	};
	const config: Config = {
		version: 1,
		projectsRoots: [join(homeDir, "projects")],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
	const state: State = {
		version: 1,
		managedEntries: {
			[destination]: {
				harnessId: "agents",
				sourcePath,
				installName: "advising",
				updatedAt: "2026-04-10T00:00:00.000Z",
				installMode: "materialized-directory",
			},
		},
	};

	const plan = buildSyncPlan([skill], harnesses, config, state, undefined, {
		codexVisibilityBridge: true,
	});
	const agentsEntry = plan.harnesses.find(
		(harness) => harness.harness.id === "agents",
	)?.entries[0];
	expect(agentsEntry?.installMode).toBe("materialized-directory");
	expect(agentsEntry?.action).toBe("ok");
});

test("repairs tracked agents materialized skill directories back to wrapper installs when codex visibility bridge is disabled", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const harnessRoot = `${homeDir}/.agents/skills`;
	const sourcePath = join(
		homeDir,
		"projects",
		"advising",
		"skills",
		"advising",
	);
	const sourceSkillPath = join(sourcePath, "SKILL.md");
	writeText(
		sourceSkillPath,
		"---\nname: advising\ndescription: canonical\n---\n\n# Advising\n",
	);

	const destination = join(harnessRoot, "advising");
	writeText(
		join(destination, "SKILL.md"),
		"---\nname: advising\ndescription: canonical\n---\n\n# Advising\n",
	);

	const harness: HarnessDefinition = {
		id: "agents",
		label: "Agents",
		rootPath: harnessRoot,
		kind: "built-in",
		detected: true,
		enabled: true,
	};
	const skill: DiscoveredSkill = {
		sourceKey: sourcePath,
		sourcePath,
		skillFilePath: sourceSkillPath,
		repoPath: join(homeDir, "projects", "advising"),
		projectsRoot: join(homeDir, "projects"),
		sourceType: "nested",
		metadataName: "advising",
		frontmatterIssues: [],
		canonicalSlug: "advising",
		contentHash: "hash",
	};
	const config: Config = {
		version: 1,
		projectsRoots: [join(homeDir, "projects")],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
	const state: State = {
		version: 1,
		managedEntries: {
			[destination]: {
				harnessId: "agents",
				sourcePath,
				installName: "advising",
				updatedAt: "2026-04-10T00:00:00.000Z",
				installMode: "materialized-directory",
			},
		},
	};

	const plan = buildSyncPlan([skill], [harness], config, state);
	expect(plan.harnesses[0]?.entries[0]?.installMode).toBe("wrapper-symlink");
	expect(plan.harnesses[0]?.entries[0]?.action).toBe("repair");
});

test("repairs tracked materialized installs when destination SKILL.md is still a symlink", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const harnessRoot = `${homeDir}/.agents/skills`;
	const sourcePath = join(homeDir, "projects", "manager", "skills", "manager");
	const sourceSkillPath = join(sourcePath, "SKILL.md");
	writeText(
		sourceSkillPath,
		"---\nname: manager\ndescription: canonical\n---\n\n# Manager\n",
	);

	const destination = join(harnessRoot, "manager");
	mkdirSync(destination, { recursive: true });
	symlinkSync(sourceSkillPath, join(destination, "SKILL.md"));

	const harnesses: HarnessDefinition[] = [
		{
			id: "agents",
			label: "Agents",
			rootPath: harnessRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
		{
			id: "codex",
			label: "Codex",
			rootPath: `${homeDir}/.codex/skills`,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];
	const skill: DiscoveredSkill = {
		sourceKey: sourcePath,
		sourcePath,
		skillFilePath: sourceSkillPath,
		repoPath: join(homeDir, "projects", "manager"),
		projectsRoot: join(homeDir, "projects"),
		sourceType: "nested",
		metadataName: "manager",
		frontmatterIssues: [],
		canonicalSlug: "manager",
		contentHash: "hash",
	};
	const config: Config = {
		version: 1,
		projectsRoots: [join(homeDir, "projects")],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
	const state: State = {
		version: 1,
		managedEntries: {
			[destination]: {
				harnessId: "agents",
				sourcePath,
				installName: "manager",
				updatedAt: "2026-04-10T00:00:00.000Z",
				installMode: "materialized-directory",
			},
		},
	};

	const plan = buildSyncPlan([skill], harnesses, config, state, undefined, {
		codexVisibilityBridge: true,
	});
	const agentsEntry = plan.harnesses.find(
		(harness) => harness.harness.id === "agents",
	)?.entries[0];
	expect(agentsEntry?.installMode).toBe("materialized-directory");
	expect(agentsEntry?.action).toBe("repair");
});

test("flags cross-harness top-level symlinks as traversal hazards", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = `${homeDir}/.codex/skills`;
	const agentsRoot = `${homeDir}/.agents/skills`;
	const codexEntry = join(codexRoot, "prod");
	mkdirSync(codexEntry, { recursive: true });
	writeText(
		join(codexEntry, "SKILL.md"),
		"---\nname: prod\ndescription: prod\n---\n\n# prod\n",
	);
	mkdirSync(agentsRoot, { recursive: true });
	symlinkSync(codexEntry, join(agentsRoot, "prod"));

	const diagnostics = findHarnessTraversalDiagnostics([
		{
			id: "codex",
			label: "Codex",
			rootPath: codexRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
		{
			id: "agents",
			label: "Agents",
			rootPath: agentsRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	]);

	expect(
		diagnostics.some(
			(diagnostic) =>
				diagnostic.kind === "cross-harness-symlink" &&
				diagnostic.harnessId === "agents" &&
				diagnostic.entryName === "prod",
		),
	).toBe(true);
});
