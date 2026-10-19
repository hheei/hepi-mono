import { describe, expect, test } from "vitest";
import { previewV4aOperations } from "../src/apply-patch-preview.js";
import { applyPatchFacts, formatApplyPatchOperationRow } from "../src/apply-patch-view.js";
import { createCollapsibleToolRendererResolver, inlinePresentation } from "../src/renderer.js";
import type { ToolView } from "../src/tool-view.js";

const plainTheme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as never;

function mockContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		state: {},
		args: {},
		cwd: "/tmp",
		toolCallId: "c1",
		expanded: false,
		invalidate: () => {},
		...overrides,
	};
}

describe("apply-patch preview", () => {
	test("recognizes completed operation headers incrementally", () => {
		expect(previewV4aOperations("*** Begin Patch\n", false, undefined)).toEqual([]);
		const first = previewV4aOperations(
			"*** Begin Patch\n*** Add File: first.txt\n",
			false,
			undefined,
		);
		expect(first).toEqual([{ kind: "add", path: "first.txt", addedLines: 0, removedLines: 0 }]);
	});
});

describe("apply_patch render", () => {
	test("collapsed summaries count unique changed paths and retain zero deltas, including nested calls", () => {
		const patch =
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Update File: a.ts\n@@\n-old2\n+new2\n*** End Patch";
		expect(inlinePresentation("apply_patch", { patch }, undefined, false)?.summary).toBe(
			"modify 1 file (+2 -2)",
		);
		const details = {
			status: "partial",
			changedPaths: ["a.ts", "a.ts"],
			addedLines: 2,
			removedLines: 0,
			operations: [
				{ kind: "update", path: "a.ts", status: "applied", addedLines: 2, removedLines: 0 },
				{
					kind: "update",
					path: "untouched.ts",
					status: "rejected",
					addedLines: 0,
					removedLines: 0,
				},
			],
		};
		const result = { content: [{ type: "text" as const, text: "partial" }], details };
		const resolve = createCollapsibleToolRendererResolver();
		const direct = resolve("apply_patch", () => undefined)!.renderResult!(
			result,
			{ expanded: false, isPartial: false },
			plainTheme,
			mockContext({ args: { patch } }) as never,
		);
		expect(direct.render(100)[0]).toContain("modify 1 file (+2 -0)");
		const parent = resolve("codemode", () => undefined)!.renderResult!(
			{
				content: [],
				details: {
					__piExtUiCapturedCalls: [
						{
							toolCallId: "c1/1",
							toolName: "apply_patch",
							args: { patch },
							result,
							isError: false,
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			mockContext() as never,
		);
		expect(parent.render(100).join("\n")).toContain("▎ ✓ apply_patch modify 1 file (+2 -0)");
	});

	test("streams pending rows from a partial patch before execute starts", () => {
		const resolve = createCollapsibleToolRendererResolver();
		const renderers = resolve("apply_patch", () => undefined)!;
		const ctx = mockContext({
			args: {
				patch:
					"*** Begin Patch\n*** Add File: first.txt\n+one\n*** Update File: second.ts\n@@ old\n-new\n+new\n",
			},
			isPartial: true,
			argsComplete: false,
		});
		const view = renderers.renderCall!(ctx.args, plainTheme, ctx as never) as ToolView;
		const lines = view.render(100);
		expect(lines[0]).toContain("apply_patch modify 2 files (+2 -1)");
		expect(lines.join("\n")).toContain("⋯ create first.txt (+1)");
		expect(lines.join("\n")).toContain("⋯ modify second.ts (+1 -1)");
	});

	test("Level 0 shows operation rows, partial maps to warn, success hides the glyph", () => {
		const resolve = createCollapsibleToolRendererResolver();
		const renderers = resolve("apply_patch", () => undefined)!;
		const details = {
			status: "partial",
			changedPaths: ["a.ts", "b.ts"],
			addedLines: 4,
			removedLines: 1,
			operations: [
				{
					operationIndex: 0,
					kind: "add" as const,
					path: "a.ts",
					addedLines: 4,
					removedLines: 0,
					status: "applied",
				},
				{
					operationIndex: 1,
					kind: "update" as const,
					path: "b.ts",
					addedLines: 0,
					removedLines: 1,
					status: "partial",
					appliedHunks: 1,
					totalHunks: 2,
					partialReason: "hunk 2",
				},
			],
			operationCount: 2,
			exactUpdateCount: 0,
			fuzzyUpdateCount: 0,
			applied: [],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
		};
		const ctx = mockContext({ args: { patch: "*** Begin Patch" }, durationMs: 120 });
		const view = renderers.renderResult!(
			{ content: [{ type: "text", text: "done" }], details },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx as never,
		) as ToolView;
		const lines = view.render(100);
		expect(lines[0]).toContain("! apply_patch");
		expect(lines[0]).toContain("modify 2 files (+4 -1) · 120ms");
		expect(lines.join("\n")).toContain("✓ create a.ts (+4)");
		expect(lines.join("\n")).toContain("▲ modify b.ts (-1) (1/2 hunks applied; hunk 2)");
	});

	test("success has no top glyph and collapsed rows carry the operations", () => {
		const resolve = createCollapsibleToolRendererResolver();
		const renderers = resolve("apply_patch", () => undefined)!;
		const details = {
			status: "success",
			changedPaths: ["a.ts"],
			addedLines: 3,
			removedLines: 0,
			operations: [
				{
					operationIndex: 0,
					kind: "add",
					path: "a.ts",
					addedLines: 3,
					removedLines: 0,
					status: "applied",
				},
			],
			operationCount: 1,
			exactUpdateCount: 0,
			fuzzyUpdateCount: 0,
			applied: [],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
		};
		const ctx = mockContext({ args: { patch: "*** Begin Patch" }, durationMs: 40 });
		const view = renderers.renderResult!(
			{ content: [{ type: "text", text: "ok" }], details },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx as never,
		) as ToolView;
		const lines = view.render(100);
		expect(lines[0]).toContain("▸ apply_patch modify 1 file (+3 -0)");
		expect(lines[1]).toContain("✓ create a.ts (+3)");
	});

	test("snapshots render through the single-column DiffView", () => {
		const resolve = createCollapsibleToolRendererResolver();
		const renderers = resolve("apply_patch", () => undefined)!;
		const details = {
			status: "success",
			changedPaths: ["a.ts"],
			addedLines: 1,
			removedLines: 1,
			operations: [
				{
					operationIndex: 0,
					kind: "update",
					path: "a.ts",
					addedLines: 1,
					removedLines: 1,
					status: "applied",
				},
			],
			operationCount: 1,
			exactUpdateCount: 1,
			fuzzyUpdateCount: 0,
			applied: [
				{
					operationIndex: 0,
					kind: "update",
					paths: ["a.ts"],
					outcomes: [],
					snapshots: [
						{
							path: "a.ts",
							hunkIndex: 0,
							startLine: 3,
							afterStartLine: 3,
							before: ["old"],
							after: ["new"],
						},
					],
				},
			],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
			durationMs: 10,
		};
		const ctx = mockContext({ args: { patch: "*** Begin Patch" } });
		const view = renderers.renderResult!(
			{ content: [{ type: "text", text: "ok" }], details },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx as never,
		) as ToolView;
		view.setFoldLevel(1);
		const lines = view.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("✓ modify a.ts (+1 -1)");
		expect(joined).toContain("- 3 old");
		expect(joined).toContain("+ 3 new");
	});

	test("non-conforming details fall back to the generic result path", () => {
		const resolve = createCollapsibleToolRendererResolver();
		const renderers = resolve("apply_patch", () => undefined)!;
		const ctx = mockContext({ args: { patch: "*** Begin Patch" } });
		const view = renderers.renderResult!(
			{ content: [{ type: "text", text: "Applied patch." }], details: {} },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx as never,
		) as ToolView;
		view.setFoldLevel(1);
		const lines = view.render(80);
		expect(lines.join("\n")).toContain("Applied patch.");
	});
});

describe("applyPatchFacts", () => {
	test("does not rebuild operation rows from retired applied and rejected lists", () => {
		const facts = applyPatchFacts({
			status: "failed",
			changedPaths: [],
			addedLines: 0,
			removedLines: 0,
			operations: undefined,
			operationCount: 1,
			exactUpdateCount: 0,
			fuzzyUpdateCount: 0,
			applied: [{ operationIndex: 0, kind: "add", paths: ["new.ts"], outcomes: [], snapshots: [] }],
			rejected: [
				{
					operationIndices: [1],
					paths: ["bad.ts"],
					error: "context not found",
					diagnostics: [],
				},
			],
			unconfirmed: [],
			notApplied: [],
		});
		expect(facts?.operations).toEqual([]);
		expect(facts?.rejected.map((rejection) => rejection.paths)).toEqual([["bad.ts"]]);
	});

	test("formats unconfirmed rows with the warning glyph", () => {
		const row = formatApplyPatchOperationRow(
			{
				operationIndex: 0,
				kind: "update",
				path: "x.ts",
				addedLines: 0,
				removedLines: 0,
				status: "unconfirmed",
				appliedHunks: undefined,
				totalHunks: undefined,
				partialReason: undefined,
			},
			plainTheme,
			undefined,
		);
		expect(row).toContain("▲ modify x.ts");
	});

	test("call view is hidden once result view renders", () => {
		const resolve = createCollapsibleToolRendererResolver();
		const renderers = resolve("apply_patch", () => undefined)!;
		const state: Record<string, unknown> = {};
		const ctx = mockContext({
			state,
			args: { patch: "*** Begin Patch\n*** Add File: a.ts\n+1\n" },
		});
		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx as never) as ToolView;
		expect(callView.render(100).length).toBeGreaterThan(0);

		const resultView = renderers.renderResult!(
			{ content: [{ type: "text", text: "ok" }], details: { status: "success", operations: [] } },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx as never,
		) as ToolView;

		expect(callView.render(100)).toEqual([]);
		expect(resultView.render(100).length).toBeGreaterThan(0);
	});
});
