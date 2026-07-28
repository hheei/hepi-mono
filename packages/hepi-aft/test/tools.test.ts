import { describe, expect, test } from "bun:test";
import type { ToolCallResult } from "@cortexkit/aft-bridge";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aftConfigureOverrides, type HepiAftRuntime } from "../src/aft/runtime.js";
import { registerAftTools } from "../src/aft/tools.js";

type RegisteredTool = {
	readonly name: string;
	execute(...args: readonly unknown[]): Promise<unknown>;
};

function createContext(): ExtensionContext {
	return {
		cwd: "/project",
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
}

function registerTools(runtime: HepiAftRuntime | undefined): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: unknown) => {
			const registered = tool as RegisteredTool;
			tools.set(registered.name, registered);
		},
	} as unknown as ExtensionAPI;
	registerAftTools(pi, () => runtime);
	return tools;
}

function response(text: string): ToolCallResult {
	return { success: true, text };
}

describe("AFT tools", () => {
	test("configures the standalone bridge for the Pi harness", () => {
		expect(aftConfigureOverrides()).toMatchObject({ harness: "pi" });
	});

	test("registers only the non-conflicting reading tools", () => {
		const tools = registerTools(undefined);
		expect([...tools.keys()]).toEqual(["aft_outline", "aft_zoom"]);
	});

	test("forwards outline options through the AFT tool-call protocol", async () => {
		const calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
		const runtime = {
			toolCall: async (
				_ctx: ExtensionContext,
				name: string,
				arguments_: Record<string, unknown>,
			) => {
				calls.push({ name, arguments_ });
				return response("outline result");
			},
		} as unknown as HepiAftRuntime;
		const outline = registerTools(runtime).get("aft_outline");
		if (outline === undefined) throw new Error("Expected aft_outline to register");

		const result = await outline.execute(
			"call-1",
			{ target: ["src", "README.md"], files: true, includeTests: false },
			AbortSignal.abort(),
			() => {},
			createContext(),
		);

		expect(calls).toEqual([
			{
				name: "outline",
				arguments_: { target: ["src", "README.md"], files: true, includeTests: false },
			},
		]);
		expect(result).toEqual({
			content: [{ type: "text", text: "outline result" }],
			details: response("outline result"),
		});
	});

	test("maps cross-file zoom targets to AFT filePath arguments", async () => {
		const calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
		const runtime = {
			toolCall: async (
				_ctx: ExtensionContext,
				name: string,
				arguments_: Record<string, unknown>,
			) => {
				calls.push({ name, arguments_ });
				return response("zoom result");
			},
		} as unknown as HepiAftRuntime;
		const zoom = registerTools(runtime).get("aft_zoom");
		if (zoom === undefined) throw new Error("Expected aft_zoom to register");

		await zoom.execute(
			"call-2",
			{
				targets: [
					{ path: "src/one.ts", symbol: "one" },
					{ path: "src/two.ts", symbol: "two" },
				],
				contextLines: 4,
				callgraph: true,
			},
			AbortSignal.abort(),
			() => {},
			createContext(),
		);

		expect(calls).toEqual([
			{
				name: "zoom",
				arguments_: {
					targets: [
						{ filePath: "src/one.ts", symbol: "one" },
						{ filePath: "src/two.ts", symbol: "two" },
					],
					contextLines: 4,
					callgraph: true,
				},
			},
		]);
	});

	test("rejects conflicting zoom modes before making a bridge call", async () => {
		const runtime = {
			toolCall: async () => response("unexpected"),
		} as unknown as HepiAftRuntime;
		const zoom = registerTools(runtime).get("aft_zoom");
		if (zoom === undefined) throw new Error("Expected aft_zoom to register");

		await expect(
			zoom.execute(
				"call-3",
				{ path: "src/one.ts", symbols: "one", targets: { path: "src/two.ts", symbol: "two" } },
				AbortSignal.abort(),
				() => {},
				createContext(),
			),
		).rejects.toThrow("'targets' is mutually exclusive");
	});

	test("reports unavailable runtime without dispatching", async () => {
		const outline = registerTools(undefined).get("aft_outline");
		if (outline === undefined) throw new Error("Expected aft_outline to register");

		await expect(
			outline.execute("call-4", { target: "src" }, AbortSignal.abort(), () => {}, createContext()),
		).rejects.toThrow("AFT is unavailable");
	});
});
