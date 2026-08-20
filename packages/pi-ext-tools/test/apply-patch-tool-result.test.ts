import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
