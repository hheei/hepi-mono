import { isRecord } from "@hheei/pi-ext-core";
export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "suppressed";
export type AgentTaskStatus = "pending" | "in_progress" | "blocked" | "completed";

/** How each status is drawn wherever a task is rendered: glyph plus semantic tone. */
export const TASK_GLYPH: Record<TaskStatus, string> = {
	in_progress: "󰪠",
	pending: "󰄰",
	blocked: "󰀪",
	completed: "󰄴",
	suppressed: "󰅚",
};
export const TASK_TONE: Record<TaskStatus, "success" | "warning" | "dim" | "muted"> = {
	in_progress: "warning",
	pending: "muted",
	blocked: "dim",
	completed: "success",
	suppressed: "muted",
};

export type TodoAction = "create" | "update" | "list" | "delete";

export interface Task {
	readonly id: number;
	readonly subject: string;
	readonly status: TaskStatus;
	readonly updatedAt?: number;
}

export interface TaskState {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export type TodoOperation =
	| { readonly action: "create"; readonly subject: string; readonly status?: AgentTaskStatus }
	| {
			readonly action: "update";
			readonly id: number;
			readonly subject?: string;
			readonly status?: AgentTaskStatus;
	  }
	| { readonly action: "list"; readonly status?: TaskStatus }
	| { readonly action: "delete"; readonly id: number };

export interface TodoParams {
	readonly operations: readonly TodoOperation[];
}

export interface TodoOperationResult {
	readonly index: number;
	readonly action: TodoAction;
	readonly changed: boolean;
	readonly id?: number;
}

export type ApplyTodoResult =
	| {
			readonly ok: true;
			readonly changed: boolean;
			readonly state: TaskState;
			readonly operations: readonly TodoOperationResult[];
	  }
	| {
			readonly ok: false;
			readonly state: TaskState;
			readonly error: string;
			readonly operationIndex?: number;
	  };

export function freshTaskState(): TaskState {
	return { tasks: [], nextId: 1 };
}

const STATUSES: readonly TaskStatus[] = [
	"pending",
	"in_progress",
	"blocked",
	"completed",
	"suppressed",
];
const ACTIONS: readonly TodoAction[] = ["create", "update", "list", "delete"];

function subjectError(subject: string): string | undefined {
	if (subject.trim() === "") return "Subject must not be empty";
	for (const character of subject) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		)
			return "Subject must be one printable line";
	}
	return undefined;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
	return (
		value === "pending" || value === "in_progress" || value === "blocked" || value === "completed"
	);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function cloneState(state: TaskState): { tasks: Task[]; nextId: number } {
	return {
		tasks: [...state.tasks],
		nextId: state.nextId,
	};
}

export function validateTaskState(value: unknown): TaskState | undefined {
	if (!isRecord(value) || !Array.isArray(value.tasks) || !isPositiveInteger(value.nextId))
		return undefined;
	const ids = new Set<number>();
	const tasks: Task[] = [];
	for (const valueTask of value.tasks) {
		if (!isRecord(valueTask) || !isPositiveInteger(valueTask.id) || ids.has(valueTask.id))
			return undefined;
		if (typeof valueTask.subject !== "string" || subjectError(valueTask.subject)) return undefined;
		if (!STATUSES.includes(valueTask.status as TaskStatus)) return undefined;
		if (
			valueTask.updatedAt !== undefined &&
			(typeof valueTask.updatedAt !== "number" ||
				!Number.isFinite(valueTask.updatedAt) ||
				valueTask.updatedAt < 0)
		) {
			return undefined;
		}
		ids.add(valueTask.id);
		tasks.push({
			id: valueTask.id,
			subject: valueTask.subject,
			status: valueTask.status as TaskStatus,
			...(valueTask.updatedAt !== undefined ? { updatedAt: valueTask.updatedAt } : {}),
		});
	}
	const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
	if (value.nextId <= maxId || tasks.filter((task) => task.status === "in_progress").length > 1)
		return undefined;
	return { tasks, nextId: value.nextId };
}

function findTask(tasks: readonly Task[], id: number): Task | undefined {
	return tasks.find((task) => task.id === id);
}

function firstPending(tasks: readonly Task[]): Task | undefined {
	return tasks
		.filter((task) => task.status === "pending")
		.sort((left, right) => left.id - right.id)[0];
}

export function isValidTimestamp(now: unknown): now is number {
	return typeof now === "number" && Number.isFinite(now) && now >= 0;
}

