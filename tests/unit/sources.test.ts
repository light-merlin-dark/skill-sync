import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import {
	describeSkill,
	discoverSkillSet,
	repairBrokenNestedSkillLinks,
} from "../../src/core/sources";
import type { Config, HarnessDefinition } from "../../src/core/types";
import {
	cleanup,
	linkPath,
	makeFakeProjectsRoot,
	makeHarnessRoot,
	makeLinkedWorktreeSkill,
	makeNestedSkill,
	makeTopLevelSkill,
	markAsGitRepo,
	readSkillFile,
	writeText,
} from "../support";
import { join } from "node:path";

function makeConfig(projectsRoot: string): Config {
	return {
		version: 1,
		projectsRoots: [projectsRoot],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
			preferPrimaryWorktree: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
}

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

test("discovers nested skills and skips repo-root skills as polluted", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	makeTopLevelSkill(projectsRoot, "prod-control", "prod");
	makeNestedSkill(
		projectsRoot,
		"packages",
		"stack-foundation",
		"StackFoundation",
	);
	const config = makeConfig(projectsRoot);

	const { skills, sourceDiagnostics } = discoverSkillSet(config);
	expect(skills.map((skill) => skill.canonicalSlug)).toEqual([
		"stack-foundation",
	]);
	expect(
		sourceDiagnostics.warnings.some(
			(w) => w.kind === "repo-root-pollution" && w.slug === "prod",
		),
	).toBe(true);
});

test("discovers skill repos nested one level below a projects root child", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	makeNestedSkill(projectsRoot, "db/db-cli", "db-cli", "db");

	const { skills } = discoverSkillSet(makeConfig(projectsRoot));
	const dbSkill = skills.find((skill) => skill.canonicalSlug === "db");
	expect(dbSkill?.sourcePath).toContain("/db/db-cli/skills/db-cli");
});

test("ignores hidden nested repo containers during discovery", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	makeNestedSkill(
		projectsRoot,
		"ldis/.claude",
		"agent-browser",
		"agent-browser",
	);

	const { skills } = discoverSkillSet(makeConfig(projectsRoot));
	expect(skills.map((skill) => skill.canonicalSlug)).not.toContain(
		"agent-browser",
	);
});

test("skips repo-root skill and discovers nested equivalent instead", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	makeTopLevelSkill(projectsRoot, "vssh", "vssh");
	makeNestedSkill(projectsRoot, "vssh", "vssh", "vssh");

	const config = makeConfig(projectsRoot);

	const { skills, sourceDiagnostics } = discoverSkillSet(config);
	expect(skills).toHaveLength(1);
	expect(skills[0]?.sourceType).toBe("nested");
	expect(
		sourceDiagnostics.warnings.some(
			(w) => w.kind === "repo-root-pollution" && w.slug === "vssh",
		),
	).toBe(true);
});

test("collapses identical duplicate skills across repos to one canonical source", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	makeNestedSkill(
		projectsRoot,
		"agent-browser-src",
		"agent-browser",
		"agent-browser",
	);
	makeNestedSkill(projectsRoot, "devh", "agent-browser", "agent-browser");

	const config = makeConfig(projectsRoot);

	const { skills, sourceDiagnostics } = discoverSkillSet(config);
	expect(skills).toHaveLength(1);
	expect(skills[0]?.sourcePath).toContain("/agent-browser-src/");
	expect(sourceDiagnostics.warnings).toHaveLength(1);
	expect(sourceDiagnostics.warnings[0]?.slug).toBe("agent-browser");
	expect(sourceDiagnostics.warnings[0]?.chosenSourcePath).toContain(
		"/agent-browser-src/",
	);
});

