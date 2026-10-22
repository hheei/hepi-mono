import type { Theme } from "@earendil-works/pi-coding-agent";
import { getToolPresentationProvider, textToolResult } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { applyPatchPresentation } from "../src/apply-patch/presentation.js";
import { registerApplyPatchTool } from "../src/apply-patch/tool.js";
import { applyPatchResultFacts } from "../src/apply-patch/view.js";
import { renderContextFor, toolFor, toolHost } from "./fixtures/harness.js";

/** A theme that adds no styling, so a row can be asserted as plain text. */
const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
} as Theme;

function context(
	args: unknown,
	overrides: Partial<{ argsComplete: boolean; isPartial: boolean; isError: boolean }> = {},
): Parameters<typeof applyPatchPresentation>[3] {
	return renderContextFor({
		args,
		toolCallId: "patch-call",
		cwd: "/repo",
		argsComplete: overrides.argsComplete ?? true,
		isPartial: overrides.isPartial ?? false,
		isError: overrides.isError ?? false,
	});
}

function rows(presentation: {
	readonly sections?: readonly { readonly content: unknown }[];
}): string {
	return (presentation.sections ?? [])
		.flatMap((section) => (Array.isArray(section.content) ? section.content : []))
		.join("\n");
}

describe("apply_patch owned presentation", () => {
	test("the registered tool carries native renderers and one presentation provider", () => {
		const host = toolHost();
		const tool = registerApplyPatchTool(host.pi);
		expect(tool.renderCall).toBeTypeOf("function");
		expect(tool.renderResult).toBeTypeOf("function");
		expect(tool.defaultActive).toBe(false);
		expect(getToolPresentationProvider(tool)).toBe(applyPatchPresentation);
		expect(toolFor(host.tools, "apply_patch")).toBe(tool);
	});

	test("streamed previews accumulate pending rows across sequential updates", () => {
		const ctx = context(
			{ patch: "*** Begin Patch\n*** Add File: first.txt\n+one\n" },
			{ argsComplete: false },
		);
		const first = applyPatchPresentation(ctx.args, undefined, plainTheme, ctx);
		expect(first.summary).toBe("modify 1 file (+1 -0)");
		expect(rows(first)).toContain("󰄰 create first.txt (+1)");

		// The same render state carries the cursor, so the next chunk only adds new operations.
		const grown = {
			...ctx,
			args: {
				patch:
					"*** Begin Patch\n*** Add File: first.txt\n+one\n*** Update File: second.ts\n@@ old\n-new\n+new\n",
			},
		};
		const second = applyPatchPresentation(grown.args, undefined, plainTheme, grown);
		expect(second.summary).toBe("modify 2 files (+2 -1)");
		const preview = rows(second);
		expect(preview).toContain("󰄰 create first.txt (+1)");
		expect(preview).toContain("󰄰 modify second.ts (+1 -1)");
		expect(second.collapsedRows).toEqual(second.sections?.[0]?.content);
	});

	test("a live frame counts the rows in play and a rejected row carries no delta", () => {
		const details = {
			status: "success",
			changedPaths: [],
			// The executor sums the rows, so the header total is the same sum the table shows.
			addedLines: 5,
			removedLines: 3,
			operations: [
				{ kind: "update", path: "a.txt", status: "applied", addedLines: 1, removedLines: 1 },
				{ kind: "update", path: "b.txt", status: "pending", addedLines: 4, removedLines: 2 },
				{ kind: "add", path: "taken.txt", status: "rejected", addedLines: 0, removedLines: 0 },
			],
			applied: [],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
		};
		const ctx = context({ patch: "*** Begin Patch" }, { isPartial: true });
		const presentation = applyPatchPresentation(
			ctx.args,
			textToolResult("", details),
			plainTheme,
			ctx,
		);
		// The live header counts the paths still in play, not the paths that have already landed.
		expect(presentation.summary).toBe("modify 2 files (+5 -3)");
		expect(presentation.status).toBe("running");
		const live = rows(presentation);
		expect(live).toContain("󰄴 modify a.txt (+1 -1)");
		expect(live).toContain("󰄰 modify b.txt (+4 -2)");
		expect(live).toContain("󰅚 create taken.txt");
	});

	test("a partial result keeps operation rows, snapshot rows and candidate lines", () => {
		const details = {
			status: "partial",
			changedPaths: ["a.ts", "a.ts"],
			addedLines: 2,
			removedLines: 1,
			operations: [
				{ kind: "add", path: "a.ts", status: "applied", addedLines: 2, removedLines: 0 },
				{
					kind: "update",
					path: "b.ts",
					status: "partial",
					addedLines: 0,
					removedLines: 1,
					appliedHunks: 1,
					totalHunks: 2,
					partialReason: "hunk 2",
				},
				{ kind: "update", path: "c.ts", status: "fuzzy", addedLines: 0, removedLines: 0 },
			],
			applied: [
				{
					operationIndex: 0,
					kind: "add",
					paths: ["a.ts"],
					outcomes: [],
					snapshots: [
						{
							path: "a.ts",
							hunkIndex: 1,
							startLine: 1,
							afterStartLine: 1,
							before: [],
							after: ["one", "two"],
						},
					],
				},
			],
			rejected: [
				{
					operationIndices: [2],
					paths: ["c.ts"],
					error: "ambiguous",
					diagnostics: [
						{ kind: "ambiguous_exact", hunkIndex: 2, candidateStartLines: [10, 20, 30] },
						{ kind: "context_not_found", hunkIndex: 3, hint: "near line 4" },
					],
				},
			],
			unconfirmed: [],
			notApplied: [],
		};
		const ctx = context({ patch: "*** Begin Patch" });
		const presentation = applyPatchPresentation(
			ctx.args,
			textToolResult("Patch partially applied.", details),
			plainTheme,
			ctx,
		);
		expect(presentation.summary).toBe("modify 1 file (+2 -1)");
		expect(presentation.status).toBe("warn");
		expect(presentation.replaceCallOnPartial).toBe(true);
		expect(presentation.collapsedRows?.join("\n")).toContain("󰄴 create a.ts (+2)");
		expect(presentation.collapsedRows?.join("\n")).toContain(
			"󰪠 modify b.ts (-1) (1/2 hunks applied; hunk 2)",
		);
		expect(presentation.collapsedRows?.join("\n")).toContain("󰾞 modify c.ts fuzzy");
		const body = rows(presentation);
		expect(body).toContain("+ 1 one");
		expect(body).toContain("+ 2 two");
		expect(body).toContain("󰅚 c.ts · exact context is ambiguous at lines 10, 20, 30");
		expect(body).toContain("󰅚 c.ts · context not found (near line 4)");
		expect(presentation.copy?.primary).toBe("*** Begin Patch");
		expect(presentation.copy?.full).toBe("*** Begin Patch\n---\nPatch partially applied.");
	});

	test("success hides the aggregate glyph and a failure reports error", () => {
		const ok = {
			status: "success",
			changedPaths: ["a.ts"],
			addedLines: 3,
			removedLines: 0,
			operations: [
				{ kind: "add", path: "a.ts", status: "applied", addedLines: 3, removedLines: 0 },
			],
			applied: [],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
		};
		const ctx = context({ patch: "*** Begin Patch" });
		expect(applyPatchPresentation(ctx.args, textToolResult("ok", ok), plainTheme, ctx).status).toBe(
			"none",
		);
		const failed = { ...ok, status: "failed", changedPaths: [] };
		const failedContext = context({ patch: "*** Begin Patch" }, { isError: true });
		expect(
			applyPatchPresentation(
				failedContext.args,
				{ ...textToolResult("Patch was not applied.", failed), isError: true },
				plainTheme,
				failedContext,
			).status,
		).toBe("error");
	});

	test("details that are not this tool's contract keep their model-visible text", () => {
		const ctx = context({ patch: "*** Begin Patch" });
		const presentation = applyPatchPresentation(
			ctx.args,
			textToolResult("Applied patch.", {}),
			plainTheme,
			ctx,
		);
		expect(presentation.summary).toBe("");
		expect(presentation.status).toBe("ok");
		expect(rows(presentation)).toContain("Applied patch.");
		expect(presentation.copy?.primary).toBe("*** Begin Patch");
	});

	test("unconfirmed and not-applied outcomes keep their own glyphs", () => {
		const details = {
			status: "failed",
			changedPaths: [],
			addedLines: 0,
			removedLines: 0,
			operations: [],
			applied: [],
			rejected: [],
			unconfirmed: [
				{ operationIndices: [0], paths: ["u.ts"], error: "publish unconfirmed", diagnostics: [] },
			],
			notApplied: [{ operationIndices: [1], paths: ["n.ts"], error: "lock held", diagnostics: [] }],
		};
		const ctx = context({ patch: "*** Begin Patch" }, { isError: true });
		const presentation = applyPatchPresentation(
			ctx.args,
			{ ...textToolResult("failed", details), isError: true },
			plainTheme,
			ctx,
		);
		const body = rows(presentation);
		expect(body).toContain("󰘥 u.ts · publish unconfirmed");
		expect(body).toContain("󰍷 n.ts · lock held");
	});
});