export function activateFirstPending(state: TaskState, now?: number): TaskState {
	if (state.tasks.some((task) => task.status === "in_progress")) return state;
	const next = firstPending(state.tasks);
	if (!next) return state;
	const timestamp = isValidTimestamp(now) ? Math.floor(now) : undefined;
	return {
		tasks: state.tasks.map((task) =>
			task.id === next.id
				? {
						...task,
						status: "in_progress",
						...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
					}
				: task,
		),
		nextId: state.nextId,
	};
}

/**
 * Applies a tool batch as one transaction. Every operation mutates only `draft`;
 * any validation or transition failure returns the original state, so callers
 * can safely render "No change made" without compensating partial writes.
 */
export function applyTodo(state: TaskState, params: TodoParams, now?: number): ApplyTodoResult {
	if (now !== undefined && !isValidTimestamp(now)) {
		return { ok: false, state, error: "Invalid timestamp" };
	}
	const timestamp = now !== undefined ? Math.floor(now) : undefined;
	if (!isRecord(params) || !Array.isArray(params.operations) || params.operations.length === 0) {
		return { ok: false, state, error: "operations must be a non-empty array" };
	}
	if (!validateTaskState(state)) return { ok: false, state, error: "Invalid task state" };
	const draft = cloneState(state);
	const operations: TodoOperationResult[] = [];
	let changed = false;
	const fail = (error: string, operationIndex: number): ApplyTodoResult => ({
		ok: false,
		state,
		error,
		operationIndex,
	});
	for (let index = 0; index < params.operations.length; index++) {
		const operation = params.operations[index];
		if (
			!isRecord(operation) ||
			typeof operation.action !== "string" ||
			!ACTIONS.includes(operation.action as TodoAction)
		)
			return fail("Invalid action", index);
		const action = operation.action as TodoAction;
		if (action === "list") {
			if (
				params.operations.length !== 1 ||
				!hasOnlyKeys(operation, ["action", "status"]) ||
				(operation.status !== undefined && !STATUSES.includes(operation.status as TaskStatus))
			)
				return fail("Invalid list operation", index);
			operations.push({ index, action, changed: false });
			continue;
		}
		if (action === "create") {
			if (
				!hasOnlyKeys(operation, ["action", "subject", "status"]) ||
				typeof operation.subject !== "string"
			)
				return fail("Invalid create fields", index);
			const subjectIssue = subjectError(operation.subject);
			if (subjectIssue) return fail(subjectIssue, index);
			if (operation.status !== undefined && !isAgentTaskStatus(operation.status))
				return fail("Invalid status", index);
			const subject = operation.subject.trim();
			const status: AgentTaskStatus = operation.status ?? "pending";
			if (draft.nextId >= Number.MAX_SAFE_INTEGER) return fail("Task id space exhausted", index);
			const task: Task = {
				id: draft.nextId,
				subject,
				status,
				...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
			};
			const existingTasks =
				status === "in_progress"
					? draft.tasks.map((existing) =>
							existing.status === "in_progress"
								? {
										...existing,
										status: "pending" as const,
										...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
									}
								: existing,
						)
					: draft.tasks;
			draft.tasks = [...existingTasks, task];
			draft.nextId++;
			changed = true;
			operations.push({ index, action, changed: true, id: task.id });
			continue;
		}
		if (action === "delete") {
			if (!hasOnlyKeys(operation, ["action", "id"]) || !isPositiveInteger(operation.id))
				return fail("Invalid delete fields", index);
			const id = operation.id;
			const task = findTask(draft.tasks, id);
			if (!task) return fail(`Task #${id} does not exist`, index);
			if (task.status === "suppressed") return fail(`Task #${id} is suppressed`, index);
			draft.tasks = draft.tasks.filter((candidate) => candidate.id !== id);
			changed = true;
			operations.push({ index, action, changed: true, id });
			continue;
		}
		if (
			!hasOnlyKeys(operation, ["action", "id", "subject", "status"]) ||
			!isPositiveInteger(operation.id)
		)
			return fail("Invalid update fields", index);
		const id = operation.id;
		const current = findTask(draft.tasks, id);
		if (!current) return fail(`Task #${id} does not exist`, index);
		if (current.status === "suppressed") return fail(`Task #${id} is suppressed`, index);
		const hasSubject = operation.subject !== undefined;
		const hasStatus = operation.status !== undefined;
		if (!hasSubject && !hasStatus) return fail("Update requires a mutable field", index);
		if (hasSubject && typeof operation.subject !== "string")
			return fail("Subject must not be empty", index);
		if (hasSubject) {
			const subjectIssue = subjectError(operation.subject as string);
			if (subjectIssue) return fail(subjectIssue, index);
		}
		if (hasStatus && !isAgentTaskStatus(operation.status)) return fail("Invalid status", index);
		const subject = hasSubject ? (operation.subject as string).trim() : current.subject;
		const status = isAgentTaskStatus(operation.status) ? operation.status : current.status;
		if (current.status === "completed" && status !== "completed") {
			return fail(`Invalid status transition from completed to ${status}`, index);
		}
		const next = {
			...current,
			subject,
			status,
			...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
		};
		// Pi permits exactly one active task. Starting a pending or blocked task is
		// an explicit switch, not an error: demote the previous active task inside
		// this same draft so the invariant never leaks between batch operations.
		const candidateTasks = draft.tasks.map((task) => {
			if (task.id === id) return next;
			if (status === "in_progress" && task.status === "in_progress") {
				return {
					...task,
					status: "pending" as const,
					...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
				};
			}
			return task;
		});
		const isChanged = candidateTasks.some((task, taskIndex) => {
			const previous = draft.tasks[taskIndex];
			return previous?.subject !== task.subject || previous.status !== task.status;
		});
		if (isChanged) {
			draft.tasks = candidateTasks;
			changed = true;
		}
		operations.push({ index, action, changed: isChanged, id });
	}
	if (changed && !draft.tasks.some((task) => task.status === "in_progress")) {
		const next = firstPending(draft.tasks);
		if (next) {
			draft.tasks = draft.tasks.map((task) =>
				task.id === next.id
					? {
							...task,
							status: "in_progress",
							...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
						}
					: task,
			);
		}
	}
	if (!changed) return { ok: true, changed: false, state, operations };
	return { ok: true, changed: true, state: draft, operations };
}

