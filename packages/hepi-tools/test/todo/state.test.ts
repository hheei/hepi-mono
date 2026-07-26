import { describe, expect, test } from "bun:test";
import type { TaskState } from "../../src/pi-todo/model.js";
import {
	latestTodoSnapshot,
	snapshotFromState,
	stateFromSnapshot,
	TODO_STATE_CUSTOM_TYPE,
} from "../../src/pi-todo/state.js";

const task = (id: number, subject = `task ${id}`) => ({
	id,
	subject,
	status: "pending" as const,
});
const result = (snapshot: unknown) => ({
	type: "message",
	message: { role: "toolResult", toolName: "todo", details: { snapshot } },
});
const custom = (snapshot: unknown) => ({
	type: "custom",
	customType: TODO_STATE_CUSTOM_TYPE,
	data: snapshot,
});

describe("todo state", () => {
	test("snapshots and restores independent copies", () => {
		const input: TaskState = { tasks: [task(1), task(2)], nextId: 3 };
		const snapshot = snapshotFromState(input);
		(input.tasks as unknown as Array<{ subject: string }>)[0]!.subject = "mutated";
		expect(snapshot.tasks[0]?.subject).toBe("task 1");
		const replayed = stateFromSnapshot(snapshot)!;
		(snapshot.tasks as unknown as Array<{ subject: string }>)[0]!.subject = "changed";
		expect(replayed.tasks[0]?.subject).toBe("task 1");
	});

	test("ignores blockedBy from legacy snapshots", () => {
		const legacy = {
			tasks: [
				{ ...task(1, "one"), status: "in_progress", blockedBy: [] },
				{ ...task(2, "two"), blockedBy: [1] },
			],
			nextId: 3,
		};
		expect(stateFromSnapshot(legacy)).toEqual({
			tasks: [
				{ id: 1, subject: "one", status: "in_progress" },
				{ id: 2, subject: "two", status: "pending" },
			],
			nextId: 3,
		});
	});

	test("starts the first pending task while restoring legacy state", () => {
		expect(stateFromSnapshot({ tasks: [task(2), task(1)], nextId: 3 })).toEqual({
			tasks: [task(2), { ...task(1), status: "in_progress" }],
			nextId: 3,
		});
	});

	test("newer snapshots preserve permanent user suppression", () => {
		const first = { tasks: [task(1)], nextId: 2 };
		const suppressed: TaskState = {
			tasks: [{ id: 1, subject: "task 1", status: "suppressed" }],
			nextId: 2,
		};
		const later = { tasks: [task(4)], nextId: 5 };
		expect(
			latestTodoSnapshot([result(first), custom(suppressed), custom({ bad: true }), result(later)]),
		).toEqual({
			tasks: [
				{ id: 1, subject: "task 1", status: "suppressed" },
				{ id: 4, subject: "task 4", status: "in_progress" },
			],
			nextId: 5,
		});
		expect(latestTodoSnapshot([result(first), custom(suppressed)])).toEqual(suppressed);
		expect(latestTodoSnapshot([result(later), custom(first)])).toEqual({
			tasks: [{ id: 4, subject: "task 4", status: "in_progress" }],
			nextId: 5,
		});
	});

	test("user suppression survives a later stale snapshot with the same next id", () => {
		const before: TaskState = {
			tasks: [
				{ id: 1, subject: "one", status: "in_progress" },
				{ id: 2, subject: "two", status: "pending" },
			],
			nextId: 3,
		};
		const userSnapshot: TaskState = {
			tasks: [
				{ id: 1, subject: "one", status: "suppressed" },
				{ id: 2, subject: "two", status: "in_progress" },
			],
			nextId: 3,
		};
		expect(latestTodoSnapshot([result(before), custom(userSnapshot), result(before)])).toEqual(
			userSnapshot,
		);
	});

	test("ignores unrelated and malformed entries", () => {
		const valid = { tasks: [task(1)], nextId: 2 };
		for (const branch of [
			[{ type: "custom", customType: "other", data: valid }],
			[{ type: "message", message: { role: "toolResult", toolName: "bash" } }],
			[result({ tasks: [], nextId: 0 })],
			[custom({ tasks: [{ id: 1, subject: "x", status: "unknown" }], nextId: 2 })],
		]) {
			expect(latestTodoSnapshot(branch)).toBeUndefined();
		}
	});
});
