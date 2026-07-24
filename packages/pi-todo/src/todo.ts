import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "@hheei/pi-basics";
import { type Static, Type } from "typebox";
import {
	applyTodo,
	freshTaskState,
	type Task,
	type TaskState,
	type TaskStatus,
	type TodoOperation,
	type TodoOperationResult,
	type TodoParams,
} from "./model.js";
import { latestTodoSnapshot, snapshotFromState } from "./state.js";
import { createTodoWidget, type TodoWidget } from "./widget.js";

export const TODO_TOOL_NAME = "todo";
export const TODO_COMMAND_NAME = "todos";

export const TODO_REMINDER_IDLE_TURNS = 3;
export const TODO_REMINDER_IDLE_MS = 3 * 60_000;
const TODO_COMPLETED_HIDE_TURNS = 2;
const TODO_REMINDER_CUSTOM_TYPE = "pi-todo:reminder";

const taskStatus = Type.String({ enum: ["pending", "in_progress", "completed"] });
const taskId = Type.Integer({ minimum: 1 });
const blockedBy = Type.Array(taskId);

const todoOperation = Type.Union([
	Type.Object(
		{
			action: Type.Literal("create"),
			subject: Type.String({ minLength: 1 }),
			blockedBy: Type.Optional(blockedBy),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("update"),
			id: taskId,
			subject: Type.Optional(Type.String({ minLength: 1 })),
			status: Type.Optional(taskStatus),
			blockedBy: Type.Optional(blockedBy),
		},
		{ additionalProperties: false },
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
	"Create and maintain a structured task list for the current coding session. Submit ordered create, update, or delete operations atomically; list must be the only operation when used.";
export const TODO_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for complex work with 3+ distinct steps, when the user provides multiple tasks, or after new instructions. Skip single trivial or purely conversational requests.",
	"The first runnable task starts automatically, and completing or deleting it starts the next runnable task. Explicitly set a task to `pending` to pause; do not send a separate update solely to start the next task.",
	"Never mark a task `completed` when work is partial, failing, or blocked; keep it `in_progress` and add a task for the blocker.",
	"When several task changes are already known, submit them together in one `operations` batch to reduce tool calls; never infer deletion from omitted tasks.",
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
			if (Array.isArray(operation.blockedBy)) {
				operation.blockedBy = operation.blockedBy.map(
					(item) => canonicalPositiveInteger(item) ?? item,
				);
			}
			return operation;
		}),
	} as Static<typeof TODO_PARAMETERS>;
}

function unresolvedBlockers(task: Task, state: TaskState): number[] {
	const tasks = new Map(state.tasks.map((candidate) => [candidate.id, candidate]));
	return task.blockedBy.filter((id) => tasks.get(id)?.status !== "completed");
}

function activeTodoTask(state: TaskState): Task | undefined {
	return state.tasks.find((task) => task.status === "in_progress");
}

function todoReminder(current: ActiveTodoRuntime): string | undefined {
	const activeTask = activeTodoTask(current.state);
	if (!activeTask) return undefined;
	const unfinished = current.state.tasks.filter((task) => task.status !== "completed").length;
	return `<system-reminder>\nActive TODO #${activeTask.id}: ${escapeReminderText(activeTask.subject)}.\n${unfinished} unfinished ${unfinished === 1 ? "task remains" : "tasks remain"}. Continue the active task. Use \`todo\` only when progress changes; do not call it merely to acknowledge this reminder.\n</system-reminder>`;
}

function formatTaskLine(task: Task, state: TaskState): string {
	const glyph = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○";
	const blockedBy = unresolvedBlockers(task, state);
	return `${glyph} #${task.id} ${task.subject}${blockedBy.length > 0 ? `  blocked by ${blockedBy.map((id) => `#${id}`).join(",")}` : ""}`;
}

function formatTodoList(state: TaskState, status?: TaskStatus): string {
	const tasks = state.tasks
		.filter((task) => status === undefined || task.status === status)
		.sort((left, right) => left.id - right.id);
	if (tasks.length === 0) return "No todos.";
	return tasks.map((task) => formatTaskLine(task, state)).join("\n");
}

function formatTodosCommand(state: TaskState): string {
	if (state.tasks.length === 0) return "No todos.";
	const completed = state.tasks.filter((task) => task.status === "completed").length;
	const lines = [`${completed}/${state.tasks.length} completed`];
	for (const status of ["in_progress", "pending", "completed"] as const) {
		const tasks = state.tasks.filter((task) => task.status === status).sort((a, b) => a.id - b.id);
		if (tasks.length === 0) continue;
		lines.push(
			`── ${status === "in_progress" ? "In Progress" : status === "pending" ? "Pending" : "Completed"} ──`,
		);
		for (const task of tasks) lines.push(formatTaskLine(task, state));
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
		case "update":
			return result.changed
				? `Updated #${operation.id}`
				: `No change: #${operation.id} already matches the requested values`;
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
	if (result.autoStartedId !== undefined) {
		const task = result.state.tasks.find(({ id }) => id === result.autoStartedId);
		if (task) lines.push(`Started #${task.id}: ${task.subject}`);
	}
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
				const prefix =
					result.operationIndex === undefined ? "" : `Operation #${result.operationIndex + 1}: `;
				throw new Error(`${prefix}${result.error}`);
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
		description: "Show current todos",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /todos", "error");
				return;
			}
			const current = active;
			if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) {
				ctx.ui.notify("Todo runtime is not active", "error");
				return;
			}
			ctx.ui.notify(formatTodosCommand(current.state), "info");
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
		const incomplete = current.state.tasks.some((task) => task.status !== "completed");
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
