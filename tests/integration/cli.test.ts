import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
	cleanup,
	makeFakeProjectsRoot,
	makeHarnessRoot,
	makeNestedSkill,
	readSkillFile,
	writeExecutableText,
	writeText,
} from "../support";

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

function runCli(cwd: string, args: string[], env: Record<string, string>) {
	return Bun.spawnSync({
		cmd: ["bun", "run", "src/index.ts", ...args],
		cwd,
		env: {
			...process.env,
			...env,
		},
		stderr: "pipe",
		stdout: "pipe",
	});
}

test("syncs, backs up, and restores inside a fake home", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	makeHarnessRoot(homeDir, ".claude/skills");
	makeNestedSkill(projectsRoot, "prod-control", "prod", "prod");
	const stackSkillDir = makeNestedSkill(
		projectsRoot,
		"packages-stack",
		"stack-foundation",
		"StackFoundation",
	);
	writeText(join(stackSkillDir, "agents", "openai.yaml"), "model: gpt-5.4\n");

	const baseArgs = ["--home", homeDir, "--projects-root", projectsRoot];

	const checkBefore = runCli(repoRoot, ["check", ...baseArgs], {});
	expect(checkBefore.exitCode).toBe(2);
	expect(checkBefore.stdout.toString()).toContain("create");

	const syncResult = runCli(repoRoot, ["execute", ...baseArgs], {});
	expect(syncResult.exitCode).toBe(0);
	expect(lstatSync(join(codexRoot, "prod")).isDirectory()).toBe(true);
	expect(lstatSync(join(codexRoot, "prod", "SKILL.md")).isFile()).toBe(true);
	expect(lstatSync(join(codexRoot, "stack-foundation")).isDirectory()).toBe(
		true,
	);
	expect(
		lstatSync(join(codexRoot, "stack-foundation", "SKILL.md")).isFile(),
	).toBe(true);
	expect(
		readFileSync(
			join(codexRoot, "stack-foundation", "agents", "openai.yaml"),
			"utf8",
		),
	).toContain("model: gpt-5.4");

	const backupCreate = runCli(
		repoRoot,
		["backup", "create", "--home", homeDir, "--harness", "codex"],
		{},
	);
	expect(backupCreate.exitCode).toBe(0);
	const backupId = backupCreate.stdout
		.toString()
		.match(/Created backup ([^\n]+)/)?.[1];
	expect(Boolean(backupId)).toBe(true);
	if (!backupId) {
		throw new Error("expected backup id from backup create output");
	}

	rmSync(join(codexRoot, "prod"), { recursive: true, force: true });
	rmSync(join(projectsRoot, "prod-control"), { recursive: true, force: true });

	const restoreResult = runCli(
		repoRoot,
		["backup", "restore", backupId, "--home", homeDir, "--harness", "codex"],
		{},
	);
	expect(restoreResult.exitCode).toBe(0);
	expect(existsSync(join(codexRoot, "prod", "SKILL.md"))).toBe(true);
	expect(lstatSync(join(codexRoot, "prod")).isDirectory()).toBe(true);
	expect(readSkillFile(join(codexRoot, "prod", "SKILL.md"))).toContain(
		"name: prod",
	);
	const manifestPath = join(
		homeDir,
		".skill-sync",
		"backups",
		backupId,
		"manifest.json",
	);
	const manifest = JSON.parse(readSkillFile(manifestPath));
	expect(JSON.stringify(manifest)).not.toContain("materialized");
});