test("drops a linked-worktree copy when the primary checkout provides the same slug", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	const primaryRepo = join(projectsRoot, "email-cli");
	const primaryNested = makeNestedSkill(
		projectsRoot,
		"email-cli",
		"email-cli",
		"email-cli",
	);
	markAsGitRepo(primaryRepo);
	// Stale feature-branch checkout with DIVERGENT content — the exact scenario
	// that used to raise a blocking unresolved-duplicate error.
	const worktreeNested = makeLinkedWorktreeSkill(
		projectsRoot,
		"email-cli-signature",
		"email-cli",
		primaryRepo,
		"email-cli",
	);
	writeText(
		join(worktreeNested, "SKILL.md"),
		"---\nname: email-cli\ndescription: stale worktree copy\n---\n\n# Old\n",
	);

	const { skills, sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
	);
	const emailSkills = skills.filter(
		(skill) => skill.canonicalSlug === "email-cli",
	);
	expect(emailSkills).toHaveLength(1);
	expect(emailSkills[0]?.sourcePath).toContain("/email-cli/skills/email-cli");
	expect(emailSkills[0]?.sourcePath).not.toContain("email-cli-signature");
	expect(primaryNested.endsWith("/email-cli/skills/email-cli")).toBe(true);
	// The worktree copy is not a competing source at all: no error, no warning.
	expect(
		sourceDiagnostics.errors.filter((d) => d.slug === "email-cli"),
	).toHaveLength(0);
	expect(
		sourceDiagnostics.warnings.filter(
			(d) => d.kind === "duplicate-slug" && d.slug === "email-cli",
		),
	).toHaveLength(0);
});

test("keeps a linked-worktree skill when its primary checkout is absent", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	// Primary lives outside the projects root, so it is never discovered.
	const primaryOutside = join(homeDir, "elsewhere", "solo-tool");
	makeLinkedWorktreeSkill(
		projectsRoot,
		"solo-tool-wt",
		"solo-tool",
		primaryOutside,
		"solo-tool",
	);

	const { skills } = discoverSkillSet(makeConfig(projectsRoot));
	expect(skills.map((skill) => skill.canonicalSlug)).toContain("solo-tool");
});

test("preferPrimaryWorktree=false retains worktree copies as duplicates", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	const primaryRepo = join(projectsRoot, "email-cli");
	makeNestedSkill(projectsRoot, "email-cli", "email-cli", "email-cli");
	markAsGitRepo(primaryRepo);
	makeLinkedWorktreeSkill(
		projectsRoot,
		"email-cli-signature",
		"email-cli",
		primaryRepo,
		"email-cli",
	);

	const config = makeConfig(projectsRoot);
	config.discovery.preferPrimaryWorktree = false;
	const { sourceDiagnostics } = discoverSkillSet(config);
	// With the guard off, both identical copies survive to global dedup and
	// collapse with a duplicate-slug warning instead of being dropped up front.
	expect(
		sourceDiagnostics.warnings.filter(
			(d) => d.kind === "duplicate-slug" && d.slug === "email-cli",
		),
	).toHaveLength(1);
});

test("reports unresolved duplicate skills as source errors", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	makeNestedSkill(
		projectsRoot,
		"agent-browser-src",
		"agent-browser",
		"agent-browser",
	);
	makeNestedSkill(projectsRoot, "devh", "agent-browser", "agent-browser");
	makeTopLevelSkill(projectsRoot, "placeholder", "placeholder");

	const config = makeConfig(projectsRoot);
	const customSkillPath = `${projectsRoot}/devh/skills/agent-browser/SKILL.md`;
	writeText(
		customSkillPath,
		"---\nname: agent-browser\ndescription: divergent\n---\n\n# Divergent Skill\n",
	);

	const { skills, sourceDiagnostics } = discoverSkillSet(config);
	expect(
		skills.filter((skill) => skill.canonicalSlug === "agent-browser"),
	).toHaveLength(2);
	expect(sourceDiagnostics.errors).toHaveLength(1);
	expect(sourceDiagnostics.errors[0]?.slug).toBe("agent-browser");
	expect(sourceDiagnostics.errors[0]?.sourcePaths).toHaveLength(2);
});

test("warns when a slug is mirrored across many equivalent sources", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	for (let i = 0; i < 8; i += 1) {
		makeNestedSkill(
			projectsRoot,
			`mirror-${i}`,
			"agent-browser",
			"agent-browser",
		);
	}

	const { skills, sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
	);
	expect(
		skills.filter((skill) => skill.canonicalSlug === "agent-browser"),
	).toHaveLength(1);
	expect(
		sourceDiagnostics.warnings.some(
			(warning) =>
				warning.kind === "fanout-high" &&
				warning.slug === "agent-browser" &&
				warning.sourcePaths.length === 8,
		),
	).toBe(true);
});

