import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskState } from "./model.js";

const TODO_WIDGET_KEY = "pi-todo:tasks";
const MAX_TASK_ROWS = 6;

export interface TodoWidget {
	/** Refreshes presentation from model state; model mutation remains feature-owned. */
	refresh(state: TaskState, trackCompletions?: boolean): void;
	/** Retires completed rows from the widget without removing them from Todo state. */
	hideCompleted(): void;
	/** Retires blocked rows after their grace window without changing audit state. */
	hideBlocked(ids: readonly number[]): void;
	/** Removes the native above-editor widget from the host. */
	hide(): void;
	/** Idempotently releases widget-local host resources. */
	dispose(): void | Promise<void>;
}

/**
 * Visibility is widget-local presentation state. Suppressed tasks never render;
 * completed and blocked IDs stay visible only for their documented grace window.
 * The Todo model keeps all of them for audit and tool-result rendering.
 */
function visibleTasks(
	state: TaskState,
	displayedCompleted: ReadonlySet<number>,
	hiddenBlocked: ReadonlySet<number>,
): TaskState["tasks"] {
	return state.tasks.filter(
		(task) =>
			task.status !== "suppressed" &&
			(task.status !== "completed" || displayedCompleted.has(task.id)) &&
			(task.status !== "blocked" || !hiddenBlocked.has(task.id)),
	);
}

function statusRank(status: TaskState["tasks"][number]["status"]): number {
	if (status === "in_progress") return 0;
	if (status === "pending") return 1;
	if (status === "blocked") return 2;
	return 3;
}

function renderTodo(
	state: TaskState,
	displayedCompleted: ReadonlySet<number>,
	hiddenBlocked: ReadonlySet<number>,
	width: number,
	theme: Theme,
): string[] {
	const tasks = visibleTasks(state, displayedCompleted, hiddenBlocked)
		.slice()
		.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.id - b.id);
	const total = tasks.length;
	const completed = tasks.filter((task) => task.status === "completed").length;
	if (total === 0) return [];

	const hasRunnable = tasks.some(
		(task) => task.status === "in_progress" || task.status === "pending",
	);
	const heading =
		completed === total
			? `${theme.fg("success", "✓")} ${theme.fg("dim", `Todos (${completed}/${total})`)}`
			: hasRunnable
				? `${theme.fg("accent", "●")} ${theme.fg("text", `Todos (${completed}/${total})`)}`
				: `${theme.fg("dim", "⊘")} ${theme.fg("text", `Todos (${completed}/${total})`)}`;
	const lines = [truncateToWidth(heading, width, "...")];
	const visible = tasks.slice(0, MAX_TASK_ROWS);
	for (let index = 0; index < visible.length; index++) {
		const task = visible[index];
		if (!task) continue;
		const last = index === visible.length - 1 && tasks.length <= MAX_TASK_ROWS;
		const retired = task.status === "completed" || task.status === "blocked";
		const glyph = theme.fg(
			retired
				? task.status === "completed"
					? "success"
					: "dim"
				: task.status === "in_progress"
					? "warning"
					: "muted",
			task.status === "completed"
				? "✓"
				: task.status === "in_progress"
					? "◐"
					: task.status === "blocked"
						? "⊘"
						: "○",
		);
		const subject = theme.fg(
			retired ? "dim" : "text",
			retired ? theme.strikethrough(task.subject) : task.subject,
		);
		lines.push(
			truncateToWidth(
				`${theme.fg("dim", `${last ? "└" : "├"}─`)} ${glyph} ${theme.fg("accent", `#${task.id}`)} ${subject}`,
				width,
				"...",
			),
		);
	}
	if (tasks.length > MAX_TASK_ROWS) {
		lines.push(
			truncateToWidth(theme.fg("dim", `└─ +${tasks.length - MAX_TASK_ROWS} more`), width, "..."),
		);
	}
	lines.push("");
	return lines;
}

export function createTodoWidget(
	context: ExtensionContext,
	initialState: TaskState,
): TodoWidget | undefined {
	if (context.mode !== "tui") return undefined;

	let state = initialState;
	const displayedCompleted = new Set<number>();
	const hiddenBlocked = new Set<number>();
	let registered = false;
	let invalidated = false;
	let currentTui: TUI | undefined;
	let disposed = false;

	// Native above-editor mounting avoids editor cursor/input interference. Core
	// has no widget compositor yet, so this feature owns its key, visibility sets,
	// invalidation and exact unregister lifecycle.
	const factory = (tui: TUI, theme: Theme): Component & { dispose(): void } => {
		currentTui = tui;
		return {
			render: (width) => renderTodo(state, displayedCompleted, hiddenBlocked, width, theme),
			invalidate() {
				invalidated = true;
				currentTui = undefined;
			},
			dispose() {
				invalidated = true;
				currentTui = undefined;
			},
		};
	};

	const hasTasks = () => visibleTasks(state, displayedCompleted, hiddenBlocked).length > 0;
	const unregister = () => {
		if (!registered) return;
		context.ui.setWidget(TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		registered = false;
		invalidated = false;
		currentTui = undefined;
	};
	const register = () => {
		if (disposed || !hasTasks() || (registered && !invalidated)) return;
		context.ui.setWidget(TODO_WIDGET_KEY, factory, { placement: "aboveEditor" });
		registered = true;
		invalidated = false;
	};

	register();
	return {
		refresh(nextState, trackCompletions = true) {
			if (disposed) return;
			if (trackCompletions) {
				const previous = new Map(state.tasks.map((task) => [task.id, task.status]));
				for (const task of nextState.tasks) {
					if (task.status === "completed" && previous.get(task.id) !== "completed") {
						displayedCompleted.add(task.id);
					}
				}
			}
			for (const id of displayedCompleted) {
				if (!nextState.tasks.some((task) => task.id === id && task.status === "completed")) {
					displayedCompleted.delete(id);
				}
			}
			for (const id of hiddenBlocked) {
				if (!nextState.tasks.some((task) => task.id === id && task.status === "blocked")) {
					hiddenBlocked.delete(id);
				}
			}
			state = nextState;
			if (!hasTasks()) unregister();
			else register();
			if (hasTasks()) currentTui?.requestRender();
		},
		hideCompleted() {
			if (disposed || displayedCompleted.size === 0) return;
			displayedCompleted.clear();
			if (!hasTasks()) unregister();
			else currentTui?.requestRender(true);
		},
		hideBlocked(ids) {
			if (disposed) return;
			let changed = false;
			for (const id of ids) {
				if (state.tasks.some((task) => task.id === id && task.status === "blocked")) {
					changed ||= !hiddenBlocked.has(id);
					hiddenBlocked.add(id);
				}
			}
			if (!changed) return;
			if (!hasTasks()) unregister();
			else currentTui?.requestRender(true);
		},
		hide() {
			if (disposed) return;
			unregister();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			currentTui = undefined;
			unregister();
		},
	};
}
