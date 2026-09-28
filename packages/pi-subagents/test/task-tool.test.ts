import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type DisposerRegistry,
	type ExtensionLifecycleContext,
	provideService,
	TASK_REGISTRY_SERVICE_KEY,
	TaskRegistry,
} from "@hheei/pi-ext-core";
import { expect, test } from "vitest";
import type { AgentTaskExecutor } from "../src/task-executor.js";
import { registerTaskTool, TASK_TOOL_ID } from "../src/task-tool.js";

interface Host {
	readonly context: ExtensionLifecycleContext;
	readonly tools: Map<string, ToolDefinition<never, unknown, unknown>>;
	activeTools(): readonly string[];
	/** Publishes the shared registry the way the owning extension does. */
	provide(registry: TaskRegistry): void;
}

function host(): Host {
	const tools = new Map<string, ToolDefinition<never, unknown, unknown>>();
	const cleanups: Array<() => unknown> = [];
	let active: string[] = [];
	const pi = {
		registerTool(tool: ToolDefinition<never, unknown, unknown>) {
			tools.set(tool.name, tool);
		},
		getActiveTools: () => active,
		setActiveTools(next: readonly string[]) {
			active = [...next];
		},
		on() {},
	} as unknown as ExtensionAPI;
	const resources = {
		add(_id: string, cleanup: () => unknown) {
			cleanups.push(cleanup);
		},
		async cleanup() {
			return [];
		},
	} as unknown as DisposerRegistry;
	const controller = new AbortController();
	const context = {
		pi,
		extension: {},
		signal: controller.signal,
		resources,
	} as unknown as ExtensionLifecycleContext;
	return {
		context,
		tools,
		activeTools: () => active,
		provide(registry) {
			// The real provider mechanism: the consumer must read this exact instance.
			expect(provideService(context, TASK_REGISTRY_SERVICE_KEY, registry)).toBe(true);
		},
	};
}

/** The tool only uses `frame`, which is identity for a definition without a renderer. */
const TUI = { frame: (tool: unknown) => tool } as unknown as Parameters<typeof registerTaskTool>[1];

function settle(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function callTool(hosted: Host, params: Record<string, unknown>): Promise<unknown> {
	const tool = hosted.tools.get(TASK_TOOL_ID);
	if (tool === undefined) throw new Error("task tool was not registered");
	return (tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
		"id",
		params,
		undefined,
		undefined,
		{},
	);
}

test("stays registered but inactive while no shared task registry exists", async (): Promise<void> => {
	const hosted = host();
	let created = 0;
	registerTaskTool(hosted.context, TUI, () => {
		created += 1;
		throw new Error("executor must not be created without a provider");
	});
	await settle();

	expect(hosted.tools.has(TASK_TOOL_ID)).toBe(true);
	expect(hosted.activeTools()).not.toContain(TASK_TOOL_ID);
	expect(created).toBe(0);
	await expect(callTool(hosted, { agent: "scout", task: "look" })).rejects.toThrow(
		/no shared background-task registry/u,
	);
});

test("activates with the existing registry and never mints a second one", async (): Promise<void> => {
	const hosted = host();
	const provided = new TaskRegistry({ runtimeDiscriminator: "test" });
	hosted.provide(provided);
	const received: TaskRegistry[] = [];
	registerTaskTool(hosted.context, TUI, (registry) => {
		received.push(registry);
		return { start: () => undefined, dispose: () => undefined } as unknown as AgentTaskExecutor;
	});
	await settle();

	expect(received).toEqual([provided]);
	expect(hosted.activeTools()).toContain(TASK_TOOL_ID);
});

test("rejects an unsupported output schema before any child exists", async (): Promise<void> => {
	const hosted = host();
	hosted.provide(new TaskRegistry({ runtimeDiscriminator: "test" }));
	let starts = 0;
	registerTaskTool(hosted.context, TUI, () => {
		return {
			start() {
				starts += 1;
				throw new Error("unreachable");
			},
			dispose() {},
		} as unknown as AgentTaskExecutor;
	});
	await settle();

	await expect(
		callTool(hosted, { agent: "scout", task: "look", outputSchema: { type: "wibble" } }),
	).rejects.toThrow(/Unsupported outputSchema/u);
	expect(starts).toBe(0);
});

test("names the real cause when the integration fails after the registry appears", async (): Promise<void> => {
	const hosted = host();
	hosted.provide(new TaskRegistry({ runtimeDiscriminator: "test" }));
	registerTaskTool(hosted.context, TUI, () => {
		throw new Error("no agent concurrency budget left");
	});
	await settle();

	// The registry exists, so blaming a missing installation would misdirect the caller.
	expect(hosted.activeTools()).not.toContain(TASK_TOOL_ID);
	await expect(callTool(hosted, { agent: "scout", task: "look" })).rejects.toThrow(
		/no agent concurrency budget left/u,
	);
});