test("discovers harness-installed skills and prefers project sources over harness fallbacks", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	makeNestedSkill(projectsRoot, "skill-sync", "skill-sync", "skill-sync");
	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	makeTopLevelSkill(codexRoot, "vendor-only", "vendor-only");
	makeTopLevelSkill(codexRoot, "skill-sync-shadow", "skill-sync");
	writeText(
		`${codexRoot}/skill-sync-shadow/SKILL.md`,
		"---\nname: skill-sync\ndescription: stale harness copy\n---\n\n# Stale Copy\n",
	);

	const harnesses: HarnessDefinition[] = [
		{
			id: "codex",
			label: "Codex",
			rootPath: codexRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];

	const { skills, sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
		harnesses,
	);
	expect(skills.map((skill) => skill.canonicalSlug)).toContain("vendor-only");
	expect(
		skills.find((skill) => skill.canonicalSlug === "skill-sync")?.sourcePath,
	).toContain("/projects/skill-sync");
	expect(
		sourceDiagnostics.warnings.some((warning) => warning.slug === "skill-sync"),
	).toBe(true);
});

test("does not warn when a harness install points back to the exact same project source path", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const paperCreationPath = makeNestedSkill(
		projectsRoot,
		"rbeckner",
		"paper-creation",
		"rbeckner-paper-creation",
	);
	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	linkPath(`${codexRoot}/rbeckner-paper-creation`, paperCreationPath);

	const harnesses: HarnessDefinition[] = [
		{
			id: "codex",
			label: "Codex",
			rootPath: codexRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];

	const { skills, sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
		harnesses,
	);
	expect(
		skills.filter((skill) => skill.canonicalSlug === "rbeckner-paper-creation"),
	).toHaveLength(1);
	expect(
		sourceDiagnostics.warnings.some(
			(warning) => warning.slug === "rbeckner-paper-creation",
		),
	).toBe(false);
});

