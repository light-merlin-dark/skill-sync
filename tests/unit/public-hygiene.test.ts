import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../..");

function trackedFiles(): string[] {
	const result = spawnSync("git", ["ls-files", "-z"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	return result.stdout.split("\0").filter(Boolean);
}

describe("public repository hygiene", () => {
	test("keeps machine-local guidance and inventories out of git", () => {
		const tracked = trackedFiles();
		expect(tracked).not.toContain("AGENTS.md");
		expect(tracked).not.toContain("docs/plan.md");
		expect(tracked.some((file) => file.startsWith("inventory/"))).toBe(false);
	});

	test("contains no absolute user-home paths in public product files", () => {
		const publicFiles = trackedFiles();
		const absoluteHome = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//;
		const offenders = publicFiles.filter((file) =>
			absoluteHome.test(readFileSync(join(repoRoot, file), "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	test("ships only reusable product artifacts", () => {
		const packageJson = JSON.parse(
			readFileSync(join(repoRoot, "package.json"), "utf8"),
		) as { files?: string[] };
		const shipped = packageJson.files || [];
		expect(shipped).not.toContain("AGENTS.md");
		expect(shipped).not.toContain("docs/plan.md");
		expect(shipped.some((file) => file.startsWith("inventory"))).toBe(false);
	});
});