test("reports unmanaged conflicts instead of clobbering them", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	makeNestedSkill(
		projectsRoot,
		"coolify-helper-repo",
		"coolify-helper",
		"coolify-helper",
	);
	mkdirSync(join(codexRoot, "coolify-helper"), { recursive: true });
	writeText(join(codexRoot, "coolify-helper", "README.txt"), "unmanaged");

	const checkResult = runCli(
		repoRoot,
		["check", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(checkResult.exitCode).toBe(3);
	expect(checkResult.stdout.toString()).toContain("conflict");
});

test("execute can continue applying non-conflicting changes when conflicts exist", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	makeNestedSkill(
		projectsRoot,
		"coolify-helper-repo",
		"coolify-helper",
		"coolify-helper",
	);
	makeNestedSkill(projectsRoot, "prod-control", "prod", "prod");
	mkdirSync(join(codexRoot, "coolify-helper"), { recursive: true });
	writeText(join(codexRoot, "coolify-helper", "README.txt"), "unmanaged");

	const result = runCli(
		repoRoot,
		[
			"execute",
			"--continue-on-conflict",
			"--home",
			homeDir,
			"--projects-root",
			projectsRoot,
		],
		{},
	);
	expect(result.exitCode).toBe(3);
	expect(result.stdout.toString()).toContain("conflict");
	expect(lstatSync(join(codexRoot, "prod")).isDirectory()).toBe(true);
	expect(lstatSync(join(codexRoot, "prod", "SKILL.md")).isFile()).toBe(true);
	expect(readFileSync(join(codexRoot, "prod", "SKILL.md"), "utf8")).toContain(
		"name: prod",
	);
});

test("stabilize runs safe dry-run by default and applies with --execute", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const agentsRoot = join(homeDir, ".agents", "skills");
	makeNestedSkill(projectsRoot, "prod-control", "prod", "prod");

	const baseArgs = [
		"--home",
		homeDir,
		"--projects-root",
		projectsRoot,
		"--harness",
		"codex",
	];
	const dryRun = runCli(repoRoot, ["stabilize", ...baseArgs], {
		SKILL_SYNC_SKIP_CODEX_APP_SERVER: "1",
	});
	expect(dryRun.exitCode).toBe(2);
	expect(dryRun.stdout.toString()).toContain("Stabilize (dry-run)");
	expect(existsSync(join(codexRoot, "prod"))).toBe(false);
	expect(existsSync(join(agentsRoot, "prod"))).toBe(false);

	const execute = runCli(repoRoot, ["stabilize", "--execute", ...baseArgs], {
		SKILL_SYNC_SKIP_CODEX_APP_SERVER: "1",
	});
	expect(execute.exitCode).toBe(0);
	expect(execute.stdout.toString()).toContain("Stabilize (execute)");
	expect(existsSync(join(codexRoot, "prod"))).toBe(false);
	expect(lstatSync(join(agentsRoot, "prod")).isDirectory()).toBe(true);
	expect(lstatSync(join(agentsRoot, "prod", "SKILL.md")).isFile()).toBe(true);
});

test("surfaces source duplicate diagnostics before harness sync", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	makeHarnessRoot(homeDir, ".codex/skills");
	makeNestedSkill(
		projectsRoot,
		"agent-browser-src",
		"agent-browser",
		"agent-browser",
	);
	makeNestedSkill(projectsRoot, "devh", "agent-browser", "agent-browser");

	const warningResult = runCli(
		repoRoot,
		["check", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(warningResult.exitCode).toBe(2);
	expect(warningResult.stdout.toString()).toContain("Source warnings:");
	expect(warningResult.stdout.toString()).toContain(
		"duplicate slug: agent-browser",
	);

	writeText(
		join(projectsRoot, "devh", "skills", "agent-browser", "SKILL.md"),
		"---\nname: agent-browser\ndescription: Divergent agent-browser\n---\n\n# Divergent Skill\n",
	);

	const errorResult = runCli(
		repoRoot,
		["check", "--home", homeDir, "--projects-root", projectsRoot, "--json"],
		{},
	);
	expect(errorResult.exitCode).toBe(3);
	const parsed = JSON.parse(errorResult.stdout.toString());
	expect(parsed.sourceDiagnostics.errors).toHaveLength(1);
	expect(parsed.sourceDiagnostics.errors[0]?.slug).toBe("agent-browser");
});

test("backup create tolerates symlink loops inside a skill source", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const prodSkill = makeNestedSkill(
		projectsRoot,
		"prod-control",
		"prod",
		"prod",
	);
	symlinkSync(".", join(prodSkill, "loop"));

	const baseArgs = ["--home", homeDir, "--projects-root", projectsRoot];
	const syncResult = runCli(repoRoot, ["execute", ...baseArgs], {});
	expect(syncResult.exitCode).toBe(0);
	expect(lstatSync(join(codexRoot, "prod")).isDirectory()).toBe(true);
	expect(lstatSync(join(codexRoot, "prod", "SKILL.md")).isFile()).toBe(true);

	const backupCreate = runCli(
		repoRoot,
		["backup", "create", "--home", homeDir, "--harness", "codex", "--json"],
		{},
	);
	expect(backupCreate.exitCode).toBe(0);
	const manifest = JSON.parse(backupCreate.stdout.toString());
	const codexHarness = manifest.harnesses.find(
		(harness: { id: string }) => harness.id === "codex",
	);
	const prodEntry = codexHarness?.entries.find(
		(entry: { name: string }) => entry.name === "prod",
	);
	expect(prodEntry.skillFiles).toHaveLength(1);
	expect(prodEntry.skillFiles[0]?.relativePath).toBe("SKILL.md");
});

