import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ApplyPatchInWorkspaceResult } from "../src/apply-patch/outcome.js";
import { createApplyPatchTool, formatApplyPatchResult } from "../src/apply-patch-tool.js";
import piExtToolsExtension from "../src/extension.js";

type ToolResultHandler = (event: { toolName: string; details: unknown }) => unknown;

function toolResultHandler(): ToolResultHandler {
	const handlers = new Map<string, ToolResultHandler>();
	piExtToolsExtension(
		new Proxy(
			{ events: {} },
			{
				get: (_target, property) => {
					if (property === "on") {
						return (event: string, handler: ToolResultHandler) => handlers.set(event, handler);
					}
					return () => undefined;
				},
			},
		) as never,
	);
	const handler = handlers.get("tool_result");
	if (handler === undefined) throw new Error("Expected tool_result handler");
	return handler;
}

describe("apply_patch tool_result contract", () => {
	test.each([
		{
			name: "ambiguous context",
			result: {
				rejected: [
					{
						operationIndices: [0],
						paths: ["value.txt"],
						error: "ambiguous",
						diagnostics: [{ kind: "ambiguous_exact", hunkIndex: 1, candidateStartLines: [1, 3] }],
					},
				],
			},
			text: "Patch was not applied.\nRejected:\n- operation 1, value.txt, hunk 1: exact context is ambiguous at lines 1, 3 (2 candidates)",
		},
		{
			name: "bounded candidate lines with total count",
			result: {
				rejected: [
					{
						operationIndices: [0],
						paths: ["value.txt"],
						error: "ambiguous",
						diagnostics: [
							{
								kind: "ambiguous_exact",
								hunkIndex: 2,
								candidateStartLines: [10, 20, 30, 40, 50, 60, 70, 80],
							},
						],
					},
				],
			},
			text: "Patch was not applied.\nRejected:\n- operation 1, value.txt, hunk 2: exact context is ambiguous at lines 10, 20, 30, 40, 50, 60 (8 candidates)",
		},
		{
			name: "unconfirmed write followed by skipped operations",
			result: {
				unconfirmed: [
					{
						operationIndices: [0],
						paths: ["uncertain.txt"],
						error: "connection lost",
						diagnostics: [],
					},
				],
				notApplied: [
					{ operationIndices: [1], paths: ["later.txt"], error: "NotApplied", diagnostics: [] },
				],
			},
			text: "Patch was not applied.\nUnconfirmed:\n- operation 1, uncertain.txt: connection lost\nNotApplied:\n- operation 2, later.txt: NotApplied",
		},
		{
			name: "move destination published but source removal rejected",
			result: {
				changedPaths: ["destination.txt"],
				applied: [
					{
						operationIndex: 0,
						kind: "update",
						paths: ["destination.txt"],
						outcomes: [],
						snapshots: [],
					},
				],
				rejected: [
					{
						operationIndices: [0],
						paths: ["source.txt"],
						error: "source changed",
						diagnostics: [],
					},
				],
			},
			text: "Patch partially applied.\nChanged:\n- destination.txt: update\nRejected:\n- operation 1, source.txt: source changed",
		},
	] satisfies {
		name: string;
		result: Partial<ApplyPatchInWorkspaceResult>;
		text: string;
	}[])("reports only outcome facts: $name", ({ result, text }) => {
		expect(
			formatApplyPatchResult({
				changedPaths: [],
				addedLines: 0,
				removedLines: 0,
				operations: [],
				operationCount: 0,
				exactUpdateCount: 0,
				fuzzyUpdateCount: 0,
				applied: [],
				rejected: [],
				unconfirmed: [],
				notApplied: [],
				...result,
			}),
		).toBe(text);
	});

	test("reports malformed source without recovery instructions", async () => {
		await expect(
			createApplyPatchTool().execute(
				"invalid-patch",
				{ patch: "*** Begin Patch\n*** Add File: value.txt\naborted\n*** End Patch" },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			),
		).rejects.toThrow(
			/^apply_patch failed: Invalid V4A patch: Add content lines must begin with \+ at line 3$/,
		);
	});

	test("marks failed and unknown outcomes as Pi errors, not Changed+Rejected partial", () => {
		const handler = toolResultHandler();
		expect(handler({ toolName: "apply_patch", details: { status: "success" } })).toBeUndefined();
		expect(handler({ toolName: "apply_patch", details: { status: "partial" } })).toBeUndefined();
		expect(
			handler({
				toolName: "apply_patch",
				details: { status: "partial", unconfirmed: [{ paths: ["a.ts"] }] },
			}),
		).toEqual({ isError: true });
		expect(handler({ toolName: "apply_patch", details: { status: "failed" } })).toEqual({
			isError: true,
		});
		expect(handler({ toolName: "read", details: { status: "partial" } })).toBeUndefined();
	});

	test("forwards parse progress to the tool update callback", async () => {
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-tool-result-"));
		const updates: { readonly details: { readonly operations: readonly unknown[] } }[] = [];
		try {
			const result = await createApplyPatchTool().execute(
				"call-id",
				{
					patch:
						"*** Begin Patch\n" +
						"*** Add File: first.txt\n+one\n" +
						"*** Add File: second.txt\n+two\n" +
						"*** End Patch",
				},
				undefined,
				(update) => updates.push(update as (typeof updates)[number]),
				{ cwd: root } as never,
			);
			expect(updates.some((update) => update.details.operations.length === 2)).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: "Applied patch: 2 operations in 2 files.\nChanged:\n- first.txt: add\n- second.txt: add",
				},
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reports and preserves successful hunks from a partial update", async () => {
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-tool-result-"));
		try {
			await writeFile(join(root, "value.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
			const result = await createApplyPatchTool().execute(
				"call-id",
				{
					patch:
						"*** Begin Patch\n" +
						"*** Update File: value.txt\n" +
						"@@\n-one\n+ONE\n" +
						"@@\n-missing\n+MISS\n" +
						"@@\n-five\n+FIVE\n" +
						"*** End Patch",
				},
				undefined,
				undefined,
				{ cwd: root } as never,
			);
			expect(result.content).toEqual([
				{
					type: "text",
					text:
						"Patch partially applied.\n" +
						"Changed:\n- value.txt: update (2/3 hunks applied)\n" +
						"Rejected:\n- operation 1, value.txt, hunk 2: context not found",
				},
			]);
			expect(result.details).toMatchObject({
				status: "partial",
				changedPaths: ["value.txt"],
				operations: [
					{
						status: "partial",
						appliedHunks: 2,
						totalHunks: 3,
						partialReason: "context not found",
					},
				],
			});
			expect(await readFile(join(root, "value.txt"), "utf8")).toBe(
				"ONE\ntwo\nthree\nfour\nFIVE\nsix\n",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("allows absolute paths and warns only for confirmed external writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-tool-result-"));
		const outside = await mkdtemp(join(tmpdir(), "hepi-apply-patch-tool-result-"));
		const insidePath = join(root, "inside.txt");
		const outsidePath = join(outside, "outside.txt");
		try {
			const inside = await createApplyPatchTool().execute(
				"call-id",
				{ patch: `*** Begin Patch\n*** Add File: ${insidePath}\n+inside\n*** End Patch` },
				undefined,
				undefined,
				{ cwd: root } as never,
			);
			expect(inside.content).toEqual([
				{
					type: "text",
					text: `Applied patch: 1 operations in 1 files.\nChanged:\n- ${insidePath}: add`,
				},
			]);

			const outsideResult = await createApplyPatchTool().execute(
				"call-id",
				{ patch: `*** Begin Patch\n*** Add File: ${outsidePath}\n+outside\n*** End Patch` },
				undefined,
				undefined,
				{ cwd: root } as never,
			);
			expect(outsideResult.content).toEqual([
				{
					type: "text",
					text: `Applied patch: 1 operations in 1 files.\nChanged:\n- ${outsidePath}: add\nWarning: changed path outside the workspace: ${outsidePath}`,
				},
			]);
			expect(await readFile(outsidePath, "utf8")).toBe("outside\n");
		} finally {
			await Promise.all([
				rm(root, { recursive: true, force: true }),
				rm(outside, { recursive: true, force: true }),
			]);
		}
	});

	test("does not warn for a workspace symlink that targets outside", async () => {
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-tool-result-"));
		const outside = await mkdtemp(join(tmpdir(), "hepi-apply-patch-tool-result-"));
		try {
			await writeFile(join(outside, "linked.txt"), "before\n");
			await symlink(join(outside, "linked.txt"), join(root, "linked.txt"));
			const result = await createApplyPatchTool().execute(
				"call-id",
				{
					patch: "*** Begin Patch\n*** Update File: linked.txt\n-before\n+after\n*** End Patch",
				},
				undefined,
				undefined,
				{ cwd: root } as never,
			);
			expect(result.content).toEqual([
				{
					type: "text",
					text: "Applied patch: 1 operations in 1 files.\nChanged:\n- linked.txt: update (1/1 hunks applied)",
				},
			]);
			expect(await readFile(join(outside, "linked.txt"), "utf8")).toBe("after\n");
		} finally {
			await Promise.all([
				rm(root, { recursive: true, force: true }),
				rm(outside, { recursive: true, force: true }),
			]);
		}
	});
});
