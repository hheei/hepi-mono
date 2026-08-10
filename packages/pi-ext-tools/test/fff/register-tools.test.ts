import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOutputRegistry } from "@hheei/pi-ext-core";
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
			getOutputs: () => undefined,
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
		expect(result.details).toMatchObject({
			__piExtToolsCompletion: { durationMs: expect.any(Number) },
		});
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
			getOutputs: () => undefined,
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

	test("allows only FFF fuzzy fallback for canonical grep", async () => {
		const outputs = createOutputRegistry();
		const fuzzyPath = `src/${"nested/".repeat(20)}example.ts`;
		let request: { fuzzyFallbackOnly?: boolean } | undefined;
		const state = {
			getRuntime: () =>
				({
					grepSearch: async (value: { fuzzyFallbackOnly?: boolean }) => {
						request = value;
						return {
							isOk: () => true,
							value: {
								items: [
									{
										relativePath: fuzzyPath,
										lineNumber: 4,
										lineContent: "near needle",
										matchRanges: [[5, 11]],
									},
								],
								linesTruncated: false,
								approximate: "fuzzy",
							},
						};
					},
				}) as never,
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
			getOutputs: () => outputs,
		} satisfies FffRuntimeState;
		const host = harness();
		registerGrepTool(host.pi, state);
		const grep = host.tools[0];
		if (grep === undefined) throw new Error("grep was not registered");

		const result = await grep.execute(
			"grep-no-fuzzy",
			{ pattern: "missing" },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
			} as never,
		);

		expect(request).toEqual(expect.objectContaining({ fuzzyFallbackOnly: true }));
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected grep text result");
		const [summary, path, match] = content.text.split("\n");
		expect(summary).toBe("1 fuzzy matches in 1 files");
		expect(path?.startsWith(".../")).toBe(true);
		expect(Array.from(path ?? "").length).toBeLessThanOrEqual(80);
		expect(match).toBe("4:near needle");
	});

	test("searches output text with grep and rejects it from find", async () => {
		const outputs = createOutputRegistry();
		const path = outputs.create("before\nNeedle\nafter");
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
			getOutputs: () => outputs,
		} satisfies FffRuntimeState;
		const grepHost = harness();
		registerGrepTool(grepHost.pi, state);
		const grep = grepHost.tools[0];
		if (grep === undefined) throw new Error("grep was not registered");
		const grepResult = await grep.execute(
			"grep-output",
			{ pattern: "Needle", path },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);
		expect(grepResult.content).toEqual([
			{ type: "text", text: `1 matches in 1 files\n${path}\n2:Needle` },
		]);

		const longPath = outputs.create(`${"prefix ".repeat(20)}needle${" suffix".repeat(20)}`);
		const longResult = await grep.execute(
			"grep-long-output",
			{ pattern: "needle", path: longPath },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);
		const longDetails = longResult.details as {
			readonly display: readonly {
				readonly type: string;
				readonly text: string;
				readonly truncatedLeft?: boolean;
				readonly truncatedRight?: boolean;
			}[];
		};
		const longMatch = longDetails.display.find((line) => line.type === "match");
		if (longMatch === undefined) throw new Error("Missing long grep match");
		expect(longMatch.text).toContain("needle");
		expect(Array.from(longMatch.text)).toHaveLength(80);
		expect(longMatch.truncatedLeft).toBe(true);
		expect(longMatch.truncatedRight).toBe(true);

		const findHost = harness();
		registerFindTool(findHost.pi, state);
		const find = findHost.tools[0];
		if (find === undefined) throw new Error("find was not registered");
		await expect(
			find.execute("find-output", { pattern: "Needle", path }, undefined, undefined, {
				cwd: process.cwd(),
			} as never),
		).rejects.toThrow("find cannot search output URLs");
	});

	test("maps compact grep omissions to recoverable output lines", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-grep-"));
		const outputs = createOutputRegistry();
		try {
			await writeFile(join(cwd, "many.txt"), Array.from({ length: 26 }, () => "needle").join("\n"));
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
				getOutputs: () => outputs,
			} satisfies FffRuntimeState;
			const host = harness();
			registerGrepTool(host.pi, state);
			const grep = host.tools[0];
			if (grep === undefined) throw new Error("grep was not registered");
			const result = await grep.execute(
				"grep-many",
				{ pattern: "needle", path: "many.txt", limit: 26 },
				undefined,
				undefined,
				{ cwd } as never,
			);
			const details = result.details as {
				readonly display: readonly { readonly text: string }[];
				readonly recovery: { readonly output: string };
			};
			expect(
				details.display.some((line) =>
					/^\+1 matches omitted -> output:\/\/\d+:\d+-\d+$/.test(line.text),
				),
			).toBe(true);
			expect(outputs.read(details.recovery.output)).toContain("26:needle");
		} finally {
			outputs.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
