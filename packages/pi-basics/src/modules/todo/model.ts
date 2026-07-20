export type TaskStatus = "pending" | "in_progress" | "completed";

export type TodoAction = "create" | "update" | "list" | "delete";

export interface Task {
	readonly id: number;
	readonly subject: string;
	readonly status: TaskStatus;
	readonly blockedBy: readonly number[];
}

export interface TaskState {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export type TodoOperation =
	| { readonly action: "create"; readonly subject: string; readonly blockedBy?: readonly number[] }
	| {
			readonly action: "update";
			readonly id: number;
			readonly subject?: string;
			readonly status?: TaskStatus;
			readonly blockedBy?: readonly number[];
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

const STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"];
const ACTIONS: readonly TodoAction[] = ["create", "update", "list", "delete"];

function subjectError(subject: string): string | undefined {
	if (subject.trim() === "") return "Subject must not be empty";
	for (const character of subject) {
		const codePoint = character.codePointAt(0)!;
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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function hasCycle(tasks: readonly Task[]): boolean {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const states = new Map<number, "visiting" | "visited">();
	for (const root of tasks) {
		if (states.get(root.id) === "visited") continue;
		const stack: Array<{ task: Task; dependencyIndex: number }> = [
			{ task: root, dependencyIndex: 0 },
		];
		states.set(root.id, "visiting");
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const dependency = frame.task.blockedBy[frame.dependencyIndex++];
			if (dependency === undefined) {
				states.set(frame.task.id, "visited");
				stack.pop();
				continue;
			}
			const state = states.get(dependency);
			if (state === "visiting") return true;
			if (state === "visited") continue;
			const task = byId.get(dependency);
			if (!task) continue;
			states.set(dependency, "visiting");
			stack.push({ task, dependencyIndex: 0 });
		}
	}
	return false;
}

function cloneState(state: TaskState): { tasks: Task[]; nextId: number } {
	return {
		tasks: state.tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy] })),
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
		if (!STATUSES.includes(valueTask.status as TaskStatus) || !Array.isArray(valueTask.blockedBy))
			return undefined;
		const blockedBy: number[] = [];
		const dependencies = new Set<number>();
		for (const dependency of valueTask.blockedBy) {
			if (
				!isPositiveInteger(dependency) ||
				dependencies.has(dependency) ||
				dependency === valueTask.id
			)
				return undefined;
			dependencies.add(dependency);
			blockedBy.push(dependency);
		}
		ids.add(valueTask.id);
		tasks.push({
			id: valueTask.id,
			subject: valueTask.subject,
			status: valueTask.status as TaskStatus,
			blockedBy,
		});
	}
	const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
	if (
		value.nextId <= maxId ||
		tasks.some((task) => task.blockedBy.some((id) => !ids.has(id))) ||
		hasCycle(tasks)
	)
		return undefined;
	return { tasks, nextId: value.nextId };
}

function dependencyError(
	task: Task,
	blockedBy: readonly unknown[],
	tasks: readonly Task[],
): string | undefined {
	if (!Array.isArray(blockedBy)) return "blockedBy must be an array";
	const dependencies = new Set<number>();
	for (const id of blockedBy) {
		if (!isPositiveInteger(id)) return "blockedBy must contain positive integer ids";
		if (dependencies.has(id)) return `Task #${task.id} has duplicate dependency #${id}`;
		if (id === task.id) return `Task #${task.id} cannot block itself`;
		if (!tasks.some((candidate) => candidate.id === id)) return `Dependency #${id} does not exist`;
		dependencies.add(id);
	}
	return undefined;
}

function findTask(tasks: readonly Task[], id: number): Task | undefined {
	return tasks.find((task) => task.id === id);
}

function validTransition(from: TaskStatus, to: TaskStatus): boolean {
	return from !== "completed" || to === "completed";
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
			if (
				!hasOnlyKeys(operation, ["action", "subject", "blockedBy"]) ||
				typeof operation.subject !== "string"
			)
				return fail("Invalid create fields", index);
			const subjectIssue = subjectError(operation.subject);
			if (subjectIssue) return fail(subjectIssue, index);
			const subject = operation.subject.trim();
			if (operation.blockedBy !== undefined && !Array.isArray(operation.blockedBy))
				return fail("blockedBy must be an array", index);
			if (draft.nextId >= Number.MAX_SAFE_INTEGER) return fail("Task id space exhausted", index);
			const task: Task = {
				id: draft.nextId,
				subject,
				status: "pending",
				blockedBy: operation.blockedBy === undefined ? [] : [...operation.blockedBy],
			};
			const error = dependencyError(task, task.blockedBy, draft.tasks);
			if (error) return fail(error, index);
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
			if (!findTask(draft.tasks, id)) return fail(`Task #${id} does not exist`, index);
			draft.tasks = draft.tasks
				.filter((task) => task.id !== id)
				.map((task) => ({
					...task,
					blockedBy: task.blockedBy.filter((dependency) => dependency !== id),
				}));
			changed = true;
			operations.push({ index, action, changed: true, id });
			continue;
		}
		if (
			!hasOnlyKeys(operation, ["action", "id", "subject", "status", "blockedBy"]) ||
			!isPositiveInteger(operation.id)
		)
			return fail("Invalid update fields", index);
		const id = operation.id;
		const current = findTask(draft.tasks, id);
		if (!current) return fail(`Task #${id} does not exist`, index);
		const hasSubject = operation.subject !== undefined;
		const hasStatus = operation.status !== undefined;
		const hasBlockedBy = operation.blockedBy !== undefined;
		if (!hasSubject && !hasStatus && !hasBlockedBy)
			return fail("Update requires a mutable field", index);
		if (hasSubject && typeof operation.subject !== "string")
			return fail("Subject must not be empty", index);
		if (hasSubject) {
			const subjectIssue = subjectError(operation.subject as string);
			if (subjectIssue) return fail(subjectIssue, index);
		}
		if (hasStatus && !STATUSES.includes(operation.status as TaskStatus))
			return fail("Invalid status", index);
		const subject = hasSubject ? (operation.subject as string).trim() : current.subject;
		const status = hasStatus ? (operation.status as TaskStatus) : current.status;
		if (hasBlockedBy && !Array.isArray(operation.blockedBy))
			return fail("blockedBy must be an array", index);
		const blockedBy = hasBlockedBy
			? [...(operation.blockedBy as readonly number[])]
			: [...current.blockedBy];
		if (!validTransition(current.status, status))
			return fail(`Invalid status transition from ${current.status} to ${status}`, index);
		const error = dependencyError(current, blockedBy, draft.tasks);
		if (error) return fail(error, index);
		const next = { ...current, subject, status, blockedBy };
		const candidateTasks = draft.tasks.map((task) => (task.id === id ? next : task));
		if (hasCycle(candidateTasks)) return fail("Task dependencies contain a cycle", index);
		const isChanged =
			current.subject !== subject ||
			current.status !== status ||
			current.blockedBy.length !== blockedBy.length ||
			current.blockedBy.some((value, i) => value !== blockedBy[i]);
		if (isChanged) {
			draft.tasks = candidateTasks;
			changed = true;
		}
		operations.push({ index, action, changed: isChanged, id });
	}
	return { ok: true, changed, state: changed ? draft : state, operations };
}
