import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerImportTools } from "../src/aft/imports.js";
import { registerInspectTool } from "../src/aft/inspect.js";
import { registerNavigateTool } from "../src/aft/navigate.js";
import { registerRefactorTool } from "../src/aft/refactor.js";
import type { HepiAftRuntime } from "../src/aft/runtime.js";
import type { PluginContext } from "../src/aft/types.js";

type RegisteredTool = {
	readonly name: string;
	readonly executionMode?: string;
	execute(...args: readonly unknown[]): Promise<unknown>;
};

function context(): ExtensionContext {
	return {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "structural-test" },
	} as unknown as ExtensionContext;
}

function registerTools(
	responseFor: (name: string) => Record<string, unknown> = (name) => ({
		success: true,
		text: `${name} complete`,
		summary: {},
	}),
): {
	readonly tools: Map<string, RegisteredTool>;
	readonly calls: Array<{ readonly name: string; readonly arguments_: Record<string, unknown> }>;
} {
	const calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
	const bridge = {
		toolCall: async (
			_sessionId: string | undefined,
			name: string,
			arguments_: Record<string, unknown>,
		) => {
			calls.push({ name, arguments_ });
			return responseFor(name);
		},
		send: async () => ({ success: true }),
	};
	const runtime = { getBridge: () => bridge } as unknown as HepiAftRuntime;
	const pluginContext: PluginContext = {
		getRuntime: () => runtime,
		getReadPathResolver: () => ({}) as never,
		config: {},
		storageDir: "",
	};
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: unknown) => {
			const registered = tool as RegisteredTool;
			tools.set(registered.name, registered);
		},
	} as unknown as ExtensionAPI;
	registerNavigateTool(pi, pluginContext);
	registerRefactorTool(pi, pluginContext);
	registerImportTools(pi, pluginContext);
	registerInspectTool(pi, pluginContext);
	return { tools, calls };
}

async function execute(
	tool: RegisteredTool | undefined,
	params: Record<string, unknown>,
): Promise<void> {
	if (tool === undefined) throw new Error("Expected structural tool to register");
	await tool.execute("call-1", params, AbortSignal.abort(), () => {}, context());
}

describe("AFT structural tools", () => {
	test("registers and forwards the upstream bridge contracts", async () => {
		const { tools, calls } = registerTools();
		expect([...tools.keys()]).toEqual([
			"aft_callgraph",
			"aft_refactor",
			"aft_import",
			"aft_inspect",
		]);

		await execute(tools.get("aft_callgraph"), {
			op: "impact",
			path: "src/app.ts",
			symbol: "run",
			depth: 2,
		});
		await execute(tools.get("aft_refactor"), {
			op: "extract",
			path: "src/app.ts",
			name: "compute",
			startLine: 10,
			endLine: 12,
		});
		await execute(tools.get("aft_import"), {
			op: "add",
			path: "src/app.ts",
			module: "react",
			names: ["useMemo"],
		});
		await execute(tools.get("aft_inspect"), { sections: "todos", topK: 3 });

		expect(calls).toEqual([
			{
				name: "callgraph",
				arguments_: { op: "impact", filePath: "src/app.ts", symbol: "run", depth: 2 },
			},
			{
				name: "refactor",
				arguments_: {
					op: "extract",
					filePath: "src/app.ts",
					name: "compute",
					startLine: 10,
					endLine: 12,
				},
			},
			{
				name: "import",
				arguments_: {
					op: "add",
					filePath: "src/app.ts",
					module: "react",
					names: ["useMemo"],
				},
			},
			{ name: "inspect", arguments_: { sections: "todos", topK: 3 } },
		]);
	});

	test("rejects required structural parameters before dispatch", async () => {
		const { tools, calls } = registerTools();
		const callgraph = tools.get("aft_callgraph");
		if (callgraph === undefined) throw new Error("Expected aft_callgraph to register");
		await expect(
			callgraph.execute(
				"call-2",
				{ op: "trace_data", path: "src/app.ts", symbol: "run" },
				AbortSignal.abort(),
				() => {},
				context(),
			),
		).rejects.toThrow("requires an `expression`");
		expect(calls).toEqual([]);
	});

	test("serializes structural mutations", () => {
		const { tools } = registerTools();
		expect(tools.get("aft_refactor")?.executionMode).toBe("sequential");
		expect(tools.get("aft_import")?.executionMode).toBe("sequential");
	});

	test("omits empty optional import fields before bridge dispatch", async () => {
		const { tools, calls } = registerTools();
		await execute(tools.get("aft_import"), {
			op: "remove",
			path: "src/app.ts",
			module: "node:path",
			names: [],
			defaultImport: "",
			namespace: "",
			alias: "",
			modifiers: [],
			importKind: "",
			removeName: "",
			typeOnly: false,
			validate: "syntax",
		});

		expect(calls).toContainEqual({
			name: "import",
			arguments_: {
				op: "remove",
				filePath: "src/app.ts",
				module: "node:path",
				validate: "syntax",
			},
		});
	});

	test("returns callgraph indexing as a readable soft result", async () => {
		const { tools } = registerTools((name) =>
			name === "callgraph"
				? { success: false, code: "callgraph_building", text: "index is building" }
				: { success: true, text: "unused" },
		);
		const callgraph = tools.get("aft_callgraph");
		if (callgraph === undefined) throw new Error("Expected aft_callgraph to register");
		await expect(
			callgraph.execute(
				"call-3",
				{ op: "call_tree", path: "src/app.ts", symbol: "run" },
				AbortSignal.abort(),
				() => {},
				context(),
			),
		).resolves.toMatchObject({ content: [{ type: "text", text: "index is building" }] });
	});
});
