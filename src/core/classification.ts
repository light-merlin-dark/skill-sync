import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { JsonValue, SkillVisibility } from "./types";
import { hashContent, readJsonFile, slugify, writeJsonFile } from "./utils";

export type ClassificationLedger = {
	schemaVersion: 1;
	createdAt: string;
	baselinePath?: string;
	entries: ClassificationLedgerEntry[];
};

export type ClassificationLedgerEntry = {
	slug: string;
	sourcePath: string;
	expectedContentHash?: string;
	visibility: Exclude<SkillVisibility, "unclassified">;
	routes?: string[];
	deprecatedBy?: string;
	installOn?: string[];
};

export type ClassificationReport = {
	schemaVersion: 1;
	ledgerPath: string;
	dryRun: boolean;
	summary: {
		entries: number;
		changes: number;
		unchanged: number;
		errors: number;
	};
	items: Array<{
		slug: string;
		sourcePath: string;
		status: "change" | "unchanged" | "error";
		message: string;
	}>;
};

export function loadClassificationLedger(path: string): ClassificationLedger {
	const ledger = readJsonFile<ClassificationLedger>(path);
	if (!ledger) throw new Error(`classification ledger not found: ${path}`);
	if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) {
		throw new Error(`invalid classification ledger: ${path}`);
	}
	return ledger;
}

export function lockClassificationLedger(
	ledgerPath: string,
): ClassificationLedger {
	const ledger = loadClassificationLedger(ledgerPath);
	const locked: ClassificationLedger = {
		...ledger,
		entries: ledger.entries.map((rawEntry) => {
			const entry = normalizeEntry(rawEntry);
			const skillFilePath = join(entry.sourcePath, "SKILL.md");
			if (!existsSync(skillFilePath)) {
				throw new Error(`SKILL.md is missing: ${skillFilePath}`);
			}
			return {
				...entry,
				expectedContentHash: hashContent(
					readFileSync(skillFilePath, "utf8"),
				),
			};
		}),
	};
	writeJsonFile(ledgerPath, locked);
	return locked;
}

export function applyClassificationLedger(
	ledgerPath: string,
	dryRun: boolean,
	sourceRewrite?: { from: string; to: string },
): ClassificationReport {
	const ledger = loadClassificationLedger(ledgerPath);
	const items: ClassificationReport["items"] = [];
	const seen = new Set<string>();

	for (const rawEntry of ledger.entries) {
		const entry = normalizeEntry({
			...rawEntry,
			sourcePath:
				sourceRewrite && rawEntry.sourcePath.startsWith(sourceRewrite.from)
					? `${sourceRewrite.to}${rawEntry.sourcePath.slice(sourceRewrite.from.length)}`
					: rawEntry.sourcePath,
		});
		const key = `${entry.slug}\0${entry.sourcePath}`;
		if (seen.has(key)) {
			items.push({
				slug: entry.slug,
				sourcePath: entry.sourcePath,
				status: "error",
				message: "duplicate ledger entry",
			});
			continue;
		}
		seen.add(key);
		const skillFilePath = join(entry.sourcePath, "SKILL.md");
		if (!existsSync(skillFilePath)) {
			items.push({
				slug: entry.slug,
				sourcePath: entry.sourcePath,
				status: "error",
				message: "SKILL.md is missing",
			});
			continue;
		}
		const current = readFileSync(skillFilePath, "utf8");
		let updated: string;
		try {
			updated = updateClassificationMetadata(current, entry);
		} catch (error) {
			items.push({
				slug: entry.slug,
				sourcePath: entry.sourcePath,
				status: "error",
				message: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (updated === current) {
			items.push({
				slug: entry.slug,
				sourcePath: entry.sourcePath,
				status: "unchanged",
				message: "classification already matches",
			});
			continue;
		}
		if (
			entry.expectedContentHash &&
			hashContent(current) !== entry.expectedContentHash
		) {
			items.push({
				slug: entry.slug,
				sourcePath: entry.sourcePath,
				status: "error",
				message:
					"content hash changed since baseline; re-audit before classification",
			});
			continue;
		}
		if (!dryRun) writeFileSync(skillFilePath, updated, "utf8");
		items.push({
			slug: entry.slug,
			sourcePath: entry.sourcePath,
			status: "change",
			message: dryRun ? "would update metadata" : "updated metadata",
		});
	}

	return {
		schemaVersion: 1,
		ledgerPath,
		dryRun,
		summary: {
			entries: items.length,
			changes: items.filter((item) => item.status === "change").length,
			unchanged: items.filter((item) => item.status === "unchanged").length,
			errors: items.filter((item) => item.status === "error").length,
		},
		items,
	};
}

export function updateClassificationMetadata(
	content: string,
	entry: ClassificationLedgerEntry,
): string {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		throw new Error("missing YAML frontmatter");
	}
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) throw new Error("unterminated YAML frontmatter");
	const frontmatterText = match[1] || "";
	const document = parseDocument(frontmatterText, { prettyErrors: true });
	if (document.errors.length > 0) {
		throw new Error(
			`invalid YAML frontmatter: ${document.errors[0]?.message.split("\n")[0]}`,
		);
	}
	const raw = document.toJS() as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("frontmatter must be a YAML mapping/object");
	}
	const mapping = raw as Record<string, unknown>;
	const metadataValue = mapping.metadata;
	if (
		metadataValue !== undefined &&
		(!metadataValue ||
			typeof metadataValue !== "object" ||
			Array.isArray(metadataValue))
	) {
		throw new Error("frontmatter metadata must be a mapping/object");
	}
	const metadata = {
		...((metadataValue || {}) as Record<string, unknown>),
	};
	metadata["skill-sync.visibility"] = entry.visibility;
	if (entry.routes && entry.routes.length > 0) {
		metadata["skill-sync.routes"] = entry.routes.join(",");
	} else {
		delete metadata["skill-sync.routes"];
	}
	if (entry.deprecatedBy) {
		metadata["skill-sync.deprecated-by"] = entry.deprecatedBy;
	} else {
		delete metadata["skill-sync.deprecated-by"];
	}
	if (entry.installOn && entry.installOn.length > 0) {
		metadata["skill-sync.install-on"] = entry.installOn.join(",");
	} else {
		delete metadata["skill-sync.install-on"];
	}
	mapping.metadata = metadata;
	const body = content.slice(match[0].length);
	const separator = body.length > 0 ? "\n" : "";
	return `---\n${stringify(mapping).trimEnd()}\n---${separator}${body}`;
}

export function classificationReportToJson(
	report: ClassificationReport,
): JsonValue {
	return report as unknown as JsonValue;
}

function normalizeEntry(entry: ClassificationLedgerEntry): ClassificationLedgerEntry {
	return {
		...entry,
		slug: slugify(entry.slug),
		routes: entry.routes
			? [...new Set(entry.routes.map(slugify).filter(Boolean))].sort()
			: undefined,
		deprecatedBy: entry.deprecatedBy
			? slugify(entry.deprecatedBy)
			: undefined,
		installOn: entry.installOn
			? [...new Set(entry.installOn.map((value) => value.trim()).filter(Boolean))].sort()
			: undefined,
	};
}
