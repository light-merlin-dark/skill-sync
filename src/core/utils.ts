import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type {
	EntryInspection,
	JsonValue,
	RuntimeContext,
	SkillFrontmatter,
} from "./types";

function resolveHomeDir(explicitHome?: string): string {
	const envHome = process.env.SKILL_SYNC_HOME;
	if (explicitHome) {
		return resolve(explicitHome);
	}
	if (envHome) {
		return resolve(envHome);
	}
	return homedir();
}

export function buildRuntimeContext(options: {
	home?: string;
	json?: boolean;
}): RuntimeContext {
	const homeDir = resolveHomeDir(options.home);
	const stateDir = join(homeDir, ".skill-sync");
	return {
		homeDir,
		stateDir,
		configPath: join(stateDir, "config.json"),
		statePath: join(stateDir, "state.json"),
		json: Boolean(options.json),
	};
}

export function expandHomePath(input: string, homeDir: string): string {
	if (input === "~") {
		return homeDir;
	}
	if (input.startsWith("~/")) {
		return join(homeDir, input.slice(2));
	}
	return resolve(input);
}

export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

export function readJsonFile<T>(path: string): T | null {
	if (!existsSync(path)) {
		return null;
	}
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonFile(
	path: string,
	value: JsonValue | Record<string, unknown>,
): void {
	ensureDir(dirname(path));
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function timestampId(): string {
	return nowIso().replace(/[:.]/g, "-");
}

export function slugify(input: string): string {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[_\s]+/g, "-")
		.replace(/[^a-zA-Z0-9.-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();
}

export function parseSkillFrontmatterContent(
	content: string,
): SkillFrontmatter {
	const frontmatterBlock = extractFrontmatterBlock(content);
	if (!frontmatterBlock) {
		return {
			hasFrontmatter: false,
			issues: ["missing YAML frontmatter block (`---` header)"],
		};
	}

	const frontmatter: SkillFrontmatter = {
		hasFrontmatter: true,
		issues: [],
	};
	const parsedDocument = parseDocument(frontmatterBlock, {
		prettyErrors: true,
	});
	if (parsedDocument.errors.length > 0) {
		frontmatter.issues.push(
			`invalid YAML frontmatter: ${formatYamlError(parsedDocument.errors[0]?.message || "unknown parse error")}`,
		);
		return frontmatter;
	}

	const parsed = parsedDocument.toJS();
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		frontmatter.issues.push("frontmatter must be a YAML mapping/object");
		return frontmatter;
	}

	const metadata = parsed as Record<string, unknown>;
	if (typeof metadata.name === "string") {
		frontmatter.name = metadata.name.trim();
	} else if (metadata.name !== undefined) {
		frontmatter.issues.push("`name` must be a string");
	}

	if (typeof metadata.description === "string") {
		frontmatter.description = metadata.description.trim();
	} else if (metadata.description !== undefined) {
		frontmatter.issues.push("`description` must be a string");
	}

	if (metadata["skill-sync-scope"] !== undefined) {
		if (typeof metadata["skill-sync-scope"] !== "string") {
			frontmatter.issues.push(
				"`skill-sync-scope` must be `global` or `local-only`",
			);
		} else {
			const scope = metadata["skill-sync-scope"].trim().toLowerCase();
			if (scope === "global" || scope === "local-only") {
				frontmatter.skillSyncScope = scope;
			} else {
				frontmatter.issues.push(
					"`skill-sync-scope` must be `global` or `local-only`",
				);
			}
		}
	}

	if (metadata["skill-sync-install-on"] !== undefined) {
		const installOn = parseInstallOnValue(metadata["skill-sync-install-on"]);
		if (installOn.length > 0) {
			frontmatter.skillSyncInstallOn = installOn;
		} else {
			frontmatter.issues.push(
				"`skill-sync-install-on` must be a string or list of strings",
			);
		}
	}

	if (!frontmatter.name) {
		frontmatter.issues.push("missing required `name:` in frontmatter");
	}

	return frontmatter;
}

export function hashContent(content: string): string {
	return createHash("sha1").update(content).digest("hex");
}

export function listImmediateDirectories(path: string): string[] {
	if (!existsSync(path)) {
		return [];
	}
	return readdirSync(path)
		.map((name) => join(path, name))
		.filter((candidate) => {
			try {
				return lstatSync(candidate).isDirectory();
			} catch {
				return false;
			}
		});
}

export function inspectEntry(path: string): EntryInspection {
	if (!existsSync(path)) {
		return { exists: false, type: "missing" };
	}
	const stats = lstatSync(path);
	if (stats.isSymbolicLink()) {
		const linkTarget = readFileSyncLink(path);
		let resolvedTarget: string | undefined;
		try {
			resolvedTarget = realpathSync(path);
		} catch {
			resolvedTarget = undefined;
		}
		return { exists: true, type: "symlink", linkTarget, resolvedTarget };
	}
	if (stats.isDirectory()) {
		return { exists: true, type: "directory" };
	}
	return { exists: true, type: "file" };
}

function readFileSyncLink(path: string): string {
	return readlinkSync(path);
}

export function pathOwnsEntry(rootPath: string, entryPath: string): boolean {
	const normalizedRoot = normalizeComparablePath(rootPath);
	const normalizedEntry = normalizeComparablePath(entryPath);
	return (
		normalizedEntry === normalizedRoot ||
		normalizedEntry.startsWith(`${normalizedRoot}/`)
	);
}

export function removePath(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export function copyMaterializedDirectory(
	sourcePath: string,
	destinationPath: string,
): void {
	copyMaterializedNode(sourcePath, destinationPath, new Set<string>());
}

export function directoriesMatchMaterialized(
	sourcePath: string,
	destinationPath: string,
): boolean {
	if (!existsSync(sourcePath) || !existsSync(destinationPath)) {
		return false;
	}
	try {
		if (treeContainsSymlinks(destinationPath)) {
			return false;
		}
		const sourceSnapshot = snapshotMaterializedTree(sourcePath);
		const destinationSnapshot = snapshotMaterializedTree(destinationPath);
		if (sourceSnapshot.size !== destinationSnapshot.size) {
			return false;
		}
		for (const [relativePath, descriptor] of sourceSnapshot) {
			if (destinationSnapshot.get(relativePath) !== descriptor) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function extractFrontmatterBlock(content: string): string | undefined {
	const lines = content.split(/\r?\n/);
	if (lines[0] !== "---") {
		return undefined;
	}
	const closingIndex = lines.findIndex(
		(line, index) => index > 0 && line === "---",
	);
	if (closingIndex === -1) {
		return undefined;
	}
	return lines.slice(1, closingIndex).join("\n");
}

function stripYamlQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function parseFrontmatterListValue(rawValue: string): string[] {
	const value = stripYamlQuotes(rawValue.trim());
	if (!value) {
		return [];
	}
	const inner =
		value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
	return [
		...new Set(
			inner
				.split(",")
				.map((item) => stripYamlQuotes(item.trim()))
				.filter(Boolean),
		),
	];
}

function parseInstallOnValue(rawValue: unknown): string[] {
	if (typeof rawValue === "string") {
		return parseFrontmatterListValue(rawValue);
	}
	if (!Array.isArray(rawValue)) {
		return [];
	}
	const values = rawValue
		.filter((item): item is string => typeof item === "string")
		.map((item) => stripYamlQuotes(item.trim()))
		.filter(Boolean);
	return [...new Set(values)];
}

function formatYamlError(message: string): string {
	const [firstLine] = message.split("\n");
	return (firstLine || message).trim();
}

function normalizeComparablePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function copyMaterializedNode(
	sourcePath: string,
	destinationPath: string,
	directoryStack: Set<string>,
): void {
	const stats = lstatSync(sourcePath);
	if (stats.isSymbolicLink()) {
		const resolvedPath = realpathSync(sourcePath);
		const resolvedStats = lstatSync(resolvedPath);
		if (resolvedStats.isDirectory()) {
			copyMaterializedDirectoryContents(
				resolvedPath,
				destinationPath,
				directoryStack,
			);
			return;
		}
		copyMaterializedFile(resolvedPath, destinationPath);
		return;
	}

	if (stats.isDirectory()) {
		copyMaterializedDirectoryContents(
			sourcePath,
			destinationPath,
			directoryStack,
		);
		return;
	}

	if (stats.isFile()) {
		copyMaterializedFile(sourcePath, destinationPath);
	}
}

function copyMaterializedDirectoryContents(
	sourcePath: string,
	destinationPath: string,
	directoryStack: Set<string>,
): void {
	const canonicalPath = normalizeComparablePath(sourcePath);
	if (directoryStack.has(canonicalPath)) {
		return;
	}

	directoryStack.add(canonicalPath);
	ensureDir(destinationPath);
	for (const name of readdirSync(sourcePath).sort()) {
		copyMaterializedNode(
			join(sourcePath, name),
			join(destinationPath, name),
			directoryStack,
		);
	}
	directoryStack.delete(canonicalPath);
}

function copyMaterializedFile(
	sourcePath: string,
	destinationPath: string,
): void {
	ensureDir(dirname(destinationPath));
	copyFileSync(sourcePath, destinationPath);
	chmodSync(destinationPath, statSync(sourcePath).mode);
}

function snapshotMaterializedTree(rootPath: string): Map<string, string> {
	const snapshot = new Map<string, string>();
	walkMaterializedTree(rootPath, "", snapshot, new Set<string>());
	return snapshot;
}

function treeContainsSymlinks(rootPath: string): boolean {
	return walkForSymlinkNodes(rootPath, new Set<string>());
}

function walkForSymlinkNodes(
	currentPath: string,
	directoryStack: Set<string>,
): boolean {
	const stats = lstatSync(currentPath);
	if (stats.isSymbolicLink()) {
		return true;
	}
	if (!stats.isDirectory()) {
		return false;
	}

	const canonicalPath = normalizeComparablePath(currentPath);
	if (directoryStack.has(canonicalPath)) {
		return false;
	}

	directoryStack.add(canonicalPath);
	try {
		for (const name of readdirSync(currentPath).sort()) {
			if (walkForSymlinkNodes(join(currentPath, name), directoryStack)) {
				return true;
			}
		}
		return false;
	} finally {
		directoryStack.delete(canonicalPath);
	}
}

function walkMaterializedTree(
	currentPath: string,
	currentRelativePath: string,
	snapshot: Map<string, string>,
	directoryStack: Set<string>,
): void {
	const stats = lstatSync(currentPath);
	if (stats.isSymbolicLink()) {
		const resolvedPath = realpathSync(currentPath);
		const resolvedStats = lstatSync(resolvedPath);
		if (resolvedStats.isDirectory()) {
			walkMaterializedDirectory(
				resolvedPath,
				currentRelativePath,
				snapshot,
				directoryStack,
			);
			return;
		}
		snapshot.set(
			currentRelativePath,
			`file:${hashBytes(readFileSync(resolvedPath))}`,
		);
		return;
	}

	if (stats.isDirectory()) {
		walkMaterializedDirectory(
			currentPath,
			currentRelativePath,
			snapshot,
			directoryStack,
		);
		return;
	}

	if (stats.isFile()) {
		snapshot.set(
			currentRelativePath,
			`file:${hashBytes(readFileSync(currentPath))}`,
		);
	}
}

function walkMaterializedDirectory(
	directoryPath: string,
	directoryRelativePath: string,
	snapshot: Map<string, string>,
	directoryStack: Set<string>,
): void {
	const canonicalPath = normalizeComparablePath(directoryPath);
	if (directoryStack.has(canonicalPath)) {
		return;
	}

	directoryStack.add(canonicalPath);
	if (directoryRelativePath) {
		snapshot.set(`${directoryRelativePath}/`, "dir");
	}
	for (const name of readdirSync(directoryPath).sort()) {
		const childRelativePath = directoryRelativePath
			? join(directoryRelativePath, name)
			: name;
		walkMaterializedTree(
			join(directoryPath, name),
			childRelativePath,
			snapshot,
			directoryStack,
		);
	}
	directoryStack.delete(canonicalPath);
}

function hashBytes(content: Uint8Array): string {
	return createHash("sha1").update(content).digest("hex");
}
