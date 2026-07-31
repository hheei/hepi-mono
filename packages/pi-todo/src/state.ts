import { activateFirstPending, type Task, type TaskState, validateTaskState } from "./model.js";

export interface TodoSnapshot {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export function snapshotFromState(state: TaskState): TodoSnapshot {
	return {
		tasks: state.tasks.map((task) => ({ ...task })),
		nextId: state.nextId,
	};
}

/** Validates one tool result's display snapshot; it never restores session state. */
export function stateFromSnapshot(value: unknown): TaskState | undefined {
	const state = validateTaskState(value);
	return state ? activateFirstPending(state) : undefined;
}
