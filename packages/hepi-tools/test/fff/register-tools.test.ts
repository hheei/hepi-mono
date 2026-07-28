import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Result } from "better-result";
import { ExternalGrepScopeError } from "../../src/fff/errors.js";
import type { FffRuntime } from "../../src/fff/fff.js";
import { registerTools } from "../../src/fff/register-tools.js";

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
			isFeatureEnabled: () => false,
			agentToolsDisabledText: () => "disabled",
		});

		expect(host.tools.map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find_files",
			"fff_multi_grep",
		]);
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

	test("delegates read to Pi when the FFF enhancement is disabled", async () => {
		const cwd = await temporaryDirectory();
		const target = join(cwd, "target.txt");
		await writeFile(target, "resolved\n", "utf8");
		const host = harness();
		const tracked: string[] = [];
		const runtime = {
			async resolvePath() {
				return Result.ok({ absolutePath: target });
			},
			async trackQuery(query: string) {
				tracked.push(query);
				return Result.ok(undefined);
			},
		} as unknown as FffRuntime;
		registerTools(host.pi, {
			getRuntime: () => runtime,
			isFeatureEnabled: () => false,
			agentToolsDisabledText: () => "disabled",
		});
		const read = host.tools.find((tool) => tool.name === "read")?.execute;
		if (read === undefined) throw new Error("FFF read wrapper was not registered");
		const ctx = { cwd } as ExtensionContext;

		const result = (await read("read", { path: "target.txt" }, undefined, undefined, ctx)) as {
			readonly content: readonly { readonly type: string; readonly text?: string }[];
		};

		expect(result.content).toContainEqual({ type: "text", text: "resolved\n" });
		expect(tracked).toEqual([]);
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
			isFeatureEnabled: (feature) => feature === "builtInGrepEnhancement",
			agentToolsDisabledText: () => "disabled",
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

	test("renders grouped grep output with aligned dim line numbers", () => {
		const host = harness();
		registerTools(host.pi, {
			getRuntime: () => null,
			isFeatureEnabled: () => false,
			agentToolsDisabledText: () => "disabled",
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
			"\n39 matches in 13 files:\n\nbun.lock (15 matches)\n... (224 earlier lines, ^o to expand)\n    9:  first\n  123:  second",
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
			isFeatureEnabled: () => false,
			agentToolsDisabledText: () => "disabled",
		});
		const find = host.tools.find((tool) => tool.name === "find");
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
						text: "2/527 matches\n1. packages/a.ts (fuzzy_filename) - frequent git:modified\n2. packages/b.ts (fuzzy_path)",
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
			"2 matches in 527 files:\nFF packages/a.ts (frequent git:modified)\nFP packages/b.ts (fuzzy_path)",
		);
		expect(roles.filter((role) => role === "success")).toHaveLength(2);
		expect(roles).toContain("accent");
		expect(roles).toContain("dim");
	});
});
