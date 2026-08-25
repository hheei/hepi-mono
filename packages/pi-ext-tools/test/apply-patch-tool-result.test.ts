import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createApplyPatchTool, failureRecovery } from "../src/apply-patch-tool.js";
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
	test("provides targeted recovery for request failures", () => {
		expect(failureRecovery("workspace outcome is unknown after disconnect")).toContain(
			"Unconfirmed",
		);
		expect(failureRecovery("apply_patch is already running for /tmp/ws")).toContain("wait");
		expect(failureRecovery("cancelled after first publish")).toContain("confirmed paths stay");
		expect(
			failureRecovery("Invalid V4A patch at line 4. No operations were validated or applied."),
		).toContain("correct the V4A syntax");
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

	test("marks native SSH mutation recovery outcomes as Pi errors", () => {
		const handler = toolResultHandler();
		const details = (outcome: "changed" | "no_change" | "unconfirmed" | "not_applied") => ({
			__piExtToolsRemoteMutation: { target: "ileqm", path: "/tmp/file.txt", outcome },
		});
		expect(handler({ toolName: "edit", details: details("changed") })).toBeUndefined();
		expect(handler({ toolName: "write", details: details("no_change") })).toBeUndefined();
		expect(handler({ toolName: "edit", details: details("unconfirmed") })).toEqual({
			isError: true,
		});
		expect(handler({ toolName: "write", details: details("not_applied") })).toEqual({
			isError: true,
		});
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
						"Rejected:\n- operation 1, value.txt, hunk 2: best fuzzy score 0.00 < required 0.70\n" +
						"Recovery: read value.txt, then retry only rejected hunks from operation 1.\n" +
						"Do not retry applied hunks.",
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
						partialReason: "fuzzy score below threshold",
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

	test("rejects output targets before mutation", async () => {
		await expect(
			createApplyPatchTool().execute(
				"call-id",
				{
					patch: "*** Begin Patch\n*** Add File: first.txt\n+one\n*** End Patch",
					target: "output",
				},
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			),
		).rejects.toThrow("does not support output targets");
	});

	test("rejects SSH apply_patch when the target runtime is missing", async () => {
		await expect(
			createApplyPatchTool().execute(
				"call-id",
				{
					patch: "*** Begin Patch\n*** Add File: first.txt\n+one\n*** End Patch",
					target: "devbox",
				},
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			),
		).rejects.toThrow("Target runtime is unavailable");
	});

	test("rejects unauthorized SSH aliases before mutation", async () => {
		await expect(
			createApplyPatchTool({
				getTargetRuntime: () => ({ isAllowedHost: () => false }) as never,
			} as never).execute(
				"call-id",
				{
					patch: "*** Begin Patch\n*** Add File: first.txt\n+one\n*** End Patch",
					target: "devbox",
				},
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			),
		).rejects.toThrow("Unknown or unauthorized SSH target: devbox");
	});
});
