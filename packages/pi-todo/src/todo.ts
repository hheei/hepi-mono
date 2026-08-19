import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getToolTui, registerManagedLoadoutTool, registerToolTuiTrace } from "@hheei/pi-ext-core";
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
import { snapshotFromState, stateFromSnapshot } from "./state.js";
import { createTodoWidget, type TodoWidget } from "./widget.js";

export const TODO_TOOL_NAME = "todo";
export const TODO_COMMAND_NAME = "todos";

/**
 * Core owns the Pi registration transport for every HEPI executable tool. This
 * stable owner permits a new Pi runner to replace this declaration on /reload
 * without allowing a different extension to claim `todo`. Loadout is optional:
 * absent its policy engine, Pi keeps this default-active tool available.
 */
const TODO_LOADOUT_REGISTRATION = {
	id: TODO_TOOL_NAME,
	owner: "@hheei/pi-todo",
	group: "Tasks",
	priority: 100,
	conflictSets: [],
	defaultActive: true,
} as const;

export const TODO_REMINDER_IDLE_TURNS = 3;
export const TODO_REMINDER_IDLE_MS = 3 * 60_000;
const TODO_REMINDER_CUSTOM_TYPE = "pi-todo:reminder";
const TODO_STATE_CUSTOM_TYPE = "pi-todo:state";
const TODO_MAX_BODY_ROWS = 8;

const todoTaskStatus = Type.String({
	enum: ["pending", "in_progress", "blocked", "completed", "suppressed"],
});
const agentTaskStatus = Type.String({ enum: ["pending", "in_progress", "blocked", "completed"] });
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
			status: Type.Optional(todoTaskStatus),
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
	"Maintain an atomic task list. Scheduling is automatic. Create known tasks in one batch; update only when state changes; use `blocked` when work cannot continue, `in_progress` to switch active work or resume blocked work, and `completed` after verification. Submit one `list` operation or an atomic batch of create, update, and delete operations. Follow the final guidance line returned by the tool.";
export const TODO_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with 3+ concrete steps or multiple user-requested tasks; skip trivial work.",
	"Create the full known task list in one atomic batch. Keep subjects short, imperative, and outcome-oriented; do not add bookkeeping tasks for routine commands.",
	"Scheduling is automatic. Update only when state changes: use `completed` after verification, `blocked` only when work cannot continue, and `in_progress` to switch active work or resume blocked work. Do not repeatedly list or restate current state.",
] as const;

/**
 * Mutable task, widget, and timer state belongs to one live Pi session. Pi
 * cannot unregister event handlers, so every handler below reads this reference
 * and validates the session ID; lifecycle disposal clears it and turns stale
 * closures into no-ops.
 */
interface ActiveTodoRuntime {
	readonly sessionId: string;
	state: TaskState;
	widget: TodoWidget | undefined;
	idleTurns: number;
	reminderWindowStartedAtMs: number;
	todoChangedThisTurn: boolean;
	blockedQuietTurns: Map<number, number>;
}

/** Restores the latest durable snapshot on the active session branch. */
function restoreTodoState(context: ExtensionContext): TaskState {
	const entries = context.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined) continue;
		if (entry.type === "custom" && entry.customType === TODO_STATE_CUSTOM_TYPE) {
			const state = stateFromSnapshot(entry.data);
			if (state) return state;
			continue;
		}
		if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === TODO_TOOL_NAME
		) {
			const state = stateFromSnapshot(entry.message.details?.snapshot);
			if (state) return state;
		}
	}
	return freshTaskState();
}

export interface TodoFeature {
	/** Starts fresh session-local task state and installs feature-owned hooks. */
	start(context: ExtensionContext, signal?: AbortSignal): void | Promise<void>;
	/** Idempotently clears widget, reminders, timers, and stale event state. */
	dispose(sessionId: string): void | Promise<void>;
}

export interface TodoFeatureOptions {
	readonly now?: () => number;
}

/**
 * Pi may pass numeric IDs as strings at the tool boundary. Normalize only that
 * compatibility form here; TypeBox and the model still validate the complete
 * operation so this helper cannot make an invalid batch partially acceptable.
 */
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

function escapeReminderText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function todoReminder(current: ActiveTodoRuntime): string | undefined {
	const activeTask = activeTodoTask(current.state);
	if (!activeTask) return undefined;
	const pending = current.state.tasks
		.filter((task) => task.status === "pending")
		.sort((left, right) => left.id - right.id);
	const lines = [
		"<system-reminder>",
		`Active TODO: #${activeTask.id} ${escapeReminderText(activeTask.subject)}`,
	];
	if (pending.length > 0) {
		lines.push("Pending TODOs:");
		for (const task of pending) lines.push(`#${task.id} ${escapeReminderText(task.subject)}`);
	}
	lines.push("</system-reminder>");
	return lines.join("\n");
}

