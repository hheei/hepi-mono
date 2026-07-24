import { type Task, type TaskState, validateTaskState } from "./model.js";

export const TODO_STATE_CUSTOM_TYPE = "pi-todo:state";

export interface TodoSnapshot {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export interface TodoToolDetails {
	readonly snapshot: TodoSnapshot;
}

export function snapshotFromState(state: TaskState): TodoSnapshot {
	return {
		tasks: state.tasks.map((task) => ({ ...task })),
		nextId: state.nextId,
	};
}

export function stateFromSnapshot(value: unknown): TaskState | undefined {
	return validateTaskState(value);
}

function snapshotFromBranchEntry(entry: unknown): TaskState | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type === "custom" && record.customType === TODO_STATE_CUSTOM_TYPE) {
		return stateFromSnapshot(record.data);
	}
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const messageRecord = message as Record<string, unknown>;
	if (messageRecord.role !== "toolResult" || messageRecord.toolName !== "todo") return undefined;
	const details = messageRecord.details;
	if (!details || typeof details !== "object") return undefined;
	return stateFromSnapshot((details as Record<string, unknown>).snapshot);
}

export function latestTodoSnapshot(branch: readonly unknown[]): TaskState | undefined {
	let latest: TaskState | undefined;
	for (const entry of branch) {
		const snapshot = snapshotFromBranchEntry(entry);
		if (snapshot && (!latest || snapshot.nextId >= latest.nextId)) latest = snapshot;
	}
	return latest;
}
