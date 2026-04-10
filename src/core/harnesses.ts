import { existsSync } from "node:fs";
import type { Config, HarnessDefinition } from "./types";
import { expandHomePath } from "./utils";

type BuiltInHarness = {
	id: string;
	label: string;
	rootPaths: string[];
	aliases?: string[];
};

const BUILT_IN_HARNESSES: BuiltInHarness[] = [
	{
		id: "agents",
		label: "Agents",
		rootPaths: ["~/.agents/skills"],
		aliases: ["cline", "warp", "amp", "kimi-cli", "replit", "universal"],
	},
	{
		id: "antigravity",
		label: "Antigravity",
		rootPaths: ["~/.gemini/antigravity/skills"],
	},
	{ id: "claude-code", label: "Claude Code", rootPaths: ["~/.claude/skills"] },
	{ id: "codex", label: "Codex", rootPaths: ["~/.codex/skills"] },
	{ id: "cursor", label: "Cursor", rootPaths: ["~/.cursor/skills"] },
	{ id: "droid", label: "Droid", rootPaths: ["~/.factory/skills"] },
	{ id: "gemini-cli", label: "Gemini CLI", rootPaths: ["~/.gemini/skills"] },
	{
		id: "github-copilot",
		label: "GitHub Copilot",
		rootPaths: ["~/.copilot/skills"],
	},
	{ id: "hermes", label: "Hermes", rootPaths: ["~/.hermes/skills"] },
	{ id: "kilocode", label: "KiloCode", rootPaths: ["~/.kilocode/skills"] },
	{
		id: "opencode",
		label: "OpenCode",
		rootPaths: ["~/.config/opencode/skills", "~/.opencode/skills"],
	},
	{ id: "skills", label: "Skills Root", rootPaths: ["~/.skills"] },
];

export function resolveHarnesses(
	homeDir: string,
	config: Config,
): HarnessDefinition[] {
	const builtIns: HarnessDefinition[] = BUILT_IN_HARNESSES.map((entry) => {
		const rootCandidates = entry.rootPaths.map((path) =>
			expandHomePath(path, homeDir),
		);
		const [fallbackRoot] = rootCandidates;
		if (!fallbackRoot) {
			throw new Error(`Harness ${entry.id} is missing rootPaths`);
		}
		const rootPath =
			rootCandidates.find((candidate) => existsSync(candidate)) || fallbackRoot;
		const detected = rootCandidates.some((candidate) => existsSync(candidate));
		return {
			id: entry.id,
			label: entry.label,
			rootPath,
			aliases: entry.aliases,
			kind: "built-in",
			detected,
			enabled: detected,
		};
	});

	const custom: HarnessDefinition[] = (config.harnesses.custom || []).map(
		(entry) => {
			const rootPath = expandHomePath(entry.rootPath, homeDir);
			return {
				id: entry.id,
				label: entry.label || entry.id,
				rootPath,
				kind: "custom",
				detected: existsSync(rootPath),
				enabled: entry.enabled !== false,
			};
		},
	);

	const merged = new Map<string, HarnessDefinition>();
	for (const harness of [...builtIns, ...custom]) {
		merged.set(harness.id, harness);
	}
	return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function filterHarnesses(
	harnesses: HarnessDefinition[],
	selectedIds: string[],
): HarnessDefinition[] {
	if (selectedIds.length === 0) {
		return harnesses.filter((harness) => harness.enabled);
	}
	const selected = new Set(selectedIds);
	return harnesses.filter((harness) => selected.has(harness.id));
}
