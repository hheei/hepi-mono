import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { HePiRuntimeContext } from "../../runtime/context.js";
import {
	applyTodo,
	freshTaskState,
	type Task,
	type TaskState,
	type TaskStatus,
	type TodoParams,
} from "./model.js";
import { latestTodoSnapshot, snapshotFromState } from "./state.js";
import { createTodoWidget, type TodoWidget } from "./widget.js";

export const TODO_TOOL_NAME = "todo";
export const TODO_COMMAND_NAME = "todos";

const TODO_REMINDER_IDLE_TURNS = 5;
const TODO_COMPLETED_HIDE_TURNS = 2;

const todoOperation = Type.Object(
	{
		action: Type.String({ enum: ["create", "update", "list", "delete"] }),
		id: Type.Optional(Type.Integer({ minimum: 1 })),
		subject: Type.Optional(Type.String({ minLength: 1 })),
		status: Type.Optional(Type.String({ enum: ["pending", "in_progress", "completed"] })),
		blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
	},
	{ additionalProperties: false },
);

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
	"Mark a task `in_progress` before beginning work and `completed` immediately when done; keep exactly one task `in_progress` while work remains, and do not delay completions to batch them.",
	"Never mark a task `completed` when work is partial, failing, or blocked; keep it `in_progress` and add a task for the blocker.",
	"When several task changes are already known, submit them together in one `operations` batch to reduce tool calls; never infer deletion from omitted tasks.",
] as const;

interface ActiveTodoRuntime {
	readonly sessionId: string;
	state: TaskState;
	widget?: TodoWidget;
	idleTurns: number;
	reminderSent: boolean;
	toolUsedThisTurn: boolean;
	completedIdleTurns: number;
	widgetHidden: boolean;
}

export interface TodoFeature {
	start(runtime: HePiRuntimeContext): void | Promise<void>;
	dispose(sessionId: string): void | Promise<void>;
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

function nextTodoTask(state: TaskState): Task | undefined {
	const incomplete = state.tasks
		.filter((task) => task.status !== "completed")
		.slice()
		.sort((left, right) => left.id - right.id);
	return (
		incomplete.find((task) => task.status === "in_progress") ??
		incomplete.find((task) => unresolvedBlockers(task, state).length === 0) ??
		incomplete[0]
	);
}

function todoReminder(current: ActiveTodoRuntime): string | undefined {
	const next = nextTodoTask(current.state);
	if (!next) return undefined;
	const unfinished = current.state.tasks.filter((task) => task.status !== "completed").length;
	const blockers = unresolvedBlockers(next, current.state);
	return `<todo_context>\nTodo reminder: ${unfinished} unfinished. Continue #${next.id}: ${next.subject}${blockers.length > 0 ? ` (blocked by ${blockers.map((id) => `#${id}`).join(", ")})` : ""}. Use \`todo\` when progress changes.\n</todo_context>`;
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

function formatTodoResult(
	params: TodoParams,
	result: Extract<ReturnType<typeof applyTodo>, { ok: true }>,
): string {
	const lines: string[] = [];
	for (const operationResult of result.operations) {
		const operation = params.operations[operationResult.index];
		if (!operation) continue;
		switch (operation.action) {
			case "create": {
				const task = result.state.tasks.find((candidate) => candidate.id === operationResult.id);
				lines.push(task ? `Created #${task.id}: ${task.subject}` : "Created task");
				break;
			}
			case "update":
				lines.push(
					operationResult.changed
						? `Updated #${operation.id}`
						: `No change: #${operation.id} already matches the requested values`,
				);
				break;
			case "delete":
				lines.push(`Deleted #${operation.id}`);
				break;
			case "list":
				lines.push(formatTodoList(result.state, operation.status));
				break;
		}
	}
	return lines.join("\n");
}

function isStaleSessionContextError(error: unknown): boolean {
	return /stale after session replacement/.test(String(error));
}

export function createTodoFeature(pi: ExtensionAPI): TodoFeature {
	let active: ActiveTodoRuntime | undefined;

	const refreshFromBranch = (kind: "compact" | "tree", ctx: ExtensionContext): void => {
		try {
			const current = active;
			if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
			const restored = latestTodoSnapshot(ctx.sessionManager.getBranch());
			if (restored) current.state = restored;
			else if (kind === "tree") current.state = freshTaskState();
			if (kind === "tree") {
				current.idleTurns = 0;
				current.reminderSent = false;
				current.toolUsedThisTurn = false;
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
			if (result.changed) current.state = result.state;
			current.idleTurns = 0;
			current.reminderSent = false;
			current.toolUsedThisTurn = true;
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

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		if (!event.systemPromptOptions.selectedTools?.includes(TODO_TOOL_NAME)) return;
		if (current.reminderSent || current.idleTurns < TODO_REMINDER_IDLE_TURNS) return;
		const content = todoReminder(current);
		if (!content) return;
		current.reminderSent = true;
		return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
	});
	pi.on("agent_start", async (_event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		current.toolUsedThisTurn = false;
	});
	pi.on("agent_end", async (_event, ctx) => {
		const current = active;
		if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
		const incomplete = current.state.tasks.some((task) => task.status !== "completed");
		if (incomplete) {
			current.completedIdleTurns = 0;
			if (!current.toolUsedThisTurn) current.idleTurns++;
			return;
		}
		current.idleTurns = 0;
		current.reminderSent = false;
		if (current.state.tasks.length === 0 || current.toolUsedThisTurn) {
			current.completedIdleTurns = 0;
			return;
		}
		current.completedIdleTurns++;
		if (current.completedIdleTurns >= TODO_COMPLETED_HIDE_TURNS) {
			current.widgetHidden = true;
			current.widget?.hide();
		}
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
				reminderSent: false,
				toolUsedThisTurn: false,
				completedIdleTurns: 0,
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
