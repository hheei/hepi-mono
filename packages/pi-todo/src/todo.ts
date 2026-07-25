import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "@hheei/pi-basics";
import { type Static, Type } from "typebox";
import {
	applyTodo,
	freshTaskState,
	suppressTodoByUser,
	type Task,
	type TaskState,
	type TaskStatus,
	type TodoOperation,
	type TodoOperationResult,
	type TodoParams,
} from "./model.js";
import { latestTodoSnapshot, snapshotFromState, TODO_STATE_CUSTOM_TYPE } from "./state.js";
import { createTodoWidget, type TodoWidget } from "./widget.js";

export const TODO_TOOL_NAME = "todo";
export const TODO_COMMAND_NAME = "todos";

export const TODO_REMINDER_IDLE_TURNS = 3;
export const TODO_REMINDER_IDLE_MS = 3 * 60_000;
const TODO_COMPLETED_HIDE_TURNS = 2;
const TODO_REMINDER_CUSTOM_TYPE = "pi-todo:reminder";

const taskStatus = Type.String({
	enum: ["pending", "in_progress", "blocked", "completed", "suppressed"],
});
const agentTaskStatus = Type.String({ enum: ["in_progress", "blocked", "completed"] });
const taskId = Type.Integer({ minimum: 1 });

const todoOperation = Type.Union([
	Type.Object(
		{
			action: Type.Literal("create"),
			subject: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("update"),
			id: taskId,
			subject: Type.Optional(Type.String({ minLength: 1 })),
			status: Type.Optional(agentTaskStatus),
		},
		{ additionalProperties: false, minProperties: 3 },
	),
	Type.Object(
		{
			action: Type.Literal("list"),
			status: Type.Optional(taskStatus),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("delete"),
			id: taskId,
		},
		{ additionalProperties: false },
	),
]);

export const TODO_PARAMETERS = Type.Object(
	{
		operations: Type.Array(todoOperation, {
			minItems: 1,
			description:
				"Ordered task operations. The complete batch validates before one atomic commit; list must be the only operation when used.",
		}),
	},
	{ additionalProperties: false },
);

export const TODO_TOOL_DESCRIPTION =
	"Maintain an atomic task list. Update only when state changes: use `blocked` when work cannot continue, `in_progress` when resuming, and `completed` after verification. Scheduling is automatic. Submit one `list` operation or an atomic batch of create, update, and delete operations. Follow the final guidance line returned by the tool.";
export const TODO_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with 3+ concrete steps or multiple user-requested tasks; skip trivial work.",
] as const;

interface ActiveTodoRuntime {
	readonly sessionId: string;
	state: TaskState;
	widget: TodoWidget | undefined;
	idleTurns: number;
	reminderWindowStartedAtMs: number;
	todoChangedThisTurn: boolean;
	todoUsedSinceSettled: boolean;
	completedIdleTurns: number;
	widgetHidden: boolean;
}

export interface TodoFeature {
	start(runtime: HePiRuntimeContext): void | Promise<void>;
	dispose(sessionId: string): void | Promise<void>;
}

export interface TodoFeatureOptions {
	readonly now?: () => number;
}