function formatTodoGuidance(state: TaskState): string {
	const active = activeTodoTask(state);
	if (active) return `Next: #${active.id} ${active.subject}.`;
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

function taskStatus(value: unknown): TaskStatus | undefined {
	return value === "pending" ||
		value === "in_progress" ||
		value === "blocked" ||
		value === "completed" ||
		value === "suppressed"
		? value
		: undefined;
}

interface TodoToolDetails {
	readonly state: TaskState;
	readonly operations: readonly TodoOperationResult[];
	readonly listStatus?: TaskStatus;
}

function readTodoToolDetails(value: unknown): TodoToolDetails | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const details = value as Record<string, unknown>;
	const state = stateFromSnapshot(details.snapshot);
	if (!state || !Array.isArray(details.operations)) return undefined;
	const operations: TodoOperationResult[] = [];
	for (const value of details.operations) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const operation = value as Record<string, unknown>;
		const action = operation.action;
		if (
			typeof operation.index !== "number" ||
			!Number.isSafeInteger(operation.index) ||
			operation.index < 0 ||
			typeof operation.changed !== "boolean" ||
			(action !== "create" && action !== "update" && action !== "list" && action !== "delete")
		)
			return undefined;
		const id = canonicalPositiveInteger(operation.id);
		if (operation.id !== undefined && id === undefined) return undefined;
		operations.push({
			index: operation.index,
			action,
			changed: operation.changed,
			...(id === undefined ? {} : { id }),
		});
	}
	const listStatus = taskStatus(details.listStatus);
	if (details.listStatus !== undefined && listStatus === undefined) return undefined;
	return { state, operations, ...(listStatus === undefined ? {} : { listStatus }) };
}

function parseTaskId(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return Number(value);
	return undefined;
}

function pushTaskId(ids: number[], value: unknown): void {
	const id = parseTaskId(value);
	if (id === undefined || ids.includes(id)) return;
	ids.push(id);
}

function formatTodoIds(ids: readonly number[]): string {
	return ids.map((id) => `#${id}`).join(" ");
}

function listedTaskIds(details: TodoToolDetails): number[] {
	return details.state.tasks
		.filter(
			(task) =>
				task.status !== "suppressed" &&
				(details.listStatus === undefined || task.status === details.listStatus),
		)
		.map((task) => task.id)
		.sort((left, right) => left - right);
}

function isListDetails(details: TodoToolDetails): boolean {
	return (
		details.listStatus !== undefined ||
		details.operations.some((operation) => operation.action === "list")
	);
}

