import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { HePiRuntimeContext } from "../../runtime/context.js";
import { truncateToWidth } from "../../ui/text.js";
import type { TaskState } from "./model.js";

const TODO_WIDGET_KEY = "pi-basics:todo";
const MAX_TASK_ROWS = 6;

export interface TodoWidget {
	refresh(state: TaskState): void;
	hide(): void;
	dispose(): void | Promise<void>;
}

function renderTodo(state: TaskState, width: number, theme: Theme): string[] {
	const total = state.tasks.length;
	const completed = state.tasks.filter((task) => task.status === "completed").length;
	if (total === completed) {
		return [
			truncateToWidth(
				`${theme.fg("dim", "✓")} ${theme.fg("dim", `Todos ${completed}/${total}`)}`,
				width,
				"...",
			),
		];
	}

	const unresolved = new Map(state.tasks.map((task) => [task.id, task]));
	const tasks = state.tasks
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
		const task = visible[index]!;
		const blockers = task.blockedBy.filter((id) => unresolved.get(id)?.status !== "completed");
		const suffix = blockers.length
			? `  ${theme.fg("warning", "⊘")} ${blockers.map((id) => theme.fg("accent", `#${id}`)).join(",")}`
			: "";
		const last = index === visible.length - 1 && tasks.length <= MAX_TASK_ROWS;
		const glyph = theme.fg(
			task.status === "in_progress" ? "warning" : "muted",
			task.status === "in_progress" ? "◐" : "○",
		);
		lines.push(
			truncateToWidth(
				`${theme.fg("dim", `${last ? "└" : "├"}─`)} ${glyph} ${theme.fg("accent", `#${task.id}`)} ${theme.fg("text", task.subject)}${suffix}`,
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
		if (disposed || state.tasks.length === 0 || (registered && !invalidated)) return;
		runtime.ctx.ui.setWidget(TODO_WIDGET_KEY, factory, { placement: "aboveEditor" });
		registered = true;
		invalidated = false;
	};

	register();
	return {
		refresh(nextState) {
			if (disposed) return;
			state = nextState;
			if (state.tasks.length === 0) unregister();
			else register();
			if (state.tasks.length > 0) currentTui?.requestRender();
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
