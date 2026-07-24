import { type Task, type TaskState, validateTaskState } from "./model.js";

export interface TodoSnapshot {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export interface TodoToolDetails {
	readonly snapshot: TodoSnapshot;
}

export function snapshotFromState(state: TaskState): TodoSnapshot {
	return {
		tasks: state.tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy] })),
		nextId: state.nextId,
	};
}

export function stateFromSnapshot(value: unknown): TaskState | undefined {
	const state = validateTaskState(value);
	if (!state) return undefined;
	const byId = new Map(state.tasks.map((task) => [task.id, task]));
	return {
		tasks: state.tasks.map((task) => ({
			...task,
			status:
				task.status === "in_progress" &&
				task.blockedBy.some((id) => byId.get(id)?.status !== "completed")
					? "pending"
					: task.status,
			blockedBy: [...task.blockedBy],
		})),
		nextId: state.nextId,
	};
}

function snapshotFromBranchEntry(entry: unknown): TaskState | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const messageRecord = message as Record<string, unknown>;
	if (messageRecord.role !== "toolResult" || messageRecord.toolName !== "todo") {
		return undefined;
	}
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
