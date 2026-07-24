import { describe, expect, test } from "bun:test";
import type { TaskState } from "../src/model.js";
import { latestTodoSnapshot, snapshotFromState, stateFromSnapshot } from "../src/state.js";

const task = (id: number, subject = `task ${id}`) => ({
	id,
	subject,
	status: "pending" as const,
	blockedBy: [] as number[],
});

function result(snapshot: unknown, toolName = "todo") {
	return {
		type: "message",
		message: { role: "toolResult", toolName, details: { snapshot } },
	};
}

describe("todo state snapshots", () => {
	test("clones snapshots and replay results", () => {
		const input: TaskState = { tasks: [{ ...task(1), blockedBy: [2] }, task(2)], nextId: 3 };
		const snapshot = snapshotFromState(input);
		(input.tasks[0]!.blockedBy as number[]).push(9);
		expect(snapshot.tasks[0]!.blockedBy).toEqual([2]);

		const replayed = stateFromSnapshot(snapshot)!;
		(snapshot.tasks[0]!.blockedBy as number[]).push(8);
		expect(replayed.tasks[0]!.blockedBy).toEqual([2]);
	});

	test("migrates legacy blocked active tasks without dropping the snapshot", () => {
		const legacy = {
			tasks: [
				{ id: 1, subject: "blocker", status: "pending", blockedBy: [] },
				{ id: 2, subject: "blocked", status: "in_progress", blockedBy: [1] },
				{ id: 3, subject: "next", status: "pending", blockedBy: [2] },
			],
			nextId: 4,
		};
		expect(stateFromSnapshot(legacy)).toEqual({
			tasks: [
				task(1, "blocker"),
				{ ...task(2, "blocked"), blockedBy: [1] },
				{
					...task(3, "next"),
					blockedBy: [2],
				},
			],
			nextId: 4,
		});
		expect(latestTodoSnapshot([result(legacy)])?.tasks.map(({ id }) => id)).toEqual([1, 2, 3]);
	});
	test("latest valid snapshot wins and malformed later entries fall back", () => {
		const first = { tasks: [task(1)], nextId: 2 };
		const second = { tasks: [task(1), task(2)], nextId: 3 };
		const malformed = { tasks: [{ ...task(1), blockedBy: [99] }], nextId: 2 };
		const branch = [result(first), result(second), result(malformed)];
		const replayed = latestTodoSnapshot(branch)!;
		expect(replayed).toEqual(second);
		(second.tasks[0]!.blockedBy as number[]).push(7);
		expect(replayed.tasks[0]!.blockedBy).toEqual([]);
	});

	test("ignores locally valid snapshots whose nextId regresses", () => {
		const current = { tasks: [task(1), task(2)], nextId: 4 };
		const regressed = { tasks: [task(1)], nextId: 2 };
		expect(latestTodoSnapshot([result(current), result(regressed)])).toEqual(current);
	});

	test("ignores non-todo results and non-message entries", () => {
		const snapshot = { tasks: [task(1)], nextId: 2 };
		expect(
			latestTodoSnapshot([
				result(snapshot, "other"),
				{ type: "message", message: { role: "user" } },
			]),
		).toBeUndefined();
	});

	test("rejects invalid task invariants", () => {
		const valid = { tasks: [task(2)], nextId: 3 };
		const invalid = [
			{ ...valid, tasks: [{ ...task(2), id: 0 }] },
			{ ...valid, tasks: [{ ...task(2) }, { ...task(2) }] },
			{ ...valid, tasks: [{ ...task(2), subject: "  " }] },
			{ ...valid, tasks: [{ ...task(2), status: "waiting" }] },
			{ ...valid, tasks: [{ ...task(2), blockedBy: [2, 2] }] },
			{ ...valid, tasks: [{ ...task(2), blockedBy: [9] }] },
			{
				tasks: [
					{ ...task(1), blockedBy: [2] },
					{ ...task(2), blockedBy: [1] },
				],
				nextId: 3,
			},
			{ ...valid, nextId: 2 },
			{ ...valid, nextId: 0 },
		];
		for (const snapshot of invalid) expect(stateFromSnapshot(snapshot)).toBeUndefined();
	});

	test("distinguishes no snapshot from valid empty snapshot", () => {
		expect(latestTodoSnapshot([])).toBeUndefined();
		expect(latestTodoSnapshot([result({ tasks: [], nextId: 1 })])).toEqual({
			tasks: [],
			nextId: 1,
		});
	});
});
