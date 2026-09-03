import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, RuntimeContext, State } from "./types";
import {
	ensureDir,
	expandHomePath,
	readJsonFile,
	writeJsonFile,
} from "./utils";

function getDefaultConfig(homeDir: string): Config {
	return {
		version: 1,
		projectsRoots: [],
		visibility: {
			strict: true,
			maxGlobalIndexTokens: 4_000,
			maxProjectIndexTokens: 500,
		},
		discovery: {
			ignorePathPrefixes: [],
			preferPathPrefixes: [],
			includeHarnessRoots: true,
			preferPrimaryWorktree: true,
		},
		harnesses: {
			custom: [],
		},
		aliases: {},
	};
}

function getDefaultState(): State {
	return {
		version: 1,
		managedEntries: {},
	};
}

export function loadConfig(runtime: RuntimeContext): Config {
	const config = readJsonFile<Config>(runtime.configPath);
	if (!config) {
		return getDefaultConfig(runtime.homeDir);
	}
	return {
		...getDefaultConfig(runtime.homeDir),
		...config,
		projectsRoots: (config.projectsRoots || []).map((root) =>
			expandHomePath(root, runtime.homeDir),
		),
		visibility: {
			baselinePath: config.visibility?.baselinePath
				? expandHomePath(config.visibility.baselinePath, runtime.homeDir)
				: undefined,
			strict: config.visibility?.strict === true,
			maxGlobalIndexTokens:
				config.visibility?.maxGlobalIndexTokens ?? 4_000,
			maxProjectIndexTokens:
				config.visibility?.maxProjectIndexTokens ?? 500,
		},
		discovery: {
			ignorePathPrefixes: (config.discovery?.ignorePathPrefixes || []).map(
				(path) => expandHomePath(path, runtime.homeDir),
			),
			preferPathPrefixes: (config.discovery?.preferPathPrefixes || []).map(
				(path) => expandHomePath(path, runtime.homeDir),
			),
			includeHarnessRoots: config.discovery?.includeHarnessRoots !== false,
			preferPrimaryWorktree: config.discovery?.preferPrimaryWorktree !== false,
		},
		harnesses: {
			custom: config.harnesses?.custom || [],
		},
		aliases: config.aliases || {},
	};
}

export function setVisibilityBaseline(
	runtime: RuntimeContext,
	baselinePath: string,
): Config {
	const config = loadConfig(runtime);
	config.visibility.baselinePath = resolve(
		expandHomePath(baselinePath, runtime.homeDir),
	);
	saveConfig(runtime, config);
	return config;
}

export function setStrictVisibility(
	runtime: RuntimeContext,
	strict: boolean,
): Config {
	const config = loadConfig(runtime);
	config.visibility.strict = strict;
	saveConfig(runtime, config);
	return config;
}

export function setVisibilityBudgets(
	runtime: RuntimeContext,
	budgets: { global?: number; project?: number },
): Config {
	const config = loadConfig(runtime);
	if (budgets.global !== undefined) {
		config.visibility.maxGlobalIndexTokens = budgets.global;
	}
	if (budgets.project !== undefined) {
		config.visibility.maxProjectIndexTokens = budgets.project;
	}
	saveConfig(runtime, config);
	return config;
}

/**
 * Add or remove a discovery path prefix.
 *
 * `ignorePathPrefixes` and `preferPathPrefixes` have always been honoured by
 * discovery but had no command, so `doctor`'s own duplicate-slug remedy — "sync
 * blocked until one source is excluded or preferred" — named an action the CLI
 * could not perform. The usual cause is a vendored stub inside a fork competing
 * with a curated skill of the same slug: editing the fork is the wrong fix
 * because upstream overwrites it, so the exclusion belongs here, in local
 * configuration.
 */
export function setDiscoveryPathPrefix(
	runtime: RuntimeContext,
	field: "ignorePathPrefixes" | "preferPathPrefixes",
	rawPath: string,
	remove: boolean,
): Config {
	const config = loadConfig(runtime);
	const path = resolve(expandHomePath(rawPath, runtime.homeDir));
	const current = config.discovery[field] || [];
	config.discovery[field] = remove
		? current.filter((entry) => resolve(entry) !== path)
		: current.some((entry) => resolve(entry) === path)
			? current
			: [...current, path];
	saveConfig(runtime, config);
	return config;
}

function saveConfig(runtime: RuntimeContext, config: Config): void {
	ensureDir(runtime.stateDir);
	writeJsonFile(runtime.configPath, config);
}

export function loadState(runtime: RuntimeContext): State {
	return readJsonFile<State>(runtime.statePath) || getDefaultState();
}

export function saveState(runtime: RuntimeContext, state: State): void {
	ensureDir(runtime.stateDir);
	writeJsonFile(runtime.statePath, state);
}

export function initConfig(runtime: RuntimeContext): Config {
	const config = loadConfig(runtime);
	saveConfig(runtime, config);
	if (!existsSync(runtime.statePath)) {
		saveState(runtime, getDefaultState());
	}
	return config;
}

export function addProjectsRoot(
	runtime: RuntimeContext,
	rootPath: string,
): Config {
	const config = loadConfig(runtime);
	const normalized = resolve(expandHomePath(rootPath, runtime.homeDir));
	if (!config.projectsRoots.includes(normalized)) {
		config.projectsRoots.push(normalized);
		config.projectsRoots.sort();
	}
	saveConfig(runtime, config);
	return config;
}

export function removeProjectsRoot(
	runtime: RuntimeContext,
	rootPath: string,
): Config {
	const config = loadConfig(runtime);
	const normalized = resolve(expandHomePath(rootPath, runtime.homeDir));
	config.projectsRoots = config.projectsRoots.filter(
		(root) => resolve(root) !== normalized,
	);
	saveConfig(runtime, config);
	return config;
}

export function addHarness(
	runtime: RuntimeContext,
	id: string,
	rootPath: string,
): Config {
	const config = loadConfig(runtime);
	const normalized = resolve(expandHomePath(rootPath, runtime.homeDir));
	const remaining = config.harnesses.custom.filter((entry) => entry.id !== id);
	remaining.push({ id, rootPath: normalized, enabled: true });
	remaining.sort((a, b) => a.id.localeCompare(b.id));
	config.harnesses.custom = remaining;
	saveConfig(runtime, config);
	return config;
}

export function removeHarness(runtime: RuntimeContext, id: string): Config {
	const config = loadConfig(runtime);
	config.harnesses.custom = config.harnesses.custom.filter(
		(entry) => entry.id !== id,
	);
	saveConfig(runtime, config);
	return config;
}
