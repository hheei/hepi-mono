import { describe, expect, test } from "bun:test";
import { applyTodo, freshTaskState, type TaskState, validateTaskState } from "../src/model.js";

const create = (subject: string, blockedBy?: number[]) => ({
	action: "create" as const,
	subject,
	...(blockedBy === undefined ? {} : { blockedBy }),
});
const update = (id: number, fields: Record<string, unknown>) => ({
	action: "update" as const,
	id,
	...fields,
});

function stateOf(state: TaskState, operations: readonly unknown[]) {
	const result = applyTodo(state, { operations } as never);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result;
}

describe("todo model", () => {
	test("creates trimmed pending tasks and returns ids", () => {
		const result = stateOf(freshTaskState(), [create("  first  ")]);
		expect(result.state).toEqual({
			tasks: [{ id: 1, subject: "first", status: "pending", blockedBy: [] }],
			nextId: 2,
		});
		expect(result.operations).toEqual([{ index: 0, action: "create", changed: true, id: 1 }]);
	});

	test("rejects create when id space is exhausted", () => {
		const state: TaskState = { tasks: [], nextId: Number.MAX_SAFE_INTEGER };
		const result = applyTodo(state, { operations: [create("overflow")] });
		expect(result).toEqual({
			ok: false,
			state,
			error: "Task id space exhausted",
			operationIndex: 0,
		});
	});

	test("commits mixed delete and create atomically", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two", [1])]).state;
		const result = stateOf(initial, [{ action: "delete", id: 1 }, create("three")]);
		expect(result.state.tasks).toEqual([
			{ id: 2, subject: "two", status: "pending", blockedBy: [] },
			{ id: 3, subject: "three", status: "pending", blockedBy: [] },
		]);
		expect(result.state.nextId).toBe(4);
	});

	test("rolls back invalid middle operation", () => {
		const initial = stateOf(freshTaskState(), [create("one")]).state;
		const result = applyTodo(initial, {
			operations: [create("two"), { action: "delete", id: 99 }, create("three")],
		} as never);
		expect(result).toMatchObject({ ok: false, operationIndex: 1, state: initial });
		expect(initial.tasks).toHaveLength(1);
	});

	test("rejects action and field mismatches", () => {
		for (const operation of [
			{ action: "create", id: 1, subject: "x" },
			{ action: "delete", id: 1, subject: "x" },
			{ action: "list", id: 1 },
		]) {
			const result = applyTodo(freshTaskState(), { operations: [operation] } as never);
			expect(result.ok).toBe(false);
		}
	});

	test("rejects terminal control characters in task subjects", () => {
		for (const subject of ["line\nbreak", "tab\tbreak", "\u001b[31mred"]) {
			const createResult = applyTodo(freshTaskState(), {
				operations: [{ action: "create", subject }],
			} as never);
			expect(createResult).toMatchObject({
				ok: false,
				error: "Subject must be one printable line",
			});
		}
		const initial = stateOf(freshTaskState(), [create("safe")]).state;
		expect(
			applyTodo(initial, { operations: [update(1, { subject: "bad\rline" })] } as never),
		).toMatchObject({
			ok: false,
			error: "Subject must be one printable line",
			state: initial,
		});
		expect(
			validateTaskState({
				tasks: [{ id: 1, subject: "bad\u2028line", status: "pending", blockedBy: [] }],
				nextId: 2,
			}),
		).toBeUndefined();
	});

	test("enforces status transitions", () => {
		const initial = stateOf(freshTaskState(), [create("one")]).state;
		const completed = stateOf(initial, [update(1, { status: "completed" })]).state;
		const result = applyTodo(completed, {
			operations: [update(1, { status: "pending" })],
		} as never);
		expect(result).toMatchObject({ ok: false, operationIndex: 0 });
	});

	test("validates dependencies and cycles", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two")]).state;
		expect(
			applyTodo(initial, { operations: [update(1, { blockedBy: [99] })] } as never),
		).toMatchObject({ ok: false, operationIndex: 0 });
		const cyclic = applyTodo(initial, {
			operations: [update(1, { blockedBy: [2] }), update(2, { blockedBy: [1] })],
		} as never);
		expect(cyclic).toMatchObject({ ok: false, operationIndex: 1, state: initial });
	});

	test("rejects completing a task with incomplete blockers", () => {
		const initial = stateOf(freshTaskState(), [create("blocker"), create("blocked", [1])]).state;
		const result = applyTodo(initial, {
			operations: [update(2, { status: "completed" })],
		} as never);
		expect(result).toMatchObject({
			ok: false,
			error: "Task #2 cannot be completed while blocked by incomplete task #1",
			operationIndex: 0,
			state: initial,
		});
	});

	test("allows blocker completion before dependent completion in one batch", () => {
		const initial = stateOf(freshTaskState(), [create("blocker"), create("blocked", [1])]).state;
		const result = stateOf(initial, [
			update(1, { status: "completed" }),
			update(2, { status: "completed" }),
		]);
		expect(result.state.tasks.every((task) => task.status === "completed")).toBe(true);
	});

	test("rejects multiple in-progress tasks within and across calls", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two")]).state;
		expect(
			applyTodo(initial, {
				operations: [update(1, { status: "in_progress" }), update(2, { status: "in_progress" })],
			} as never),
		).toMatchObject({
			ok: false,
			error: "Task #2 cannot be in progress while Task #1 is in progress",
			operationIndex: 1,
			state: initial,
		});
		const active = stateOf(initial, [update(1, { status: "in_progress" })]).state;
		expect(
			applyTodo(active, { operations: [update(2, { status: "in_progress" })] } as never),
		).toMatchObject({
			ok: false,
			error: "Task #2 cannot be in progress while Task #1 is in progress",
			operationIndex: 0,
			state: active,
		});
	});

	test("rejects snapshots violating status invariants", () => {
		expect(
			validateTaskState({
				nextId: 3,
				tasks: [
					{ id: 1, subject: "blocker", status: "pending", blockedBy: [] },
					{ id: 2, subject: "blocked", status: "completed", blockedBy: [1] },
				],
			}),
		).toBeUndefined();
		expect(
			validateTaskState({
				nextId: 3,
				tasks: [
					{ id: 1, subject: "one", status: "in_progress", blockedBy: [] },
					{ id: 2, subject: "two", status: "in_progress", blockedBy: [] },
				],
			}),
		).toBeUndefined();
	});

	test("validates dependency chains beyond the call stack", () => {
		const count = 50_000;
		const tasks = Array.from({ length: count }, (_, index) => ({
			id: index + 1,
			subject: "task",
			status: "pending" as const,
			blockedBy: index + 1 < count ? [index + 2] : [],
		}));
		expect(validateTaskState({ tasks, nextId: count + 1 })).toBeDefined();
	});

	test("reports update no-op without new state", () => {
		const initial = stateOf(freshTaskState(), [create("one")]).state;
		const result = stateOf(initial, [update(1, { subject: " one " })]);
		expect(result.changed).toBe(false);
		expect(result.state).toBe(initial);
		expect(result.operations[0]).toMatchObject({ changed: false, id: 1 });
	});

	test("scrubs dependencies and preserves monotonic ids", () => {
		const initial = stateOf(freshTaskState(), [create("one"), create("two", [1])]).state;
		const result = stateOf(initial, [{ action: "delete", id: 1 }, create("three")]);
		expect(result.state.nextId).toBe(4);
		expect(result.state.tasks[0]?.blockedBy).toEqual([]);
	});

	test("requires list to be sole operation", () => {
		const result = applyTodo(freshTaskState(), {
			operations: [{ action: "list" }, create("x")],
		} as never);
		expect(result).toMatchObject({ ok: false, operationIndex: 0 });
	});

	test("validates snapshots and deep-isolates result", () => {
		const input = {
			nextId: 3,
			tasks: [
				{ id: 1, subject: "one", status: "completed" as const, blockedBy: [] },
				{ id: 2, subject: "two", status: "completed" as const, blockedBy: [1] },
			],
		};
		const result = validateTaskState(input);
		expect(result).toEqual(input);
		if (!result) throw new Error("expected valid snapshot");
		(input.tasks[1]!.blockedBy as number[]).push(99);
		expect(result.tasks[1]!.blockedBy).toEqual([1]);
		for (const malformed of [
			{ nextId: 1, tasks: [{ id: 1, subject: "x", status: "pending", blockedBy: [] }] },
			{ nextId: 3, tasks: [{ id: 1, subject: "x", status: "pending", blockedBy: [1] }] },
			{
				nextId: 3,
				tasks: [
					{ id: 1, subject: "x", status: "pending", blockedBy: [2] },
					{ id: 2, subject: "y", status: "pending", blockedBy: [1] },
				],
			},
		])
			expect(validateTaskState(malformed)).toBeUndefined();
	});
});
