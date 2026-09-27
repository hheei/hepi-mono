import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { inferFffGrepMode } from "../../src/fff/extension-common.js";
import { FffRuntime } from "../../src/fff/fff.js";
import { createFffRuntimeState, type FffRuntimeState } from "../../src/fff/lifecycle.js";
import { registerMultiGrepTool } from "../../src/fff/multi-grep.js";
import { DEFAULT_FFF_SETTINGS } from "../../src/fff/settings.js";
import { registerFindTool } from "../../src/find.js";
import { registerGrepTool } from "../../src/grep.js";
import { GREP_TIMEOUT_RECOVERY } from "../../src/search-timeout.js";
import { RemoteGrepAccessDeniedError, type TargetRuntime } from "../../src/targets.js";
import { toolFor, toolHost } from "../fixtures/harness.js";

/** The fff collaborators none of these tests reach. */
const noRuntimeStubs = {
	getTasks: (): undefined => undefined,
	getBashJobs: (): undefined => undefined,
	getTargetRuntime: (): undefined => undefined,
};

describe("FFF tool registration", () => {
	test("preserves Pi grep literal and regex mode semantics", () => {
		expect(inferFffGrepMode()).toBe("regex");
		expect(inferFffGrepMode(false)).toBe("regex");
		expect(inferFffGrepMode(true)).toBe("plain");
		expect(inferFffGrepMode(undefined, "catch (error")).toBe("plain");
		expect(inferFffGrepMode(undefined, "catch \\(error\\)")).toBe("regex");
	});

	test("does not register retired find_files name", () => {
		const host = toolHost();
		registerMultiGrepTool(host.pi, createFffRuntimeState());
		expect(host.tools.map((tool) => tool.name)).toEqual(["fff_multi_grep"]);
		expect(host.tools.some((tool) => tool.name === "find_files")).toBe(false);
	});

	test("reports canonical unavailable text when FFF runtime is unavailable", async () => {
		const host = toolHost();
		registerMultiGrepTool(host.pi, createFffRuntimeState());
		const tool = toolFor(host.tools, "fff_multi_grep");
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
			const host = toolHost();
			registerFindTool(host.pi, createFffRuntimeState());
			expect(host.tools.map((tool) => tool.name)).toEqual(["find"]);
			const find = toolFor(host.tools, "find");
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

	test("joins remote find pages with real newlines and records target details", async () => {
		const host = toolHost();
		const state = {
			...noRuntimeStubs,
			getRuntime: () => undefined,
			getSettings: () => ({
				...DEFAULT_FFF_SETTINGS,
				shellPath: "sh",
				grepEnhancement: false,
				readEnhancement: false,
				findEnhancement: false,
			}),
			getTargetRuntime: () =>
				({
					find: async () => [
						{ path: "a.ts", matchType: "path", score: 2 },
						{ path: "b.ts", matchType: "fuzzy", score: 1 },
					],
				}) as unknown as TargetRuntime,
		} satisfies FffRuntimeState;
		registerFindTool(host.pi, state);
		const find = toolFor(host.tools, "find");
		const result = await find.execute(
			"find-remote-newlines",
			{ pattern: "ts", target: "devbox" },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected find text result");
		expect(content.text).toContain("a.ts");
		expect(content.text).toContain("b.ts");
		expect(content.text).not.toContain("\\n");
		expect(content.text.split("\n").length).toBeGreaterThan(1);
		expect((result.details as { target?: string; outcome?: string }).target).toBe("devbox");
		expect((result.details as { outcome?: string }).outcome).toBe("ok");
	});

	test("uses FFF for unscoped non-glob find queries when enabled", async () => {
		const host = toolHost();
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
			...noRuntimeStubs,
			getRuntime: () => runtime,
			getSettings: () => ({ ...DEFAULT_FFF_SETTINGS, shellPath: "sh" }),
		} satisfies FffRuntimeState;
		registerFindTool(host.pi, state);
		const find = toolFor(host.tools, "find");

		const result = await find.execute(
			"find-fff",
			{ pattern: "find enhancement", limit: 1 },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);

		const text = result.content[0];
		if (text?.type !== "text") throw new Error("Expected text result");
		expect(text.text).toBe("fuzzy files:\nsrc/find-enhancement.ts\ncursor: find:1");
		expect(text.text).toContain("cursor: find:");
		expect(result.details).toMatchObject({
			format: "canonical-find",
			candidates: [{ path: "src/find-enhancement.ts", matchType: "fuzzy" }],
			totalMatched: 2,
			totalFiles: 2,
			__piExtToolsCompletion: { durationMs: expect.any(Number) },
		});
	});

	test("treats an empty cursor as a new FFF search", async () => {
		const host = toolHost();
		const runtime = new FffRuntime(process.cwd(), {
			finder: {
				fileSearch: () => ({
					ok: true as const,
					value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
				}),
			} as never,
		});
		const state = {
			...noRuntimeStubs,
			getRuntime: () => runtime,
			getSettings: () => ({ ...DEFAULT_FFF_SETTINGS, shellPath: "sh" }),
		} satisfies FffRuntimeState;
		registerFindTool(host.pi, state);
		const find = toolFor(host.tools, "find");

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
		const fuzzyPath = `src/${"nested/".repeat(20)}example.ts`;
		let request: { fuzzyFallbackOnly?: boolean } | undefined;
		const state = {
			...noRuntimeStubs,
			getRuntime: () =>
				({
					grepSearch: async (value: { fuzzyFallbackOnly?: boolean }) => {
						request = value;
						return {
							ok: true,
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
			getSettings: () => ({ ...DEFAULT_FFF_SETTINGS, shellPath: "sh" }),
		} satisfies FffRuntimeState;
		const host = toolHost();
		registerGrepTool(host.pi, state);
		const grep = toolFor(host.tools, "grep");

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
		expect(path?.startsWith("…/")).toBe(true);
		expect(Array.from(path ?? "").length).toBeLessThanOrEqual(80);
		expect(match).toBe("4:near needle");
	});

	test("treats an empty grep path as the current directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-grep-empty-path-"));
		try {
			await writeFile(join(cwd, "needle.ts"), "const needle = true;\n");
			const state = {
				...noRuntimeStubs,
				getRuntime: () => undefined,
				getSettings: () => ({ ...DEFAULT_FFF_SETTINGS, shellPath: "sh" }),
			} satisfies FffRuntimeState;
			const host = toolHost();
			registerGrepTool(host.pi, state);
			const grep = toolFor(host.tools, "grep");
			const result = await grep.execute(
				"grep-empty-path",
				{ pattern: "needle", path: "" },
				undefined,
				undefined,
				{ cwd } as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("Expected grep text result");
			expect(content.text).toContain("1 matches in 1 files");
			expect(content.text).toContain("needle.ts");
			expect(content.text).not.toContain(`${cwd}/`);
			expect(content.text).toContain("1:const needle = true;");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("hints when ripgrep rejects an over-escaped brace", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-grep-regex-hint-"));
		try {
			await writeFile(join(cwd, "needle.ts"), "properties: { patch\n");
			const state = {
				...noRuntimeStubs,
				getRuntime: () => undefined,
				getSettings: () => ({
					...DEFAULT_FFF_SETTINGS,
					shellPath: "sh",
					grepEnhancement: false,
					readEnhancement: true,
					findEnhancement: true,
				}),
			} satisfies FffRuntimeState;
			const host = toolHost();
			registerGrepTool(host.pi, state);
			const grep = toolFor(host.tools, "grep");
			await expect(
				grep.execute(
					"grep-over-escaped",
					{ pattern: "properties: \\\\{ patch", path: "needle.ts" },
					undefined,
					undefined,
					{ cwd } as never,
				),
			).rejects.toThrow(/regex parse error[\s\S]*decoded pattern needs exactly one backslash/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("shows grep hits relative to the search path and omits a single-file heading", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-grep-rel-"));
		try {
			await mkdir(join(cwd, "src"));
			await writeFile(join(cwd, "src/a.ts"), "needle\n");
			await writeFile(join(cwd, "src/b.ts"), "needle\n");
			const state = {
				...noRuntimeStubs,
				getRuntime: () => undefined,
				getSettings: () => ({ ...DEFAULT_FFF_SETTINGS, shellPath: "sh" }),
			} satisfies FffRuntimeState;
			const host = toolHost();
			registerGrepTool(host.pi, state);
			const grep = toolFor(host.tools, "grep");
			const dirResult = await grep.execute(
				"grep-dir",
				{ pattern: "needle", path: join(cwd, "src") },
				undefined,
				undefined,
				{ cwd } as never,
			);
			const dirText = dirResult.content[0];
			if (dirText?.type !== "text") throw new Error("Expected grep text result");
			expect(dirText.text).toContain("a.ts");
			expect(dirText.text).toContain("b.ts");
			expect(dirText.text).not.toContain(cwd);
			const fileResult = await grep.execute(
				"grep-file",
				{ pattern: "needle", path: join(cwd, "src/a.ts") },
				undefined,
				undefined,
				{ cwd } as never,
			);
			const fileDetails = fileResult.details as {
				readonly display: readonly { readonly type: string; readonly text: string }[];
			};
			expect(fileDetails.display.some((line) => line.type === "path")).toBe(false);
			const fileText = fileResult.content[0];
			if (fileText?.type !== "text") throw new Error("Expected grep text result");
			expect(fileText.text).toContain("1:needle");
			expect(fileText.text).not.toContain("a.ts\n");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("preserves readable grep matches and records inaccessible paths", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-grep-permission-"));
		const blocked = join(cwd, "blocked");
		try {
			await writeFile(join(cwd, "visible.txt"), "needle\n", "utf8");
			await mkdir(blocked);
			await writeFile(join(blocked, "secret.txt"), "needle\n", "utf8");
			await chmod(blocked, 0o000);
			const state = {
				...noRuntimeStubs,
				getRuntime: () => undefined,
				getSettings: () => ({
					...DEFAULT_FFF_SETTINGS,
					shellPath: "sh",
					grepEnhancement: false,
					readEnhancement: true,
					findEnhancement: true,
				}),
			} satisfies FffRuntimeState;
			const host = toolHost();
			registerGrepTool(host.pi, state);
			const grep = toolFor(host.tools, "grep");
			const result = await grep.execute(
				"grep-inaccessible",
				{ pattern: "needle", path: cwd },
				undefined,
				undefined,
				{ cwd } as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("Expected grep text result");
			expect(content.text).toContain("visible.txt");
			expect(content.text).toContain("Results may be incomplete");
			expect(content.text).not.toContain("No matches found");
			expect(result.details).toMatchObject({
				incomplete: {
					reason: "access_denied",
					noSearchablePaths: false,
					diagnostics: [expect.stringContaining("Permission denied")],
				},
			});
		} finally {
			await chmod(blocked, 0o700).catch(() => undefined);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("preserves remote grep matches after an access-denied diagnostic", async () => {
		try {
			const stdout = [
				'{"type":"match","data":{"path":{"text":"visible.txt"},"lines":{"text":"needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}',
				'{"type":"summary","data":{"stats":{"searches":1}}}',
			].join("\n");
			const state = {
				...noRuntimeStubs,
				getRuntime: () => undefined,
				getSettings: () => ({
					...DEFAULT_FFF_SETTINGS,
					shellPath: "sh",
					grepEnhancement: false,
					readEnhancement: true,
					findEnhancement: true,
				}),
				getTargetRuntime: () =>
					({
						validateRemotePath: () => undefined,
						grep: async () => {
							throw new RemoteGrepAccessDeniedError(stdout, [
								"rg: /root: Permission denied (os error 13)",
							]);
						},
					}) as unknown as TargetRuntime,
			} satisfies FffRuntimeState;
			const host = toolHost();
			registerGrepTool(host.pi, state);
			const grep = toolFor(host.tools, "grep");
			const result = await grep.execute(
				"grep-remote-inaccessible",
				{ pattern: "needle", path: ".", target: "ileqm" },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("Expected grep text result");
			expect(content.text).toContain("visible.txt");
			expect(content.text).toContain("Results may be incomplete");
			expect(result.details).toMatchObject({
				target: "ileqm",
				incomplete: {
					reason: "access_denied",
					noSearchablePaths: false,
				},
			});
		} finally {
		}
	});

	test("returns a typed error when grep cannot search any requested path", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-grep-inaccessible-"));
		const blocked = join(cwd, "blocked");
		try {
			await mkdir(blocked);
			await writeFile(join(blocked, "secret.txt"), "needle\n", "utf8");
			await chmod(blocked, 0o000);
			const state = {
				...noRuntimeStubs,
				getRuntime: () => undefined,
				getSettings: () => ({
					...DEFAULT_FFF_SETTINGS,
					shellPath: "sh",
					grepEnhancement: false,
					readEnhancement: true,
					findEnhancement: true,
				}),
			} satisfies FffRuntimeState;
			const host = toolHost();
			registerGrepTool(host.pi, state);
			const grep = toolFor(host.tools, "grep");
			const result = await grep.execute(
				"grep-only-inaccessible",
				{ pattern: "needle", path: blocked },
				undefined,
				undefined,
				{ cwd } as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("Expected grep text result");
			expect(content.text).toContain("could not inspect any files");
			expect(content.text).not.toContain("No matches found");
			expect(result.details).toMatchObject({
				incomplete: {
					reason: "access_denied",
					noSearchablePaths: true,
					diagnostics: [expect.stringContaining("Permission denied")],
				},
			});
		} finally {
			await chmod(blocked, 0o700).catch(() => undefined);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("surfaces a grep timeout as a narrow-scope recovery", async () => {
		const state = {
			...noRuntimeStubs,
			getRuntime: () =>
				({
					grepSearch: async () => ({
						ok: true,
						value: {
							items: [],
							linesTruncated: false,
							timedOut: true,
						},
					}),
				}) as never,
			getSettings: () => ({ ...DEFAULT_FFF_SETTINGS, shellPath: "sh" }),
		} satisfies FffRuntimeState;
		const host = toolHost();
		registerGrepTool(host.pi, state);
		const grep = toolFor(host.tools, "grep");
		const result = await grep.execute("grep-timeout", { pattern: "needle" }, undefined, undefined, {
			cwd: process.cwd(),
		} as never);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected grep text result");
		expect(content.text).toBe(GREP_TIMEOUT_RECOVERY);
		expect((result.details as { timedOut?: boolean }).timedOut).toBe(true);
	});
});
