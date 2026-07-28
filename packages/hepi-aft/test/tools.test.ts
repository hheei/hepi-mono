import { describe, expect, test } from "bun:test";
import type { ToolCallResult } from "@cortexkit/aft-bridge";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHoistedTools } from "../src/aft/hoisted.js";
import { aftConfigureOverrides, type HepiAftRuntime } from "../src/aft/runtime.js";
import { registerAftTools } from "../src/aft/tools.js";
import type { PluginContext } from "../src/aft/types.js";

type RegisteredTool = {
	readonly name: string;
	readonly executionMode?: string;
	execute(...args: readonly unknown[]): Promise<unknown>;
};

function createContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
}

function registerHoisted(
	onToolCall: (
		name: string,
		arguments_: Record<string, unknown>,
		options: Record<string, unknown> | undefined,
	) => Promise<Record<string, unknown>>,
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const runtime = {
		getBridge: () => ({
			toolCall: async (
				_sessionId: string | undefined,
				name: string,
				arguments_: Record<string, unknown>,
				options: Record<string, unknown> | undefined,
			) => await onToolCall(name, arguments_, options),
		}),
	} as unknown as HepiAftRuntime;
	const context: PluginContext = {
		getRuntime: () => runtime,
		getReadPathResolver: () =>
			({
				resolvePath: async (path: string) => ({
					absolutePath: `/resolved/${path}`,
					location: undefined,
				}),
			}) as never,
		config: {},
		storageDir: "",
	};
	const pi = {
		registerTool: (tool: unknown) => {
			const registered = tool as RegisteredTool;
			tools.set(registered.name, registered);
		},
	} as unknown as ExtensionAPI;
	registerHoistedTools(pi, context, {
		hoistRead: true,
		hoistWrite: true,
		hoistEdit: true,
		hoistGrep: false,
		hoistApplyPatch: true,
		restrictToProjectRoot: false,
	});
	return tools;
}

function registerTools(runtime: HepiAftRuntime | undefined): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: unknown) => {
			const registered = tool as RegisteredTool;
			tools.set(registered.name, registered);
		},
	} as unknown as ExtensionAPI;
	registerAftTools(pi, () => runtime, { outline: true, zoom: true });
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

	test("defers AFT grep while registering the selected file surface", () => {
		const tools = registerHoisted(async () => ({ success: true, text: "unused" }));
		expect([...tools.keys()]).toEqual(["read", "write", "edit", "apply_patch"]);
	});

	test("maps AFT read and apply_patch preview/apply protocol", async () => {
		const calls: Array<{
			name: string;
			arguments_: Record<string, unknown>;
			options: Record<string, unknown> | undefined;
		}> = [];
		const tools = registerHoisted(async (name, arguments_, options) => {
			calls.push({ name, arguments_, options });
			if (name === "read") return { success: true, text: "1: content" };
			if (options?.preview === true)
				return { success: true, text: "preview", affected_paths: ["README.md"] };
			return { success: true, complete: false, text: "one file applied; one failed" };
		});
		const read = tools.get("read");
		const applyPatch = tools.get("apply_patch");
		if (read === undefined || applyPatch === undefined)
			throw new Error("Expected AFT tools to register");

		await read.execute(
			"read-1",
			{ path: "README.md", offset: 2, limit: 3 },
			undefined,
			undefined,
			createContext(),
		);
		const updates: unknown[] = [];
		await expect(
			applyPatch.execute(
				"patch-1",
				{ patchText: "*** Begin Patch\n*** End Patch" },
				undefined,
				(update: unknown) => updates.push(update),
				createContext(),
			),
		).rejects.toThrow("apply_patch partially completed");

		expect(
			calls.map(({ name, arguments_, options }) => ({
				name,
				arguments_,
				preview: options?.preview,
			})),
		).toEqual([
			{
				name: "read",
				arguments_: { filePath: "/resolved/README.md", offset: 2, limit: 3 },
				preview: undefined,
			},
			{
				name: "apply_patch",
				arguments_: { patchText: "*** Begin Patch\n*** End Patch" },
				preview: true,
			},
			{
				name: "apply_patch",
				arguments_: { patchText: "*** Begin Patch\n*** End Patch" },
				preview: undefined,
			},
		]);
		expect(updates).toEqual([
			{
				content: [{ type: "text", text: "preview" }],
				details: { phase: "preview", paths: ["README.md"], text: "preview" },
			},
		]);
	});

	test("serializes AFT file mutations", () => {
		const tools = registerHoisted(async () => ({ success: true, text: "unused" }));
		expect(tools.get("write")?.executionMode).toBe("sequential");
		expect(tools.get("edit")?.executionMode).toBe("sequential");
		expect(tools.get("apply_patch")?.executionMode).toBe("sequential");
	});
});
