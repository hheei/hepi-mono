import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Task, TaskState, TaskStatus } from "./model.js";

export const TODO_STATUS_KEY = "pi-ext-tools:todo";
export const COMPLETED_DISPLAY_DURATION_MS = 3 * 60 * 1000; // 3 minutes
export const COMPLETED_WITH_SUBSEQUENT_DURATION_MS = 15 * 1000; // 15 seconds
export const BLOCKED_DISPLAY_DURATION_MS = 15 * 1000; // 15 seconds

export interface FooterStatusDecision {
	readonly text: string | undefined;
	readonly expiresAt?: number;
}

/** Most recently updated task in `status` whose update is still inside `window`. */
function mostRecent(
	tasks: readonly Task[],
	status: TaskStatus,
	window: number,
	now: number,
): Task | undefined {
	let newest: Task | undefined;
	for (const task of tasks) {
		if (task.status !== status || task.updatedAt === undefined) continue;
		if (now - task.updatedAt >= window) continue;
		if (newest === undefined || task.updatedAt > (newest.updatedAt ?? 0)) newest = task;
	}
	return newest;
}

function formatTaskStatus(
	task: Task,
	glyph: string,
	tone: "success" | "warning" | "dim" | "muted",
	theme?: Theme,
): string {
	const subject = task.subject.trim();
	if (!theme) return `${glyph} #${task.id} ${subject}`;
	const styledGlyph = theme.fg(tone, glyph);
	const styledId = theme.fg("accent", `#${task.id}`);
	const styledSubject =
		tone === "dim" || tone === "success" ? theme.fg("dim", subject) : theme.fg("text", subject);
	return `${styledGlyph} ${styledId} ${styledSubject}`;
}

/**
 * Footer text for the current task state, plus when that text expires.
 *
 * An in-progress task wins, then a recently completed one, then pending, then recently
 * blocked; with no in-progress task a recent completion and a recent block compete on
 * recency. A completion stays visible for `COMPLETED_WITH_SUBSEQUENT_DURATION_MS` when
 * work is already queued behind it, otherwise for `COMPLETED_DISPLAY_DURATION_MS`.
 */
export function computeFooterStatus(
	state: TaskState,
	now: number = Date.now(),
	theme?: Theme,
): FooterStatusDecision {
	const inProgress = state.tasks.find((task) => task.status === "in_progress");
	const completedDuration = inProgress
		? COMPLETED_WITH_SUBSEQUENT_DURATION_MS
		: COMPLETED_DISPLAY_DURATION_MS;
	const recentCompleted = mostRecent(state.tasks, "completed", completedDuration, now);
	const recentBlocked = mostRecent(state.tasks, "blocked", BLOCKED_DISPLAY_DURATION_MS, now);

	if (!inProgress && recentCompleted && recentBlocked) {
		const completedTime = recentCompleted.updatedAt ?? 0;
		const blockedTime = recentBlocked.updatedAt ?? 0;
		if (completedTime >= blockedTime) {
			return {
				text: formatTaskStatus(recentCompleted, "✓", "success", theme),
				expiresAt: completedTime + COMPLETED_DISPLAY_DURATION_MS,
			};
		}
		return {
			text: formatTaskStatus(recentBlocked, "⊘", "dim", theme),
			expiresAt: blockedTime + BLOCKED_DISPLAY_DURATION_MS,
		};
	}

	if (recentCompleted) {
		return {
			text: formatTaskStatus(recentCompleted, "✓", "success", theme),
			expiresAt: (recentCompleted.updatedAt ?? 0) + completedDuration,
		};
	}

	if (inProgress) {
		return { text: formatTaskStatus(inProgress, "◐", "warning", theme) };
	}

	const pending = state.tasks.find((task) => task.status === "pending");
	if (pending) {
		return { text: formatTaskStatus(pending, "○", "muted", theme) };
	}

	if (recentBlocked) {
		return {
			text: formatTaskStatus(recentBlocked, "⊘", "dim", theme),
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
	ui: Pick<ExtensionUIContext, "setStatus"> & { readonly theme?: Theme },
	signal?: AbortSignal,
	now: () => number = () => Date.now(),
): TodoFooterStatusController {
	let currentTimer: ReturnType<typeof setTimeout> | undefined;
	let isDisposed = false;

	const clearTimer = (): void => {
		if (currentTimer !== undefined) clearTimeout(currentTimer);
		currentTimer = undefined;
	};

	/** Renders the state, and re-renders when text that is only shown for a while expires. */
	const scheduleNext = (state: TaskState): void => {
		clearTimer();
		const decision = computeFooterStatus(state, now(), ui.theme);
		ui.setStatus(TODO_STATUS_KEY, decision.text);
		if (decision.expiresAt !== undefined) {
			currentTimer = setTimeout(() => scheduleNext(state), decision.expiresAt - now());
		}
	};

	const dispose = (): void => {
		if (isDisposed) return;
		isDisposed = true;
		clearTimer();
		ui.setStatus(TODO_STATUS_KEY, undefined);
	};

	if (signal?.aborted === true) dispose();
	else signal?.addEventListener("abort", dispose, { once: true });

	return {
		update(state: TaskState): void {
			if (isDisposed) return;
			scheduleNext(state);
		},
		dispose,
	};
}
