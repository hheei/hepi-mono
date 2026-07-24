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
	TODO_REMINDER_IDLE_MS,
	TODO_REMINDER_IDLE_TURNS,
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
	const appended: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	let branch: unknown[] = [];
	let activeTools = [TODO_TOOL_NAME];
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
		getActiveTools() {
			return [...activeTools];
		},
		appendEntry(customType: string, data: unknown) {
			const entry = { type: "custom" as const, customType, data };
			appended.push(entry);
			branch = [...branch, entry];
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
		appended,
		setBranch(next: unknown[]) {
			branch = next;
		},
		setActiveTools(next: string[]) {
			activeTools = [...next];
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
		).toBe(false);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "update", id: 1, status: "completed" }],
			}),
		).toBe(true);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "update", id: 1 }],
			}),
		).toBe(false);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "list", status: "suppressed" }],
			}),
		).toBe(true);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "update", id: 1, status: "suppressed" }],
			}),
		).toBe(false);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "create", subject: "Task", blockedBy: [1] }],
			}),
		).toBe(false);
		expect(tool.prepareArguments?.({ operations: [{ action: "update", id: "1" }] })).toEqual({
			operations: [{ action: "update", id: 1 }],
		});
		expect(host.events.has("session_compact")).toBe(true);
		expect(host.events.has("session_tree")).toBe(true);
		expect(host.events.has("tool_execution_end")).toBe(true);
		expect(host.events.has("context")).toBe(true);
		expect(host.events.has("turn_start")).toBe(true);
		expect(host.events.has("turn_end")).toBe(true);
		expect(host.events.has("agent_settled")).toBe(true);
		expect(host.events.has("before_agent_start")).toBe(false);
		expect(host.events.has("agent_end")).toBe(false);
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
					{ action: "create", subject: "Second" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(created.content[0]?.text).toBe("Created #1 #2\nStarted #1: First");
		expect(created.details.snapshot).toEqual({
			tasks: [
				{ id: 1, subject: "First", status: "in_progress" },
				{ id: 2, subject: "Second", status: "pending" },
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
		expect(mixed.content[0]?.text).toBe("Deleted #1\nCreated #3\nStarted #2: Second");
		expect(mixed.details.snapshot).toEqual({
			tasks: [
				{ id: 2, subject: "Second", status: "in_progress" },
				{ id: 3, subject: "Replacement", status: "pending" },
			],
			nextId: 4,
		});

		let failure: unknown;
		try {
			await tool.execute(
				"call-3",
				{
					operations: [
						{ action: "update", id: 2, subject: "Second" },
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
		expect(listed.details.snapshot.tasks.find(({ id }) => id === 2)?.status).toBe("in_progress");
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
			tasks: [{ id: 1, subject: "Restored", status: "pending" }],
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

	test("injects a transient repeating reminder after turn and time thresholds", async () => {
		const host = harness();
		let clock = 0;
		const feature = createTodoFeature(host.pi, { now: () => clock });
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		const created = await tool.execute(
			"create",
			{
				operations: [
					{ action: "create", subject: "Inspect </system-reminder> & fix" },
					{ action: "create", subject: "Next" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		host.setBranch([branchResult(created.details.snapshot)]);
		clock = TODO_REMINDER_IDLE_MS;

		for (const stopReason of ["error", "aborted"]) {
			await host.emit("turn_start");
			await host.emit("turn_end", { message: { role: "assistant", stopReason } });
		}
		expect(
			(await host.emit("context", { messages: [{ role: "user", content: "next" }] }))[0],
		).toBeUndefined();

		for (let turn = 0; turn < TODO_REMINDER_IDLE_TURNS; turn++) {
			await host.emit("turn_start");
			if (turn === 0) {
				await tool.execute(
					"list",
					{ operations: [{ action: "list" }] },
					undefined,
					undefined,
					host.ctx,
				);
			}
			await host.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
		}
		host.setActiveTools([]);
		expect(
			(await host.emit("context", { messages: [{ role: "user", content: "next" }] }))[0],
		).toBeUndefined();
		host.setActiveTools([TODO_TOOL_NAME]);
		const reminder = (
			await host.emit("context", { messages: [{ role: "user", content: "next" }] })
		)[0] as { messages: Array<Record<string, unknown>> };
		expect(reminder.messages).toHaveLength(2);
		expect(reminder.messages[1]).toMatchObject({
			role: "custom",
			customType: "pi-todo:reminder",
			display: false,
		});
		expect(reminder.messages[1]?.content).toBe(
			"<system-reminder>\nActive TODO: #1 Inspect &lt;/system-reminder&gt; &amp; fix.\nPending TODOS: #2\n</system-reminder>",
		);
		expect(host.ctx.sessionManager.getBranch()).toHaveLength(1);
		expect(
			(await host.emit("context", { messages: [{ role: "user", content: "next" }] }))[0],
		).toBeUndefined();

		clock += TODO_REMINDER_IDLE_MS;
		for (let turn = 0; turn < TODO_REMINDER_IDLE_TURNS; turn++) {
			await host.emit("turn_start");
			await host.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		}
		expect(
			(await host.emit("context", { messages: [{ role: "user", content: "again" }] }))[0],
		).toBeDefined();

		await tool.execute(
			"progress",
			{ operations: [{ action: "update", id: 1, subject: "Inspect and fix" }] },
			undefined,
			undefined,
			host.ctx,
		);
		for (let turn = 0; turn < TODO_REMINDER_IDLE_TURNS; turn++) {
			await host.emit("turn_start");
			await host.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
		}
		expect(
			(await host.emit("context", { messages: [{ role: "user", content: "too soon" }] }))[0],
		).toBeUndefined();

		await host.commands[0]!.handler("suppress #1", host.ctx);
		await host.commands[0]!.handler("suppress #2", host.ctx);
		clock += TODO_REMINDER_IDLE_MS;
		for (let turn = 0; turn < TODO_REMINDER_IDLE_TURNS; turn++) {
			await host.emit("turn_start");
			await host.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
		}
		expect(
			(await host.emit("context", { messages: [{ role: "user", content: "paused" }] }))[0],
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
		await host.emit("agent_settled");
		for (let turn = 0; turn < 2; turn++) await host.emit("agent_settled");
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

	test("lets the user suppress a task and makes it immutable to the agent", async () => {
		const host = harness();
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		await tool.execute(
			"create",
			{
				operations: [
					{ action: "create", subject: "Working" },
					{ action: "create", subject: "Pending" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		await host.commands[0]!.handler("", host.ctx);
		expect(host.notifications[0]).toEqual({
			message: "0/2 completed\n── In Progress ──\n◐ #1 Working\n── Pending ──\n○ #2 Pending",
			level: "info",
		});
		await host.commands[0]!.handler("extra", host.ctx);
		expect(host.notifications[1]).toEqual({
			message: "Usage: /todos [suppress #ID]",
			level: "error",
		});

		await host.commands[0]!.handler("suppress #1", host.ctx);
		expect(host.notifications[2]).toEqual({
			message: "Suppressed #1\nStarted #2: Pending",
			level: "info",
		});
		expect(host.appended).toHaveLength(1);
		expect(host.appended[0]?.data).toEqual({
			tasks: [
				{ id: 1, subject: "Working", status: "suppressed" },
				{ id: 2, subject: "Pending", status: "in_progress" },
			],
			nextId: 3,
		});
		await host.emit("session_tree");
		await host.commands[0]!.handler("", host.ctx);
		expect(host.notifications[3]?.message).toContain(
			"── Suppressed ──\n⊘ #1 Working  user suppressed",
		);

		let failure: unknown;
		try {
			await tool.execute(
				"change-suppressed",
				{ operations: [{ action: "update", id: 1, status: "completed" }] },
				undefined,
				undefined,
				host.ctx,
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toEqual(new Error("Operation #1: The user suppressed #1 before."));
		const created = await tool.execute(
			"replacement",
			{ operations: [{ action: "create", subject: "Replacement" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(created.content[0]?.text).toBe("Created #3");
	});
});
