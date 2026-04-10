import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
	auditCodex,
	parseCodexSkillsConfig,
	probeCodexWorkspaceVisibility,
	repairCodexSkillsConfig,
} from "../../src/core/codex";
import {
	cleanup,
	makeFakeProjectsRoot,
	writeExecutableText,
	writeText,
} from "../support";

const tempPaths: string[] = [];
const originalCodexBin = process.env.SKILL_SYNC_CODEX_BIN;

afterEach(() => {
	while (tempPaths.length > 0) {
		const tempPath = tempPaths.pop();
		if (!tempPath) {
			continue;
		}
		cleanup(tempPath);
	}
	if (originalCodexBin === undefined) {
		delete process.env.SKILL_SYNC_CODEX_BIN;
	} else {
		process.env.SKILL_SYNC_CODEX_BIN = originalCodexBin;
	}
});

test("parses codex skills.config entries and flags invalid name-only blocks", () => {
	const parsed = parseCodexSkillsConfig(`
[[skills.config]]
path = "/Users/merlin/.codex/skills/dev-control/SKILL.md"
enabled = true

[[skills.config]]
name = "google-drive:google-docs"
enabled = false
`);

	expect(parsed).toHaveLength(2);
	expect(parsed[0]?.path).toContain("/skills/dev-control/SKILL.md");
	expect(parsed[0]?.issues).toHaveLength(0);
	expect(parsed[1]?.name).toBe("google-drive:google-docs");
	expect(
		parsed[1]?.issues.some((issue) => issue.includes("name without path")),
	).toBe(true);
});

test("audits installed codex skills and repairs stale/invalid config blocks", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = join(homeDir, ".codex");
	const skillsRoot = join(codexRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });

	const sourceRoot = join(homeDir, "sources");
	const advisingSource = join(sourceRoot, "advising", "SKILL.md");
	const devSource = join(sourceRoot, "dev-control", "SKILL.md");
	mkdirSync(join(sourceRoot, "advising"), { recursive: true });
	mkdirSync(join(sourceRoot, "dev-control"), { recursive: true });
	writeText(
		advisingSource,
		"---\nname: advising\ndescription: ok\n---\n\n# Advising\n",
	);
	writeText(devSource, "---\nname: dev\ndescription: ok\n---\n\n# Dev\n");

	mkdirSync(join(skillsRoot, "advising"), { recursive: true });
	symlinkSync(advisingSource, join(skillsRoot, "advising", "SKILL.md"));
	mkdirSync(join(skillsRoot, "dev"), { recursive: true });
	symlinkSync(devSource, join(skillsRoot, "dev", "SKILL.md"));

	writeText(
		join(codexRoot, "config.toml"),
		`model = "gpt-5.3-codex"

[[skills.config]]
path = "${join(skillsRoot, "dev-control", "SKILL.md")}"
enabled = true

[[skills.config]]
name = "google-drive:google-docs"
enabled = false

[[skills.config]]
path = "${join(skillsRoot, "advising", "SKILL.md")}"
enabled = true
`,
	);

	const before = auditCodex(homeDir);
	expect(
		before.installed.some(
			(item) =>
				item.installName === "advising" && item.isSymlink && item.yamlValid,
		),
	).toBe(true);
	expect(before.invalidEntries.length).toBe(1);
	expect(before.rewriteCandidates.length).toBe(1);

	const repair = repairCodexSkillsConfig(homeDir, false);
	expect(repair.updated).toBe(true);
	expect(repair.removedInvalid).toBe(1);
	expect(repair.rewrittenLegacy).toBe(1);

	const after = auditCodex(homeDir);
	expect(after.invalidEntries.length).toBe(0);
	expect(after.staleEntries.length).toBe(0);
	expect(
		after.entries.some((entry) => entry.path?.endsWith("/skills/dev/SKILL.md")),
	).toBe(true);
});

