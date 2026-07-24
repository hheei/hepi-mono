import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "@hheei/pi-basics";
import { Value } from "typebox/value";
import type { TodoSnapshot } from "../src/state.js";
import {
	createTodoFeature,
	TODO_PARAMETERS,
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_NAME,
} from "../src/todo.js";

interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: string[];
	readonly parameters: typeof TODO_PARAMETERS;
	readonly executionMode?: string;
	readonly prepareArguments?: (value: unknown) => unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{
		readonly content: readonly { readonly type: string; readonly text: string }[];
		readonly details: { readonly snapshot: TodoSnapshot };
	}>;
}

function harness(mode: "tui" | "json" = "tui", sessionId = "todo-session") {
	const tools: RegisteredTool[] = [];
	const commands: Array<{
		readonly name: string;
		readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	}> = [];
	const events = new Map<
		string,
		Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>>
	>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const widgets: Array<{ key: string; content: unknown; options?: unknown }> = [];
	let branch: unknown[] = [];
	const pi = {
		registerTool(tool: unknown) {
			tools.push(tool as RegisteredTool);
		},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) {
			commands.push({ name, handler: options.handler });
		},
		on(
			event: string,
			handler: (
				event: Record<string, unknown>,
				ctx: ExtensionContext,
			) => unknown | Promise<unknown>,
		) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode,
		hasUI: mode === "tui",
		ui: {
			notify(message: string, level?: string) {
				notifications.push(level === undefined ? { message } : { message, level });
			},
			setWidget(key: string, content: unknown, options?: unknown) {
				widgets.push({ key, content, options });
			},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;
	const runtime = {
		pi,
		ctx,
		registry: {},
		requestRender: () => undefined,
		close: () => undefined,
	} as unknown as HePiRuntimeContext;
	return {
		pi,
		ctx,
		runtime,
		tools,
		commands,
		events,
		notifications,
		widgets,
		setBranch(next: unknown[]) {
			branch = next;
		},
		async emit(event: string, data: Record<string, unknown> = {}) {
			const results: unknown[] = [];
			for (const handler of events.get(event) ?? []) results.push(await handler(data, ctx));
			return results;
		},
	};
}

function branchResult(snapshot: TodoSnapshot) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: TODO_TOOL_NAME, details: { snapshot } },
	};
}