test("collapses wrapper-directory mirrors across harness roots to canonical sources", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const sourcePath = makeNestedSkill(
		projectsRoot,
		"dev-control",
		"dev-control",
		"dev",
	);
	const sourceSkillPath = `${sourcePath}/SKILL.md`;
	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const opencodeRoot = makeHarnessRoot(homeDir, ".config/opencode/skills");
	mkdirSync(`${codexRoot}/dev`, { recursive: true });
	mkdirSync(`${opencodeRoot}/dev`, { recursive: true });
	linkPath(`${codexRoot}/dev/SKILL.md`, sourceSkillPath);
	linkPath(`${opencodeRoot}/dev/SKILL.md`, sourceSkillPath);

	const harnesses: HarnessDefinition[] = [
		{
			id: "codex",
			label: "Codex",
			rootPath: codexRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
		{
			id: "opencode",
			label: "OpenCode",
			rootPath: opencodeRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];

	const { skills, sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
		harnesses,
	);
	const devSkills = skills.filter((skill) => skill.canonicalSlug === "dev");
	expect(devSkills).toHaveLength(1);
	expect(
		devSkills[0]?.sourcePath.endsWith(
			"/projects/dev-control/skills/dev-control",
		),
	).toBe(true);
	expect(
		sourceDiagnostics.warnings.some(
			(warning) => warning.kind === "duplicate-slug" && warning.slug === "dev",
		),
	).toBe(false);
});

test("preserves the owning harness and local-only scope for mirrored harness-native skills", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const agentsRoot = makeHarnessRoot(homeDir, ".agents/skills");
	const hermesRoot = makeHarnessRoot(homeDir, ".hermes/skills");
	const dogfoodPath = makeTopLevelSkill(hermesRoot, "dogfood", "dogfood");
	writeText(
		`${dogfoodPath}/SKILL.md`,
		"---\nname: dogfood\ndescription: Hermes-only QA skill\nskill-sync-scope: local-only\n---\n\n# Dogfood\n",
	);
	linkPath(`${agentsRoot}/dogfood`, dogfoodPath);

	const harnesses: HarnessDefinition[] = [
		{
			id: "agents",
			label: "Agents",
			rootPath: agentsRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
		{
			id: "hermes",
			label: "Hermes",
			rootPath: hermesRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];

	const { skills } = discoverSkillSet(makeConfig(projectsRoot), harnesses);
	const dogfood = skills.find((skill) => skill.canonicalSlug === "dogfood");
	if (!dogfood) {
		throw new Error("expected dogfood skill to be discovered");
	}
	expect(dogfood?.harnessId).toBe("hermes");
	expect(dogfood?.installHarnessIds).toEqual(["hermes"]);
	expect(describeSkill(dogfood)).toContain("[local-only: hermes]");
});

test("treats harness-root sources as local-only by default", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const cursorRoot = makeHarnessRoot(homeDir, ".cursor/skills");
	const vendorSkillPath = makeTopLevelSkill(
		codexRoot,
		"vendor-only",
		"vendor-only",
	);
	linkPath(`${cursorRoot}/vendor-only`, vendorSkillPath);

	const harnesses: HarnessDefinition[] = [
		{
			id: "codex",
			label: "Codex",
			rootPath: codexRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
		{
			id: "cursor",
			label: "Cursor",
			rootPath: cursorRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];

	const { skills } = discoverSkillSet(makeConfig(projectsRoot), harnesses);
	const vendorOnly = skills.find(
		(skill) => skill.canonicalSlug === "vendor-only",
	);
	if (!vendorOnly) {
		throw new Error("expected vendor-only skill to be discovered");
	}
	expect(vendorOnly?.harnessId).toBe("codex");
	expect(vendorOnly?.installHarnessIds).toEqual(["codex"]);
	expect(describeSkill(vendorOnly)).toContain("[local-only: codex]");
});

test("allows divergent harness-local skills with disjoint install scopes", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const opencodeRoot = makeHarnessRoot(homeDir, ".config/opencode/skills");
	const kimiRoot = makeHarnessRoot(homeDir, ".kimi/skills");
	makeTopLevelSkill(opencodeRoot, "logo-pipeline", "logo-pipeline");
	const kimiSkill = makeTopLevelSkill(kimiRoot, "logo-pipeline", "logo-pipeline");
	writeText(
		`${kimiSkill}/SKILL.md`,
		"---\nname: logo-pipeline\ndescription: Kimi-specific implementation\n---\n\n# Kimi Logo Pipeline\n",
	);

	const harnesses: HarnessDefinition[] = [
		{
			id: "opencode",
			label: "OpenCode",
			rootPath: opencodeRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
		{
			id: "kimi",
			label: "Kimi",
			rootPath: kimiRoot,
			kind: "custom",
			detected: true,
			enabled: true,
		},
	];

	const { skills, sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
		harnesses,
	);
	const logoSkills = skills.filter(
		(skill) => skill.canonicalSlug === "logo-pipeline",
	);
	expect(logoSkills).toHaveLength(2);
	expect(
		logoSkills
			.flatMap((skill) => skill.installHarnessIds || [])
			.sort(),
	).toEqual(["kimi", "opencode"]);
	expect(
		sourceDiagnostics.errors.some(
			(error) => error.slug === "logo-pipeline",
		),
	).toBe(false);
});

test("keeps shared agents-root skills global by default", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const agentsRoot = makeHarnessRoot(homeDir, ".agents/skills");
	makeTopLevelSkill(agentsRoot, "agent-browser", "agent-browser");

	const harnesses: HarnessDefinition[] = [
		{
			id: "agents",
			label: "Agents",
			rootPath: agentsRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];

	const { skills } = discoverSkillSet(makeConfig(projectsRoot), harnesses);
	const sharedSkill = skills.find(
		(skill) => skill.canonicalSlug === "agent-browser",
	);
	if (!sharedSkill) {
		throw new Error("expected shared agent-browser skill to be discovered");
	}
	expect(
		sharedSkill?.sourcePath.endsWith("/.agents/skills/agent-browser"),
	).toBe(true);
	expect(sharedSkill?.installHarnessIds).toBeUndefined();
	expect(describeSkill(sharedSkill)).not.toContain("local-only");
});

test("does not warn when a harness mirror exactly matches the project source", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const projectSkill = makeNestedSkill(projectsRoot, "invoice", "invoice", "invoice");
	const agentsRoot = makeHarnessRoot(homeDir, ".agents/skills");
	const mirror = makeTopLevelSkill(agentsRoot, "invoice", "invoice");
	writeText(`${mirror}/SKILL.md`, readSkillFile(`${projectSkill}/SKILL.md`));

	const harnesses: HarnessDefinition[] = [
		{
			id: "agents",
			label: "Agents",
			rootPath: agentsRoot,
			kind: "built-in",
			detected: true,
			enabled: true,
		},
	];
	const { sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
		harnesses,
	);

	expect(
		sourceDiagnostics.warnings.some(
			(warning) => warning.kind === "duplicate-slug" && warning.slug === "invoice",
		),
	).toBe(false);
});

test("reports malformed or missing frontmatter as source warnings", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const brokenRepo = makeNestedSkill(projectsRoot, "db-cli", "db-cli");
	writeText(
		`${brokenRepo}/SKILL.md`,
		"name: db\ndescription: Broken frontmatter example\n---\n\n# DB\n",
	);

	const { skills, sourceDiagnostics } = discoverSkillSet(
		makeConfig(projectsRoot),
	);
	const brokenSkill = skills.find((skill) =>
		skill.sourcePath.endsWith("/db-cli"),
	);
	expect(brokenSkill?.frontmatterIssues).toContain(
		"missing YAML frontmatter block (`---` header)",
	);
	expect(
		sourceDiagnostics.warnings.some(
			(warning) =>
				warning.kind === "invalid-frontmatter" &&
				warning.sourcePaths.some((path) => path.endsWith("/db-cli")),
		),
	).toBe(true);
});

test("treats invalid YAML frontmatter as a blocking source error", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const brokenRepo = makeNestedSkill(
		projectsRoot,
		"dev-control",
		"dev-control",
		"dev-control",
	);
	writeText(
		`${brokenRepo}/SKILL.md`,
		"---\nname: dev-control\ndescription: Control plane skill: intake + audits\n---\n\n# Dev Control\n",
	);

	const { sourceDiagnostics, skills } = discoverSkillSet(
		makeConfig(projectsRoot),
	);
	const brokenSkill = skills.find((skill) =>
		skill.sourcePath.endsWith("/dev-control"),
	);
	expect(
		brokenSkill?.frontmatterIssues.some((issue) =>
			issue.startsWith("invalid YAML frontmatter:"),
		),
	).toBe(true);
	expect(
		sourceDiagnostics.errors.some(
			(error) =>
				error.kind === "invalid-frontmatter" &&
				error.slug === "dev-control" &&
				Boolean(error.message?.startsWith("invalid YAML frontmatter:")),
		),
	).toBe(true);
});