test("audits codex runtime snapshot and reports runtime-missing installed skills", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = join(homeDir, ".codex");
	const skillsRoot = join(codexRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });

	const sourceRoot = join(homeDir, "sources");
	const advisingSource = join(sourceRoot, "advising", "SKILL.md");
	const devSource = join(sourceRoot, "dev", "SKILL.md");
	mkdirSync(join(sourceRoot, "advising"), { recursive: true });
	mkdirSync(join(sourceRoot, "dev"), { recursive: true });
	writeText(
		advisingSource,
		"---\nname: advising\ndescription: ok\n---\n\n# Advising\n",
	);
	writeText(devSource, "---\nname: dev\ndescription: ok\n---\n\n# Dev\n");

	mkdirSync(join(skillsRoot, "advising"), { recursive: true });
	symlinkSync(advisingSource, join(skillsRoot, "advising", "SKILL.md"));
	mkdirSync(join(skillsRoot, "dev"), { recursive: true });
	symlinkSync(devSource, join(skillsRoot, "dev", "SKILL.md"));

	writeText(
		join(codexRoot, "config.toml"),
		`[[skills.config]]
path = "${join(skillsRoot, "advising", "SKILL.md")}"
enabled = true

[[skills.config]]
path = "${join(skillsRoot, "dev", "SKILL.md")}"
enabled = true
`,
	);

	const sessionPath = join(
		codexRoot,
		"sessions",
		"2026",
		"04",
		"09",
		"rollout-2026-04-09T17-13-29-thread-1.jsonl",
	);
	writeText(
		sessionPath,
		`${JSON.stringify({
			type: "response_item",
			payload: {
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: `<skills_instructions>
## Skills
### Available skills
- advising: advising skill
### How to use skills
</skills_instructions>
thread-1`,
					},
				],
			},
		})}\n`,
	);

	const report = auditCodex(homeDir, { threadId: "thread-1" });
	expect(report.runtimeSnapshot?.source).toBe("thread-session");
	expect(report.runtimeSnapshot?.availableSkills).toContain("advising");
	expect(report.runtimeMissingSkills).toContain("dev");
	expect(report.runtimeMissingSkills).not.toContain("advising");
	expect(report.runtimeMissingSkillsUncertain).toHaveLength(0);
	expect(report.runtimeMissingSkillsInstalledAfterSnapshot).toHaveLength(0);
});

test("marks runtime gaps as uncertain when the parsed snapshot is stale", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = join(homeDir, ".codex");
	const skillsRoot = join(codexRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });

	const sourceRoot = join(homeDir, "sources");
	const advisingSource = join(sourceRoot, "advising", "SKILL.md");
	const devSource = join(sourceRoot, "dev", "SKILL.md");
	mkdirSync(join(sourceRoot, "advising"), { recursive: true });
	mkdirSync(join(sourceRoot, "dev"), { recursive: true });
	writeText(
		advisingSource,
		"---\nname: advising\ndescription: ok\n---\n\n# Advising\n",
	);
	writeText(devSource, "---\nname: dev\ndescription: ok\n---\n\n# Dev\n");

	mkdirSync(join(skillsRoot, "advising"), { recursive: true });
	symlinkSync(advisingSource, join(skillsRoot, "advising", "SKILL.md"));
	mkdirSync(join(skillsRoot, "dev"), { recursive: true });
	symlinkSync(devSource, join(skillsRoot, "dev", "SKILL.md"));

	const sessionPath = join(
		codexRoot,
		"sessions",
		"2020",
		"01",
		"01",
		"rollout-2020-01-01T00-00-00-stale.jsonl",
	);
	writeText(
		sessionPath,
		`${JSON.stringify({
			timestamp: "2020-01-01T00:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: `<skills_instructions>
## Skills
### Available skills
- advising: advising skill
### How to use skills
</skills_instructions>`,
					},
				],
			},
		})}\n`,
	);

	const report = auditCodex(homeDir, { runtimeMaxAgeHours: 1 });
	expect(report.runtimeSnapshot?.stale).toBe(true);
	expect(report.runtimeMissingSkills).toHaveLength(0);
	expect(report.runtimeMissingSkillsUncertain).toContain("dev");
	expect(report.runtimeMissingSkillsInstalledAfterSnapshot).toContain("dev");
});

test("flags missing skills that were installed after the active thread snapshot", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = join(homeDir, ".codex");
	const skillsRoot = join(codexRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });

	const sourceRoot = join(homeDir, "sources");
	const advisingSource = join(sourceRoot, "advising", "SKILL.md");
	const devSource = join(sourceRoot, "dev", "SKILL.md");
	mkdirSync(join(sourceRoot, "advising"), { recursive: true });
	mkdirSync(join(sourceRoot, "dev"), { recursive: true });
	writeText(
		advisingSource,
		"---\nname: advising\ndescription: ok\n---\n\n# Advising\n",
	);
	writeText(devSource, "---\nname: dev\ndescription: ok\n---\n\n# Dev\n");

	mkdirSync(join(skillsRoot, "advising"), { recursive: true });
	symlinkSync(advisingSource, join(skillsRoot, "advising", "SKILL.md"));
	mkdirSync(join(skillsRoot, "dev"), { recursive: true });
	symlinkSync(devSource, join(skillsRoot, "dev", "SKILL.md"));

	const sessionPath = join(
		codexRoot,
		"sessions",
		"2026",
		"04",
		"09",
		"rollout-2026-04-09T17-13-29-thread-lag.jsonl",
	);
	writeText(
		sessionPath,
		`${JSON.stringify({
			timestamp: "2026-04-09T00:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: `<skills_instructions>
## Skills
### Available skills
- advising: advising skill
### How to use skills
</skills_instructions>
thread-lag`,
					},
				],
			},
		})}\n`,
	);

	const newer = new Date("2026-04-09T12:00:00.000Z");
	utimesSync(join(skillsRoot, "dev", "SKILL.md"), newer, newer);

	const report = auditCodex(homeDir, {
		threadId: "thread-lag",
		runtimeMaxAgeHours: 99999,
	});
	expect(report.runtimeSnapshot?.stale).toBe(false);
	expect(report.runtimeMissingSkills).toContain("dev");
	expect(report.runtimeMissingSkillsInstalledAfterSnapshot).toContain("dev");
});

