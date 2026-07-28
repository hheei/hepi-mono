import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
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

		expect(host.tools.map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find_files",
			"fff_multi_grep",
		]);
		expect(host.tools.find((tool) => tool.name === "find_files")?.promptGuidelines).toEqual([
			"Use `find_files` when exploring a topic, looking for a file, or needing paginated ranked candidates before reading.",
		]);
	});

	test("uses FFF path resolution after enabling the feature without reload", async () => {
		const cwd = await temporaryDirectory();
		const target = join(cwd, "target.txt");
		await writeFile(target, "resolved\n", "utf8");
		const host = harness();
		let enabled = false;
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
			isFeatureEnabled: (feature) => feature === "builtInReadEnhancement" && enabled,
			agentToolsDisabledText: () => "disabled",
		});
		const read = host.tools.find((tool) => tool.name === "read")?.execute;
		if (read === undefined) throw new Error("FFF read wrapper was not registered");
		const ctx = { cwd } as ExtensionContext;

		await read("read-before", { path: "target.txt" }, undefined, undefined, ctx);
		enabled = true;
		const result = (await read("read-after", { path: "alias" }, undefined, undefined, ctx)) as {
			readonly content: readonly { readonly type: string; readonly text?: string }[];
		};

		expect(result.content).toContainEqual({ type: "text", text: "resolved\n" });
		expect(tracked).toEqual(["alias"]);
	});
});