test("default command shows landing help while execute mutates and doctor diagnoses", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	makeHarnessRoot(homeDir, ".claude/skills");
	makeNestedSkill(projectsRoot, "skill-sync", "skill-sync", "skill-sync");
	mkdirSync(join(codexRoot, "legacy-skill"), { recursive: true });
	writeText(
		join(codexRoot, "legacy-skill", "SKILL.md"),
		"---\nname: legacy-skill\ndescription: Legacy skill\n---\n\n# Legacy\n",
	);

	const baseArgs = ["--home", homeDir, "--projects-root", projectsRoot];

	const helpResult = runCli(repoRoot, [], {});
	expect(helpResult.exitCode).toBe(0);
	const helpStdout = helpResult.stdout.toString();
	expect(helpStdout).toContain("High-signal commands:");
	expect(helpStdout).toContain("skill-sync doctor");
	expect(helpStdout).toContain("skill-sync execute");

	const syncResult = runCli(repoRoot, ["execute", ...baseArgs], {});
	expect(syncResult.exitCode).toBe(0);
	const syncStdout = syncResult.stdout.toString();
	expect(syncStdout).toContain("Summary:");
	expect(syncStdout).toContain("Harness changes:");
	expect(syncStdout).not.toContain("Orphan installed skills:");
	expect(syncStdout).not.toContain("missing entry will be created");

	const doctorResult = runCli(repoRoot, ["doctor", ...baseArgs], {});
	expect(doctorResult.exitCode).toBe(0);
	const doctorStdout = doctorResult.stdout.toString();
	expect(doctorStdout).toContain("Doctor");
	expect(doctorStdout).toContain("Orphans: 0");

	const verboseCheck = runCli(
		repoRoot,
		["doctor", "--verbose", ...baseArgs],
		{},
	);
	expect(verboseCheck.exitCode).toBe(0);
	const verboseStdout = verboseCheck.stdout.toString();
	expect(verboseStdout).toContain("codex  ");
	expect(verboseStdout).toContain("legacy-skill");

	const jsonSync = runCli(repoRoot, ["execute", "--json", ...baseArgs], {});
	expect(jsonSync.exitCode).toBe(0);
	const parsed = JSON.parse(jsonSync.stdout.toString());
	expect(parsed.changes).toBe(0);
	expect(parsed.orphanSkills || []).toHaveLength(0);
});

