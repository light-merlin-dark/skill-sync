import { expect, test } from "bun:test";
import {
	hasBlockingSourceErrors,
	isBudgetGrowthAction,
	withholdBudgetGrowth,
} from "../../src/core/sync";
import type {
	HarnessDefinition,
	PlannedAction,
	PlannedEntry,
	SyncPlan,
} from "../../src/core/types";

const harness: HarnessDefinition = {
	id: "agents",
	label: "Agents",
	rootPath: "/tmp/agents/skills",
} as HarnessDefinition;

function entry(action: PlannedAction, installName: string): PlannedEntry {
	return {
		harnessId: "agents",
		harnessRoot: "/tmp/agents/skills",
		installName,
		destinationPath: `/tmp/agents/skills/${installName}`,
		action,
		message: action,
	};
}

function plan(entries: PlannedEntry[], errorKinds: string[] = []): SyncPlan {
	return {
		schemaVersion: 1,
		planHash: "test",
		harnesses: [{ harness, entries }],
		changes: entries.filter((item) => item.action !== "ok").length,
		conflicts: entries.filter((item) => item.action === "conflict").length,
		ok: entries.filter((item) => item.action === "ok").length,
		sourceDiagnostics: {
			errors: errorKinds.map((kind) => ({ kind, slug: "global" })),
			warnings: [],
		},
		harnessDiagnostics: [],
	} as unknown as SyncPlan;
}

test("only `create` can grow the startup index", () => {
	expect(isBudgetGrowthAction("create")).toBe(true);
	for (const action of [
		"repair",
		"replace-managed",
		"remove-managed",
		"remove-obsolete",
		"remove-broken",
		"remove-dir-symlink",
		"prune-state",
		"ok",
	] as PlannedAction[]) {
		expect(isBudgetGrowthAction(action)).toBe(false);
	}
});

test("a repair survives an over-budget plan — it cannot grow the index", () => {
	// The measured case: a stale copy replaced by a symlink whose name and
	// description are byte-identical. Refusing it froze a harness root for three
	// weeks and moved the estimate by nothing.
	const original = plan(
		[entry("repair", "email-cli"), entry("ok", "db")],
		["visibility-budget-exceeded"],
	);
	const { plan: applicable, withheld } = withholdBudgetGrowth(original);
	expect(withheld).toHaveLength(0);
	expect(applicable.harnesses[0].entries.map((item) => item.action)).toEqual([
		"repair",
		"ok",
	]);
});

test("a new install is withheld, and the rest of the plan still applies", () => {
	const original = plan(
		[entry("create", "brand-new"), entry("repair", "email-cli")],
		["visibility-budget-exceeded"],
	);
	const { plan: applicable, withheld } = withholdBudgetGrowth(original);
	expect(withheld.map((item) => item.installName)).toEqual(["brand-new"]);
	expect(applicable.harnesses[0].entries.map((item) => item.action)).toEqual([
		"repair",
	]);
	expect(applicable.changes).toBe(1);
});

test("removals apply while over budget, because they are how it clears", () => {
	const original = plan(
		[entry("remove-managed", "retired"), entry("remove-obsolete", "gone")],
		["visibility-budget-exceeded"],
	);
	const { withheld } = withholdBudgetGrowth(original);
	expect(withheld).toHaveLength(0);
});

test("the plan object is returned untouched when nothing is withheld", () => {
	const original = plan([entry("repair", "email-cli")], ["visibility-budget-exceeded"]);
	expect(withholdBudgetGrowth(original).plan).toBe(original);
});

test("a budget overage alone is not a blocking source error", () => {
	expect(hasBlockingSourceErrors(plan([], ["visibility-budget-exceeded"]))).toBe(false);
});

test("an unclassified source is a blocking source error", () => {
	expect(
		hasBlockingSourceErrors(
			plan([], ["visibility-budget-exceeded", "unclassified-visibility"]),
		),
	).toBe(true);
});