export type CancelTodosResult =
	| {
			readonly ok: true;
			readonly changed: boolean;
			readonly state: TaskState;
			readonly cancelledIds: readonly number[];
	  }
	| { readonly ok: false; readonly state: TaskState; readonly error: string };

export function cancelTodosByUser(
	state: TaskState,
	ids: readonly number[],
	now?: number,
): CancelTodosResult {
	if (now !== undefined && !isValidTimestamp(now)) {
		return { ok: false, state, error: "Invalid timestamp" };
	}
	const timestamp = now !== undefined ? Math.floor(now) : undefined;
	if (!validateTaskState(state)) return { ok: false, state, error: "Invalid task state" };
	if (!Array.isArray(ids) || ids.length === 0) {
		return { ok: false, state, error: "At least one task id is required" };
	}
	for (const id of ids) {
		if (!isPositiveInteger(id)) return { ok: false, state, error: `Invalid task id: ${id}` };
		const current = findTask(state.tasks, id);
		if (!current) return { ok: false, state, error: `Task #${id} does not exist` };
		if (current.status === "completed") {
			return { ok: false, state, error: `Task #${id} is already completed` };
		}
	}

	const targetIds = new Set(ids);
	const cancelledIds: number[] = [];
	let hasChanges = false;
	let tasks = state.tasks.map((task) => {
		if (targetIds.has(task.id) && task.status !== "suppressed") {
			cancelledIds.push(task.id);
			hasChanges = true;
			return {
				...task,
				status: "suppressed" as const,
				...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
			};
		}
		return task;
	});

	if (!hasChanges) {
		return { ok: true, changed: false, state, cancelledIds: [] };
	}

	if (!tasks.some((task) => task.status === "in_progress")) {
		const next = firstPending(tasks);
		if (next) {
			tasks = tasks.map((task) =>
				task.id === next.id
					? {
							...task,
							status: "in_progress" as const,
							...(timestamp !== undefined ? { updatedAt: timestamp } : {}),
						}
					: task,
			);
		}
	}

	return {
		ok: true,
		changed: true,
		state: { tasks, nextId: state.nextId },
		cancelledIds,
	};
}

export type SuppressTodoResult =
	| {
			readonly ok: true;
			readonly changed: boolean;
			readonly state: TaskState;
	  }
	| { readonly ok: false; readonly state: TaskState; readonly error: string };

export function suppressTodoByUser(state: TaskState, id: number, now?: number): SuppressTodoResult {
	const result = cancelTodosByUser(state, [id], now);
	if (!result.ok) return result;
	return { ok: true, changed: result.changed, state: result.state };
}
