import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TodoSnapshot } from "../../src/todo/state.js";
import {
	createTodoFeature,
	TODO_PARAMETERS,
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODO_REMINDER_IDLE_MS,
	TODO_REMINDER_IDLE_TURNS,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_NAME,
} from "../../src/todo/todo.js";
import { plainTheme } from "../fixtures/theme.js";

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
		result: {
			readonly content?: readonly { readonly type: string; readonly text?: string }[];
			readonly details?: unknown;
		},
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

function renderToolComponent(value: unknown): string {
	if (!value || typeof value !== "object" || !("render" in value))
		throw new Error("Expected a renderable tool component");
	const component = value as { readonly render?: (width: number) => readonly string[] };
	if (typeof component.render !== "function")
		throw new Error("Expected a tool component render function");
	return component.render(120).join("\n");
}

function harness(mode: "tui" | "json" = "tui", sessionId = "todo-session") {
	const tools: RegisteredTool[] = [];
	const commands: Array<{
		readonly name: string;
		readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		readonly getArgumentCompletions?:
			| ((prefix: string) => { value: string; label: string }[] | null)
			| undefined;
	}> = [];
	const events = new Map<
		string,
		Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>>
	>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
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
			options: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
				getArgumentCompletions?:
					| ((prefix: string) => { value: string; label: string }[] | null)
					| undefined;
			},
		) {
			commands.push({
				name,
				handler: options.handler,
				getArgumentCompletions: options.getArgumentCompletions,
			});
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
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			theme: plainTheme,
			setWidget(key: string, content: unknown, options?: unknown) {
				widgets.push({ key, content, options });
			},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;
	const runtime = ctx;
	return {
		pi,
		ctx,
		runtime,
		tools,
		commands,
		events,
		notifications,
		statuses,
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
	afterEach(() => {
		vi.useRealTimers();
	});

	test("registers sourced batch schema, prompt, command, and lifecycle hooks", () => {
		const host = harness();
		createTodoFeature(host.pi);
		const tool = host.tools[0]!;

		expect(host.commands.map(({ name }) => name)).toEqual(["todo"]);
		expect(host.commands[0]!.getArgumentCompletions?.("cl")).toEqual([
			{ value: "clear", label: "clear" },
		]);
		expect(host.tools.map(({ name }) => name)).toEqual(["todo"]);
		expect(tool.executionMode).toBe("sequential");
		expect(tool.description).toBe(TODO_TOOL_DESCRIPTION);
		expect(tool.promptSnippet).toBe(TODO_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toEqual([...TODO_PROMPT_GUIDELINES]);
		expect(TODO_PROMPT_GUIDELINES).toEqual([
			"Use `todo` for work with 3+ concrete steps or multiple user-requested tasks; skip trivial work.",
			"Create the full known task list in one atomic batch. Keep subjects short, imperative, and outcome-oriented; do not add bookkeeping tasks for routine commands.",
			"Scheduling is automatic; active task is already in_progress. Update only when state changes: use `completed` after verification, `blocked` only when work cannot continue, and `in_progress` to switch active work or resume blocked work. Do not repeatedly list or restate current state.",
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
		).toBe(true);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "create", subject: "Task", status: "in_progress" }],
			}),
		).toBe(true);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "create", subject: "Task", status: "suppressed" }],
			}),
		).toBe(false);
		expect(
			Value.Check(TODO_PARAMETERS, {
				operations: [{ action: "create", subject: "Task", status: "invalid" }],
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
		expect(host.events.has("session_tree")).toBe(true);
		expect(host.events.has("tool_execution_end")).toBe(true);
		expect(host.events.has("context")).toBe(true);
		expect(host.events.has("turn_start")).toBe(true);
		expect(host.events.has("turn_end")).toBe(true);
	});

	test("renders current result state", async () => {
		const host = harness("json");
		const feature = createTodoFeature(host.pi);
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			strikethrough: (text: string) => `~${text}~`,
		};

		const createParams = { operations: [{ action: "create", subject: "First" }] };
		const created = await tool.execute("create", createParams, undefined, undefined, host.ctx);
		const active = tool.renderResult?.(created, {}, theme, { isError: false });
		expect(renderToolComponent(active)).toContain("󰪠 #1 First");

		const completed = await tool.execute(
			"complete",
			{ operations: [{ action: "update", id: 1, status: "completed" }] },
			undefined,
			undefined,
			host.ctx,
		);
		const done = tool.renderResult?.(completed, {}, theme, { isError: false });
		expect(renderToolComponent(done)).toContain("󰄴 #1 ~First~");

		const nextParams = {
			operations: [
				{ action: "create", subject: "Second" },
				{ action: "create", subject: "Third" },
			],
		};
		await tool.execute("create-next", nextParams, undefined, undefined, host.ctx);

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
		const blocked = tool.renderResult?.(blockedResult, {}, theme, { isError: false });
		expect(renderToolComponent(blocked)).toContain("󰀪 #3 ~Third~");

		const failed = tool.renderResult?.(
			{ content: [] },
			{},
			{ fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			{ isError: true },
		);
		expect(renderToolComponent(failed)).toContain("<error>Error</error>");
	});

	test("executes ordered atomic batches and returns display snapshots", async () => {
		const host = harness("json");
		const feature = createTodoFeature(host.pi, { clock: () => 1_000 });
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
		expect(created.content[0]?.text).toBe("Created #1 #2\nin_progress: #1 First.");
		expect(created.details.snapshot).toEqual({
			tasks: [
				{ id: 1, subject: "First", status: "in_progress", updatedAt: 1_000 },
				{ id: 2, subject: "Second", status: "pending", updatedAt: 1_000 },
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
		expect(mixed.content[0]?.text).toBe("Updated #1\nCreated #3\nin_progress: #2 Second.");
		expect(mixed.details.snapshot).toEqual({
			tasks: [
				{ id: 1, subject: "First", status: "blocked", updatedAt: 1_000 },
				{ id: 2, subject: "Second", status: "in_progress", updatedAt: 1_000 },
				{ id: 3, subject: "Replacement", status: "pending", updatedAt: 1_000 },
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
		expect(listed.content[0]?.text).toContain("󰪠 #2 Second");
		expect(listed.content[0]?.text).toContain("󰀪 #1 First");
		expect(listed.content[0]?.text?.endsWith("in_progress: #2 Second.")).toBe(true);

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
			"#2 is already `Second`\nUpdated #3\nin_progress: #2 Second.",
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
		expect(allBlocked.content[0]?.text).toBe("Updated #2\nUpdated #3\nFinished all todos.");
	});

	test("keeps failed and aborted calls out of runtime state", async () => {
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

	test("restores the active branch state on startup and session tree navigation", async () => {
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
		expect(listed.content[0]?.text).toBe("󰪠 #1 Restored\nin_progress: #1 Restored.");
		host.setBranch([
			branchResult({
				tasks: [{ id: 2, subject: "Tree state", status: "pending" }],
				nextId: 3,
			}),
		]);

		await host.emit("session_tree");
		listed = await tool.execute(
			"list-2",
			{ operations: [{ action: "list" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(listed.content[0]?.text).toBe("󰪠 #2 Tree state\nin_progress: #2 Tree state.");
	});

	test("updates footer status on task status transitions and hides after window expires", async () => {
		vi.useFakeTimers();
		const host = harness();
		let clock = 100_000;
		const feature = createTodoFeature(host.pi, { clock: () => clock });
		await feature.start(host.runtime);
		const tool = host.tools[0]!;

		// Initially empty -> status undefined
		expect(host.statuses.at(-1)?.text).toBeUndefined();

		// Create active task -> 󰪠 #1 Work
		await tool.execute(
			"create",
			{ operations: [{ action: "create", subject: "Work" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(host.statuses.at(-1)?.text).toBe("󰪠 #1 Work");

		// Complete task -> 󰄴 #1 Work
		await tool.execute(
			"complete",
			{ operations: [{ action: "update", id: 1, status: "completed" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(host.statuses.at(-1)?.text).toBe("󰄴 #1 Work");

		// After 3 minutes, completed task expires -> undefined
		clock += 3 * 60 * 1000 + 1;
		vi.advanceTimersByTime(3 * 60 * 1000 + 1);
		expect(host.statuses.at(-1)?.text).toBeUndefined();

		// Create another and block it -> 󰀪 #2 Blocked
		await tool.execute(
			"create2",
			{ operations: [{ action: "create", subject: "Blocked task", status: "blocked" }] },
			undefined,
			undefined,
			host.ctx,
		);
		expect(host.statuses.at(-1)?.text).toBe("󰀪 #2 Blocked task");

		// After 15 seconds, blocked task expires -> undefined
		clock += 15 * 1000 + 1;
		vi.advanceTimersByTime(15 * 1000 + 1);
		expect(host.statuses.at(-1)?.text).toBeUndefined();

		// Create two tasks: #3 and #4
		clock += 1000;
		await tool.execute(
			"create-multi",
			{
				operations: [
					{ action: "create", subject: "First step" },
					{ action: "create", subject: "Second step" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(host.statuses.at(-1)?.text).toBe("󰪠 #3 First step");

		// Complete #3 -> #4 auto-advances to in_progress
		clock += 1000;
		await tool.execute(
			"complete-first",
			{ operations: [{ action: "update", id: 3, status: "completed" }] },
			undefined,
			undefined,
			host.ctx,
		);
		// Shows completed #3 for 15 seconds even though #4 is in_progress
		expect(host.statuses.at(-1)?.text).toBe("󰄴 #3 First step");

		// After 15 seconds, transitions to in_progress #4
		clock += 15 * 1000 + 1;
		vi.advanceTimersByTime(15 * 1000 + 1);
		expect(host.statuses.at(-1)?.text).toBe("󰪠 #4 Second step");
	});

	test("injects a transient repeating reminder after turn and time thresholds", async () => {
		const host = harness();
		let clock = 0;
		const feature = createTodoFeature(host.pi, { now: () => clock });
		await feature.start(host.runtime);
		const tool = host.tools[0]!;
		await tool.execute(
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
			customType: "pi-ext-tools:todo:reminder",
			display: false,
		});
		expect(reminder.messages[1]?.content).toBe(
			"<system-reminder>\nActive TODO: #1 Inspect &lt;/system-reminder&gt; &amp; fix\nPending TODOs:\n#2 Next\n</system-reminder>",
		);
		expect(host.ctx.sessionManager.getBranch()).toHaveLength(0);
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

		await host.commands[0]!.handler("cancel #1", host.ctx);
		await host.commands[0]!.handler("cancel #2", host.ctx);
		clock += TODO_REMINDER_IDLE_MS;
		for (let turn = 0; turn < TODO_REMINDER_IDLE_TURNS; turn++) {
			await host.emit("turn_start");
			await host.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
		}
		expect(
			(await host.emit("context", { messages: [{ role: "user", content: "paused" }] }))[0],
		).toBeUndefined();
	});

	test("supports /todo subcommands: default, list, clear, and cancel", async () => {
		const host = harness();
		const clock = 100_000;
		const feature = createTodoFeature(host.pi, { clock: () => clock });
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

		// /todo (default: active + recent)
		await host.commands[0]!.handler("", host.ctx);
		expect(host.notifications[0]).toEqual({
			message: "── Active ──\n󰪠 #1 Working\n󰄰 #2 Pending",
			level: "info",
		});

		// /todo list (all) - case-insensitive
		await host.commands[0]!.handler("LIST", host.ctx);
		expect(host.notifications[1]).toEqual({
			message: "0/2 completed\n── In Progress ──\n󰪠 #1 Working\n── Pending ──\n󰄰 #2 Pending",
			level: "info",
		});

		// /todo invalid / pseudo-cancel command does not match cancel prefix
		await host.commands[0]!.handler("cancelXYZ", host.ctx);
		expect(host.notifications[2]).toEqual({
			message: "Usage: /todo [list | clear | cancel #ID...]",
			level: "error",
		});

		// /todo list extra tokens
		await host.commands[0]!.handler("list extra", host.ctx);
		expect(host.notifications[3]).toEqual({
			message: "Usage: /todo [list | clear | cancel #ID...]",
			level: "error",
		});

		// /todo cancel with no args
		await host.commands[0]!.handler("cancel", host.ctx);
		expect(host.notifications[4]).toEqual({
			message: "Usage: /todo cancel #ID...",
			level: "error",
		});

		// /todo cancel #1 - case-insensitive
		await host.commands[0]!.handler("Cancel #1", host.ctx);
		expect(host.notifications[5]).toEqual({
			message: "Cancelled #1\nin_progress: #2 Pending.",
			level: "info",
		});
		expect(host.appended).toEqual([
			{
				type: "custom",
				customType: "pi-ext-tools:todo:state",
				data: {
					tasks: [
						{ id: 1, subject: "Working", status: "suppressed", updatedAt: 100_000 },
						{ id: 2, subject: "Pending", status: "in_progress", updatedAt: 100_000 },
					],
					nextId: 3,
				},
			},
		]);

		// Cannot modify cancelled/suppressed task by agent
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

		// /todo clear
		await host.commands[0]!.handler("clear", host.ctx);
		expect(host.notifications.at(-1)).toEqual({
			message: "Cleared all todos.",
			level: "info",
		});
		expect(host.statuses.at(-1)?.text).toBeUndefined();

		// /todo after clear
		await host.commands[0]!.handler("", host.ctx);
		expect(host.notifications.at(-1)).toEqual({
			message: "No active or recent todos. Use /todo list to view all.",
			level: "info",
		});
	});

	test("accepts optional status in create operations", async () => {
		const host = harness("json");
		const feature = createTodoFeature(host.pi, { now: () => 1_000, clock: () => 1_000 });
		await feature.start(host.runtime);
		const tool = host.tools[0]!;

		const created = await tool.execute(
			"call-with-status",
			{
				operations: [
					{ action: "create", subject: "Initial Active", status: "in_progress" },
					{ action: "create", subject: "Initial Pending", status: "pending" },
				],
			},
			undefined,
			undefined,
			host.ctx,
		);
		expect(created.content[0]?.text).toBe("Created #1 #2\nin_progress: #1 Initial Active.");
		expect(created.details.snapshot).toEqual({
			tasks: [
				{ id: 1, subject: "Initial Active", status: "in_progress", updatedAt: 1_000 },
				{ id: 2, subject: "Initial Pending", status: "pending", updatedAt: 1_000 },
			],
			nextId: 3,
		});

		await feature.dispose(host.ctx.sessionManager.getSessionId());
	});
});
