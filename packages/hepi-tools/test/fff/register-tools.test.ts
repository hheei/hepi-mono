import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

		expect(host.tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "fff_multi_grep"]);
		expect(host.tools.find((tool) => tool.name === "find")?.promptGuidelines).toEqual([
			"Use `find` when exploring a topic, looking for a file, or needing paginated ranked candidates before reading.",
		]);
		expect(host.tools.find((tool) => tool.name === "grep")?.promptGuidelines).toEqual([
			"Prefer simple literal patterns over complex regex when possible.",
			"Use path/glob/constraints to narrow scope before trying another grep.",
			"Use outputMode=files_with_matches when content output is too noisy.",
			"After one or two good greps, read the best matching file.",
		]);
	});

	test("omits read when AFT owns the read slot", () => {
		const host = harness();
		registerTools(
			host.pi,
			{
				getRuntime: () => null,
				isFeatureEnabled: () => false,
				agentToolsDisabledText: () => "disabled",
			},
			{ registerRead: false },
		);

		expect(host.tools.map((tool) => tool.name)).toEqual(["grep", "find", "fff_multi_grep"]);
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
});