function escapeReminderText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function canonicalPositiveInteger(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : undefined;
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function prepareTodoArguments(value: unknown): Static<typeof TODO_PARAMETERS> {
	if (!value || typeof value !== "object") return value as Static<typeof TODO_PARAMETERS>;
	const params = value as Record<string, unknown>;
	if (!Array.isArray(params.operations)) return value as Static<typeof TODO_PARAMETERS>;
	return {
		...params,
		operations: params.operations.map((entry) => {
			if (!entry || typeof entry !== "object") return entry;
			const operation = { ...(entry as Record<string, unknown>) };
			const id = canonicalPositiveInteger(operation.id);
			if (id !== undefined) operation.id = id;
			return operation;
		}),
	} as Static<typeof TODO_PARAMETERS>;
}

function activeTodoTask(state: TaskState): Task | undefined {
	return state.tasks.find((task) => task.status === "in_progress");
}

function todoReminder(current: ActiveTodoRuntime): string | undefined {
	const activeTask = activeTodoTask(current.state);
	if (!activeTask) return undefined;
	const pending = current.state.tasks
		.filter((task) => task.status === "pending")
		.sort((left, right) => left.id - right.id)
		.map((task) => `#${task.id}`);
	return `<system-reminder>\nActive TODO: #${activeTask.id} ${escapeReminderText(activeTask.subject)}.\nPending TODOS: ${pending.length > 0 ? pending.join(", ") : "none"}\n</system-reminder>`;
}

function taskIds(state: TaskState, status: TaskStatus): string | undefined {
	const ids = state.tasks
		.filter((task) => task.status === status)
		.sort((left, right) => left.id - right.id)
		.map((task) => `#${task.id}`);
	return ids.length > 0 ? ids.join(" ") : undefined;
}

function formatTodoGuidance(state: TaskState): string {
	const active = activeTodoTask(state);
	if (active) return `Next: #${active.id} ${active.subject}.`;
	const blocked = taskIds(state, "blocked");
	if (blocked) return `Only blocked todos ${blocked} left. Discuss to the user.`;
	return "Finished all todos.";
}

function formatTaskLine(task: Task): string {
	const glyph =
		task.status === "completed"
			? "✓"
			: task.status === "in_progress"
				? "◐"
				: task.status === "blocked"
					? "⊘"
					: task.status === "suppressed"
						? "×"
						: "○";
	return `${glyph} #${task.id} ${task.subject}${task.status === "suppressed" ? "  user suppressed" : ""}`;
}

function formatTodoList(state: TaskState, status?: TaskStatus): string {
	const tasks = state.tasks
		.filter((task) => status === undefined || task.status === status)
		.sort((left, right) => left.id - right.id);
	if (tasks.length === 0) return "No todos.";
	return tasks.map((task) => formatTaskLine(task)).join("\n");
}

function formatTodosCommand(state: TaskState): string {
	if (state.tasks.length === 0) return "No todos.";
	const visible = state.tasks.filter((task) => task.status !== "suppressed");
	const completed = visible.filter((task) => task.status === "completed").length;
	const lines = [`${completed}/${visible.length} completed`];
	for (const status of ["in_progress", "pending", "blocked", "completed", "suppressed"] as const) {
		const tasks = state.tasks.filter((task) => task.status === status).sort((a, b) => a.id - b.id);
		if (tasks.length === 0) continue;
		lines.push(
			`── ${status === "in_progress" ? "In Progress" : status === "pending" ? "Pending" : status === "blocked" ? "Blocked" : status === "completed" ? "Completed" : "Suppressed"} ──`,
		);
		for (const task of tasks) lines.push(formatTaskLine(task));
	}
	return lines.join("\n");
}

function formatTodoOperationResult(
	operation: TodoOperation,
	result: TodoOperationResult,
	state: TaskState,
): string {
	switch (operation.action) {
		case "create":
			return result.id === undefined ? "Created task" : `Created #${result.id}`;
		case "update": {
			if (result.changed) return `Updated #${operation.id}`;
			const value = operation.status ?? operation.subject?.trim();
			return `#${operation.id} is already \`${value ?? "unchanged"}\``;
		}
		case "delete":
			return `Deleted #${operation.id}`;
		case "list":
			return formatTodoList(state, operation.status);
	}
}

function formatTodoResult(
	params: TodoParams,
	result: Extract<ReturnType<typeof applyTodo>, { ok: true }>,
): string {
	const lines: string[] = [];
	const createdIds = result.operations
		.filter((operation) => operation.action === "create" && operation.id !== undefined)
		.flatMap((operation) => (operation.id === undefined ? [] : [operation.id]));
	let createdReported = false;
	for (const operationResult of result.operations) {
		const operation = params.operations[operationResult.index];
		if (!operation) continue;
		if (operation.action === "create") {
			if (!createdReported) {
				lines.push(
					createdIds.length === 0
						? "Created task"
						: `Created ${createdIds.map((id) => `#${id}`).join(" ")}`,
				);
				createdReported = true;
			}
			continue;
		}
		lines.push(formatTodoOperationResult(operation, operationResult, result.state));
	}
	if (!result.changed && params.operations[0]?.action !== "list") {
		lines.push("No change made.");
		return lines.join("\n");
	}
	lines.push(formatTodoGuidance(result.state));
	return lines.join("\n");
}

function isStaleSessionContextError(error: unknown): boolean {
	return /stale after session replacement/.test(String(error));
}

export function createTodoFeature(pi: ExtensionAPI, options: TodoFeatureOptions = {}): TodoFeature {
	let active: ActiveTodoRuntime | undefined;
	const now = options.now ?? (() => performance.now());

	const refreshFromBranch = (kind: "compact" | "tree", ctx: ExtensionContext): void => {
		try {
			const current = active;
			if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
			const restored = latestTodoSnapshot(ctx.sessionManager.getBranch());
			if (restored) current.state = restored;
			else if (kind === "tree") current.state = freshTaskState();
			if (kind === "tree") {
				current.idleTurns = 0;
				current.reminderWindowStartedAtMs = now();
				current.todoChangedThisTurn = false;
				current.todoUsedSinceSettled = false;
				current.completedIdleTurns = 0;
				current.widgetHidden = false;
			}
			if (current.widgetHidden) current.widget?.hide();
			else current.widget?.refresh(current.state);
		} catch (error) {
			if (!isStaleSessionContextError(error)) throw error;
		}
	};

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Todo",
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet: TODO_PROMPT_SNIPPET,
		promptGuidelines: [...TODO_PROMPT_GUIDELINES],
		parameters: TODO_PARAMETERS,
		prepareArguments: prepareTodoArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const current = active;
			if (!current || current.sessionId !== ctx.sessionManager.getSessionId())
				throw new Error("Todo runtime is not active");
			const todoParams = params as TodoParams;
			const result = applyTodo(current.state, todoParams);
			if (!result.ok) {
				const message = result.error.endsWith(".") ? result.error : `${result.error}.`;
				throw new Error(`${message}\nNo change made.`);
			}
			if (result.changed) {
				current.state = result.state;
				current.idleTurns = 0;
				current.reminderWindowStartedAtMs = now();
				current.todoChangedThisTurn = true;
			}
			current.todoUsedSinceSettled = true;
			current.completedIdleTurns = 0;
			current.widgetHidden = false;
			return {
				content: [{ type: "text", text: formatTodoResult(todoParams, result) }],
				details: { snapshot: snapshotFromState(current.state) },
			};
		},
	});

	pi.registerCommand(TODO_COMMAND_NAME, {
		description: "Show todos or suppress one as the user",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const current = active;
			if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) {
				ctx.ui.notify("Todo runtime is not active", "error");
				return;
			}
			const input = args.trim();
			if (input === "") {
				ctx.ui.notify(formatTodosCommand(current.state), "info");
				return;
			}
			const match = /^suppress\s+#?([1-9]\d*)$/i.exec(input);
			const id = canonicalPositiveInteger(match?.[1]);
			if (id === undefined) {
				ctx.ui.notify("Usage: /todos [suppress #ID]", "error");
				return;
			}
			const result = suppressTodoByUser(current.state, id);
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			if (!result.changed) {
				ctx.ui.notify(`Todo #${id} is already suppressed`, "info");
				return;
			}
			try {
				pi.appendEntry(TODO_STATE_CUSTOM_TYPE, snapshotFromState(result.state));
			} catch (error) {
				ctx.ui.notify(
					`Could not persist Todo suppression: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			current.state = result.state;
			current.idleTurns = 0;
			current.reminderWindowStartedAtMs = now();
			current.todoChangedThisTurn = true;
			current.completedIdleTurns = 0;
			current.widgetHidden = false;
			current.widget?.refresh(current.state);
			const lines = [`Suppressed #${id}`, formatTodoGuidance(result.state)];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("context", async (event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		if (!pi.getActiveTools().includes(TODO_TOOL_NAME)) return;
		if (
			current.idleTurns < TODO_REMINDER_IDLE_TURNS ||
			now() - current.reminderWindowStartedAtMs < TODO_REMINDER_IDLE_MS
		)
			return;
		const content = todoReminder(current);
		if (!content) return;
		current.idleTurns = 0;
		current.reminderWindowStartedAtMs = now();
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: TODO_REMINDER_CUSTOM_TYPE,
					content,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
	pi.on("turn_start", async (_event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		current.todoChangedThisTurn = false;
	});
	pi.on("turn_end", async (event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		if (current.todoChangedThisTurn) {
			current.todoChangedThisTurn = false;
			return;
		}
		if (!activeTodoTask(current.state)) {
			current.idleTurns = 0;
			current.reminderWindowStartedAtMs = now();
			return;
		}
		if (
			event.message.role !== "assistant" ||
			event.message.stopReason === "error" ||
			event.message.stopReason === "aborted"
		)
			return;
		current.idleTurns++;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		const incomplete = current.state.tasks.some(
			(task) =>
				task.status === "pending" || task.status === "in_progress" || task.status === "blocked",
		);
		if (incomplete) {
			current.completedIdleTurns = 0;
			current.todoUsedSinceSettled = false;
			return;
		}
		if (current.state.tasks.length === 0 || current.todoUsedSinceSettled) {
			current.completedIdleTurns = 0;
			current.todoUsedSinceSettled = false;
			return;
		}
		current.completedIdleTurns++;
		if (current.completedIdleTurns >= TODO_COMPLETED_HIDE_TURNS) {
			current.widgetHidden = true;
			current.widget?.hide();
		}
		current.todoUsedSinceSettled = false;
	});

	pi.on("session_compact", async (_event, ctx) => refreshFromBranch("compact", ctx));
	pi.on("session_tree", async (_event, ctx) => refreshFromBranch("tree", ctx));
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== TODO_TOOL_NAME || event.isError) return;
		try {
			const current = active;
			if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
			current.widget?.refresh(current.state);
		} catch {
			// Widget refresh is best-effort; the successful tool snapshot remains durable.
		}
	});

	return {
		start(runtime) {
			const state = latestTodoSnapshot(runtime.ctx.sessionManager.getBranch()) ?? freshTaskState();
			const current: ActiveTodoRuntime = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				state,
				idleTurns: 0,
				reminderWindowStartedAtMs: now(),
				todoChangedThisTurn: false,
				todoUsedSinceSettled: false,
				completedIdleTurns: 0,
				widget: undefined,
				widgetHidden: false,
			};
			current.widget = createTodoWidget(runtime, state);
			active = current;
		},
		async dispose(sessionId) {
			const current = active;
			if (!current || current.sessionId !== sessionId) return;
			try {
				await current.widget?.dispose();
			} finally {
				if (active === current) active = undefined;
			}
		},
	};
}
