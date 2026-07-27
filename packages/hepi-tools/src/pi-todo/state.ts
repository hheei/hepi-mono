import { activateFirstPending, type Task, type TaskState, validateTaskState } from "./model.js";

export const TODO_STATE_CUSTOM_TYPE = "pi-todo:state";

export interface TodoSnapshot {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export interface TodoToolDetails {
	readonly snapshot: TodoSnapshot;
	readonly focusTaskId?: number;
}

export function snapshotFromState(state: TaskState): TodoSnapshot {
	return {
		tasks: state.tasks.map((task) => ({ ...task })),
		nextId: state.nextId,
	};
}

export function stateFromSnapshot(value: unknown): TaskState | undefined {
	const state = validateTaskState(value);
	return state ? activateFirstPending(state) : undefined;
}

interface BranchSnapshot {
	readonly state: TaskState;
	readonly userOwned: boolean;
}

function snapshotFromBranchEntry(entry: unknown): BranchSnapshot | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type === "custom" && record.customType === TODO_STATE_CUSTOM_TYPE) {
		const state = stateFromSnapshot(record.data);
		return state ? { state, userOwned: true } : undefined;
	}
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const messageRecord = message as Record<string, unknown>;
	if (messageRecord.role !== "toolResult" || messageRecord.toolName !== "todo") return undefined;
	const details = messageRecord.details;
	if (!details || typeof details !== "object") return undefined;
	const state = stateFromSnapshot((details as Record<string, unknown>).snapshot);
	return state ? { state, userOwned: false } : undefined;
}

function applyUserSuppressions(state: TaskState, suppressed: ReadonlyMap<number, Task>): TaskState {
	if (suppressed.size === 0) return state;
	const tasks = new Map(state.tasks.map((task) => [task.id, task]));
	let nextId = state.nextId;
	for (const [id, task] of suppressed) {
		tasks.set(id, task);
		nextId = Math.max(nextId, id + 1);
	}
	return activateFirstPending({
		tasks: [...tasks.values()].sort((left, right) => left.id - right.id),
		nextId,
	});
}

export function latestTodoSnapshot(branch: readonly unknown[]): TaskState | undefined {
	let latest: TaskState | undefined;
	const suppressed = new Map<number, Task>();
	for (const entry of branch) {
		const snapshot = snapshotFromBranchEntry(entry);
		if (!snapshot) continue;
		if (snapshot.userOwned) {
			for (const task of snapshot.state.tasks) {
				if (task.status === "suppressed") suppressed.set(task.id, task);
			}
		}
		if (!latest || snapshot.state.nextId >= latest.nextId) latest = snapshot.state;
	}
	return latest ? applyUserSuppressions(latest, suppressed) : undefined;
}
