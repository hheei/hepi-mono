/** Unit tests adapted from AFT Pi adapter's safety.test.ts. */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HepiAftRuntime } from "../src/aft/runtime.js";
import { registerSafetyTool } from "../src/aft/safety.js";
import type { PluginContext } from "../src/aft/types.js";

type RegisteredTool = {
	readonly name: string;
	execute(...args: readonly unknown[]): Promise<unknown>;
};

type Call = {
	readonly kind: "command" | "tool";
	readonly name: string;
	readonly args: Record<string, unknown>;
};

function createContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
}

function registerSafety(
	onCall: (call: Call) => Promise<Record<string, unknown>>,
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const runtime = {
		getBridge: () => ({
			send: async (name: string, args: Record<string, unknown>) =>
				await onCall({ kind: "command", name, args }),
			toolCall: async (
				_sessionId: string | undefined,
				name: string,
				args: Record<string, unknown>,
			) => await onCall({ kind: "tool", name, args }),
		}),
	} as unknown as HepiAftRuntime;
	const pluginContext: PluginContext = {
		getRuntime: () => runtime,
		getReadPathResolver: () => ({}) as never,
		config: { restrict_to_project_root: false },
		storageDir: "",
	};
	const pi = {
		registerTool: (tool: unknown) => {
			const registered = tool as RegisteredTool;
			tools.set(registered.name, registered);
		},
	} as unknown as ExtensionAPI;
	registerSafetyTool(pi, pluginContext);
	return tools;
}

async function execute(
	tools: Map<string, RegisteredTool>,
	params: Record<string, unknown>,
): Promise<unknown> {
	const tool = tools.get("aft_safety");
	if (tool === undefined) throw new Error("Expected aft_safety to register");
	return await tool.execute("safety", params, undefined, undefined, createContext());
}

describe("aft_safety adapter", () => {
	test("requires history path before bridge dispatch", async () => {
		const calls: Call[] = [];
		const tools = registerSafety(async (call) => {
			calls.push(call);
			return { success: true, text: "unexpected" };
		});

		await expect(execute(tools, { op: "history" })).rejects.toThrow("requires 'path'");
		expect(calls).toEqual([]);
	});

	test("previews undo before forwarding the AFT safety call", async () => {
		const calls: Call[] = [];
		const tools = registerSafety(async (call) => {
			calls.push(call);
			return call.kind === "command"
				? { success: true, paths: [] }
				: { success: true, operation: true, text: "restored operation" };
		});

		await execute(tools, { op: "undo" });
		expect(calls).toEqual([
			{ kind: "command", name: "undo_preview", args: { session_id: "session-1" } },
			{ kind: "tool", name: "safety", args: { op: "undo" } },
		]);
	});

	test("treats an empty optional checkpoint path as omitted", async () => {
		const calls: Call[] = [];
		const tools = registerSafety(async (call) => {
			calls.push(call);
			return { success: true, text: "checkpoint created" };
		});

		await execute(tools, { op: "checkpoint", name: "all-tracked", path: "" });
		expect(calls).toEqual([
			{
				kind: "tool",
				name: "safety",
				args: { op: "checkpoint", name: "all-tracked" },
			},
		]);
	});

	test("previews restore paths and forwards the canonical filePath payload", async () => {
		const calls: Call[] = [];
		const tools = registerSafety(async (call) => {
			calls.push(call);
			return call.kind === "command"
				? { success: true, paths: [] }
				: { success: true, text: "checkpoint restored" };
		});

		await execute(tools, {
			op: "restore",
			name: "before-edit",
			files: ["src/a.ts", "src/b.ts"],
		});
		expect(calls).toEqual([
			{
				kind: "command",
				name: "checkpoint_paths",
				args: { name: "before-edit", session_id: "session-1" },
			},
			{
				kind: "tool",
				name: "safety",
				args: {
					op: "restore",
					name: "before-edit",
					files: ["src/a.ts", "src/b.ts"],
				},
			},
		]);
	});

	test("restores an AFT-backed write through the real safety undo protocol", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "hepi-aft-safety-"));
		const path = join(cwd, "sample.txt");
		const runtime = new HepiAftRuntime();
		try {
			await writeFile(path, "before\n", "utf8");
			await runtime.start();
			const bridge = runtime.getBridge(cwd);
			const write = await bridge.toolCall("safety-e2e", "write", {
				filePath: path,
				content: "after\n",
			});
			expect(write.success).toBe(true);
			expect(await readFile(path, "utf8")).toBe("after\n");

			const undo = await bridge.toolCall("safety-e2e", "safety", { op: "undo" });
			expect(undo.success).toBe(true);
			expect(await readFile(path, "utf8")).toBe("before\n");
		} finally {
			await runtime.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