test("codex-audit reports workspace visibility gaps that extra user roots would recover", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	makeHarnessRoot(homeDir, ".codex/skills");
	makeNestedSkill(projectsRoot, "advising", "advising", "advising");
	makeNestedSkill(projectsRoot, "vssh", "vssh", "vssh");

	const executeResult = runCli(
		repoRoot,
		[
			"execute",
			"--home",
			homeDir,
			"--projects-root",
			projectsRoot,
			"--harness",
			"codex",
		],
		{},
	);
	expect(executeResult.exitCode).toBe(0);

	const mockCodexPath = join(homeDir, "bin", "codex");
	writeExecutableText(
		mockCodexPath,
		`#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'mock', codexHome: '${homeDir.replace(/\\/g, "\\\\")}/.codex', platformFamily: 'unix', platformOs: 'macos' } }) + '\\n');
    return;
  }
  if (message.method === 'skills/list') {
    const extraRoots = message.params?.perCwdExtraUserRoots?.[0]?.extraUserRoots || [];
    const skills = extraRoots.length > 0
      ? ['aibrowser', 'advising', 'vssh']
      : ['aibrowser'];
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        data: [{
          cwd: message.params?.cwds?.[0] || '${repoRoot.replace(/\\/g, "\\\\")}',
          skills: skills.map((name) => ({ name, description: name, path: '/tmp/' + name + '/SKILL.md', scope: 'user', enabled: true })),
          errors: [],
        }],
      },
    }) + '\\n');
  }
});
`,
	);

	const result = runCli(
		repoRoot,
		["codex-audit", "--home", homeDir, "--cwd", repoRoot, "--json"],
		{ SKILL_SYNC_CODEX_BIN: mockCodexPath },
	);
	expect(result.exitCode).toBe(2);
	const parsed = JSON.parse(result.stdout.toString());
	expect(parsed.workspaceProbes).toHaveLength(1);
	expect(parsed.workspaceProbes[0]?.status).toBe("ok");
	expect(parsed.workspaceProbes[0]?.missingManagedSkills).toEqual([
		"advising",
		"vssh",
	]);
	expect(
		parsed.workspaceProbes[0]?.missingManagedSkillsRecoveredWithExtraRoots,
	).toEqual(["advising", "vssh"]);
	expect(parsed.workspaceProbes[0]?.missingManagedSkillsStillMissing).toEqual(
		[],
	);
});

test("execute --harness codex also materializes agents-root bridge installs for Codex visibility", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const agentsRoot = join(homeDir, ".agents", "skills");
	const stackSkillDir = makeNestedSkill(
		projectsRoot,
		"packages-stack",
		"stack",
		"stack",
	);
	writeText(join(stackSkillDir, "agents", "openai.yaml"), "model: gpt-5.4\n");
	makeNestedSkill(projectsRoot, "advising", "advising", "advising");

	const executeResult = runCli(
		repoRoot,
		[
			"execute",
			"--home",
			homeDir,
			"--projects-root",
			projectsRoot,
			"--harness",
			"codex",
		],
		{},
	);
	expect(executeResult.exitCode).toBe(0);

	expect(existsSync(join(codexRoot, "advising"))).toBe(false);
	expect(existsSync(join(codexRoot, "stack"))).toBe(false);
	expect(lstatSync(join(agentsRoot, "advising")).isDirectory()).toBe(true);
	expect(lstatSync(join(agentsRoot, "advising", "SKILL.md")).isFile()).toBe(
		true,
	);
	expect(lstatSync(join(agentsRoot, "stack")).isDirectory()).toBe(true);
	expect(lstatSync(join(agentsRoot, "stack", "SKILL.md")).isFile()).toBe(true);
	expect(
		readFileSync(join(agentsRoot, "stack", "agents", "openai.yaml"), "utf8"),
	).toContain("model: gpt-5.4");

	const doctorResult = runCli(
		repoRoot,
		[
			"doctor",
			"--home",
			homeDir,
			"--projects-root",
			projectsRoot,
			"--harness",
			"codex",
			"--json",
		],
		{},
	);
	expect(doctorResult.exitCode).toBe(0);
	const parsed = JSON.parse(doctorResult.stdout.toString());
	const agentsEntries =
		parsed.harnesses.find(
			(harness: { harness: { id: string } }) => harness.harness.id === "agents",
		)?.entries || [];
	const codexEntries =
		parsed.harnesses.find(
			(harness: { harness: { id: string } }) => harness.harness.id === "codex",
		)?.entries || [];
	expect(
		agentsEntries.some(
			(entry: { installName: string; action: string; installMode: string }) =>
				entry.installName === "advising" &&
				entry.action === "ok" &&
				entry.installMode === "materialized-directory",
		),
	).toBe(true);
	expect(
		agentsEntries.some(
			(entry: { installName: string; action: string; installMode: string }) =>
				entry.installName === "stack" &&
				entry.action === "ok" &&
				entry.installMode === "materialized-directory",
		),
	).toBe(true);
	expect(
		codexEntries.some(
			(entry: { installName: string }) => entry.installName === "advising",
		),
	).toBe(false);
	expect(
		codexEntries.some(
			(entry: { installName: string }) => entry.installName === "stack",
		),
	).toBe(false);
});

