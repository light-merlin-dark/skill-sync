import {
	closeSync,
	existsSync,
	lstatSync,
	lutimesSync,
	openSync,
	readdirSync,
	utimesSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { HarnessDefinition } from "./types";
import { inspectEntry } from "./utils";

type CacheBustTarget = {
	harnessId: string;
	path: string;
	reason: string;
};

type CacheBustResult = {
	dryRun: boolean;
	totalTargets: number;
	touched: CacheBustTarget[];
	skipped: Array<{
		target: CacheBustTarget;
		reason: string;
	}>;
};

export function collectCacheBustTargets(
	harnesses: HarnessDefinition[],
	homeDir: string,
): CacheBustTarget[] {
	const targets: CacheBustTarget[] = [];
	const codexThreadId = process.env.CODEX_THREAD_ID;
	for (const harness of harnesses) {
		if (!harness.detected) {
			continue;
		}
		targets.push({
			harnessId: harness.id,
			path: harness.rootPath,
			reason: "harness-root-mtime",
		});
		targets.push(...collectHarnessSkillFileTargets(harness));
		if (harness.id === "codex") {
			const codexConfigPath = join(homeDir, ".codex", "config.toml");
			if (existsSync(codexConfigPath)) {
				targets.push({
					harnessId: harness.id,
					path: codexConfigPath,
					reason: "codex-config-mtime",
				});
			}

			const codexGlobalStatePath = join(
				homeDir,
				".codex",
				".codex-global-state.json",
			);
			if (existsSync(codexGlobalStatePath)) {
				targets.push({
					harnessId: harness.id,
					path: codexGlobalStatePath,
					reason: "codex-global-state-mtime",
				});
			}

			const codexStatePath = join(homeDir, ".codex", "state_5.sqlite");
			if (existsSync(codexStatePath)) {
				targets.push({
					harnessId: harness.id,
					path: codexStatePath,
					reason: "codex-state-sqlite-mtime",
				});
			}
			const codexStateWalPath = join(homeDir, ".codex", "state_5.sqlite-wal");
			if (existsSync(codexStateWalPath)) {
				targets.push({
					harnessId: harness.id,
					path: codexStateWalPath,
					reason: "codex-state-sqlite-wal-mtime",
				});
			}

			const codexSessionIndexPath = join(
				homeDir,
				".codex",
				"session_index.jsonl",
			);
			if (existsSync(codexSessionIndexPath)) {
				targets.push({
					harnessId: harness.id,
					path: codexSessionIndexPath,
					reason: "codex-session-index-mtime",
				});
			}

			if (codexThreadId) {
				const activeThreadSessionPath = findCodexThreadSessionPath(
					homeDir,
					codexThreadId,
				);
				if (activeThreadSessionPath) {
					targets.push({
						harnessId: harness.id,
						path: activeThreadSessionPath,
						reason: "codex-active-thread-session-mtime",
					});
				}
			}
		}
	}
	return dedupeTargets(targets);
}

export function applyCacheBust(
	targets: CacheBustTarget[],
	dryRun: boolean,
): CacheBustResult {
	const touched: CacheBustTarget[] = [];
	const skipped: CacheBustResult["skipped"] = [];
	for (const target of targets) {
		if (!existsSync(target.path)) {
			skipped.push({
				target,
				reason: "target path no longer exists",
			});
			continue;
		}
		if (!dryRun) {
			try {
				touchPath(target.path);
			} catch (error) {
				skipped.push({
					target,
					reason: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
		}
		touched.push(target);
	}

	return {
		dryRun,
		totalTargets: targets.length,
		touched,
		skipped,
	};
}

function collectHarnessSkillFileTargets(
	harness: HarnessDefinition,
): CacheBustTarget[] {
	const targets: CacheBustTarget[] = [];
	let children: string[] = [];
	try {
		children = readdirSync(harness.rootPath);
	} catch {
		return targets;
	}

	for (const child of children) {
		if (shouldIgnoreHarnessEntry(child)) {
			continue;
		}
		const entryPath = join(harness.rootPath, child);
		const inspection = inspectEntry(entryPath);
		if (!inspection.exists) {
			continue;
		}

		if (inspection.type === "directory") {
			targets.push({
				harnessId: harness.id,
				path: entryPath,
				reason: "installed-entry-directory-mtime",
			});
			const skillFile = join(entryPath, "SKILL.md");
			if (existsSync(skillFile)) {
				targets.push({
					harnessId: harness.id,
					path: skillFile,
					reason: "installed-skill-file",
				});
				const skillInspection = inspectEntry(skillFile);
				if (
					skillInspection.type === "symlink" &&
					skillInspection.resolvedTarget &&
					existsSync(skillInspection.resolvedTarget)
				) {
					targets.push({
						harnessId: harness.id,
						path: skillInspection.resolvedTarget,
						reason: "installed-skill-file-target",
					});
				}
			}
			continue;
		}

		if (inspection.type === "symlink" && inspection.resolvedTarget) {
			targets.push({
				harnessId: harness.id,
				path: entryPath,
				reason: "installed-entry-symlink-path",
			});
			const resolvedTarget = inspection.resolvedTarget;
			const targetSkillFile = existsSync(join(resolvedTarget, "SKILL.md"))
				? join(resolvedTarget, "SKILL.md")
				: basename(resolvedTarget) === "SKILL.md"
					? resolvedTarget
					: undefined;

			if (targetSkillFile && existsSync(targetSkillFile)) {
				targets.push({
					harnessId: harness.id,
					path: targetSkillFile,
					reason: "installed-symlink-target-skill-file",
				});
			}
		}
	}

	return targets;
}

function dedupeTargets(targets: CacheBustTarget[]): CacheBustTarget[] {
	const deduped = new Map<string, CacheBustTarget>();
	for (const target of targets) {
		if (!deduped.has(target.path)) {
			deduped.set(target.path, target);
		}
	}
	return [...deduped.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function findCodexThreadSessionPath(
	homeDir: string,
	threadId: string,
): string | undefined {
	const sessionsRoot = join(homeDir, ".codex", "sessions");
	if (!existsSync(sessionsRoot)) {
		return undefined;
	}

	const matches: Array<{ path: string; mtimeMs: number }> = [];
	const pending = [sessionsRoot];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) {
			continue;
		}
		let names: string[] = [];
		try {
			names = readdirSync(current);
		} catch {
			continue;
		}
		for (const name of names) {
			const candidate = join(current, name);
			let stats: ReturnType<typeof lstatSync>;
			try {
				stats = lstatSync(candidate);
			} catch {
				continue;
			}
			if (stats.isSymbolicLink()) {
				continue;
			}
			if (stats.isDirectory()) {
				pending.push(candidate);
				continue;
			}
			if (
				!stats.isFile() ||
				!candidate.endsWith(".jsonl") ||
				!basename(candidate).includes(threadId)
			) {
				continue;
			}
			matches.push({ path: candidate, mtimeMs: stats.mtimeMs });
		}
	}

	if (matches.length === 0) {
		return undefined;
	}
	matches.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
	return matches[0]?.path;
}

function shouldIgnoreHarnessEntry(name: string): boolean {
	return name.startsWith(".") || name.includes(".backup-");
}

function touchPath(path: string): void {
	const now = new Date();
	try {
		if (lstatSync(path).isSymbolicLink()) {
			lutimesSync(path, now, now);
			return;
		}
	} catch {}

	try {
		utimesSync(path, now, now);
		return;
	} catch {}

	const fd = openSync(path, "a");
	closeSync(fd);
	utimesSync(path, now, now);
}
