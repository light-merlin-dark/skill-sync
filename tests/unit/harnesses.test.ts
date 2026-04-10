import { expect, test } from "bun:test";
import { resolveHarnesses } from "../../src/core/harnesses";
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

test("prefers the XDG opencode skills root over the legacy dotdir when both exist", () => {
	const { homeDir } = makeFakeProjectsRoot();
	makeHarnessRoot(homeDir, ".config/opencode/skills");
	makeHarnessRoot(homeDir, ".opencode/skills");

	const harnesses = resolveHarnesses(homeDir, makeConfig());
	expect(harnesses.find((harness) => harness.id === "opencode")?.rootPath).toBe(
		`${homeDir}/.config/opencode/skills`,
	);
});
