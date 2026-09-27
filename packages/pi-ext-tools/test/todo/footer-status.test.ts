import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	BLOCKED_DISPLAY_DURATION_MS,
	COMPLETED_DISPLAY_DURATION_MS,
	COMPLETED_WITH_SUBSEQUENT_DURATION_MS,
	computeFooterStatus,
	createTodoFooterStatusController,
	TODO_STATUS_KEY,
} from "../../src/todo/footer-status.js";
import type { Task, TaskState, TaskStatus } from "../../src/todo/model.js";
import { roleTheme } from "../fixtures/theme.js";

function task(id: number, status: TaskStatus, updatedAt: number): Task {
	return { id, subject: `Task ${id}`, status, updatedAt };
}

function state(tasks: readonly Task[]): TaskState {
	return { tasks: [...tasks], nextId: 9 };
}

/** Controller over a fake clock that records every footer text Pi was given. */
function harness(): {
	readonly statuses: (string | undefined)[];
	readonly update: (next: TaskState) => void;
	readonly advance: (ms: number) => void;
	readonly now: () => number;
	readonly dispose: () => void;
} {
	const statuses: (string | undefined)[] = [];
	const ui = {
		setStatus: vi.fn((key: string, text: string | undefined) => {
			if (key === TODO_STATUS_KEY) statuses.push(text);
		}),
	};
	let currentTime = 100_000;
	const controller = createTodoFooterStatusController(ui, undefined, () => currentTime);
	return {
		statuses,
		update: (next) => controller.update(next),
		advance: (ms) => {
			currentTime += ms;
			vi.advanceTimersByTime(ms);
		},
		now: () => currentTime,
		dispose: () => controller.dispose(),
	};
}

describe("todo footer-status", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("maps task state to one footer line, most urgent first", () => {
		const now = 100_000;
		expect(computeFooterStatus(state([]), now)).toEqual({ text: undefined });
		expect(
			computeFooterStatus(state([task(1, "in_progress", now), task(2, "pending", now)]), now).text,
		).toBe("◐ #1 Task 1");
		expect(computeFooterStatus(state([task(2, "pending", now)]), now).text).toBe("○ #2 Task 2");

		// Each terminal state expires on its own clock.
		const done = computeFooterStatus(state([task(1, "completed", now - 60_000)]), now);
		expect(done.text).toBe("✓ #1 Task 1");
		expect(done.expiresAt).toBe(now - 60_000 + COMPLETED_DISPLAY_DURATION_MS);
		expect(
			computeFooterStatus(
				state([task(1, "completed", now - 60_000)]),
				now - 60_000 + COMPLETED_DISPLAY_DURATION_MS + 1,
			).text,
		).toBeUndefined();

		const blocked = computeFooterStatus(state([task(1, "blocked", now - 5_000)]), now);
		expect(blocked.text).toBe("⊘ #1 Task 1");
		expect(blocked.expiresAt).toBe(now - 5_000 + BLOCKED_DISPLAY_DURATION_MS);
		expect(
			computeFooterStatus(
				state([task(1, "blocked", now - 5_000)]),
				now - 5_000 + BLOCKED_DISPLAY_DURATION_MS + 1,
			).text,
		).toBeUndefined();

		// A completion with work queued behind it gets the short window, then yields to it.
		const queued = state([task(1, "completed", now), task(2, "in_progress", now)]);
		const recent = computeFooterStatus(queued, now + 5_000);
		expect(recent.text).toBe("✓ #1 Task 1");
		expect(recent.expiresAt).toBe(now + COMPLETED_WITH_SUBSEQUENT_DURATION_MS);
		expect(computeFooterStatus(queued, now + COMPLETED_WITH_SUBSEQUENT_DURATION_MS + 1)).toEqual({
			text: "◐ #2 Task 2",
		});

		// With nothing in progress, the newer of completed and blocked wins.
		expect(
			computeFooterStatus(
				state([task(1, "completed", now), task(2, "blocked", now + 2_000)]),
				now + 3_000,
			).text,
		).toBe("⊘ #2 Task 2");
		expect(
			computeFooterStatus(
				state([task(1, "blocked", now), task(2, "completed", now + 2_000)]),
				now + 3_000,
			).text,
		).toBe("✓ #2 Task 2");
	});

	test("controller re-renders as each display window expires", () => {
		// A completion clears the footer once its 3-minute window is over.
		const done = harness();
		done.update(state([task(1, "completed", 100_000)]));
		expect(done.statuses).toEqual(["✓ #1 Task 1"]);
		done.advance(2 * 60 * 1000);
		expect(done.statuses).toEqual(["✓ #1 Task 1"]);
		done.advance(60 * 1000 + 1);
		expect(done.statuses).toEqual(["✓ #1 Task 1", undefined]);
		done.dispose();

		// A later block expires first and hands the line back to the earlier completion.
		const fallback = harness();
		fallback.update(state([task(1, "completed", 100_000), task(2, "blocked", 105_000)]));
		expect(fallback.statuses).toEqual(["⊘ #2 Task 2"]);
		fallback.advance(20_001);
		expect(fallback.statuses.at(-1)).toBe("✓ #1 Task 1");
		fallback.advance(160_000);
		expect(fallback.statuses.at(-1)).toBeUndefined();
		fallback.dispose();

		// A completion followed by in-progress work switches to it after 15 seconds.
		const queued = harness();
		queued.update(state([task(1, "completed", 100_000), task(2, "in_progress", 100_000)]));
		expect(queued.statuses).toEqual(["✓ #1 Task 1"]);
		queued.advance(15_001);
		expect(queued.statuses).toEqual(["✓ #1 Task 1", "◐ #2 Task 2"]);
		queued.update(state([task(1, "completed", 100_000), task(2, "completed", queued.now())]));
		expect(queued.statuses.at(-1)).toBe("✓ #2 Task 2");
		queued.advance(3 * 60 * 1000 + 1);
		expect(queued.statuses.at(-1)).toBeUndefined();
		queued.dispose();
	});

	test("controller cleans up on dispose and abort signal", () => {
		const mockUi = {
			setStatus: vi.fn(),
		};
		const abortController = new AbortController();
		const controller = createTodoFooterStatusController(mockUi, abortController.signal);

		controller.update(state([task(1, "in_progress", 100_000)]));
		expect(mockUi.setStatus).toHaveBeenCalledWith(TODO_STATUS_KEY, "◐ #1 Task 1");

		abortController.abort();
		expect(mockUi.setStatus).toHaveBeenLastCalledWith(TODO_STATUS_KEY, undefined);
	});

	test("applies semantic theme styling when theme is provided", () => {
		const now = 100_000;

		const inProgress = computeFooterStatus(state([task(1, "in_progress", now)]), now, roleTheme);
		expect(inProgress.text).toBe("<warning>◐</warning> <accent>#1</accent> <text>Task 1</text>");

		const pending = computeFooterStatus(state([task(2, "pending", now)]), now, roleTheme);
		expect(pending.text).toBe("<muted>○</muted> <accent>#2</accent> <text>Task 2</text>");

		const completed = computeFooterStatus(state([task(3, "completed", now)]), now, roleTheme);
		expect(completed.text).toBe("<success>✓</success> <accent>#3</accent> <dim>Task 3</dim>");

		const blocked = computeFooterStatus(state([task(4, "blocked", now)]), now, roleTheme);
		expect(blocked.text).toBe("<dim>⊘</dim> <accent>#4</accent> <dim>Task 4</dim>");
	});
});
