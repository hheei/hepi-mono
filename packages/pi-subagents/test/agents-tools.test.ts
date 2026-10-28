import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { DashboardView, DelegationView } from "../src/delegation.js";
import type { SubagentManager } from "../src/manager.js";
import { registerParentTools } from "../src/tools.js";

function createFakePi() {
	const registeredTools: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			registeredTools.push(tool);
		},
		getAllTools() {
			return registeredTools;
		},
		getActiveTools() {
			return registeredTools.map((tool) => tool.name);
		},
		setActiveTools() {},
		on() {
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { pi, registeredTools };
}

const view: DelegationView = {
	id: "agent-9",
	revision: 3,
	status: "completed",
	task: "Investigate performance bottleneck",
	hasOutput: true,
	agent: "scout",
	resultText: "Found hot loop in query tokenizer",
	progress: { runtimeState: "done", summary: "finished" },
};

const dashboard: DashboardView = {
	total: 2,
	running: 1,
	blocked: 0,
	completed: 1,
	failed: 0,
	children: [
		{
			id: "agent-9",
			agent: "scout",
			runtimeState: "done",
			revision: 3,
			status: "completed",
			hasOutput: true,
		},
		{
			id: "agent-10",
			agent: "worker",
			runtimeState: "running",
			revision: 1,
			status: "accepted",
			hasOutput: false,
		},
	],
};

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	const [only] = result.content;
	return only?.type === "text" ? (only.text ?? "") : "";
}

function toolset(manager: SubagentManager) {
	const { pi, registeredTools } = createFakePi();
	registerParentTools(pi, manager, []);
	return async (name: string, params: unknown): Promise<{ text: string; details: unknown }> => {
		const tool = registeredTools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`${name} was not registered`);
		const result = (await tool.execute("call", params, undefined, undefined, {
			cwd: process.cwd(),
		} as never)) as { content: readonly { type: string; text?: string }[]; details?: unknown };
		return { text: textOf(result), details: result.details };
	};
}

describe("agent tools", () => {
	test("registers exactly the four agent tools", () => {
		const { pi, registeredTools } = createFakePi();
		registerParentTools(pi, {} as unknown as SubagentManager, []);
		expect(registeredTools.map((tool) => tool.name)).toEqual([
			"agents_delegate",
			"agents_get",
			"agents_stop",
			"agents_dashboard",
		]);
		expect(registeredTools.every((tool) => tool.exposure === "deferred")).toBe(true);
	});

	test("get reads the newest delegation by default and the chosen revision on request", async () => {
		const inspect = vi.fn(async () => view);
		const manager = { inspect } as unknown as SubagentManager;
		const plain = await toolset(manager)("agents_get", { id: "agent-9" });
		expect(inspect).toHaveBeenLastCalledWith({ id: "agent-9", includeOutput: false });
		expect(JSON.parse(plain.text)).toEqual(view);
		expect(plain.details).toEqual(view);

		await toolset(manager)("agents_get", {
			id: "agent-9",
			revision: 2,
			includeOutput: true,
		});
		expect(inspect).toHaveBeenLastCalledWith({
			id: "agent-9",
			revision: 2,
			includeOutput: true,
		});
	});

	test("get rejects a non-positive revision and unknown parameters", async () => {
		const manager = { inspect: vi.fn() } as unknown as SubagentManager;
		await expect(toolset(manager)("agents_get", { id: "agent-9", revision: 0 })).rejects.toThrow(
			"Invalid agents_get parameters",
		);
		await expect(toolset(manager)("agents_get", { id: "agent-9", keys: "status" })).rejects.toThrow(
			"Invalid agents_get parameters",
		);
	});

	test("a repeated inspection adds the no-poll reminder", async () => {
		const callTool = toolset({ inspect: vi.fn(async () => view) } as unknown as SubagentManager);
		const first = await callTool("agents_get", { id: "agent-9" });
		expect(first.text).not.toContain("do not poll");
		const again = await callTool("agents_get", { id: "agent-9" });
		expect(again.text).toContain("do not poll agents_get");
	});

	test("stop reports the delegation status it ended", async () => {
		const stopAgent = vi.fn(async () => ({ ...view, status: "failed" as const, hasOutput: false }));
		const manager = { stopAgent } as unknown as SubagentManager;
		const stopped = await toolset(manager)("agents_stop", { id: "agent-9" });
		expect(stopAgent).toHaveBeenCalledWith("agent-9");
		expect(stopped.text).toContain("revision 3 is failed");
	});

	test("dashboard summarises runtime counts and every agent", async () => {
		const manager = { dashboard: vi.fn(async () => dashboard) } as unknown as SubagentManager;
		const listed = await toolset(manager)("agents_dashboard", {});
		expect(listed.text).toContain("2 agents");
		expect(listed.text).toContain("running 1");
		expect(listed.details).toEqual(dashboard);
	});

	test("delegate forwards the request and returns the accepted delegation", async () => {
		const delegate = vi.fn(async () => view);
		const manager = { delegate } as unknown as SubagentManager;
		const accepted = await toolset(manager)("agents_delegate", {
			agent: "scout",
			task: "look into it",
			wait: false,
		});
		expect(delegate).toHaveBeenCalledWith(
			{ agent: "scout", task: "look into it", wait: false },
			undefined,
			expect.any(Function),
		);
		expect(JSON.parse(accepted.text)).toEqual(view);
	});

	test("delegate rejects the removed title and mode parameters", async () => {
		const manager = { delegate: vi.fn() } as unknown as SubagentManager;
		await expect(
			toolset(manager)("agents_delegate", { agent: "scout", task: "x", title: "name" }),
		).rejects.toThrow("Invalid agents_delegate parameters");
		await expect(
			toolset(manager)("agents_delegate", { id: "agent-9", task: "x", mode: "follow_up" }),
		).rejects.toThrow("Invalid agents_delegate parameters");
	});

	test("failures surface the reason and nothing else", async () => {
		const failure = {
			operation: "delegate",
			reason: "Unknown child",
			safeToRetry: true,
			sideEffects: [],
		};
		const manager = {
			delegate: vi.fn(async () => failure),
			inspect: vi.fn(async () => failure),
			stopAgent: vi.fn(async () => failure),
		} as unknown as SubagentManager;
		await expect(
			toolset(manager)("agents_delegate", { agent: "scout", task: "x" }),
		).rejects.toThrow("Unknown child");
		await expect(toolset(manager)("agents_get", { id: "agent-9" })).rejects.toThrow(
			"Unknown child",
		);
		await expect(toolset(manager)("agents_stop", { id: "agent-9" })).rejects.toThrow(
			"Unknown child",
		);
	});
});
