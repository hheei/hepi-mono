import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Result } from "better-result";
import { ExternalGrepScopeError } from "../src/errors.js";
import type { FffRuntime } from "../src/fff.js";
import { registerTools } from "../src/register-tools.js";
import { DEFAULT_FFF_SETTINGS } from "../src/settings.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-fff-tools-"));
	temporaryPaths.push(path);
	return path;
}

interface RegisteredTool {
	readonly name: string;
	readonly promptGuidelines?: readonly string[];
	execute?: (...args: unknown[]) => Promise<unknown>;
	renderCall?: (args: unknown, theme: Theme, context: unknown) => Component;
	renderResult?: (result: unknown, options: unknown, theme: Theme, context: unknown) => Component;
}

function harness(): { readonly pi: ExtensionAPI; readonly tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = [];
	return {
		pi: {
			registerTool(tool: RegisteredTool) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		tools,
	};
}

describe("FFF tool registration", () => {
	test("registers built-in wrappers regardless of their initial feature state", () => {
		const host = harness();
		registerTools(host.pi, {
			getRuntime: () => null,
			getSettings: () => DEFAULT_FFF_SETTINGS,
		});

		expect(host.tools.map((tool) => tool.name)).toEqual(["grep", "find_files", "fff_multi_grep"]);
		expect(host.tools.find((tool) => tool.name === "find_files")?.promptGuidelines).toEqual([
			"Use `find_files` when exploring a topic, looking for a file, or needing paginated ranked candidates before reading.",
		]);
		expect(host.tools.find((tool) => tool.name === "grep")?.promptGuidelines).toEqual([
			"Prefer simple literal patterns over complex regex when possible.",
			"Use path/glob/constraints to narrow scope before trying another grep.",
			"Use outputMode=files_with_matches when content output is too noisy.",
			"After one or two good greps, read the best matching file.",
		]);
	});

	test("falls back to Pi grep for a scope outside the FFF project root", async () => {
		const cwd = await temporaryDirectory();
		const externalRoot = await temporaryDirectory();
		const externalPath = join(externalRoot, "outside.txt");
		await writeFile(externalPath, "outside needle\n", "utf8");
		const host = harness();
		const runtime = {
			async grepSearch() {
				return Result.err(new ExternalGrepScopeError({ path: externalPath, projectRoot: cwd }));
			},
		} as unknown as FffRuntime;
		registerTools(host.pi, {
			getRuntime: () => runtime,
			getSettings: () => DEFAULT_FFF_SETTINGS,
		});
		const grep = host.tools.find((tool) => tool.name === "grep")?.execute;
		if (grep === undefined) throw new Error("FFF grep wrapper was not registered");
		const ctx = { cwd } as ExtensionContext;

		const result = (await grep(
			"grep-external",
			{ pattern: "needle", path: externalPath },
			undefined,
			undefined,
			ctx,
		)) as { readonly content: readonly { readonly type: string; readonly text?: string }[] };

		expect(result.content.some((item) => item.text?.includes("outside needle"))).toBe(true);
	});

	test("passes default and requested grep timeouts to FFF", async () => {
		const cwd = await temporaryDirectory();
		const timeBudgets: number[] = [];
		const runtime = {
			async grepSearch(request: { readonly timeBudgetMs?: number }) {
				if (request.timeBudgetMs !== undefined) timeBudgets.push(request.timeBudgetMs);
				return Result.ok({ items: [], formatted: "No matches found.", linesTruncated: false });
			},
		} as unknown as FffRuntime;
		const host = harness();
		registerTools(host.pi, {
			getRuntime: () => runtime,
			getSettings: () => DEFAULT_FFF_SETTINGS,
		});
		const grep = host.tools.find((tool) => tool.name === "grep")?.execute;
		if (grep === undefined) throw new Error("FFF grep wrapper was not registered");
		const ctx = { cwd } as ExtensionContext;

		await grep("grep-default-timeout", { pattern: "needle" }, undefined, undefined, ctx);
		await grep("grep-custom-timeout", { pattern: "needle", timeout: 7 }, undefined, undefined, ctx);

		expect(timeBudgets).toEqual([30_000, 7_000]);
	});

	test("falls back to Pi find when the FFF runtime is unavailable", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "fallback-target.txt"), "", "utf8");
		const host = harness();
		registerTools(host.pi, {
			getRuntime: () => null,
			getSettings: () => DEFAULT_FFF_SETTINGS,
		});
		const find = host.tools.find((tool) => tool.name === "find_files")?.execute;
		if (find === undefined) throw new Error("FFF find wrapper was not registered");

		const result = (await find(
			"find-fallback",
			{ query: "fallback-target" },
			undefined,
			undefined,
			{ cwd } as ExtensionContext,
		)) as { readonly content: readonly { readonly type: string; readonly text?: string }[] };

		expect(result.content.some((item) => item.text?.includes("fallback-target.txt"))).toBe(true);
	});

	test("renders grouped grep output with aligned dim line numbers", () => {
		const host = harness();
		registerTools(host.pi, {
			getRuntime: () => null,
			getSettings: () => DEFAULT_FFF_SETTINGS,
		});
		const grep = host.tools.find((tool) => tool.name === "grep");
		if (grep?.renderCall === undefined || grep.renderResult === undefined)
			throw new Error("FFF grep renderer was not registered");
		const roles: string[] = [];
		const theme = {
			fg: (role: string, text: string) => {
				roles.push(role);
				return text;
			},
			bold: (text: string) => text,
		} as unknown as Theme;
		const call = grep.renderCall({ pattern: "aft_move", path: "/tmp/aft", limit: 50 }, theme, {
			lastComponent: undefined,
		});
		const result = grep.renderResult(
			{
				content: [
					{
						type: "text",
						text: "39 matches in 13 files:\n\n> bun.lock (15 matches):\n... (224 more lines, ctrl+o to expand)\n    9: first\n  123: second\n\n",
					},
				],
			},
			{},
			theme,
			{ isError: false, lastComponent: undefined },
		);

		const renderText = (component: Component): string =>
			component
				.render(120)
				.map((line) => line.trimEnd())
				.join("\n");
		expect(renderText(call)).toBe("grep `/aft_move/` in /tmp/aft (limit 50)");
		expect(renderText(result)).toBe(
			"\n39 matches in 13 files:\n\nbun.lock (15 matches)\n... (224 earlier lines, ^o to expand)\n  9:  first\n123:  second",
		);
		const noMatches = grep.renderResult(
			{ content: [{ type: "text", text: 'No files matched "references/repos/pi"' }] },
			{},
			theme,
			{ isError: false, lastComponent: undefined },
		);
		expect(renderText(noMatches)).toBe('\nNo files matched "references/repos/pi"');
		const narrowCall = grep.renderCall(
			{
				pattern: "aft_move",
				path: "/tmp/pi-github-repos/cortexkit/aft@main/packages/pi-plugin",
				limit: 50,
			},
			theme,
			{ lastComponent: undefined },
		);
		expect(narrowCall.render(40).every((line) => line.length <= 40)).toBe(true);
		expect(result.render(40).every((line) => line.length <= 40)).toBe(true);
		expect(roles.filter((role) => role === "success")).toHaveLength(3);
		expect(roles).toContain("accent");
		expect(roles).toContain("dim");
		expect(roles).toContain("toolOutput");
		expect(roles).toContain("warning");
	});

	test("renders find queries and file-match tags", () => {
		const host = harness();
		registerTools(host.pi, {
			getRuntime: () => null,
			getSettings: () => DEFAULT_FFF_SETTINGS,
		});
		const find = host.tools.find((tool) => tool.name === "find_files");
		if (find?.renderCall === undefined || find.renderResult === undefined)
			throw new Error("FFF find renderer was not registered");
		const roles: string[] = [];
		const theme = {
			fg: (role: string, text: string) => {
				roles.push(role);
				return text;
			},
			bold: (text: string) => text,
		} as unknown as Theme;
		const call = find.renderCall({ query: "tools", limit: 30 }, theme, {
			lastComponent: undefined,
		});
		const result = find.renderResult(
			{
				content: [
					{
						type: "text",
						text: "2/527 matches\n1. packages/a.ts (fuzzy_filename) - frequent git:modified\n2. packages/b.ts (fuzzy_path) - frequent\ncursor: find:next-page",
					},
				],
				details: { totalMatched: 527 },
			},
			{},
			theme,
			{ isError: false, lastComponent: undefined },
		);

		const renderText = (component: Component): string =>
			component
				.render(120)
				.map((line) => line.trimEnd())
				.join("\n");
		expect(renderText(call)).toBe("find tools (limit 30)");
		expect(renderText(result)).toBe(
			"2 matches in 527 files:\nFF packages/a.ts (frequent git:modified)\nFP packages/b.ts (frequent)",
		);
		expect(roles.filter((role) => role === "success")).toHaveLength(2);
		expect(roles).toContain("accent");
		expect(roles).toContain("dim");
	});
});
