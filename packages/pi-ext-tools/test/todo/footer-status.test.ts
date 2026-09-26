import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	BLOCKED_DISPLAY_DURATION_MS,
	COMPLETED_DISPLAY_DURATION_MS,
	COMPLETED_WITH_SUBSEQUENT_DURATION_MS,
	computeFooterStatus,
	createTodoFooterStatusController,
	TODO_STATUS_KEY,
} from "../../src/todo/footer-status.js";
import type { TaskState } from "../../src/todo/model.js";

describe("todo footer-status", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("returns undefined for empty tasks", () => {
		const state: TaskState = { tasks: [], nextId: 1 };
		expect(computeFooterStatus(state, 1000)).toEqual({ text: undefined });
	});

	test("prioritizes in-progress task and formats with ◐", () => {
		const state: TaskState = {
			tasks: [
				{ id: 1, subject: "Working on UI", status: "in_progress", updatedAt: 1000 },
				{ id: 2, subject: "Upcoming task", status: "pending", updatedAt: 1000 },
			],
			nextId: 3,
		};
		expect(computeFooterStatus(state, 1500)).toEqual({
			text: "◐ #1 Working on UI",
		});
	});

	test("shows pending task if no in-progress task", () => {
		const state: TaskState = {
			tasks: [{ id: 2, subject: "Upcoming task", status: "pending", updatedAt: 1000 }],
			nextId: 3,
		};
		expect(computeFooterStatus(state, 1500)).toEqual({
			text: "○ #2 Upcoming task",
		});
	});

	test("shows completed task within 3 minutes and calculates expiration", () => {
		const now = 100_000;
		const state: TaskState = {
			tasks: [{ id: 1, subject: "Completed task", status: "completed", updatedAt: now - 60_000 }],
			nextId: 2,
		};
		const decision = computeFooterStatus(state, now);
		expect(decision.text).toBe("✓ #1 Completed task");
		expect(decision.expiresAt).toBe(now - 60_000 + COMPLETED_DISPLAY_DURATION_MS);

		// After 3 minutes
		const expired = computeFooterStatus(state, now - 60_000 + COMPLETED_DISPLAY_DURATION_MS + 1);
		expect(expired.text).toBeUndefined();
	});

	test("shows blocked task within 15 seconds and calculates expiration", () => {
		const now = 100_000;
		const state: TaskState = {
			tasks: [{ id: 1, subject: "Blocked task", status: "blocked", updatedAt: now - 5_000 }],
			nextId: 2,
		};
		const decision = computeFooterStatus(state, now);
		expect(decision.text).toBe("⊘ #1 Blocked task");
		expect(decision.expiresAt).toBe(now - 5_000 + BLOCKED_DISPLAY_DURATION_MS);

		// After 15 seconds
		const expired = computeFooterStatus(state, now - 5_000 + BLOCKED_DISPLAY_DURATION_MS + 1);
		expect(expired.text).toBeUndefined();
	});

	test("picks the more recent when both completed and blocked exist", () => {
		const baseTime = 100_000;
		// Case A: Blocked is more recent
		const blockedRecent: TaskState = {
			tasks: [
				{ id: 1, subject: "Done first", status: "completed", updatedAt: baseTime },
				{ id: 2, subject: "Blocked later", status: "blocked", updatedAt: baseTime + 2_000 },
			],
			nextId: 3,
		};
		const decisionA = computeFooterStatus(blockedRecent, baseTime + 3_000);
		expect(decisionA.text).toBe("⊘ #2 Blocked later");

		// Case B: Completed is more recent
		const completedRecent: TaskState = {
			tasks: [
				{ id: 1, subject: "Blocked first", status: "blocked", updatedAt: baseTime },
				{ id: 2, subject: "Done later", status: "completed", updatedAt: baseTime + 2_000 },
			],
			nextId: 3,
		};
		const decisionB = computeFooterStatus(completedRecent, baseTime + 3_000);
		expect(decisionB.text).toBe("✓ #2 Done later");
	});

	test("controller manages timer and clears status on expiration", () => {
		const statuses: (string | undefined)[] = [];
		const mockUi = {
			setStatus: vi.fn((key: string, text: string | undefined) => {
				if (key === TODO_STATUS_KEY) statuses.push(text);
			}),
		};

		let currentTime = 100_000;
		const controller = createTodoFooterStatusController(mockUi, undefined, () => currentTime);

		const state: TaskState = {
			tasks: [{ id: 1, subject: "Done", status: "completed", updatedAt: currentTime }],
			nextId: 2,
		};

		controller.update(state);
		expect(statuses).toEqual(["✓ #1 Done"]);

		// Advance time by 2 minutes - still visible
		currentTime += 2 * 60 * 1000;
		vi.advanceTimersByTime(2 * 60 * 1000);
		expect(statuses).toEqual(["✓ #1 Done"]);

		// Advance past 3 minutes (another 1 minute + 1ms) - timer fires and sets status to undefined
		currentTime += 60 * 1000 + 1;
		vi.advanceTimersByTime(60 * 1000 + 1);
		expect(statuses).toEqual(["✓ #1 Done", undefined]);

		controller.dispose();
	});

	test("controller falls back to completed task when more recent blocked task expires", () => {
		const statuses: (string | undefined)[] = [];
		const mockUi = {
			setStatus: vi.fn((key: string, text: string | undefined) => {
				if (key === TODO_STATUS_KEY) statuses.push(text);
			}),
		};

		let currentTime = 100_000;
		const controller = createTodoFooterStatusController(mockUi, undefined, () => currentTime);

		// Task 1 completed at t=100_000 (valid until 280_000)
		// Task 2 blocked at t=105_000 (valid until 120_000)
		const state: TaskState = {
			tasks: [
				{ id: 1, subject: "Done early", status: "completed", updatedAt: 100_000 },
				{ id: 2, subject: "Blocked late", status: "blocked", updatedAt: 105_000 },
			],
			nextId: 3,
		};

		currentTime = 106_000;
		controller.update(state);
		expect(statuses).toEqual(["⊘ #2 Blocked late"]);

		// Advance past 120_000 (blocked task expires)
		currentTime = 120_001;
		vi.advanceTimersByTime(14_001);

		// Should fall back to completed task!
		expect(statuses[statuses.length - 1]).toBe("✓ #1 Done early");

		// Advance past 280_000 (completed task expires)
		currentTime = 280_001;
		vi.advanceTimersByTime(160_000);
		expect(statuses[statuses.length - 1]).toBeUndefined();

		controller.dispose();
	});

	test("controller cleans up on dispose and abort signal", () => {
		const mockUi = {
			setStatus: vi.fn(),
		};
		const abortController = new AbortController();
		const controller = createTodoFooterStatusController(mockUi, abortController.signal);

		controller.update({
			tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
			nextId: 2,
		});
		expect(mockUi.setStatus).toHaveBeenCalledWith(TODO_STATUS_KEY, "◐ #1 Task");

		abortController.abort();
		expect(mockUi.setStatus).toHaveBeenLastCalledWith(TODO_STATUS_KEY, undefined);
	});

	test("shows recent completed task for 15 seconds when subsequent in_progress task exists", () => {
		const state: TaskState = {
			tasks: [
				{ id: 1, subject: "First task", status: "completed", updatedAt: 10_000 },
				{ id: 2, subject: "Next task", status: "in_progress", updatedAt: 10_000 },
			],
			nextId: 3,
		};

		// Within 15 seconds: shows completed task with 15-second expiration
		const decision = computeFooterStatus(state, 15_000);
		expect(decision.text).toBe("✓ #1 First task");
		expect(decision.expiresAt).toBe(10_000 + COMPLETED_WITH_SUBSEQUENT_DURATION_MS);

		// After 15 seconds: switches to the subsequent in-progress task
		const after15s = computeFooterStatus(state, 10_000 + COMPLETED_WITH_SUBSEQUENT_DURATION_MS + 1);
		expect(after15s.text).toBe("◐ #2 Next task");
		expect(after15s.expiresAt).toBeUndefined();
	});

	test("controller transitions from completed to in-progress after 15 seconds", () => {
		const statuses: (string | undefined)[] = [];
		const mockUi = {
			setStatus: vi.fn((key: string, text: string | undefined) => {
				if (key === TODO_STATUS_KEY) statuses.push(text);
			}),
		};

		let currentTime = 100_000;
		const controller = createTodoFooterStatusController(mockUi, undefined, () => currentTime);

		// Step 1: Task 1 completed, Task 2 in progress
		controller.update({
			tasks: [
				{ id: 1, subject: "Task 1", status: "completed", updatedAt: currentTime },
				{ id: 2, subject: "Task 2", status: "in_progress", updatedAt: currentTime },
			],
			nextId: 3,
		});
		expect(statuses).toEqual(["✓ #1 Task 1"]);

		// Advance 15 seconds -> switches to Task 2 in progress
		currentTime += 15_000 + 1;
		vi.advanceTimersByTime(15_000 + 1);
		expect(statuses).toEqual(["✓ #1 Task 1", "◐ #2 Task 2"]);

		// Step 2: Task 2 completed, no subsequent tasks
		currentTime += 10_000;
		controller.update({
			tasks: [
				{ id: 1, subject: "Task 1", status: "completed", updatedAt: 100_000 },
				{ id: 2, subject: "Task 2", status: "completed", updatedAt: currentTime },
			],
			nextId: 3,
		});
		expect(statuses[statuses.length - 1]).toBe("✓ #2 Task 2");

		// Advance 3 minutes -> clears status
		currentTime += 3 * 60 * 1000 + 1;
		vi.advanceTimersByTime(3 * 60 * 1000 + 1);
		expect(statuses[statuses.length - 1]).toBeUndefined();

		controller.dispose();
	});
});
