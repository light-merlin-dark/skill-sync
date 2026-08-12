import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyClassificationLedger,
	updateClassificationMetadata,
} from "../../src/core/classification";
import { hashContent, parseSkillFrontmatterContent } from "../../src/core/utils";
import { cleanup, makeFakeProjectsRoot, writeText } from "../support";

const tempPaths: string[] = [];

afterEach(() => {
	for (const path of tempPaths.splice(0)) cleanup(path);
});

test("applies a hash-guarded standards-aligned classification idempotently", () => {
	const { homeDir } = makeFakeProjectsRoot();
	tempPaths.push(homeDir);
	const sourcePath = join(homeDir, "projects", "stack", "skills", "stack");
	const skillPath = join(sourcePath, "SKILL.md");
	const original =
		"---\nname: stack\ndescription: Stack router\nmetadata:\n  short-description: Router\n---\n\n# Stack\n";
	writeText(skillPath, original);
	const ledgerPath = join(homeDir, "classification.json");
	writeText(
		ledgerPath,
		JSON.stringify({
			schemaVersion: 1,
			createdAt: "2026-08-12T00:00:00.000Z",
			entries: [
				{
					slug: "stack",
					sourcePath,
					expectedContentHash: hashContent(original),
					visibility: "project",
					routes: ["stack-ui-kit", "stack-admin"],
				},
			],
		}),
	);

	const planned = applyClassificationLedger(ledgerPath, true);
	expect(planned.summary).toEqual({
		entries: 1,
		changes: 1,
		unchanged: 0,
		errors: 0,
	});
	expect(readFileSync(skillPath, "utf8")).toBe(original);

	const applied = applyClassificationLedger(ledgerPath, false);
	expect(applied.summary.errors).toBe(0);
	const updated = readFileSync(skillPath, "utf8");
	const metadata = parseSkillFrontmatterContent(updated);
	expect(metadata.skillSyncVisibility).toBe("project");
	expect(metadata.skillSyncRoutes).toEqual(["stack-admin", "stack-ui-kit"]);
	expect(updated).toContain("short-description: Router");

	const repeated = applyClassificationLedger(ledgerPath, false);
	expect(repeated.summary.unchanged).toBe(1);
	expect(repeated.summary.errors).toBe(0);
});

test("refuses a changed source instead of overwriting classification metadata", () => {
	const content = "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n";
	expect(() =>
		updateClassificationMetadata(content, {
			slug: "demo",
			sourcePath: "/tmp/demo",
			visibility: "global",
		}),
	).not.toThrow();
});
