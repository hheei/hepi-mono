import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { PublicSubagent } from "../src/domain.js";
import type { SubagentManager } from "../src/manager.js";
import {
	INTERACTIVE_TOOL_NAMES,
	registerInteractiveToolActivation,
	SUBAGENTS_LOADER_NAME,
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
	test("deactivates interactive tools on initial clean session start", async () => {
		const { pi, registeredTools, getActive } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		// Simulate Pi registering parent tools
		registerParentTools(pi, manager);
		// Simulate Pi activating all registered extension tools by default
		pi.setActiveTools(registeredTools.map((t) => t.name));

		const context = {
			sessionManager: {
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		const activation = registerInteractiveToolActivation({ pi, manager, context });

		// Wait for selectFromSession to finish
		await activation.selectFromSession(context);

		// subagent_enable and list_agents should be active, but not the interactive tools
		expect(getActive()).toContain(SUBAGENTS_LOADER_NAME);
		expect(getActive()).toContain("list_agents");
		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			expect(getActive()).not.toContain(toolName);
		}

		activation.dispose();
	});

	test("executing subagent_enable activates interactive tools and omits interactive_agents when none exist", async () => {
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
		} as unknown as ExtensionToolContext;

		const activation = registerInteractiveToolActivation({ pi, manager, context });
		await activation.selectFromSession(context);

		const loaderTool = registeredTools.find((t) => t.name === SUBAGENTS_LOADER_NAME);
		expect(loaderTool).toBeDefined();

		const result = await loaderTool!.execute("call_1", {}, undefined, undefined, context);
		const firstText = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(firstText).toContain("Enabled interactive agent tools");
		// Since probe/worker/scout/reviewer are not interactive, <interactive_agents> should not be appended
		expect(firstText).not.toContain("<interactive_agents>");

		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			expect(getActive()).toContain(toolName);
		}

		// Idempotent execution
		const secondResult = await loaderTool!.execute("call_2", {}, undefined, undefined, context);
		const secondText = secondResult.content[0]?.type === "text" ? secondResult.content[0].text : "";
		expect(secondText).toContain("already enabled");
		expect(secondText).not.toContain("<interactive_agents>");

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
			interactive: true,
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

		// Since there is a live child, all tools stay active
		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			expect(getActive()).toContain(toolName);
		}
		expect(getActive()).toContain(SUBAGENTS_LOADER_NAME);

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

		// Branch had subagent call, so tools stay active
		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			expect(getActive()).toContain(toolName);
		}

		activation.dispose();
	});
});