function todoHeaderIds(value: unknown, latest: { readonly details?: unknown } | undefined): string {
	const details = latest === undefined ? undefined : readTodoToolDetails(latest.details);
	if (details !== undefined) {
		if (isListDetails(details)) return formatTodoIds(listedTaskIds(details));
		const ids: number[] = [];
		for (const operation of details.operations) {
			if (operation.changed) pushTaskId(ids, operation.id);
		}
		return formatTodoIds(ids);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const operations = (value as { readonly operations?: unknown }).operations;
	if (!Array.isArray(operations)) return "";
	const ids: number[] = [];
	for (const operation of operations) {
		if (typeof operation !== "object" || operation === null || Array.isArray(operation)) continue;
		const record = operation as Record<string, unknown>;
		if (record.action === "list") continue;
		pushTaskId(ids, record.id);
	}
	return formatTodoIds(ids);
}

function taskRow(task: Task, theme: Theme): string {
	const glyph =
		task.status === "completed"
			? theme.fg("success", "✓")
			: task.status === "in_progress"
				? theme.fg("warning", "◐")
				: task.status === "blocked"
					? theme.fg("dim", "⊘")
					: theme.fg("muted", "○");
	const subject =
		task.status === "completed" || task.status === "blocked"
			? theme.fg("dim", theme.strikethrough(task.subject))
			: theme.fg("text", task.subject);
	return `${glyph} ${theme.fg("accent", `#${task.id}`)} ${subject}`;
}

function taskRows(
	state: TaskState,
	status: TaskStatus | undefined,
	theme: Theme,
	expanded: boolean,
): string[] {
	const selected = state.tasks
		.filter(
			(task) => task.status !== "suppressed" && (status === undefined || task.status === status),
		)
		.slice()
		.sort((left, right) => {
			const rank = (task: Task): number =>
				task.status === "in_progress"
					? 0
					: task.status === "pending"
						? 1
						: task.status === "blocked"
							? 2
							: 3;
			return rank(left) - rank(right) || left.id - right.id;
		});
	const visible = expanded ? selected : selected.slice(0, TODO_MAX_BODY_ROWS);
	const rows: string[] = [];
	for (const currentStatus of ["in_progress", "pending", "blocked", "completed"] as const) {
		const group = visible.filter((task) => task.status === currentStatus);
		if (group.length === 0) continue;
		rows.push(theme.fg("dim", currentStatus.replaceAll("_", " ")));
		for (const task of group) rows.push(taskRow(task, theme));
	}
	if (selected.length > visible.length)
		rows.push(theme.fg("dim", `… +${selected.length - visible.length} more`));
	return rows.length === 0 ? [theme.fg("dim", "No tasks.")] : rows;
}

function mutationRows(details: TodoToolDetails, theme: Theme): string[] {
	const rows = details.operations
		.filter((operation) => operation.changed)
		.map((operation) => {
			const task = details.state.tasks.find((candidate) => candidate.id === operation.id);
			if (operation.action === "delete") return theme.fg("dim", `− #${operation.id ?? "?"}`);
			if (operation.action === "create")
				return task === undefined ? `+ #${operation.id ?? "?"}` : `+ ${taskRow(task, theme)}`;
			return task === undefined ? `#${operation.id ?? "?"}` : taskRow(task, theme);
		});
	return rows.length === 0 ? [theme.fg("dim", "No changes.")] : rows;
}

function todoResultText(result: {
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
}): string {
	return (result.content ?? [])
		.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function renderTodoToolTuiResult(
	result: {
		readonly content?: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: unknown;
	},
	theme: Theme,
	isError: boolean,
	expanded: boolean,
): Text {
	if (isError) return new Text(theme.fg("error", todoResultText(result) || "Error"), 0, 0);
	const details = readTodoToolDetails(result.details);
	if (details === undefined) return new Text(theme.fg("dim", "No Todo state."), 0, 0);
	const rows =
		details.listStatus !== undefined ||
		details.operations.some((operation) => operation.action === "list")
			? taskRows(details.state, details.listStatus, theme, expanded)
			: mutationRows(details, theme);
	return new Text(rows.join("\n"), 0, 0);
}

function todoToolTuiFooter(
	result: { readonly details?: unknown },
	completion: { readonly durationMs?: number } | undefined,
): string | undefined {
	const details = readTodoToolDetails(result.details);
	if (details === undefined) return undefined;
	const tasks = details.state.tasks.filter(
		(task) =>
			task.status !== "suppressed" &&
			(details.listStatus === undefined || task.status === details.listStatus),
	);
	const parts: string[] = [];
	const active = tasks.filter((task) => task.status === "in_progress");
	if (active.length > 0) parts.push(`active ${active.map((task) => `#${task.id}`).join(" ")}`);
	const pending = tasks.filter((task) => task.status === "pending").length;
	if (pending > 0) parts.push(`${pending} pending`);
	const duration = completion?.durationMs;
	if (duration !== undefined)
		parts.push(duration < 1_000 ? `${duration}ms` : `${(duration / 1_000).toFixed(1)}s`);
	return parts.length === 0 ? undefined : parts.join(" · ");
}

function reconcileBlockedQuietTurns(current: ActiveTodoRuntime, nextState: TaskState): void {
	for (const task of nextState.tasks) {
		const previous = current.state.tasks.find((candidate) => candidate.id === task.id);
		if (task.status === "blocked" && previous?.status !== "blocked") {
			current.blockedQuietTurns.set(task.id, 0);
		}
		if (task.status !== "blocked") current.blockedQuietTurns.delete(task.id);
	}
	for (const id of current.blockedQuietTurns.keys()) {
		if (!nextState.tasks.some((task) => task.id === id && task.status === "blocked")) {
			current.blockedQuietTurns.delete(id);
		}
	}
}

/** Advances independent retirement clocks only after effective non-Todo assistant turns. */
function hideExpiredBlockedTasks(current: ActiveTodoRuntime): void {
	const expired: number[] = [];
	for (const [id, quietTurns] of current.blockedQuietTurns) {
		if (quietTurns + 1 >= 2) {
			current.blockedQuietTurns.delete(id);
			expired.push(id);
		} else {
			current.blockedQuietTurns.set(id, quietTurns + 1);
		}
	}
	if (expired.length > 0) current.widget?.hideBlocked(expired);
}

export function createTodoFeature(pi: ExtensionAPI, options: TodoFeatureOptions = {}): TodoFeature {
	let active: ActiveTodoRuntime | undefined;
	const now = options.now ?? (() => performance.now());
	registerToolTuiTrace(pi);
	const tool = getToolTui(pi).frame(
		{
			name: TODO_TOOL_NAME,
			label: "todo",
			description: TODO_TOOL_DESCRIPTION,
			promptSnippet: TODO_PROMPT_SNIPPET,
			promptGuidelines: [...TODO_PROMPT_GUIDELINES],
			parameters: TODO_PARAMETERS,
			prepareArguments: prepareTodoArguments,
			executionMode: "sequential",
			renderResult(result, options, theme, context) {
				return renderTodoToolTuiResult(result, theme, context.isError, options.expanded);
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const current = active;
				if (!current || current.sessionId !== ctx.sessionManager.getSessionId())
					throw new Error("Todo runtime is not active");
				// applyTodo validates the entire candidate batch before returning a new
				// state. Keep the live state untouched on every error to preserve atomicity.
				const todoParams = params as TodoParams;
				const result = applyTodo(current.state, todoParams);
				if (!result.ok) {
					const message = result.error.endsWith(".") ? result.error : `${result.error}.`;
					throw new Error(`${message}\nNo change made.`);
				}
				if (result.changed) {
					reconcileBlockedQuietTurns(current, result.state);
					current.state = result.state;
					current.idleTurns = 0;
					current.reminderWindowStartedAtMs = now();
					current.todoChangedThisTurn = true;
				}
				const listOperation =
					todoParams.operations.length === 1 && todoParams.operations[0]?.action === "list"
						? todoParams.operations[0]
						: undefined;
				return {
					content: [{ type: "text", text: formatTodoResult(todoParams, result) }],
					details: {
						snapshot: snapshotFromState(current.state),
						operations: result.operations,
						...(listOperation?.status === undefined ? {} : { listStatus: listOperation.status }),
					},
				};
			},
		},
		{
			summary: todoHeaderIds,
			summarySeparator: "space",
			footer: todoToolTuiFooter,
			maxBodyLines: Number.POSITIVE_INFINITY,
		},
	);
	registerManagedLoadoutTool(pi, TODO_LOADOUT_REGISTRATION, tool);

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
			reconcileBlockedQuietTurns(current, result.state);
			current.state = result.state;
			current.idleTurns = 0;
			current.reminderWindowStartedAtMs = now();
			current.todoChangedThisTurn = true;
			current.widget?.refresh(current.state);
			// Commands do not create a tool result, so persist this user-only state change.
			pi.appendEntry(TODO_STATE_CUSTOM_TYPE, snapshotFromState(current.state));
			const lines = [`Suppressed #${id}`, formatTodoGuidance(result.state)];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// These subscriptions intentionally remain feature-owned: reminder timing,
	// widget retirement, and session-tree semantics are Todo policy, not core
	// coordination. The ActiveTodoRuntime guard above makes retained Pi handlers
	// harmless after lifecycle cleanup or /reload.
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
		if (
			event.message.role !== "assistant" ||
			event.message.stopReason === "error" ||
			event.message.stopReason === "aborted"
		)
			return;
		if (current.todoChangedThisTurn) {
			current.todoChangedThisTurn = false;
			return;
		}
		hideExpiredBlockedTasks(current);
		if (!activeTodoTask(current.state)) {
			current.idleTurns = 0;
			current.reminderWindowStartedAtMs = now();
			return;
		}
		current.idleTurns++;
	});
	pi.on("agent_start", async (_event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		current.widget?.hideCompleted();
	});

	pi.on("session_tree", async (_event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		current.state = restoreTodoState(ctx);
		current.blockedQuietTurns.clear();
		current.idleTurns = 0;
		current.reminderWindowStartedAtMs = now();
		current.todoChangedThisTurn = false;
		current.widget?.hide();
		current.widget?.refresh(current.state, false);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== TODO_TOOL_NAME || event.isError) return;
		try {
			const current = active;
			if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
			current.widget?.refresh(current.state);
		} catch {
			// Widget refresh is best-effort; the successful tool result remains renderable.
		}
	});

	return {
		start(context, signal) {
			const state = restoreTodoState(context);
			const current: ActiveTodoRuntime = {
				sessionId: context.sessionManager.getSessionId(),
				state,
				idleTurns: 0,
				reminderWindowStartedAtMs: now(),
				todoChangedThisTurn: false,
				blockedQuietTurns: new Map(),
				widget: undefined,
			};
			current.widget = createTodoWidget(pi, context, signal ?? new AbortController().signal, state);
			active = current;
		},
		async dispose(sessionId) {
			const current = active;
			if (!current || current.sessionId !== sessionId) return;
			try {
				await current.widget?.dispose();
			} finally {
				// Clear the shared pointer last so in-flight handlers either finish against
				// their matching session or observe no active runtime on their next event.
				if (active === current) active = undefined;
			}
		},
	};
}
