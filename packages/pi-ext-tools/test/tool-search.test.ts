import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { createToolSearchToolDefinition } from "../src/tool-search.js";

function toolInfo(
	name: string,
	description: string,
	exposure: ToolInfo["exposure"],
	parameterDescription = "",
): ToolInfo {
	return {
		name,
		description,
		parameters: Type.Object({ path: Type.String({ description: parameterDescription }) }),
		exposure,
		sourceInfo: {
			path: "/repo/test-extension",
			source: "test-extension",
			scope: "project",
			origin: "package",
		},
	};
}

function harness(catalog: ToolInfo[], initial: string[] = []) {
	let active = initial;
	const updates: string[][] = [];
	const api = {
		getAllTools: () => catalog,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
			updates.push(names);
		},
	} as unknown as Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
	const tool = createToolSearchToolDefinition(api);
	return {
		active: () => active,
		updates,
		search: (query: string) =>
			tool.execute("call", { query }, new AbortController().signal, () => undefined, {} as never),
	};
}

describe("tool_search", () => {
	test("loads matching deferred tools and preserves the active set", async () => {
		const host = harness(
			[
				toolInfo("bg_bash_spawn", "Start a long-running background shell command", "deferred"),
				toolInfo("agent_spawn", "Start an independent child agent", "deferred"),
				toolInfo("read", "Read a file", "direct"),
			],
			["read", "tool_search"],
		);

		const result = await host.search("run a shell command in background");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Loaded for next call:\n- bg_bash_spawn:"),
		});
		expect(result.details).toEqual({ loaded: ["bg_bash_spawn"], alreadyAvailable: [] });
		expect(host.active()).toEqual(["read", "tool_search", "bg_bash_spawn"]);
	});

	test("reports matching tools that are already available without changing activation", async () => {
		const host = harness(
			[
				toolInfo("bg_bash_spawn", "Start a background shell command", "deferred"),
				toolInfo("bg_bash_get", "Get a background shell command status", "deferred"),
			],
			["bg_bash_spawn", "bg_bash_get"],
		);

		const result = await host.search("background shell");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(
				/^loaded: (?:bg_bash_spawn, bg_bash_get|bg_bash_get, bg_bash_spawn)$/,
			),
		});
		expect(result.details).toEqual({
			loaded: [],
			alreadyAvailable: ["bg_bash_spawn", "bg_bash_get"],
		});
		expect(host.updates).toEqual([]);
	});

	test("does not search parameter schemas or non-searchable tools", async () => {
		const host = harness([
			toolInfo("read", "Read a file", "direct", "Filesystem path to inspect"),
			toolInfo("custom_action", "Perform a custom action", "hidden", "Filesystem path to inspect"),
		]);

		const result = await host.search("filesystem path to inspect");
		expect(result.content[0]).toMatchObject({ type: "text", text: "No matching tools found." });
		expect(host.updates).toEqual([]);
	});

	test("refuses explicit tool-definition lookup without activating matches", async () => {
		const host = harness([
			toolInfo("bg_bash_spawn", "Start a background shell command", "deferred"),
		]);

		const result = await host.search("show me the definition of bg_bash_spawn");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("does not look up tool definitions"),
		});
		expect(result.details).toEqual({ loaded: [], alreadyAvailable: [] });
		expect(host.updates).toEqual([]);
	});

	test("rejects empty queries and invalid limits before changing tools", async () => {
		const host = harness([
			toolInfo("bg_bash_spawn", "Start a background shell command", "deferred"),
		]);
		const tool = createToolSearchToolDefinition({
			getAllTools: () => [
				toolInfo("bg_bash_spawn", "Start a background shell command", "deferred"),
			],
			getActiveTools: () => [],
			setActiveTools: (names) => host.updates.push(names),
		});
		const execute = (query: string, limit?: number) =>
			tool.execute(
				"call",
				{ query, ...(limit === undefined ? {} : { limit }) },
				new AbortController().signal,
				() => undefined,
				{} as never,
			);

		await expect(host.search("   ")).rejects.toThrow("query must not be empty");
		await expect(execute("background shell", 0)).rejects.toThrow(
			"limit must be a positive integer",
		);
		expect(host.updates).toEqual([]);
	});
});