test("uses snapshot captured timestamp (not file mtime) to choose latest-session runtime snapshot", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = join(homeDir, ".codex");
	const skillsRoot = join(codexRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });

	const sourceRoot = join(homeDir, "sources");
	const advisingSource = join(sourceRoot, "advising", "SKILL.md");
	const devSource = join(sourceRoot, "dev", "SKILL.md");
	mkdirSync(join(sourceRoot, "advising"), { recursive: true });
	mkdirSync(join(sourceRoot, "dev"), { recursive: true });
	writeText(
		advisingSource,
		"---\nname: advising\ndescription: ok\n---\n\n# Advising\n",
	);
	writeText(devSource, "---\nname: dev\ndescription: ok\n---\n\n# Dev\n");

	mkdirSync(join(skillsRoot, "advising"), { recursive: true });
	symlinkSync(advisingSource, join(skillsRoot, "advising", "SKILL.md"));
	mkdirSync(join(skillsRoot, "dev"), { recursive: true });
	symlinkSync(devSource, join(skillsRoot, "dev", "SKILL.md"));

	const staleButTouchedPath = join(
		codexRoot,
		"sessions",
		"2026",
		"04",
		"01",
		"rollout-old-touched.jsonl",
	);
	writeText(
		staleButTouchedPath,
		`${JSON.stringify({
			timestamp: "2026-04-01T00:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: `<skills_instructions>
## Skills
### Available skills
- advising: advising skill
### How to use skills
</skills_instructions>`,
					},
				],
			},
		})}\n`,
	);

	const freshSnapshotPath = join(
		codexRoot,
		"sessions",
		"2026",
		"04",
		"09",
		"rollout-fresh-snapshot.jsonl",
	);
	writeText(
		freshSnapshotPath,
		`${JSON.stringify({
			timestamp: "2026-04-09T12:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: `<skills_instructions>
## Skills
### Available skills
- advising: advising skill
- dev: dev skill
### How to use skills
</skills_instructions>`,
					},
				],
			},
		})}\n`,
	);

	const newerMtime = new Date("2026-04-10T00:00:00.000Z");
	const olderMtime = new Date("2026-04-08T00:00:00.000Z");
	utimesSync(staleButTouchedPath, newerMtime, newerMtime);
	utimesSync(freshSnapshotPath, olderMtime, olderMtime);

	const report = auditCodex(homeDir, { runtimeMaxAgeHours: 99999 });
	expect(report.runtimeSnapshot?.source).toBe("latest-session");
	expect(report.runtimeSnapshot?.sessionPath).toBe(freshSnapshotPath);
	expect(report.runtimeSnapshot?.availableSkills).toContain("dev");
	expect(report.runtimeMissingSkills).toHaveLength(0);
});

test("matches thread snapshots by session filename to avoid false positives from content mentions", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = join(homeDir, ".codex");
	const skillsRoot = join(codexRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });

	const sourceRoot = join(homeDir, "sources");
	const advisingSource = join(sourceRoot, "advising", "SKILL.md");
	const devSource = join(sourceRoot, "dev", "SKILL.md");
	mkdirSync(join(sourceRoot, "advising"), { recursive: true });
	mkdirSync(join(sourceRoot, "dev"), { recursive: true });
	writeText(
		advisingSource,
		"---\nname: advising\ndescription: ok\n---\n\n# Advising\n",
	);
	writeText(devSource, "---\nname: dev\ndescription: ok\n---\n\n# Dev\n");

	mkdirSync(join(skillsRoot, "advising"), { recursive: true });
	symlinkSync(advisingSource, join(skillsRoot, "advising", "SKILL.md"));
	mkdirSync(join(skillsRoot, "dev"), { recursive: true });
	symlinkSync(devSource, join(skillsRoot, "dev", "SKILL.md"));

	const wrongThreadPath = join(
		codexRoot,
		"sessions",
		"2026",
		"04",
		"09",
		"rollout-2026-04-09T10-00-00-thread-wrong.jsonl",
	);
	writeText(
		wrongThreadPath,
		`${JSON.stringify({
			timestamp: "2026-04-09T10:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: `<skills_instructions>
## Skills
### Available skills
- advising: advising skill
### How to use skills
</skills_instructions>
thread-target`,
					},
				],
			},
		})}\n`,
	);

	const latestPath = join(
		codexRoot,
		"sessions",
		"2026",
		"04",
		"09",
		"rollout-2026-04-09T11-00-00-latest.jsonl",
	);
	writeText(
		latestPath,
		`${JSON.stringify({
			timestamp: "2026-04-09T11:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: `<skills_instructions>
## Skills
### Available skills
- advising: advising skill
- dev: dev skill
### How to use skills
</skills_instructions>`,
					},
				],
			},
		})}\n`,
	);

	const report = auditCodex(homeDir, {
		threadId: "thread-target",
		runtimeMaxAgeHours: 99999,
	});
	expect(report.runtimeSnapshot?.source).toBe("latest-session");
	expect(report.runtimeSnapshot?.sessionPath).toBe(latestPath);
	expect(report.runtimeSnapshot?.availableSkills).toContain("dev");
});

