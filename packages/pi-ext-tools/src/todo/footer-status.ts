import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TaskState } from "./model.js";

export const TODO_STATUS_KEY = "pi-ext-tools:todo";
export const COMPLETED_DISPLAY_DURATION_MS = 3 * 60 * 1000; // 3 minutes
export const COMPLETED_WITH_SUBSEQUENT_DURATION_MS = 15 * 1000; // 15 seconds
export const BLOCKED_DISPLAY_DURATION_MS = 15 * 1000; // 15 seconds

export interface FooterStatusDecision {
	readonly text: string | undefined;
	readonly expiresAt?: number;
}

/**
 * Computes the footer status text and optional expiration timestamp
 * for the current task state.
 *
 * Rules:
 * 1. If a task was recently completed:
 *    - With a subsequent in-progress task: displays for 15 seconds, then transitions to in-progress.
 *    - Without subsequent tasks: displays for 3 minutes, then disappears.
 * 2. If no recent completed task within its window:
 *    - In-progress task has top priority: "◐ #<id> <subject>" (no timer).
 *    - Pending task if present: "○ #<id> <subject>" (no timer).
 *    - Recent blocked task within 15 seconds: "⊘ #<id> <subject>".
 * 3. When without in-progress tasks, if both recent completed and blocked exist, choose the most recently updated one.
 * 4. Otherwise: undefined (cleared from footer).
 */
export function computeFooterStatus(
	state: TaskState,
	now: number = Date.now(),
): FooterStatusDecision {
	const inProgress = state.tasks.find((task) => task.status === "in_progress");
	const completedDuration = inProgress
		? COMPLETED_WITH_SUBSEQUENT_DURATION_MS
		: COMPLETED_DISPLAY_DURATION_MS;

	const recentCompleted = state.tasks
		.filter(
			(task) =>
				task.status === "completed" &&
				task.updatedAt !== undefined &&
				now - task.updatedAt < completedDuration,
		)
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];

	const recentBlocked = state.tasks
		.filter(
			(task) =>
				task.status === "blocked" &&
				task.updatedAt !== undefined &&
				now - task.updatedAt < BLOCKED_DISPLAY_DURATION_MS,
		)
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];

	// If there is no in-progress task, completed task (3 min) and blocked task (15s)
	// compete on recency:
	if (!inProgress && recentCompleted && recentBlocked) {
		const completedTime = recentCompleted.updatedAt ?? 0;
		const blockedTime = recentBlocked.updatedAt ?? 0;
		if (completedTime >= blockedTime) {
			return {
				text: `✓ #${recentCompleted.id} ${recentCompleted.subject.trim()}`,
				expiresAt: completedTime + COMPLETED_DISPLAY_DURATION_MS,
			};
		}
		return {
			text: `⊘ #${recentBlocked.id} ${recentBlocked.subject.trim()}`,
			expiresAt: blockedTime + BLOCKED_DISPLAY_DURATION_MS,
		};
	}

	if (recentCompleted) {
		return {
			text: `✓ #${recentCompleted.id} ${recentCompleted.subject.trim()}`,
			expiresAt: (recentCompleted.updatedAt ?? 0) + completedDuration,
		};
	}

	if (inProgress) {
		return { text: `◐ #${inProgress.id} ${inProgress.subject.trim()}` };
	}

	const pending = state.tasks.find((task) => task.status === "pending");
	if (pending) {
		return { text: `○ #${pending.id} ${pending.subject.trim()}` };
	}

	if (recentBlocked) {
		return {
			text: `⊘ #${recentBlocked.id} ${recentBlocked.subject.trim()}`,
			expiresAt: (recentBlocked.updatedAt ?? 0) + BLOCKED_DISPLAY_DURATION_MS,
		};
	}

	return { text: undefined };
}

export interface TodoFooterStatusController {
	update(state: TaskState): void;
	dispose(): void;
}

export function createTodoFooterStatusController(
	ui: Pick<ExtensionUIContext, "setStatus">,
	signal?: AbortSignal,
	now: () => number = () => Date.now(),
): TodoFooterStatusController {
	let currentTimer: ReturnType<typeof setTimeout> | undefined;
	let currentState: TaskState = { tasks: [], nextId: 1 };
	let isDisposed = false;

	const clearTimer = () => {
		if (currentTimer !== undefined) {
			clearTimeout(currentTimer);
			currentTimer = undefined;
		}
	};

	const scheduleNext = () => {
		clearTimer();
		if (isDisposed || signal?.aborted) {
			ui.setStatus(TODO_STATUS_KEY, undefined);
			return;
		}

		const decision = computeFooterStatus(currentState, now());
		ui.setStatus(TODO_STATUS_KEY, decision.text);

		if (decision.expiresAt !== undefined) {
			const delay = Math.max(0, decision.expiresAt - now());
			currentTimer = setTimeout(() => {
				scheduleNext();
			}, delay);
		}
	};

	const dispose = () => {
		if (isDisposed) return;
		isDisposed = true;
		clearTimer();
		ui.setStatus(TODO_STATUS_KEY, undefined);
	};

	if (signal) {
		if (signal.aborted) {
			dispose();
		} else {
			signal.addEventListener("abort", dispose, { once: true });
		}
	}

	return {
		update(state: TaskState) {
			if (isDisposed || signal?.aborted) return;
			currentState = state;
			scheduleNext();
		},
		dispose,
	};
}
