import { describe, expect, test } from "bun:test";
import type { ToolCallResult } from "@cortexkit/aft-bridge";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { registerBashTool } from "../src/aft/bash.js";
import { registerHoistedTools } from "../src/aft/hoisted.js";
import { aftConfigureOverrides, type HepiAftRuntime } from "../src/aft/runtime.js";
import { registerAftTools } from "../src/aft/tools.js";
import type { PluginContext } from "../src/aft/types.js";

type RegisteredTool = {
	readonly name: string;
	readonly executionMode?: string;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => Component;
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

	test("ignores empty fields injected for another zoom mode", async () => {
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
			"call-3",
			{
				path: "src/one.ts",
				url: "",
				symbols: "one",
				targets: { path: "", symbol: "" },
				contextLines: 2,
				callgraph: false,
			},
			AbortSignal.abort(),
			() => {},
			createContext(),
		);

		expect(calls).toEqual([
			{
				name: "zoom",
				arguments_: { filePath: "src/one.ts", symbols: "one", contextLines: 2 },
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
				"call-4",
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
			outline.execute("call-5", { target: "src" }, AbortSignal.abort(), () => {}, createContext()),
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
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			content: [{ type: "text", text: "preview" }],
			details: {
				phase: "preview",
				paths: ["README.md"],
				text: "preview",
				timing: { previewMs: expect.any(Number), permissionsMs: expect.any(Number) },
			},
		});
	});

	test("renders AFT read paths dim with the original warning line range", () => {
		const read = registerHoisted(async () => ({ success: true, text: "unused" })).get("read");
		if (read?.renderCall === undefined) throw new Error("Expected AFT read renderer");
		const roles: string[] = [];
		const component = read.renderCall(
			{ path: "src/example.ts", offset: 10, limit: 20 },
			{
				fg: (role: string, text: string) => {
					roles.push(role);
					return text;
				},
				bold: (text: string) => text,
			},
			{ lastComponent: undefined },
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("read src/example.ts:10-29");
		expect(roles).toContain("dim");
		expect(roles).toContain("warning");
		expect(roles).not.toContain("accent");
	});

	test("renders Bash commands in accent with a dim inline timeout", () => {
		const tools = new Map<string, RegisteredTool>();
		const pi = {
			registerTool(tool: unknown) {
				const registered = tool as RegisteredTool;
				tools.set(registered.name, registered);
			},
		} as unknown as ExtensionAPI;
		registerBashTool(pi, {
			getRuntime: () => ({}) as HepiAftRuntime,
			getReadPathResolver: () => ({}) as never,
			config: {},
			storageDir: "",
		});
		const bash = tools.get("bash");
		if (bash?.renderCall === undefined) throw new Error("Expected Bash renderer");
		const roles: string[] = [];
		const component = bash.renderCall(
			{ command: "bun test", timeout: 10_000 },
			{
				fg: (role: string, text: string) => {
					roles.push(role);
					return text;
				},
				bold: (text: string) => text,
			},
			{ lastComponent: undefined },
		);

		expect(
			component
				.render(120)
				.map((line) => line.trimEnd())
				.join("\n"),
		).toBe("$ bun test (timeout 10.0s)");
		expect(roles).toEqual(["accent", "dim"]);
	});

	test("serializes AFT file mutations", () => {
		const tools = registerHoisted(async () => ({ success: true, text: "unused" }));
		expect(tools.get("write")?.executionMode).toBe("sequential");
		expect(tools.get("edit")?.executionMode).toBe("sequential");
		expect(tools.get("apply_patch")?.executionMode).toBe("sequential");
	});
});
