import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, setDiscoveryPathPrefix } from "../../src/core/config";
import { buildRuntimeContext } from "../../src/core/utils";
import { cleanup, makeFakeProjectsRoot } from "../support";

const tempPaths: string[] = [];

afterEach(() => {
	for (const path of tempPaths.splice(0)) cleanup(path);
});

function runtimeFor() {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	return buildRuntimeContext({ home: homeDir });
}

test("ignore-source records an absolute prefix discovery already honours", () => {
	const runtime = runtimeFor();
	const target = join(runtime.homeDir, "projects", "fork", "skills", "tool");
	setDiscoveryPathPrefix(runtime, "ignorePathPrefixes", target, false);
	expect(loadConfig(runtime).discovery.ignorePathPrefixes).toEqual([target]);
});

test("adding the same source twice does not duplicate it", () => {
	const runtime = runtimeFor();
	const target = join(runtime.homeDir, "projects", "fork", "skills", "tool");
	setDiscoveryPathPrefix(runtime, "ignorePathPrefixes", target, false);
	setDiscoveryPathPrefix(runtime, "ignorePathPrefixes", target, false);
	expect(loadConfig(runtime).discovery.ignorePathPrefixes).toHaveLength(1);
});

test("--remove takes it back out", () => {
	const runtime = runtimeFor();
	const target = join(runtime.homeDir, "projects", "fork", "skills", "tool");
	setDiscoveryPathPrefix(runtime, "ignorePathPrefixes", target, false);
	setDiscoveryPathPrefix(runtime, "ignorePathPrefixes", target, true);
	expect(loadConfig(runtime).discovery.ignorePathPrefixes).toEqual([]);
});

test("a `~` path is expanded, so the stored prefix can actually match a source", () => {
	const runtime = runtimeFor();
	setDiscoveryPathPrefix(runtime, "preferPathPrefixes", "~/projects/curated", false);
	const [stored] = loadConfig(runtime).discovery.preferPathPrefixes;
	expect(stored?.startsWith("~")).toBe(false);
	expect(stored).toBe(join(runtime.homeDir, "projects", "curated"));
});

test("ignore and prefer are independent lists", () => {
	const runtime = runtimeFor();
	setDiscoveryPathPrefix(runtime, "ignorePathPrefixes", "~/a", false);
	setDiscoveryPathPrefix(runtime, "preferPathPrefixes", "~/b", false);
	const { discovery } = loadConfig(runtime);
	expect(discovery.ignorePathPrefixes).toHaveLength(1);
	expect(discovery.preferPathPrefixes).toHaveLength(1);
});
