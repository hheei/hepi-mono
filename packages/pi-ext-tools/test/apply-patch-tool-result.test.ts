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
	test("provides targeted recovery for coordinator failures", () => {
		expect(failureRecovery("workspace outcome is unknown after disconnect")).toContain(
			"read every path",
		);
		expect(
			failureRecovery(
				"workspace state indeterminate after cancellation; Apply patch cancelled by client",
			),
		).toContain("read every path");
		expect(failureRecovery("Apply patch cancellation outcome is unknown")).toContain(
			"read every path",
		);
		expect(failureRecovery("Apply patch coordinator queue is full")).toContain("wait");
		expect(failureRecovery("Apply patch cancelled by client after rollback")).toContain(
			"read targets",
		);
		expect(
			failureRecovery("Invalid V4A patch at line 4. No operations were validated or applied."),
		).toContain("correct the V4A syntax");
	});

	test("marks only partial and failed actual outcomes as Pi errors", () => {
		const handler = toolResultHandler();
		expect(handler({ toolName: "apply_patch", details: { status: "success" } })).toBeUndefined();
		expect(handler({ toolName: "apply_patch", details: { status: "partial" } })).toEqual({
			isError: true,
		});
		expect(handler({ toolName: "apply_patch", details: { status: "failed" } })).toEqual({
			isError: true,
		});
		expect(handler({ toolName: "read", details: { status: "partial" } })).toBeUndefined();
	});

	test("forwards coordinator parse progress to the tool update callback", async () => {
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
			expect(updates.map((update) => update.details.operations.length)).toEqual(
				expect.arrayContaining([1, 2]),
			);
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
});
