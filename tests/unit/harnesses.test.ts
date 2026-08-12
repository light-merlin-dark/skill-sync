import { expect, test } from "bun:test";
import { filterHarnesses, resolveHarnesses } from "../../src/core/harnesses";
import type { Config } from "../../src/core/types";
import { makeFakeProjectsRoot, makeHarnessRoot } from "../support";

function makeConfig(): Config {
	return {
		version: 1,
		projectsRoots: [],
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
		},
		harnesses: { custom: [] },
		aliases: {},
	};
}

test("detects opencode and kilocode built-in harness roots", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".config/opencode/skills");
	makeHarnessRoot(homeDir, ".kilocode/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	expect(harnesses.find((harness) => harness.id === "opencode")?.detected).toBe(
		true,
	);
	expect(harnesses.find((harness) => harness.id === "opencode")?.rootPath).toBe(
		`${homeDir}/.config/opencode/skills`,
	);
	expect(harnesses.find((harness) => harness.id === "kilocode")?.detected).toBe(
		true,
	);
});

test("detects grok built-in harness root", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".grok/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	const grok = harnesses.find((harness) => harness.id === "grok");
	expect(grok?.detected).toBe(true);
	expect(grok?.rootPath).toBe(`${homeDir}/.grok/skills`);
	expect(grok?.aliases).toContain("grok-build");
});

test("maps Pi selection to the shared Agents skills root", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".agents/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	const agents = harnesses.find((harness) => harness.id === "agents");
	expect(agents?.aliases).toContain("pi");
	expect(filterHarnesses(harnesses, ["pi"])).toEqual([agents]);
});

test("maps Claude selection to the Claude Code adapter", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".claude/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	const claudeCode = harnesses.find(
		(harness) => harness.id === "claude-code",
	);
	expect(filterHarnesses(harnesses, ["claude"])).toEqual([claudeCode]);
});

test("detects Kimi and Kimi Code as distinct built-in harness roots", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".kimi/skills");
	makeHarnessRoot(homeDir, ".kimi-code/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	expect(harnesses.find((harness) => harness.id === "kimi")).toMatchObject({
		kind: "built-in",
		detected: true,
		rootPath: `${homeDir}/.kimi/skills`,
	});
	expect(harnesses.find((harness) => harness.id === "kimi-code")).toMatchObject(
		{
			kind: "built-in",
			detected: true,
			rootPath: `${homeDir}/.kimi-code/skills`,
		},
	);
});

test("adopts a matching custom Kimi root into the built-in adapter", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".kimi/skills");
	const config = makeConfig();
	config.harnesses.custom.push({
		id: "kimi",
		rootPath: "~/.kimi/skills",
		label: "legacy custom Kimi",
	});

	const harnesses = resolveHarnesses(homeDir, config);
	expect(harnesses.find((harness) => harness.id === "kimi")).toMatchObject({
		kind: "built-in",
		label: "Kimi",
		rootPath: `${homeDir}/.kimi/skills`,
	});
});

test("prefers the XDG opencode skills root over the legacy dotdir when both exist", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".config/opencode/skills");
	makeHarnessRoot(homeDir, ".opencode/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	expect(harnesses.find((harness) => harness.id === "opencode")?.rootPath).toBe(
		`${homeDir}/.config/opencode/skills`,
	);
});

test("declares Hermes category-based nested skill discovery", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".hermes/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	expect(
		harnesses.find((harness) => harness.id === "hermes")?.nestedSkillLayout,
	).toBe("category");
});