test("reports and repairs broken nested SKILL.md symlinks using pre-migration backups", () => {
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const nestedSkillDir = `${projectsRoot}/cf-cli/skills/cf`;
	const nestedSkillFile = `${nestedSkillDir}/SKILL.md`;
	writeText(`${nestedSkillDir}/README.md`, "stub");
	linkPath(nestedSkillFile, "../../SKILL.md");
	writeText(
		`${projectsRoot}/cf-cli/SKILL.md.pre-migration-backup`,
		"---\nname: cf\ndescription: Restored from backup\n---\n\n# CF\n",
	);

	const config = makeConfig(projectsRoot);
	const before = discoverSkillSet(config);
	expect(
		before.sourceDiagnostics.errors.some(
			(error) => error.kind === "broken-skill-link" && error.slug === "cf",
		),
	).toBe(true);

	const dryRun = repairBrokenNestedSkillLinks(config, true);
	expect(dryRun.brokenLinks).toHaveLength(1);
	expect(dryRun.repairedLinks).toHaveLength(1);
	expect(dryRun.skipped).toHaveLength(0);

	const applied = repairBrokenNestedSkillLinks(config, false);
	expect(applied.repairedLinks).toHaveLength(1);
	expect(readSkillFile(nestedSkillFile)).toContain("name: cf");

	const after = discoverSkillSet(config);
	expect(
		after.sourceDiagnostics.errors.some(
			(error) => error.kind === "broken-skill-link",
		),
	).toBe(false);
	expect(after.skills.some((skill) => skill.canonicalSlug === "cf")).toBe(true);
});
