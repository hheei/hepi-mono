import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { formatApplyPatchFooter, renderApplyPatchResult } from "../src/apply-patch/renderer.js";
import type { ApplyPatchToolDetails } from "../src/apply-patch-tool.js";

initTheme(undefined, false);

const roles: string[] = [];
const theme = {
	fg: (role: string, text: string) => {
		roles.push(role);
		return text;
	},
	bold: (text: string) => text,
};

const details: ApplyPatchToolDetails = {
	status: "partial",
	changedPaths: ["src/created.ts", "src/updated.ts"],
	addedLines: 17,
	removedLines: 10,
	operations: [
		{
			operationIndex: 0,
			kind: "add",
			path: "src/created.ts",
			addedLines: 4,
			removedLines: 0,
			status: "applied",
		},
		{
			operationIndex: 1,
			kind: "update",
			path: "src/updated.ts",
			addedLines: 6,
			removedLines: 2,
			status: "applied",
		},
		{
			operationIndex: 2,
			kind: "update",
			path: "src/fuzzy.ts",
			addedLines: 7,
			removedLines: 1,
			status: "fuzzy",
			score: 0.72,
		},
		{
			operationIndex: 3,
			kind: "delete",
			path: "src/rejected.ts",
			addedLines: 0,
			removedLines: 7,
			status: "rejected",
		},
	],
	operationCount: 4,
	exactUpdateCount: 1,
	fuzzyUpdateCount: 1,
	applied: [
		{
			operationIndex: 1,
			kind: "update",
			paths: ["src/updated.ts"],
			outcomes: [],
			snapshots: [
				{
					path: "src/updated.ts",
					hunkIndex: 1,
					startLine: 2,
					afterStartLine: 2,
					before: ["old"],
					after: ["new"],
				},
			],
		},
	],
	rejected: [
		{
			operationIndices: [3],
			paths: ["src/rejected.ts"],
			error: "Patch update failed: src/rejected.ts",
			diagnostics: [],
		},
	],
	durationMs: 720,
};

describe("apply_patch progress renderer", () => {
	test("renders actual operation rows and fuzzy score", () => {
		const text = renderApplyPatchResult(details, false, theme as never)
			.render(200)
			.join("\n");
		expect(text).toContain("✓ create src/created.ts +4");
		expect(text).toContain("✓ modify src/updated.ts +6 -2");
		expect(text).toContain("! modify src/fuzzy.ts +7 -1 (0.72)");
		expect(text).toContain("✗ delete src/rejected.ts -7");
		expect(text).toContain("created 1 · deleted 1 · modified 2 · 0.72s");
	});

	test("uses semantic colors for patch facts", () => {
		roles.splice(0);
		renderApplyPatchResult(details, false, theme as never).render(200);
		expect(roles).toEqual(expect.arrayContaining(["success", "error", "warning", "dim"]));
	});

	test("keeps outcome-time diff expanded only", () => {
		const collapsed = renderApplyPatchResult(details, false, theme as never)
			.render(200)
			.join("\n");
		const expanded = renderApplyPatchResult(details, true, theme as never)
			.render(200)
			.join("\n");
		expect(collapsed).not.toContain("--- a/src/updated.ts");
		expect(expanded).toContain("--- a/src/updated.ts");
	});

	test("uses progress rows while applying", () => {
		const progress: ApplyPatchToolDetails = {
			...details,
			status: "success",
			operations: details.operations.map((operation, index) =>
				index === 0 ? { ...operation, status: "pending" as const } : operation,
			),
		};
		const text = renderApplyPatchResult(progress, false, theme as never)
			.render(200)
			.join("\n");
		expect(text).toContain("○ create src/created.ts +4");
		expect(formatApplyPatchFooter(details)).toBe("created 1 · deleted 1 · modified 2 · 0.72s");
	});
});
