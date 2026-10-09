import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { PublicSubagent } from "../src/domain.js";
import type { SubagentManager } from "../src/manager.js";
import {
	INTERACTIVE_TOOL_NAMES,
	registerInteractiveToolActivation,
	SUBAGENT_DEFERRED_PROMPT_GUIDANCE,
	SUBAGENT_PROMPT_SECTION,
} from "../src/tool-activation.js";
import { registerParentTools } from "../src/tools.js";

function createFakePi(initialActiveTools: string[] = []) {
	const registeredTools: ToolDefinition[] = [];
	let activeTools = [...initialActiveTools];
	const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

	const pi = {
		registerTool(tool: ToolDefinition) {
			registeredTools.push(tool);
		},
		getAllTools() {
			return registeredTools;
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(tools: string[]) {
			activeTools = [...tools];
		},
		on(event: string, handler: (...args: unknown[]) => void) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
			return () => {
				const current = eventHandlers.get(event) ?? [];
				eventHandlers.set(
					event,
					current.filter((h) => h !== handler),
				);
			};
		},
		emit(event: string, ...args: unknown[]) {
			for (const handler of eventHandlers.get(event) ?? []) {
				handler(...args);
			}
		},
	} as unknown as ExtensionAPI & { emit(event: string, ...args: unknown[]): void };

	return {
		pi,
		registeredTools,
		getActive: () => activeTools,
		setLoaded: (t: string[]) => {
			activeTools = t;
		},
	};
}

describe("interactive tool activation", () => {
	test("registers interactive tools with exposure deferred", () => {
		const { pi, registeredTools } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager);

		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			const tool = registeredTools.find((t) => t.name === toolName);
			expect(tool).toBeDefined();
			expect(tool?.exposure).toBe("deferred");
			expect(tool?.defaultActive).toBe(false);
		}
	});

	test("deactivates interactive tools on initial clean session start and injects deferred guidance", async () => {
		const { pi, registeredTools, getActive } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager);
		pi.setActiveTools(registeredTools.map((t) => t.name));

		const context = {
			sessionManager: {
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		const activation = registerInteractiveToolActivation({ pi, manager, context });
		await activation.selectFromSession(context);

		expect(getActive()).toContain("list_agents");
		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			expect(getActive()).not.toContain(toolName);
		}

		// before_agent_start injects deferred discovery guidance
		const startEvent = { systemPromptOptions: { sections: {} as Record<string, string> } };
		pi.emit("before_agent_start", startEvent);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const guidance = startEvent.systemPromptOptions.sections[SUBAGENT_PROMPT_SECTION];
		expect(guidance).toBe(SUBAGENT_DEFERRED_PROMPT_GUIDANCE);

		activation.dispose();
	});

	test("injects full collaboration guidance when interactive tools become active", async () => {
		const { pi, registeredTools, getActive } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager);
		pi.setActiveTools(registeredTools.map((t) => t.name));

		const context = {
			cwd: process.cwd(),
			sessionManager: {
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		const activation = registerInteractiveToolActivation({ pi, manager, context });
		await activation.selectFromSession(context);

		// Activate interactive tools (as tool_search does)
		pi.setActiveTools([...getActive(), ...INTERACTIVE_TOOL_NAMES]);

		const startEvent = { systemPromptOptions: { sections: {} as Record<string, string> } };
		pi.emit("before_agent_start", startEvent);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const guidance = startEvent.systemPromptOptions.sections[SUBAGENT_PROMPT_SECTION];
		expect(guidance).toBeDefined();
		expect(guidance).toContain("Reuse an existing subagent via send_agent");
		expect(guidance).toContain("Do not poll get_agent or list_agents");
		expect(guidance).toContain("<available_agents>");

		activation.dispose();
	});

	test("retains interactive tools if session has live children", async () => {
		const { pi, registeredTools, getActive } = createFakePi();
		const liveChild = {
			id: "sa_live1",
			agent: "worker",
			state: "running",
			presentation: "background",
			cwd: "/test",
			sessionId: "s1",
			summary: "working",
			freshness: "live",
			model: { provider: "mock", id: "mock-model", source: "agent" },
			thinking: { level: "off", source: "agent" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as PublicSubagent;
		const manager = {
			list: vi.fn().mockResolvedValue([liveChild]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager);
		pi.setActiveTools(registeredTools.map((t) => t.name));

		const context = {
			sessionManager: {
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		const activation = registerInteractiveToolActivation({ pi, manager, context });
		await activation.selectFromSession(context);

		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			expect(getActive()).toContain(toolName);
		}

		activation.dispose();
	});

	test("retains interactive tools if branch transcript recorded tool addition", async () => {
		const { pi, registeredTools, getActive } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager);
		pi.setActiveTools(registeredTools.map((t) => t.name));

		const context = {
			sessionManager: {
				getBranch: () => [
					{
						id: "entry_1",
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "tool_use", name: "spawn_agent" }],
						},
					},
				],
			},
		} as unknown as ExtensionContext;

		const activation = registerInteractiveToolActivation({ pi, manager, context });
		await activation.selectFromSession(context);

		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			expect(getActive()).toContain(toolName);
		}

		activation.dispose();
	});
});