describe("Todo integration", () => {
	test("registers sourced batch schema, prompt, command, and lifecycle hooks", () => {
		const host = harness();
		createTodoFeature(host.pi);
		const tool = host.tools[0]!;

		expect(host.commands.map(({ name }) => name)).toEqual(["todos"]);
		expect(host.tools.map(({ name }) => name)).toEqual(["todo"]);
		expect(tool.executionMode).toBe("sequential");
		expect(tool.description).toBe(TODO_TOOL_DESCRIPTION);
		expect(tool.promptSnippet).toBe(TODO_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toEqual([...TODO_PROMPT_GUIDELINES]);
		expect(Value.Check(TODO_PARAMETERS, { action: "list" })).toBe(false);
		expect(Value.Check(TODO_PARAMETERS, { operations: [] })).toBe(false);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [
					{ action: "delete", id: 2 },
					{ action: "create", subject: "Implement replacement" },
				],
			}),
		).toBe(true);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "create", subject: "Task", id: 1 }],
			}),
		).toBe(false);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "create", subject: "Task", status: "pending" }],
			}),
		).toBe(false);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "update", id: 1, status: "in_progress" }],
			}),
		).toBe(true);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "list", status: "pending" }],
			}),
		).toBe(true);
		expect(
			tool.prepareArguments?.({
				operations: [{ action: "update", id: "1", blockedBy: ["2", "01", "1e2"] }],
			}),
		).toEqual({
			operations: [{ action: "update", id: 1, blockedBy: [2, "01", "1e2"] }],
		});
		expect(host.events.has("session_compact")).toBe(true);
		expect(host.events.has("session_tree")).toBe(true);
		expect(host.events.has("tool_execution_end")).toBe(true);
		expect(host.events.has("before_agent_start")).toBe(true);
		expect(host.events.has("agent_start")).toBe(true);
		expect(host.events.has("agent_end")).toBe(true);
	});

	test("executes ordered atomic batches and returns durable snapshots", async () => {
		const host = harness("json");
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;

		const created = await tool.execute(
			"call-1",
			{
				operations: [
					{ action: "create", subject: "First" },
					{ action: "create", subject: "Second", blockedBy: [1] },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(created.content[0]?.text).toContain("Created #1: First");
		expect(created.details.snapshot).toEqual({
			tasks: [
				{ id: 1, subject: "First", status: "pending", blockedBy: [] },
				{ id: 2, subject: "Second", status: "pending", blockedBy: [1] },
			],
			nextId: 3,
		});

		const mixed = await tool.execute(
			"call-2",
			{
				operations: [
					{ action: "delete", id: 1 },
					{ action: "create", subject: "Replacement" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(mixed.details.snapshot).toEqual({
			tasks: [
				{ id: 2, subject: "Second", status: "pending", blockedBy: [] },
				{ id: 3, subject: "Replacement", status: "pending", blockedBy: [] },
			],
			nextId: 4,
		});

		let failure: unknown;
		try {
			await tool.execute(
				"call-3",
				{
					operations: [
						{ action: "update", id: 2, status: "in_progress" },
						{ action: "delete", id: 99 },
					],
				},
				undefined,
				undefined,
				host.ctx,
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toEqual(new Error("Operation #2: Task #99 does not exist"));
		const listed = await tool.execute(
			"call-4",
			{ operations: [{ action: "list" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(listed.details.snapshot.tasks.find(({ id }) => id === 2)?.status).toBe("pending");
	});

	test("keeps failed and aborted calls out of durable state", async () => {
		const host = harness("json");
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		let failure: unknown;
		try {
			await tool.execute(
				"call-abort",
				{ operations: [{ action: "create", subject: "Never" }] },
				controller.signal,
				undefined,
				host.ctx,
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toEqual(new Error("cancelled"));
		const listed = await tool.execute(
			"call-list",
			{ operations: [{ action: "list" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(listed.details.snapshot).toEqual({ tasks: [], nextId: 1 });
	});

	test("restores branch snapshots and applies compact/tree fallbacks", async () => {
		const host = harness("json");
		const feature = createTodoFeature(host.pi);
		const snapshot: TodoSnapshot = {
			tasks: [{ id: 1, subject: "Restored", status: "pending", blockedBy: [] }],
			nextId: 2,
		};
		host.setBranch([branchResult(snapshot)]);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		let listed = await tool.execute(
			"list-1",
			{ operations: [{ action: "list" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(listed.content[0]?.text).toContain("Restored");

		host.setBranch([]);
		await host.emit("session_compact");
		listed = await tool.execute(
			"list-2",
			{ operations: [{ action: "list" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(listed.content[0]?.text).toContain("Restored");

		await host.emit("session_tree");
		listed = await tool.execute(
			"list-3",
			{ operations: [{ action: "list" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(listed.content[0]?.text).toBe("No todos.");
	});

	test("injects one conservative reminder after five idle turns", async () => {
		const host = harness();
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		await host.emit("agent_start");
		const created = await tool.execute(
			"create",
			{
				operations: [
					{ action: "create", subject: "Working" },
					{ action: "create", subject: "Blocked", blockedBy: [1] },
					{ action: "update", id: 1, status: "in_progress" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		host.setBranch([branchResult(created.details.snapshot)]);
		await host.emit("agent_end");
		for (let turn = 0; turn < 4; turn++) {
			expect(
				(
					await host.emit("before_agent_start", {
						systemPrompt: "base",
						systemPromptOptions: { selectedTools: [TODO_TOOL_NAME] },
					})
				)[0],
			).toBeUndefined();
			await host.emit("agent_start");
			await host.emit("agent_end");
		}
		await host.emit("session_compact");
		expect(
			(
				await host.emit("before_agent_start", {
					systemPrompt: "base",
					systemPromptOptions: { selectedTools: [TODO_TOOL_NAME] },
				})
			)[0],
		).toBeUndefined();
		await host.emit("agent_start");
		await host.emit("agent_end");
		expect(
			(
				await host.emit("before_agent_start", {
					systemPrompt: "base",
					systemPromptOptions: { selectedTools: [] },
				})
			)[0],
		).toBeUndefined();
		const reminder = (
			await host.emit("before_agent_start", {
				systemPrompt: "base",
				systemPromptOptions: { selectedTools: [TODO_TOOL_NAME] },
			})
		)[0] as { systemPrompt: string };
		expect(reminder.systemPrompt).toContain("base\n\n<todo_context>");
		expect(reminder.systemPrompt).toContain("2 unfinished. Continue #1: Working");
		expect(
			(
				await host.emit("before_agent_start", {
					systemPrompt: "base",
					systemPromptOptions: { selectedTools: [TODO_TOOL_NAME] },
				})
			)[0],
		).toBeUndefined();
	});

	test("auto-hides completed rendering without clearing state or ids", async () => {
		const host = harness();
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		await host.emit("agent_start");
		const completed = await tool.execute(
			"complete",
			{
				operations: [
					{ action: "create", subject: "Done" },
					{ action: "update", id: 1, status: "completed" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		host.setBranch([branchResult(completed.details.snapshot)]);
		await host.emit("tool_execution_end", { toolName: TODO_TOOL_NAME, isError: false });
		await host.emit("agent_end");
		for (let turn = 0; turn < 2; turn++) {
			await host.emit("agent_start");
			await host.emit("agent_end");
		}
		expect(host.widgets.at(-1)?.content).toBeUndefined();
		const hiddenCallCount = host.widgets.length;
		await host.emit("session_compact");
		expect(host.widgets).toHaveLength(hiddenCallCount);
		const created = await tool.execute(
			"next",
			{ operations: [{ action: "create", subject: "Next" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(created.details.snapshot.tasks.map(({ id }) => id)).toEqual([1, 2]);
		expect(created.details.snapshot.nextId).toBe(3);
		await host.emit("tool_execution_end", { toolName: TODO_TOOL_NAME, isError: false });
		expect(typeof host.widgets.at(-1)?.content).toBe("function");
	});

	test("renders grouped /todos output while remaining read-only", async () => {
		const host = harness();
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		await tool.execute(
			"create",
			{
				operations: [
					{ action: "create", subject: "Pending" },
					{ action: "create", subject: "Working" },
					{ action: "update", id: 2, status: "in_progress" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		await host.commands[0]!.handler("", host.ctx);
		expect(host.notifications[0]).toEqual({
			message: "0/2 completed\n── In Progress ──\n◐ #2 Working\n── Pending ──\n○ #1 Pending",
			level: "info",
		});
		await host.commands[0]!.handler("extra", host.ctx);
		expect(host.notifications[1]).toEqual({ message: "Usage: /todos", level: "error" });
	});
});
