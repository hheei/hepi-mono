import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { HepiRuntimeContext } from "../../../hepi-basics/src/core/index.js";
import type { TodoSnapshot } from "../../src/pi-todo/state.js";
import {
	createTodoFeature,
	TODO_PARAMETERS,
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODO_REMINDER_IDLE_MS,
	TODO_REMINDER_IDLE_TURNS,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_NAME,
} from "../../src/pi-todo/todo.js";

interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: string[];
	readonly parameters: typeof TODO_PARAMETERS;
	readonly executionMode?: string;
	readonly prepareArguments?: (value: unknown) => unknown;
	readonly renderCall?: (
		args: Record<string, unknown>,
		theme: unknown,
		context: unknown,
	) => unknown;
	readonly renderResult?: (
		result: { readonly details?: unknown },
		options: unknown,
		theme: unknown,
		context: unknown,
	) => unknown;
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
	} as unknown as HepiRuntimeContext;
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
		expect(TODO_PROMPT_GUIDELINES).toEqual([
			"Use `todo` for work with 3+ concrete steps or multiple user-requested tasks; skip trivial work.",
			"Create the full known task list in one atomic batch. Keep subjects short, imperative, and outcome-oriented; do not add bookkeeping tasks for routine commands.",
			"Scheduling is automatic. Update only when state changes: use `completed` after verification, `blocked` only when work cannot continue, and `in_progress` only when resuming blocked work. Do not repeatedly list or restate current state.",
		]);
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
				operations: [{ action: "update", id: 1, status: "blocked" }],
			}),
		).toBe(true);
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
				operations: [{ action: "update", id: 1, status: "pending" }],
			}),
		).toBe(false);
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
		expect(host.events.has("agent_start")).toBe(true);
		expect(host.events.has("agent_settled")).toBe(false);
		expect(host.events.has("before_agent_start")).toBe(false);
		expect(host.events.has("agent_end")).toBe(false);
	});

	test("renders compact tool calls and current result state", async () => {
		const host = harness("json");
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const call = tool.renderCall?.(
			{
				operations: [
					{ action: "update", id: 1, status: "blocked" },
					{ action: "delete", id: 2 },
					{ action: "update", id: 3, status: "completed" },
				],
			},
			theme,
			{ toolCallId: "batch" },
		) as { readonly text: string };
		expect(call.text).toBe("todo → #1 #2 #3");
		const partial = tool.renderCall?.({ operations: [null, {}] }, theme, {
			toolCallId: "partial",
		}) as {
			readonly text: string;
		};
		expect(partial.text).toBe("todo");

		const unsafe = tool.renderCall?.(
			{ operations: [{ action: "update", id: "\x1b[2J", status: "blocked" }] },
			theme,
			{ toolCallId: "unsafe" },
		) as { readonly text: string };
		expect(unsafe.text).toBe("todo");
		const unsafeList = tool.renderCall?.(
			{ operations: [{ action: "list", status: "\x1b[2J" }] },
			theme,
			{ toolCallId: "unsafe-list" },
		) as { readonly text: string };
		expect(unsafeList.text).toBe("todo ☰");

		const createParams = { operations: [{ action: "create", subject: "First" }] };
		const createRenderContext = { toolCallId: "create" };
		expect(tool.renderCall?.(createParams, theme, createRenderContext)).toMatchObject({
			text: "todo →",
		});
		const created = await tool.execute("create", createParams, undefined, undefined, host.ctx);
		expect(tool.renderCall?.(createParams, theme, createRenderContext)).toMatchObject({
			text: "todo → #1",
		});
		const active = tool.renderResult?.(created, {}, theme, { isError: false }) as {
			readonly text: string;
		};
		expect(active.text).toBe("◐ #1 First");

		const completed = await tool.execute(
			"complete",
			{ operations: [{ action: "update", id: 1, status: "completed" }] },
			undefined,
			undefined,
			host.ctx,
		);
		const done = tool.renderResult?.(completed, {}, theme, { isError: false }) as {
			readonly text: string;
		};
		expect(done.text).toBe("✓ #1 First");

		const nextParams = {
			operations: [
				{ action: "create", subject: "Second" },
				{ action: "create", subject: "Third" },
			],
		};
		const nextContext = { toolCallId: "create-next" };
		expect(tool.renderCall?.(nextParams, theme, nextContext)).toMatchObject({ text: "todo →" });
		await tool.execute("create-next", nextParams, undefined, undefined, host.ctx);
		expect(tool.renderCall?.(nextParams, theme, nextContext)).toMatchObject({
			text: "todo → #2 #3",
		});

		await tool.execute(
			"block-second",
			{ operations: [{ action: "update", id: 2, status: "blocked" }] },
			undefined,
			undefined,
			host.ctx,
		);
		const blockedResult = await tool.execute(
			"block-third",
			{ operations: [{ action: "update", id: 3, status: "blocked" }] },
			undefined,
			undefined,
			host.ctx,
		);
		const blocked = tool.renderResult?.(blockedResult, {}, theme, { isError: false }) as {
			readonly text: string;
		};
		expect(blocked.text).toBe("⊘ #3 Third");

		const failed = tool.renderResult?.(
			{},
			{},
			{ fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			{ isError: true },
		) as { readonly text: string };
		expect(failed.text).toBe("<error>✗</error>");
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
		expect(created.content[0]?.text).toBe("Created #1 #2\nNext: #1 First.");
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
					{ action: "update", id: 1, status: "blocked" },
					{ action: "create", subject: "Replacement" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(mixed.content[0]?.text).toBe("Updated #1\nCreated #3\nNext: #2 Second.");
		expect(mixed.details.snapshot).toEqual({
			tasks: [
				{ id: 1, subject: "First", status: "blocked" },
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
						{ action: "update", id: 2, subject: "Changed" },
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
		expect(failure).toEqual(new Error("Task #99 does not exist.\nNo change made."));
		const listed = await tool.execute(
			"call-4",
			{ operations: [{ action: "list" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(listed.details.snapshot.tasks.find(({ id }) => id === 2)?.status).toBe("in_progress");
		expect(listed.content[0]?.text).toContain("◐ #2 Second");
		expect(listed.content[0]?.text).toContain("⊘ #1 First");
		expect(listed.content[0]?.text).toEndWith("Next: #2 Second.");

		const noChange = await tool.execute(
			"call-5",
			{ operations: [{ action: "update", id: 2, subject: "Second" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(noChange.content[0]?.text).toBe("#2 is already `Second`\nNo change made.");

		const changedWithNoOp = await tool.execute(
			"call-6",
			{
				operations: [
					{ action: "update", id: 2, subject: "Second" },
					{ action: "update", id: 3, subject: "Renamed" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(changedWithNoOp.content[0]?.text).toBe(
			"#2 is already `Second`\nUpdated #3\nNext: #2 Second.",
		);

		const allBlocked = await tool.execute(
			"call-7",
			{
				operations: [
					{ action: "update", id: 2, status: "blocked" },
					{ action: "update", id: 3, status: "blocked" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(allBlocked.content[0]?.text).toBe(
			"Updated #2\nUpdated #3\nOnly blocked todos #1 #2 #3 left. Agree next steps with the user.",
		);
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
		expect(listed.content[0]?.text).toBe("No todos.\nFinished all todos.");
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
		expect(listed.content[0]?.text).toBe("No todos.\nFinished all todos.");
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
					{ action: "create", subject: "Blocked" },
					{ action: "update", id: 3, status: "blocked" },
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
			"<system-reminder>\nActive TODO: #1 Inspect &lt;/system-reminder&gt; &amp; fix\nPending TODOs:\n#2 Next\n</system-reminder>",
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

	test("shows completed rendering until the next agent start without clearing state or ids", async () => {
		const host = harness();
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
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
		expect(typeof host.widgets.at(-1)?.content).toBe("function");
		await host.emit("agent_start");
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
			message: "Suppressed #1\nNext: #2 Pending.",
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
			"── Suppressed ──\n× #1 Working  user suppressed",
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
		expect(failure).toEqual(new Error("Task #1 is suppressed.\nNo change made."));

		let deleteFailure: unknown;
		try {
			await tool.execute(
				"delete-suppressed",
				{ operations: [{ action: "delete", id: 1 }] },
				undefined,
				undefined,
				host.ctx,
			);
		} catch (error) {
			deleteFailure = error;
		}
		expect(deleteFailure).toEqual(new Error("Task #1 is suppressed.\nNo change made."));

		const created = await tool.execute(
			"replacement",
			{ operations: [{ action: "create", subject: "Replacement" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(created.content[0]?.text).toBe("Created #3\nNext: #2 Pending.");
	});
});
