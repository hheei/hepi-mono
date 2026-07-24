import { describe, expect, test } from "bun:test";
import {
	applyTodo,
	freshTaskState,
	suppressTodoByUser,
	type TaskState,
	type TodoOperation,
	validateTaskState,
} from "../src/model.js";

const create = (subject: string): TodoOperation => ({ action: "create", subject });
const update = (
	id: number,
	fields: Omit<Extract<TodoOperation, { action: "update" }>, "action" | "id">,
): TodoOperation => ({ action: "update", id, ...fields });

function stateOf(state: TaskState, operations: readonly TodoOperation[]) {
	const result = applyTodo(state, { operations });
	if (!result.ok) throw new Error(result.error);
	return result;
}

describe("todo model", () => {
	test("creates trimmed tasks and auto-starts the first pending task", () => {
		const result = stateOf(freshTaskState(), [create("  first  "), create("second")]);
		expect(result.state).toEqual({
			tasks: [
				{ id: 1, subject: "first", status: "in_progress" },
				{ id: 2, subject: "second", status: "pending" },
			],
			nextId: 3,
		});
		expect(result.operations).toEqual([
			{ index: 0, action: "create", changed: true, id: 1 },
			{ index: 1, action: "create", changed: true, id: 2 },
		]);
		expect(result.autoStartedId).toBe(1);
	});

	test("commits mixed delete and create atomically and advances", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two")]).state;
		const result = stateOf(initial, [{ action: "delete", id: 1 }, create("three")]);
		expect(result.state).toEqual({
			tasks: [
				{ id: 2, subject: "two", status: "in_progress" },
				{ id: 3, subject: "three", status: "pending" },
			],
			nextId: 4,
		});
		expect(result.autoStartedId).toBe(2);
	});

	test("rolls back an invalid middle operation", () => {
		const initial = stateOf(freshTaskState(), [create("one")]).state;
		const result = applyTodo(initial, {
			operations: [create("two"), update(99, { status: "completed" }), create("three")],
		});
		expect(result).toMatchObject({ ok: false, operationIndex: 1, state: initial });
		expect(initial.tasks).toHaveLength(1);
	});

	test("validates fields and printable subjects", () => {
		const initial = freshTaskState();
		for (const operations of [
			[],
			[{ action: "list" }, create("two")],
			[{ action: "create", subject: " " }],
			[{ action: "create", subject: "bad\nline" }],
			[{ action: "create", subject: "x", blockedBy: [] }],
		] as const) {
			expect(applyTodo(initial, { operations } as never).ok).toBe(false);
		}
	});

	test("enforces completed and single-active transitions", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two")]).state;
		expect(
			applyTodo(initial, { operations: [update(2, { status: "in_progress" })] }),
		).toMatchObject({
			ok: false,
			error: "Task #2 cannot be in progress while Task #1 is in progress",
		});
		const completed = stateOf(initial, [update(1, { status: "completed" })]).state;
		expect(applyTodo(completed, { operations: [update(1, { status: "pending" })] })).toMatchObject({
			ok: false,
			operationIndex: 0,
		});
	});

	test("auto-advances after completion and respects an agent pause batch", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two")]).state;
		const advanced = stateOf(initial, [update(1, { status: "completed" })]);
		expect(advanced.autoStartedId).toBe(2);
		expect(advanced.state.tasks.map(({ status }) => status)).toEqual(["completed", "in_progress"]);

		const paused = stateOf(advanced.state, [update(2, { status: "pending" })]);
		expect(paused.autoStartedId).toBeUndefined();
		const changedWhilePaused = stateOf(paused.state, [
			update(2, { subject: "updated two" }),
			update(2, { status: "pending" }),
		]);
		expect(changedWhilePaused.autoStartedId).toBeUndefined();
		expect(changedWhilePaused.state.tasks[1]).toMatchObject({
			subject: "updated two",
			status: "pending",
		});
	});

	test("user suppression is immutable to the agent and starts the next task", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two")]).state;
		const suppressed = suppressTodoByUser(initial, 1);
		expect(suppressed).toMatchObject({ ok: true, changed: true, autoStartedId: 2 });
		if (!suppressed.ok) throw new Error(suppressed.error);
		expect(suppressed.state.tasks).toEqual([
			{ id: 1, subject: "one", status: "suppressed" },
			{ id: 2, subject: "two", status: "in_progress" },
		]);
		for (const operation of [
			update(1, { subject: "changed" }),
			update(1, { status: "completed" }),
			{ action: "delete", id: 1 } as const,
		]) {
			expect(applyTodo(suppressed.state, { operations: [operation] })).toMatchObject({
				ok: false,
				error: "The user suppressed #1 before.",
				state: suppressed.state,
			});
		}
	});

	test("user suppression is idempotent and rejects completed tasks", () => {
		const initial = stateOf(freshTaskState(), [create("one")]).state;
		const first = suppressTodoByUser(initial, 1);
		expect(first).toMatchObject({ ok: true, changed: true });
		if (!first.ok) throw new Error(first.error);
		expect(suppressTodoByUser(first.state, 1)).toEqual({
			ok: true,
			changed: false,
			state: first.state,
		});
		const completed = stateOf(initial, [update(1, { status: "completed" })]).state;
		expect(suppressTodoByUser(completed, 1)).toMatchObject({
			ok: false,
			error: "Task #1 is already completed",
		});
		expect(suppressTodoByUser(initial, 99)).toMatchObject({
			ok: false,
			error: "Task #99 does not exist",
		});
	});

	test("list and no-op updates preserve state identity", () => {
		const initial = stateOf(freshTaskState(), [create("one")]).state;
		const listed = stateOf(initial, [{ action: "list" }]);
		expect(listed.changed).toBe(false);
		expect(listed.state).toBe(initial);
		const unchanged = stateOf(initial, [update(1, { subject: " one " })]);
		expect(unchanged.changed).toBe(false);
		expect(unchanged.state).toBe(initial);
	});

	test("validates snapshots and ignores legacy blockedBy fields", () => {
		const legacy = {
			tasks: [
				{ id: 1, subject: "one", status: "in_progress", blockedBy: [99] },
				{ id: 2, subject: "two", status: "pending", blockedBy: [1] },
			],
			nextId: 3,
		};
		expect(validateTaskState(legacy)).toEqual({
			tasks: [
				{ id: 1, subject: "one", status: "in_progress" },
				{ id: 2, subject: "two", status: "pending" },
			],
			nextId: 3,
		});
		for (const malformed of [
			{ nextId: 1, tasks: [{ id: 1, subject: "x", status: "pending" }] },
			{
				nextId: 3,
				tasks: [
					{ id: 1, subject: "one", status: "in_progress" },
					{ id: 2, subject: "two", status: "in_progress" },
				],
			},
			{ nextId: 2, tasks: [{ id: 1, subject: "x", status: "unknown" }] },
		]) {
			expect(validateTaskState(malformed)).toBeUndefined();
		}
	});
});