test("probes codex app-server workspace visibility and detects extra-root recovery gaps", async () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);

	const codexRoot = join(homeDir, ".codex");
	const skillsRoot = join(codexRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });

	const sourceRoot = join(homeDir, "_dev");
	mkdirSync(join(sourceRoot, "skill-sync"), { recursive: true });
	const advisingSource = join(
		sourceRoot,
		"advising",
		"skills",
		"advising",
		"SKILL.md",
	);
	const vsshSource = join(sourceRoot, "vssh", "skills", "vssh", "SKILL.md");
	mkdirSync(join(sourceRoot, "advising", "skills", "advising"), {
		recursive: true,
	});
	mkdirSync(join(sourceRoot, "vssh", "skills", "vssh"), { recursive: true });
	writeText(
		advisingSource,
		"---\nname: advising\ndescription: ok\n---\n\n# Advising\n",
	);
	writeText(vsshSource, "---\nname: vssh\ndescription: ok\n---\n\n# vssh\n");

	mkdirSync(join(skillsRoot, "advising"), { recursive: true });
	symlinkSync(advisingSource, join(skillsRoot, "advising", "SKILL.md"));
	mkdirSync(join(skillsRoot, "vssh"), { recursive: true });
	symlinkSync(vsshSource, join(skillsRoot, "vssh", "SKILL.md"));

	writeText(
		join(codexRoot, "config.toml"),
		`[[skills.config]]
path = "${join(skillsRoot, "advising", "SKILL.md")}"
enabled = true

[[skills.config]]
path = "${join(skillsRoot, "vssh", "SKILL.md")}"
enabled = true
`,
	);

	writeText(
		join(homeDir, ".skill-sync", "state.json"),
		JSON.stringify(
			{
				version: 1,
				managedEntries: {
					[join(skillsRoot, "advising")]: {
						harnessId: "codex",
						sourcePath: advisingSource,
						installName: "advising",
						updatedAt: "2026-04-10T00:00:00.000Z",
					},
					[join(skillsRoot, "vssh")]: {
						harnessId: "codex",
						sourcePath: vsshSource,
						installName: "vssh",
						updatedAt: "2026-04-10T00:00:00.000Z",
					},
				},
			},
			null,
			2,
		),
	);

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
          cwd: message.params?.cwds?.[0] || '${homeDir.replace(/\\/g, "\\\\")}',
          skills: skills.map((name) => ({ name, description: name, path: '/tmp/' + name + '/SKILL.md', scope: 'user', enabled: true })),
          errors: [],
        }],
      },
    }) + '\\n');
  }
});
`,
	);
	process.env.SKILL_SYNC_CODEX_BIN = mockCodexPath;

	const audit = auditCodex(homeDir, { includeRuntimeSnapshot: false });
	const report = await probeCodexWorkspaceVisibility(
		homeDir,
		join(homeDir, "_dev", "skill-sync"),
		audit.installed,
	);

	expect(report.status).toBe("ok");
	expect(report.missingManagedSkills).toEqual(["advising", "vssh"]);
	expect(report.missingManagedSkillsRecoveredWithExtraRoots).toEqual([
		"advising",
		"vssh",
	]);
	expect(report.missingManagedSkillsStillMissing).toEqual([]);
	expect(report.extraUserRoots).toHaveLength(2);
	expect(
		report.extraUserRoots.some((value) =>
			value.endsWith("/_dev/advising/skills"),
		),
	).toBe(true);
	expect(
		report.extraUserRoots.some((value) => value.endsWith("/_dev/vssh/skills")),
	).toBe(true);
});
