import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { PublicSubagent } from "../src/domain.js";
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
			return registeredTools.map((t) => t.name);
		},
		setActiveTools() {},
		on() {
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { pi, registeredTools };
}

describe("list_agents tool", () => {
	test("formats empty message when no child agents exist", async () => {
		const { pi, registeredTools } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager);
		const listTool = registeredTools.find((t) => t.name === "list_agents");
		expect(listTool).toBeDefined();

		const context = {
			cwd: process.cwd(),
		} as unknown as ExtensionToolContext;

		const result = await listTool!.execute("call_1", {}, undefined, undefined, context);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).not.toContain("<subagents>");

		expect(text).toBe("No child agents are currently owned by this parent session.");

		const details = result.details as {
			runningAgents: unknown[];
		};
		expect(details.runningAgents).toEqual([]);
	});

	test("formats running agents when children exist", async () => {
		const { pi, registeredTools } = createFakePi();
		const child = {
			id: "sa_interactive1",
			agent: "worker",
			state: "done",
			presentation: "background",
			cwd: "/test",
			sessionId: "s1",
			summary: "interactive partner",
			freshness: "live",
			model: { provider: "mock", id: "mock-model", source: "agent" },
			thinking: { level: "off", source: "agent" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as PublicSubagent;
		const manager = {
			list: vi.fn().mockResolvedValue([child]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager);
		const listTool = registeredTools.find((t) => t.name === "list_agents");

		const context = {
			cwd: process.cwd(),
		} as unknown as ExtensionToolContext;

		const result = await listTool!.execute("call_2", {}, undefined, undefined, context);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("<owned_child_agents>");
		expect(text).toContain("sa_interactive1");
		expect(text).toContain("worker");
		expect(text).toContain("done");
		expect(text).toContain("interactive partner");
		expect(text).toContain("</owned_child_agents>");
	});

	test("declares readOnlyHint and idempotentHint annotations for get_agent and list_agents", () => {
		const { pi, registeredTools } = createFakePi();
		const manager = {} as unknown as SubagentManager;
		registerParentTools(pi, manager);

		const listTool = registeredTools.find((t) => t.name === "list_agents");
		const getTool = registeredTools.find((t) => t.name === "get_agent");

		expect(listTool?.annotations).toEqual({
			readOnlyHint: true,
			idempotentHint: true,
		});
		expect(getTool?.annotations).toEqual({
			readOnlyHint: true,
			idempotentHint: true,
		});
	});

	test("get_agent formats detailed state and recent information with task", async () => {
		const { pi, registeredTools } = createFakePi();
		const mockChild: PublicSubagent = {
			id: "agent-9",
			agent: "scout",
			displayName: "Code Scout",
			state: "done",
			presentation: "panel",
			cwd: "/mock/repo",
			sessionId: "session-9",
			task: "Investigate performance bottleneck",
			summary: "Found hot loop in query tokenizer",
			freshness: "live",
			model: { provider: "mock", id: "m1", source: "agent" },
			thinking: { level: "low", source: "agent" },
			createdAt: "2026-10-05T00:00:00Z",
			updatedAt: "2026-10-05T00:01:00Z",
			usage: {
				inputTokens: 1200,
				outputTokens: 300,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0.01,
				turns: 2,
			},
		};
		const manager = {
			get: vi.fn(async () => mockChild),
		} as unknown as SubagentManager;
		registerParentTools(pi, manager);

		const getTool = registeredTools.find((t) => t.name === "get_agent");
		const context = { cwd: process.cwd() } as unknown as ExtensionToolContext;

		const result = await getTool!.execute(
			"call_get",
			{ id: "agent-9" },
			undefined,
			undefined,
			context,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Agent agent-9 [Code Scout (scout)]:");
		expect(text).toContain("- State: done");
		expect(text).toContain("- Task: Investigate performance bottleneck");
		expect(text).toContain("- Recent output: Found hot loop in query tokenizer");
		expect(text).toContain("- Usage: 2 turn(s), 1500 tokens");
		expect(result.details).toMatchObject(mockChild);
	});
});
