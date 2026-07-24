import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { HePiRuntimeContext } from "@hheei/pi-basics";
import { truncateToWidth } from "@hheei/pi-basics";
import type { TaskState } from "./model.js";

const TODO_WIDGET_KEY = "pi-basics:todo";
const MAX_TASK_ROWS = 6;

export interface TodoWidget {
	refresh(state: TaskState): void;
	hide(): void;
	dispose(): void | Promise<void>;
}

function hasVisibleTasks(state: TaskState): boolean {
	return state.tasks.some((task) => task.status !== "suppressed");
}

function renderTodo(state: TaskState, width: number, theme: Theme): string[] {
	const visibleTasks = state.tasks.filter((task) => task.status !== "suppressed");
	const total = visibleTasks.length;
	const completed = visibleTasks.filter((task) => task.status === "completed").length;
	if (total === completed) {
		return [
			truncateToWidth(
				`${theme.fg("dim", "✓")} ${theme.fg("dim", `Todos ${completed}/${total}`)}`,
				width,
				"...",
			),
		];
	}

	const tasks = visibleTasks
		.filter((task) => task.status !== "completed")
		.slice()
		.sort(
			(a, b) =>
				(a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1) || a.id - b.id,
		);
	const visible = tasks.slice(0, MAX_TASK_ROWS);
	const lines = [
		truncateToWidth(
			`${theme.fg("accent", "●")} ${theme.fg("text", `Todos ${completed}/${total}`)}`,
			width,
			"...",
		),
	];
	for (let index = 0; index < visible.length; index++) {
		const task = visible[index];
		if (!task) continue;
		const last = index === visible.length - 1 && tasks.length <= MAX_TASK_ROWS;
		const glyph = theme.fg(
			task.status === "in_progress" ? "warning" : "muted",
			task.status === "in_progress" ? "◐" : "○",
		);
		lines.push(
			truncateToWidth(
				`${theme.fg("dim", `${last ? "└" : "├"}─`)} ${glyph} ${theme.fg("accent", `#${task.id}`)} ${theme.fg("text", task.subject)}`,
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
	return lines;
}

export function createTodoWidget(
	runtime: HePiRuntimeContext,
	initialState: TaskState,
): TodoWidget | undefined {
	if (runtime.ctx.mode !== "tui") return undefined;

	let state = initialState;
	let registered = false;
	let invalidated = false;
	let currentTui: TUI | undefined;
	let disposed = false;

	const factory = (tui: TUI, theme: Theme): Component & { dispose(): void } => {
		currentTui = tui;
		return {
			render: (width) => renderTodo(state, width, theme),
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

	const unregister = () => {
		if (!registered) return;
		runtime.ctx.ui.setWidget(TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		registered = false;
		invalidated = false;
		currentTui = undefined;
	};
	const register = () => {
		if (disposed || !hasVisibleTasks(state) || (registered && !invalidated)) return;
		runtime.ctx.ui.setWidget(TODO_WIDGET_KEY, factory, { placement: "aboveEditor" });
		registered = true;
		invalidated = false;
	};

	register();
	return {
		refresh(nextState) {
			if (disposed) return;
			state = nextState;
			if (!hasVisibleTasks(state)) unregister();
			else register();
			if (hasVisibleTasks(state)) currentTui?.requestRender();
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