describe("applyPatchResultFacts", () => {
	test("does not rebuild operation rows from retired applied and rejected lists", () => {
		const facts = applyPatchResultFacts({
			status: "failed",
			changedPaths: [],
			addedLines: 0,
			removedLines: 0,
			operations: undefined,
			applied: [{ operationIndex: 0, kind: "add", paths: ["new.ts"], outcomes: [], snapshots: [] }],
			rejected: [
				{ operationIndices: [1], paths: ["bad.ts"], error: "context not found", diagnostics: [] },
			],
			unconfirmed: [],
			notApplied: [],
		});
		expect(facts?.operations).toEqual([]);
		expect(facts?.rejected.map((rejection) => rejection.paths)).toEqual([["bad.ts"]]);
	});

	test("reads snapshots and rejects an unknown status", () => {
		const facts = applyPatchResultFacts({
			status: "success",
			changedPaths: ["a.ts"],
			addedLines: 1,
			removedLines: 1,
			operations: [],
			applied: [
				{
					operationIndex: 0,
					kind: "update",
					paths: ["a.ts"],
					outcomes: [],
					snapshots: [
						{ path: "a.ts", startLine: 3, afterStartLine: 3, before: ["old"], after: ["new"] },
					],
				},
			],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
		});
		expect(facts?.snapshots).toEqual([
			{
				path: "a.ts",
				hunkIndex: 0,
				startLine: 3,
				afterStartLine: 3,
				before: ["old"],
				after: ["new"],
			},
		]);
		expect(applyPatchResultFacts({ status: "unknown" })).toBeUndefined();
		expect(applyPatchResultFacts(undefined)).toBeUndefined();
	});
});
