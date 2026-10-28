import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { SubagentManager } from "../src/manager.js";
import {
	INTERACTIVE_TOOL_NAMES,
	registerInteractiveToolActivation,
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
	};
}

describe("interactive tool activation", () => {
	test("registers interactive tools with exposure deferred and defaultActive false", () => {
		const { pi, registeredTools } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager, []);

		for (const toolName of INTERACTIVE_TOOL_NAMES) {
			const tool = registeredTools.find((t) => t.name === toolName);
			expect(tool).toBeDefined();
			expect(tool?.exposure).toBe("deferred");
			expect(tool?.defaultActive).toBe(false);
		}
	});

	test("injects subagents into optional_tools as a stable entry", async () => {
		const { pi } = createFakePi();
		const manager = {
			list: vi.fn().mockResolvedValue([]),
		} as unknown as SubagentManager;

		registerParentTools(pi, manager, []);

		const context = {
			cwd: process.cwd(),
			sessionManager: {
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		const activation = registerInteractiveToolActivation({ pi, manager, context });

		const startEvent = { systemPromptOptions: { sections: {} as Record<string, string> } };
		pi.emit("before_agent_start", startEvent);
		expect(startEvent.systemPromptOptions.sections.optional_tools).toContain(
			'If not loaded, use tool_search ({ query: "<query>" }) or call via codemode.',
		);
		expect(startEvent.systemPromptOptions.sections.optional_tools).toContain(
			'- subagents (query: "agent"): Agent orchestration and delegation (agents_delegate, agents_get, agents_stop, agents_dashboard).',
		);

		activation.dispose();
	});
});
