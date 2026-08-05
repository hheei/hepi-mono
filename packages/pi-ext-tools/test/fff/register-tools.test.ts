import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { grepNeedsBuiltinFallback, inferFffGrepMode } from "../../src/fff/extension-common.js";
import { createFffRuntimeState } from "../../src/fff/lifecycle.js";
import { registerMultiGrepTool } from "../../src/fff/multi-grep.js";
import { registerFindTool } from "../../src/find.js";

function harness(): { readonly pi: ExtensionAPI; readonly tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	return {
		pi: {
			events: {},
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		tools,
	};
}

describe("FFF tool registration", () => {
	test("preserves Pi grep literal and regex mode semantics", () => {
		expect(inferFffGrepMode()).toBe("regex");
		expect(inferFffGrepMode(false)).toBe("regex");
		expect(inferFffGrepMode(true)).toBe("plain");
	});

	test("delegates every case-insensitive grep request to Pi", () => {
		expect(grepNeedsBuiltinFallback({ pattern: "needle", ignoreCase: true })).toBe(true);
		expect(grepNeedsBuiltinFallback({ pattern: "NEEDLE", ignoreCase: true })).toBe(true);
		expect(grepNeedsBuiltinFallback({ pattern: "needle", ignoreCase: false })).toBe(false);
	});

	test("does not register retired find_files name", () => {
		const host = harness();
		registerMultiGrepTool(host.pi, createFffRuntimeState());
		expect(host.tools.map((tool) => tool.name)).toEqual(["fff_multi_grep"]);
		expect(host.tools.some((tool) => tool.name === "find_files")).toBe(false);
	});

	test("reports canonical unavailable text when FFF runtime is unavailable", async () => {
		const host = harness();
		registerMultiGrepTool(host.pi, createFffRuntimeState());
		const tool = host.tools[0];
		if (tool === undefined) throw new Error("FFF multi-grep was not registered");
		const result = await tool.execute(
			"multi-grep-unavailable",
			{ patterns: ["needle"] },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
			} as never,
		);
		expect(result.content).toEqual([{ type: "text", text: "FFF runtime is not ready." }]);
	});

	test("registers native find under canonical name and executes it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-fff-find-"));
		try {
			await writeFile(join(directory, "fallback-target.txt"), "", "utf8");
			const host = harness();
			registerFindTool(host.pi, createFffRuntimeState());
			expect(host.tools.map((tool) => tool.name)).toEqual(["find"]);
			const find = host.tools[0];
			if (find === undefined) throw new Error("native find was not registered");
			const result = await find.execute(
				"find-canonical",
				{ pattern: "*fallback-target*" },
				undefined,
				undefined,
				{
					cwd: directory,
				} as never,
			);
			expect(
				result.content.some(
					(part) =>
						part.type === "text" && "text" in part && part.text.includes("fallback-target.txt"),
				),
			).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
