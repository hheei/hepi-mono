import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createArtifactRegistry } from "@hheei/pi-ext-core";
import { grepNeedsBuiltinFallback, inferFffGrepMode } from "../../src/fff/extension-common.js";
import { FffRuntime } from "../../src/fff/fff.js";
import { createFffRuntimeState, type FffRuntimeState } from "../../src/fff/lifecycle.js";
import { registerMultiGrepTool } from "../../src/fff/multi-grep.js";
import { registerFindTool } from "../../src/find.js";
import { registerGrepTool } from "../../src/grep.js";

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
		expect(inferFffGrepMode(undefined, "catch (error")).toBe("plain");
		expect(inferFffGrepMode(undefined, "catch \\(error\\)")).toBe("regex");
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

	test("uses FFF for unscoped non-glob find queries when enabled", async () => {
		const host = harness();
		const runtime = new FffRuntime(process.cwd(), {
			finder: {
				fileSearch: () => ({
					ok: true as const,
					value: {
						items: [
							{
								relativePath: "src/find-enhancement.ts",
								totalFrecencyScore: 100,
								gitStatus: "modified",
							},
						],
						scores: [{ matchType: "fuzzy", total: 1 }],
						totalMatched: 2,
						totalFiles: 2,
					},
				}),
			} as never,
		});
		const state = {
			getRuntime: () => runtime,
			getSettings: () => ({
				shellPath: "sh",
				bashOutputTailKiB: 10,
				autocomplete: true,
				grepEnhancement: true,
				readEnhancement: true,
				findEnhancement: true,
				statusUI: true,
			}),
			getBashJobs: () => undefined,
			getArtifacts: () => undefined,
		} satisfies FffRuntimeState;
		registerFindTool(host.pi, state);
		const find = host.tools[0];
		if (find === undefined) throw new Error("FFF find was not registered");

		const result = await find.execute(
			"find-fff",
			{ pattern: "find enhancement", limit: 1 },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);

		const text = result.content[0];
		if (text?.type !== "text") throw new Error("Expected text result");
		expect(text.text).toStartWith("1. src/find-enhancement.ts (fuzzy) - hot git:modified");
		expect(text.text).toContain("cursor: find:");
		expect(result.details).toBeUndefined();
	});

	test("treats an empty cursor as a new FFF search", async () => {
		const host = harness();
		const runtime = new FffRuntime(process.cwd(), {
			finder: {
				fileSearch: () => ({
					ok: true as const,
					value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
				}),
			} as never,
		});
		const state = {
			getRuntime: () => runtime,
			getSettings: () => ({
				shellPath: "sh",
				bashOutputTailKiB: 10,
				autocomplete: true,
				grepEnhancement: true,
				readEnhancement: true,
				findEnhancement: true,
				statusUI: true,
			}),
			getBashJobs: () => undefined,
			getArtifacts: () => undefined,
		} satisfies FffRuntimeState;
		registerFindTool(host.pi, state);
		const find = host.tools[0];
		if (find === undefined) throw new Error("FFF find was not registered");

		const result = await find.execute(
			"find-empty-cursor",
			{ pattern: "missing", cursor: "" },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);

		expect(result.content).toEqual([{ type: "text", text: "No files found matching pattern" }]);
	});

	test("searches artifact text with grep and rejects it from find", async () => {
		const artifacts = createArtifactRegistry();
		const path = artifacts.create("before\nNeedle\nafter");
		const state = {
			getRuntime: () => undefined,
			getSettings: () => ({
				shellPath: "sh",
				bashOutputTailKiB: 10,
				autocomplete: true,
				grepEnhancement: true,
				readEnhancement: true,
				findEnhancement: true,
				statusUI: true,
			}),
			getBashJobs: () => undefined,
			getArtifacts: () => artifacts,
		} satisfies FffRuntimeState;
		const grepHost = harness();
		registerGrepTool(grepHost.pi, state);
		const grep = grepHost.tools[0];
		if (grep === undefined) throw new Error("grep was not registered");
		const grepResult = await grep.execute(
			"grep-artifact",
			{ pattern: "Needle", path },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);
		expect(grepResult.content).toEqual([
			{ type: "text", text: `${path}\n1│before\n2:Needle\n3│after` },
		]);

		const findHost = harness();
		registerFindTool(findHost.pi, state);
		const find = findHost.tools[0];
		if (find === undefined) throw new Error("find was not registered");
		await expect(
			find.execute("find-artifact", { pattern: "Needle", path }, undefined, undefined, {
				cwd: process.cwd(),
			} as never),
		).rejects.toThrow("find cannot search artifact URLs");
		artifacts.dispose();
	});
});
