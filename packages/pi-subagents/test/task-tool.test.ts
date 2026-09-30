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

interface FrameOptions {
	readonly summary?: (args: { agent: string; task: string }) => string;
	readonly footer?: (result: { details: unknown }) => string | undefined;
}

const frames: FrameOptions[] = [];

/** The tool only uses `frame`: the definition is returned unchanged, the options are captured. */
const TUI = {
	frame: (tool: unknown, options: FrameOptions) => {
		frames.push(options);
		return tool;
	},
} as unknown as Parameters<typeof registerTaskTool>[1];

function settle(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function callTool(
	hosted: Host,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const tool = hosted.tools.get(TASK_TOOL_ID);
	if (tool === undefined) throw new Error("task tool was not registered");
	return (tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
		"id",
		params,
		signal,
		undefined,
		// The tool records where the Task started, so every call needs a session to read it from.
		{ sessionManager: { getLeafId: () => "leaf-anchor" } },
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

test("waits by default and only backgrounds an explicit blocking: false", async (): Promise<void> => {
	const hosted = host();
	const registry = new TaskRegistry();
	hosted.provide(registry);
	const inline: boolean[] = [];
	const stopped: string[] = [];
	registerTaskTool(hosted.context, TUI, () => {
		return {
			start(request: { purpose: string; inlineResult?: boolean }) {
				inline.push(request.inlineResult === true);
				// The execution never settles in this test, so the call can only return by aborting:
				// that is what proves the default path is the waiting one.
				const task = registry.create({
					type: "task",
					purpose: request.purpose,
					begin: () => ({
						stop: () => undefined,
						describe: () => ({ output: "", truncated: false }),
					}),
				});
				return { id: task.id, shortId: task.shortId, status: task.status };
			},
			stop(id: string) {
				stopped.push(id);
			},
			dispose() {},
		} as unknown as AgentTaskExecutor;
	});
	await settle();

	const controller = new AbortController();
	const waiting = callTool(hosted, { agent: "scout", task: "look" }, controller.signal);
	await settle();
	// No `blocking` at all is the default path, so the call is still open and its result is inline.
	expect(inline).toEqual([true]);
	controller.abort();
	await expect(waiting).resolves.toMatchObject({
		content: [{ type: "text", text: expect.stringContaining("was stopped") }],
	});
	expect(stopped).toEqual(["task-1"]);

	const background = (await callTool(hosted, {
		agent: "scout",
		task: "look later",
		blocking: false,
	})) as { readonly content: readonly { readonly text: string }[] };
	expect(inline).toEqual([true, false]);
	expect(background.content[0]?.text).toContain("Started task-2.");
});

test("tells the model that waiting is the default", async (): Promise<void> => {
	const hosted = host();
	hosted.provide(new TaskRegistry());
	registerTaskTool(hosted.context, TUI, () => ({}) as unknown as AgentTaskExecutor);
	await settle();

	const tool = hosted.tools.get(TASK_TOOL_ID);
	const guidelines = tool?.promptGuidelines?.join("\n") ?? "";
	// Review and reconnaissance work is only useful before the next step, so the tool says which
	// mode that work belongs in instead of leaving the model to infer it from two booleans.
	expect(guidelines).toContain("The default waits for the result");
	expect(guidelines).toContain("review");
	expect(guidelines).toContain("scout");
	expect(guidelines).toContain("`blocking: false`");
	expect(guidelines).toContain("Do not poll wait_tasks");
	expect(tool?.description).toContain("Waits for the result in this call");
});

test("activates with the existing registry and never mints a second one", async (): Promise<void> => {
	const hosted = host();
	const provided = new TaskRegistry();
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
	hosted.provide(new TaskRegistry());
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
	hosted.provide(new TaskRegistry());
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

test("records where the task started so its result cannot land on another branch", async (): Promise<void> => {
	const hosted = host();
	hosted.provide(new TaskRegistry());
	const anchors: (string | undefined)[] = [];
	registerTaskTool(hosted.context, TUI, () => {
		return {
			start: (request: { anchor?: string }) => {
				anchors.push(request.anchor);
				return { id: "task-1", shortId: "task-1", status: "queued" };
			},
			dispose() {},
		} as unknown as AgentTaskExecutor;
	});
	await settle();

	await callTool(hosted, { agent: "scout", task: "look" });

	// The delivery adapter only holds a result back when it knows where the task began.
	expect(anchors).toEqual(["leaf-anchor"]);
});

test("the frame footer reads the registry's own abbreviation", async (): Promise<void> => {
	const hosted = host();
	const registry = new TaskRegistry();
	hosted.provide(registry);
	registerTaskTool(hosted.context, TUI, () => {
		return { start: () => undefined, dispose: () => undefined } as unknown as AgentTaskExecutor;
	});
	await settle();

	const task = registry.create({
		type: "task",
		purpose: "look around",
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	});
	const footer = frames[frames.length - 1]?.footer;
	// The full id from a wait outcome is rendered with the registry's short form.
	expect(footer?.({ details: [{ id: task.id, status: "completed" }] })).toBe(
		`${task.shortId} \u00b7 completed`,
	);
	// An unknown or evicted id has no abbreviation to show, so the frame shows no footer.
	expect(footer?.({ details: [{ id: "task-nope-9", status: "completed" }] })).toBeUndefined();
	expect(footer?.({ details: undefined })).toBeUndefined();
});

test("cancelling a blocking call stops the execution whose result only it could carry", async (): Promise<void> => {
	const hosted = host();
	const registry = new TaskRegistry();
	hosted.provide(registry);
	const stopped: string[] = [];
	registerTaskTool(hosted.context, TUI, () => {
		return {
			start: () => ({ id: "task-1", shortId: "task-1", status: "queued" }),
			stop(id: string) {
				stopped.push(id);
			},
			dispose() {},
		} as unknown as AgentTaskExecutor;
	});
	await settle();

	const controller = new AbortController();
	const call = callTool(
		hosted,
		{ agent: "scout", task: "look", blocking: true },
		controller.signal,
	);
	controller.abort();

	// Without the stop the task keeps running while its only delivery channel is gone.
	expect(stopped).toEqual(["task-1"]);
	await expect(call).resolves.toMatchObject({
		content: [{ type: "text", text: expect.stringContaining("was stopped") }],
	});
});

test("a call cancelled before it starts waiting still stops its task", async (): Promise<void> => {
	const hosted = host();
	const registry = new TaskRegistry();
	hosted.provide(registry);
	const stopped: string[] = [];
	registerTaskTool(hosted.context, TUI, () => {
		return {
			start: () => ({ id: "agent-test-1", shortId: "agent-1", status: "queued" }),
			stop(id: string) {
				stopped.push(id);
			},
			dispose() {},
		} as unknown as AgentTaskExecutor;
	});
	await settle();

	const controller = new AbortController();
	controller.abort();
	// An already-aborted signal fires no event, so only an explicit check can stop the task.
	await callTool(hosted, { agent: "scout", task: "look", blocking: true }, controller.signal);

	expect(stopped).toEqual(["agent-test-1"]);
});

test("an interrupted blocking call hands its result to the background channel", async (): Promise<void> => {
	const hosted = host();
	const registry = new TaskRegistry();
	hosted.provide(registry);
	const stops: string[] = [];
	registerTaskTool(hosted.context, TUI, () => {
		return {
			start: (request: { readonly inlineResult?: boolean }) => {
				const task = registry.create({
					type: "task",
					purpose: "look",
					begin: () => ({
						stop: () => undefined,
						describe: () => ({ output: "", truncated: false }),
					}),
					...(request.inlineResult === true ? { inlineResult: true } : {}),
				});
				return { id: task.id, shortId: task.shortId, status: task.status };
			},
			stop(id: string) {
				stops.push(id);
			},
			dispose() {},
		} as unknown as AgentTaskExecutor;
	});
	await settle();

	const controller = new AbortController();
	const call = callTool(
		hosted,
		{ agent: "scout", task: "look", blocking: true },
		controller.signal,
	);
	controller.abort();
	const result = await call;

	// The call returned, so the result it was going to report has to reach the parent some other way:
	// the task gives up the inline claim and the settlement becomes a background result.
	const task = registry.list()[0];
	if (task === undefined) throw new Error("expected an admitted task");
	registry.settle(task.id, { status: "completed", output: "answer", truncated: false });
	expect(registry.pendingDeliveries().map((event) => event.id)).toEqual([task.id]);
	expect(result).toMatchObject({
		content: [{ type: "text", text: expect.stringContaining("background task result") }],
	});
	expect(stops).toEqual([task.id]);
});