test("execute keeps harness-root sources on their owning harness by default", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const hermesRoot = makeHarnessRoot(homeDir, ".hermes/skills");
	mkdirSync(join(codexRoot, "vendor-only"), { recursive: true });
	writeText(
		join(codexRoot, "vendor-only", "SKILL.md"),
		"---\nname: vendor-only\ndescription: Vendor skill\n---\n\n# Vendor\n",
	);

	const result = runCli(
		repoRoot,
		["execute", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(result.exitCode).toBe(0);
	expect(existsSync(join(hermesRoot, "vendor-only"))).toBe(false);

	const doctorResult = runCli(
		repoRoot,
		["doctor", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(doctorResult.exitCode).toBe(0);
	expect(doctorResult.stdout.toString()).toContain(
		"Sources: 1 discovered skill source(s)",
	);
	expect(doctorResult.stdout.toString()).toContain("Scope: 0 global, 1 scoped");
});

test("execute keeps harness-local skills on their owning harness only", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const agentsRoot = makeHarnessRoot(homeDir, ".agents/skills");
	const hermesRoot = makeHarnessRoot(homeDir, ".hermes/skills");
	mkdirSync(join(hermesRoot, "dogfood"), { recursive: true });
	writeText(
		join(hermesRoot, "dogfood", "SKILL.md"),
		"---\nname: dogfood\ndescription: Hermes-only skill\nskill-sync-scope: local-only\n---\n\n# Dogfood\n",
	);

	const result = runCli(
		repoRoot,
		["execute", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(result.exitCode).toBe(0);
	expect(existsSync(join(agentsRoot, "dogfood"))).toBe(false);
	expect(lstatSync(join(hermesRoot, "dogfood")).isDirectory()).toBe(true);

	const doctorResult = runCli(
		repoRoot,
		["doctor", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(doctorResult.exitCode).toBe(0);
	const doctorStdout = doctorResult.stdout.toString();
	expect(doctorStdout).toContain("Scope: 0 global, 1 scoped");
	expect(doctorStdout).toContain("Expected installs: 1");

	const sourcesResult = runCli(
		repoRoot,
		["sources", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(sourcesResult.exitCode).toBe(0);
	expect(sourcesResult.stdout.toString()).toContain("dogfood <= hermes:");
	expect(sourcesResult.stdout.toString()).toContain("[local-only: hermes]");
});

test("doctor flags malformed skill metadata even when sync layout is otherwise fine", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	makeHarnessRoot(homeDir, ".codex/skills");
	const brokenSkillPath = makeNestedSkill(projectsRoot, "db-cli", "db-cli");
	writeText(
		join(brokenSkillPath, "SKILL.md"),
		"name: db\ndescription: Broken frontmatter example\n---\n\n# DB\n",
	);

	const result = runCli(
		repoRoot,
		["doctor", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(result.exitCode).toBe(2);
	expect(result.stdout.toString()).toContain("Source warnings:");
	expect(result.stdout.toString()).toContain("invalid skill metadata: db");
	expect(result.stdout.toString()).toContain("frontmatter");
});

test("execute is blocked when a source skill has invalid YAML frontmatter", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const brokenSkillPath = makeNestedSkill(
		projectsRoot,
		"dev-control",
		"dev-control",
		"dev-control",
	);
	writeText(
		join(brokenSkillPath, "SKILL.md"),
		"---\nname: dev-control\ndescription: Control plane skill: intake + audits\n---\n\n# Dev Control\n",
	);

	const doctorResult = runCli(
		repoRoot,
		["doctor", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(doctorResult.exitCode).toBe(3);
	expect(doctorResult.stdout.toString()).toContain(
		"invalid skill metadata: dev-control",
	);
	expect(doctorResult.stdout.toString()).toContain(
		"Codex/OpenCode-compatible YAML parsing will fail",
	);

	const executeResult = runCli(
		repoRoot,
		["execute", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(executeResult.exitCode).toBe(3);
	expect(existsSync(join(codexRoot, "dev-control"))).toBe(false);
});

test("doctor surfaces recursive harness traversal hazards that root-only checks miss", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	makeHarnessRoot(homeDir, ".codex/skills");
	const agentsRoot = makeHarnessRoot(homeDir, ".agents/skills");
	mkdirSync(join(homeDir, ".codex", "skills", "appcast", "skills", "appcast"), {
		recursive: true,
	});
	writeText(
		join(
			homeDir,
			".codex",
			"skills",
			"appcast",
			"skills",
			"appcast",
			"SKILL.md",
		),
		"---\nname: appcast\ndescription: Nested skill only\n---\n\n# Appcast\n",
	);
	symlinkSync("../../.codex/skills/appcast", join(agentsRoot, "appcast"));
	makeNestedSkill(projectsRoot, "prod-control", "prod", "prod");

	const result = runCli(
		repoRoot,
		["doctor", "--home", homeDir, "--projects-root", projectsRoot, "--json"],
		{},
	);
	expect(result.exitCode).toBe(2);
	const parsed = JSON.parse(result.stdout.toString());
	expect(
		parsed.harnessDiagnostics.some(
			(diagnostic: { kind: string; entryName: string }) =>
				diagnostic.kind === "missing-root-skill" &&
				diagnostic.entryName === "appcast",
		),
	).toBe(true);
});

test("doctor reports and execute removes broken harness-root symlinks", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	makeNestedSkill(projectsRoot, "prod-control", "prod", "prod");
	symlinkSync("/tmp/does-not-exist", join(codexRoot, "broken-skill"));

	const doctorBefore = runCli(
		repoRoot,
		["doctor", "--home", homeDir, "--projects-root", projectsRoot, "--json"],
		{},
	);
	expect(doctorBefore.exitCode).toBe(2);
	const parsedBefore = JSON.parse(doctorBefore.stdout.toString());
	expect(
		parsedBefore.harnessDiagnostics.some(
			(diagnostic: { kind: string; entryName: string }) =>
				diagnostic.kind === "broken-root-symlink" &&
				diagnostic.entryName === "broken-skill",
		),
	).toBe(true);

	const executeResult = runCli(
		repoRoot,
		["execute", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(executeResult.exitCode).toBe(0);
	expect(existsSync(join(codexRoot, "broken-skill"))).toBe(false);
});

test("doctor reports and execute removes unmanaged top-level directory symlinks", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	makeNestedSkill(projectsRoot, "prod-control", "prod", "prod");
	const legacySource = join(homeDir, "legacy-folder-skill");
	mkdirSync(legacySource, { recursive: true });
	writeText(join(legacySource, "README.md"), "legacy folder");
	symlinkSync(legacySource, join(codexRoot, "legacy-folder-skill"));

	const doctorBefore = runCli(
		repoRoot,
		["doctor", "--home", homeDir, "--projects-root", projectsRoot, "--json"],
		{},
	);
	expect(doctorBefore.exitCode).toBe(2);
	const parsedBefore = JSON.parse(doctorBefore.stdout.toString());
	expect(
		parsedBefore.harnesses.some(
			(harness: {
				harness: { id: string };
				entries: Array<{ action: string; installName: string }>;
			}) =>
				harness.harness.id === "codex" &&
				harness.entries.some(
					(entry) =>
						entry.action === "remove-dir-symlink" &&
						entry.installName === "legacy-folder-skill",
				),
		),
	).toBe(true);

	const executeResult = runCli(
		repoRoot,
		["execute", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(executeResult.exitCode).toBe(0);
	expect(existsSync(join(codexRoot, "legacy-folder-skill"))).toBe(false);
});

test("clean detects and removes unmanaged top-level directory symlinks even when not state-tracked", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const legacySource = join(homeDir, "legacy-folder-skill");
	mkdirSync(legacySource, { recursive: true });
	writeText(join(legacySource, "README.md"), "legacy folder");
	symlinkSync(legacySource, join(codexRoot, "legacy-folder-skill"));

	const dryRun = runCli(
		repoRoot,
		["clean", "--home", homeDir, "--harness", "codex", "--dry-run", "--json"],
		{},
	);
	expect(dryRun.exitCode).toBe(0);
	const parsedDryRun = JSON.parse(dryRun.stdout.toString());
	expect(parsedDryRun.count).toBe(1);
	expect(parsedDryRun.polluted[0]?.destinationPath).toBe(
		join(codexRoot, "legacy-folder-skill"),
	);

	const cleaned = runCli(
		repoRoot,
		["clean", "--home", homeDir, "--harness", "codex", "--json"],
		{},
	);
	expect(cleaned.exitCode).toBe(0);
	const parsedCleaned = JSON.parse(cleaned.stdout.toString());
	expect(parsedCleaned.removed).toBe(1);
	expect(existsSync(join(codexRoot, "legacy-folder-skill"))).toBe(false);
});

test("repair-sources restores broken nested SKILL.md symlinks from pre-migration backups", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	makeHarnessRoot(homeDir, ".codex/skills");
	writeText(
		join(projectsRoot, "appcast", "skills", "appcast", "README.md"),
		"placeholder",
	);
	symlinkSync(
		"../../SKILL.md",
		join(projectsRoot, "appcast", "skills", "appcast", "SKILL.md"),
	);
	writeText(
		join(projectsRoot, "appcast", "SKILL.md.pre-migration-backup"),
		"---\nname: appcast\ndescription: Restored skill\n---\n\n# Appcast\n",
	);

	const brokenCheck = runCli(
		repoRoot,
		["check", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(brokenCheck.exitCode).toBe(3);
	expect(brokenCheck.stdout.toString()).toContain(
		"broken nested skill file: appcast",
	);

	const dryRun = runCli(
		repoRoot,
		[
			"repair-sources",
			"--dry-run",
			"--home",
			homeDir,
			"--projects-root",
			projectsRoot,
		],
		{},
	);
	expect(dryRun.exitCode).toBe(2);
	expect(dryRun.stdout.toString()).toContain("would restore");

	const repaired = runCli(
		repoRoot,
		["repair-sources", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(repaired.exitCode).toBe(0);
	expect(
		lstatSync(
			join(projectsRoot, "appcast", "skills", "appcast", "SKILL.md"),
		).isFile(),
	).toBe(true);

	const checkAfter = runCli(
		repoRoot,
		["check", "--json", "--home", homeDir, "--projects-root", projectsRoot],
		{},
	);
	expect(checkAfter.exitCode).toBe(2);
	const parsedAfter = JSON.parse(checkAfter.stdout.toString());
	expect(
		parsedAfter.sourceDiagnostics.errors.some(
			(error: { kind: string }) => error.kind === "broken-skill-link",
		),
	).toBe(false);
});

test("cache-bust touches installed skill files for codex harness", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const { homeDir, projectsRoot } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const _codexRoot = makeHarnessRoot(homeDir, ".codex/skills");
	const agentsRoot = join(homeDir, ".agents", "skills");
	const codexDir = join(homeDir, ".codex");
	const vsshSkillDir = makeNestedSkill(projectsRoot, "vssh", "vssh", "vssh");
	const vsshSkillFile = join(vsshSkillDir, "SKILL.md");
	const installedSkillFile = join(agentsRoot, "vssh", "SKILL.md");
	const codexStateFile = join(codexDir, "state_5.sqlite");
	const codexSessionIndexFile = join(codexDir, "session_index.jsonl");
	const threadId = "019d6571-b903-7163-afde-7a900b8abb61";
	const codexThreadSessionFile = join(
		codexDir,
		"sessions",
		"2026",
		"04",
		`rollout-2026-04-09T17-13-29-${threadId}.jsonl`,
	);
	const oldDate = new Date("2000-01-01T00:00:00.000Z");
	writeText(codexStateFile, "state");
	writeText(codexSessionIndexFile, "{}\n");
	writeText(codexThreadSessionFile, "{}\n");
	utimesSync(vsshSkillFile, oldDate, oldDate);
	utimesSync(codexStateFile, oldDate, oldDate);
	utimesSync(codexSessionIndexFile, oldDate, oldDate);
	utimesSync(codexThreadSessionFile, oldDate, oldDate);

	const executeResult = runCli(
		repoRoot,
		[
			"execute",
			"--home",
			homeDir,
			"--projects-root",
			projectsRoot,
			"--harness",
			"codex",
		],
		{},
	);
	expect(executeResult.exitCode).toBe(0);
	utimesSync(installedSkillFile, oldDate, oldDate);
	utimesSync(agentsRoot, oldDate, oldDate);

	const beforeSource = statSync(vsshSkillFile).mtimeMs;
	const beforeInstalled = lstatSync(installedSkillFile).mtimeMs;
	const beforeRoot = statSync(agentsRoot).mtimeMs;
	const beforeCodexState = statSync(codexStateFile).mtimeMs;
	const beforeCodexSessionIndex = statSync(codexSessionIndexFile).mtimeMs;
	const beforeCodexThreadSession = statSync(codexThreadSessionFile).mtimeMs;

	const bustResult = runCli(
		repoRoot,
		["cache-bust", "--home", homeDir, "--harness", "codex"],
		{ CODEX_THREAD_ID: threadId },
	);
	expect(bustResult.exitCode).toBe(0);
	const afterSource = statSync(vsshSkillFile).mtimeMs;
	const afterInstalled = lstatSync(installedSkillFile).mtimeMs;
	const afterRoot = statSync(agentsRoot).mtimeMs;
	const afterCodexState = statSync(codexStateFile).mtimeMs;
	const afterCodexSessionIndex = statSync(codexSessionIndexFile).mtimeMs;
	const afterCodexThreadSession = statSync(codexThreadSessionFile).mtimeMs;
	expect(afterSource).toBe(beforeSource);
	expect(afterInstalled).toBeGreaterThan(beforeInstalled);
	expect(afterRoot).toBeGreaterThan(beforeRoot);
	expect(afterCodexState).toBeGreaterThan(beforeCodexState);
	expect(afterCodexSessionIndex).toBeGreaterThan(beforeCodexSessionIndex);
	expect(afterCodexThreadSession).toBeGreaterThan(beforeCodexThreadSession);
});

test("version command matches package.json", () => {
	const repoRoot = "/Users/merlin/_dev/skill-sync";
	const packageVersion = JSON.parse(
		readFileSync(join(repoRoot, "package.json"), "utf8"),
	).version;

	const result = runCli(repoRoot, ["--version"], {});
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain(`skill-sync/${packageVersion}`);
});
