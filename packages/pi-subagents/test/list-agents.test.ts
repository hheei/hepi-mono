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
	test("formats empty message when no interactive agents or running subagents exist", async () => {
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

		// list_agents is only for interactive subagents, so task agents must NOT be included
		expect(text).not.toContain("<task_agents>");
		expect(text).not.toContain("scout:");
		expect(text).not.toContain("worker:");
		expect(text).not.toContain("reviewer:");
		expect(text).not.toContain("probe:");

		// Empty blocks should NOT be present
		expect(text).not.toContain("<interactive_agents>");
		expect(text).not.toContain("<running_agents>");
		expect(text).not.toContain("<subagents>");

		expect(text).toBe("No active or available interactive subagents.");

		const details = result.details as {
			interactiveAgents?: Array<{ name: string }>;
			runningAgents: unknown[];
		};
		expect(details.interactiveAgents).toBeUndefined();
		expect(details.runningAgents).toEqual([]);
	});

	test("formats running agents when children exist", async () => {
		const { pi, registeredTools } = createFakePi();
		const child = {
			id: "sa_interactive1",
			agent: "worker",
			state: "idle",
			mode: "rpc",
			cwd: "/test",
			sessionId: "s1",
			summary: "interactive partner",
			freshness: "live",
			interactive: true,
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

		expect(text).not.toContain("<task_agents>");
		expect(text).toContain("<running_agents>");
		expect(text).toContain("sa_interactive1");
		expect(text).toContain("worker");
		expect(text).toContain("idle");
		expect(text).toContain("interactive partner");
		expect(text).toContain("</running_agents>");
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
});
