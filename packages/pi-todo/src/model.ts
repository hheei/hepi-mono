export type TaskStatus = "pending" | "in_progress" | "completed" | "suppressed";

export type TodoAction = "create" | "update" | "list" | "delete";

export interface Task {
	readonly id: number;
	readonly subject: string;
	readonly status: TaskStatus;
}

export interface TaskState {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export type TodoOperation =
	| { readonly action: "create"; readonly subject: string }
	| {
			readonly action: "update";
			readonly id: number;
			readonly subject?: string;
			readonly status?: "completed";
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
			readonly autoStartedId?: number;
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

const STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed", "suppressed"];
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCompletedStatus(value: unknown): value is "completed" {
	return value === "completed";
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
		ids.add(valueTask.id);
		tasks.push({
			id: valueTask.id,
			subject: valueTask.subject,
			status: valueTask.status as TaskStatus,
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

export function activateFirstPending(state: TaskState): TaskState {
	if (state.tasks.some((task) => task.status === "in_progress")) return state;
	const next = firstPending(state.tasks);
	if (!next) return state;
	return {
		tasks: state.tasks.map((task) =>
			task.id === next.id ? { ...task, status: "in_progress" } : task,
		),
		nextId: state.nextId,
	};
}

export function applyTodo(state: TaskState, params: TodoParams): ApplyTodoResult {
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
			if (!hasOnlyKeys(operation, ["action", "subject"]) || typeof operation.subject !== "string")
				return fail("Invalid create fields", index);
			const subjectIssue = subjectError(operation.subject);
			if (subjectIssue) return fail(subjectIssue, index);
			const subject = operation.subject.trim();
			if (draft.nextId >= Number.MAX_SAFE_INTEGER) return fail("Task id space exhausted", index);
			const task: Task = {
				id: draft.nextId,
				subject,
				status: "pending",
			};
			draft.tasks = [...draft.tasks, task];
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
			if (task.status === "suppressed") return fail(`The user suppressed #${id} before.`, index);
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
		if (current.status === "suppressed") return fail(`The user suppressed #${id} before.`, index);
		const hasSubject = operation.subject !== undefined;
		const hasStatus = operation.status !== undefined;
		if (!hasSubject && !hasStatus) return fail("Update requires a mutable field", index);
		if (hasSubject && typeof operation.subject !== "string")
			return fail("Subject must not be empty", index);
		if (hasSubject) {
			const subjectIssue = subjectError(operation.subject as string);
			if (subjectIssue) return fail(subjectIssue, index);
		}
		if (hasStatus && !isCompletedStatus(operation.status)) return fail("Invalid status", index);
		const subject = hasSubject ? (operation.subject as string).trim() : current.subject;
		const status = isCompletedStatus(operation.status) ? operation.status : current.status;
		const next = { ...current, subject, status };
		const candidateTasks = draft.tasks.map((task) => (task.id === id ? next : task));
		const isChanged = current.subject !== subject || current.status !== status;
		if (isChanged) {
			draft.tasks = candidateTasks;
			changed = true;
		}
		operations.push({ index, action, changed: isChanged, id });
	}
	let autoStartedId: number | undefined;
	if (changed && !draft.tasks.some((task) => task.status === "in_progress")) {
		const next = firstPending(draft.tasks);
		if (next) {
			draft.tasks = draft.tasks.map((task) =>
				task.id === next.id ? { ...task, status: "in_progress" } : task,
			);
			autoStartedId = next.id;
		}
	}
	if (!changed) return { ok: true, changed: false, state, operations };
	return autoStartedId === undefined
		? { ok: true, changed: true, state: draft, operations }
		: { ok: true, changed: true, state: draft, operations, autoStartedId };
}

export type SuppressTodoResult =
	| {
			readonly ok: true;
			readonly changed: boolean;
			readonly state: TaskState;
			readonly autoStartedId?: number;
	  }
	| { readonly ok: false; readonly state: TaskState; readonly error: string };

export function suppressTodoByUser(state: TaskState, id: number): SuppressTodoResult {
	if (!validateTaskState(state)) return { ok: false, state, error: "Invalid task state" };
	if (!isPositiveInteger(id)) return { ok: false, state, error: "Task id must be positive" };
	const current = findTask(state.tasks, id);
	if (!current) return { ok: false, state, error: `Task #${id} does not exist` };
	if (current.status === "completed") {
		return { ok: false, state, error: `Task #${id} is already completed` };
	}
	if (current.status === "suppressed") return { ok: true, changed: false, state };

	let tasks = state.tasks.map((task) =>
		task.id === id ? { ...task, status: "suppressed" as const } : task,
	);
	let autoStartedId: number | undefined;
	if (!tasks.some((task) => task.status === "in_progress")) {
		const next = firstPending(tasks);
		if (next) {
			tasks = tasks.map((task) =>
				task.id === next.id ? { ...task, status: "in_progress" as const } : task,
			);
			autoStartedId = next.id;
		}
	}
	const nextState = { tasks, nextId: state.nextId };
	return autoStartedId === undefined
		? { ok: true, changed: true, state: nextState }
		: { ok: true, changed: true, state: nextState, autoStartedId };
}
