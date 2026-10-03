import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { registerWidget, type WidgetHandle } from "@hheei/pi-ext-core";
import {
	type PublicSubagent,
	type SubagentState,
	toVisualSubagentState,
	VISUAL_SUBAGENT_GLYPH,
	VISUAL_SUBAGENT_TONE,
} from "./domain.js";

const WIDGET_ID = "@hheei/pi-subagents:status";
const MAX_ROWS = 8;
const ELAPSED_TICK_MS = 1_000;
export const SUBAGENT_TERMINAL_DISPLAY_DURATION_MS = 15_000;

export interface SubagentWidget {
	refresh(children: readonly PublicSubagent[]): void;
	dispose(): void;
}

export function isTerminalState(state: SubagentState): boolean {
	return state === "done" || state === "blocked" || state === "error";
}

export function isWidgetVisibleChild(child: PublicSubagent, nowMs = Date.now()): boolean {
	const visual = toVisualSubagentState(child.state, child.interrupted);
	if (visual === "running") {
		return true;
	}
	const updated = Date.parse(child.updatedAt);
	if (!Number.isNaN(updated) && nowMs - updated < SUBAGENT_TERMINAL_DISPLAY_DURATION_MS) {
		return true;
	}
	return false;
}

function visibleChildren(
	children: readonly PublicSubagent[],
	nowMs = Date.now(),
): PublicSubagent[] {
	return children.filter((c) => isWidgetVisibleChild(c, nowMs));
}

export function formatElapsed(fromIso: string, nowMs = Date.now()): string {
	const from = Date.parse(fromIso);
	if (Number.isNaN(from)) return "";
	const totalSeconds = Math.max(0, Math.floor((nowMs - from) / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

export function renderSubagentWidget(
	children: readonly PublicSubagent[],
	width: number,
	theme: Theme,
	nowMs = Date.now(),
): string[] {
	const visible = visibleChildren(children, nowMs);
	if (visible.length === 0) return [];

	const heading = `🤖 ${theme.fg("text", "Agents:")}`;
	const lines = [truncateToWidth(heading, width, theme.fg("dim", "…"))];
	const rows = visible.slice(0, MAX_ROWS);
	const sep = theme.fg("dim", " · ");

	for (let index = 0; index < rows.length; index++) {
		const child = rows[index];
		if (child === undefined) continue;

		const visual = toVisualSubagentState(child.state, child.interrupted);
		const glyph = VISUAL_SUBAGENT_GLYPH[visual];
		const tone = VISUAL_SUBAGENT_TONE[visual];

		const glyphStyled = theme.fg(tone, glyph);
		const idStyled = theme.fg("dim", `#${child.id}`);
		const nameStyled = theme.fg("text", child.displayName ?? child.agent);
		const elapsed = formatElapsed(child.createdAt, nowMs);
		const timeStyled = theme.fg("dim", elapsed === "" ? "0s" : elapsed);
		const stateStyled = theme.fg(tone, visual);
		const turnsCount = child.usage?.turns ?? 0;
		const turnsLabel = `${turnsCount} turn${turnsCount === 1 ? "" : "s"}`;
		const turnsStyled = theme.fg("dim", turnsLabel);

		let detailText = "";
		if (child.activeTool !== undefined && child.activeTool.trim() !== "") {
			detailText = child.activeTool.trim();
		} else if (child.summary !== undefined && child.summary.trim() !== "") {
			detailText = child.summary.replace(/\s+/g, " ").trim();
		}

		const detailStyled = detailText === "" ? "" : `${sep}${theme.fg("dim", detailText)}`;
		const rowContent = `${glyphStyled} ${idStyled} ${nameStyled}${sep}${timeStyled}${sep}${stateStyled}${sep}${turnsStyled}${detailStyled}`;

		lines.push(truncateToWidth(rowContent, width, theme.fg("dim", "…")));
	}

	if (visible.length > MAX_ROWS) {
		lines.push(
			truncateToWidth(
				theme.fg("dim", `+${visible.length - MAX_ROWS} more`),
				width,
				theme.fg("dim", "…"),
			),
		);
	}
	lines.push("");
	return lines;
}

export function createSubagentWidget(
	pi: ExtensionAPI,
	context: ExtensionContext,
	signal: AbortSignal,
	initial: readonly PublicSubagent[] = [],
): SubagentWidget | undefined {
	if (context.mode !== "tui") return undefined;
	let children = initial;
	let disposed = false;
	let tick: ReturnType<typeof setInterval> | undefined;
	const hasRows = () => visibleChildren(children).length > 0;
	const widget: WidgetHandle = registerWidget(pi, context, signal, {
		id: WIDGET_ID,
		placement: "aboveEditor",
		visible: hasRows(),
		create: (_tui, theme): Component & { dispose(): void } => ({
			render: (width) => renderSubagentWidget(children, width, theme),
			invalidate: () => undefined,
			dispose: () => undefined,
		}),
	});
	const stopTick = (): void => {
		if (tick === undefined) return;
		clearInterval(tick);
		tick = undefined;
	};
	const syncTick = (): void => {
		if (disposed || !hasRows()) {
			stopTick();
			return;
		}
		// 仅在有进行中任务或待淡出任务时维持 tick，纯 idle 时静默
		const hasActiveOrExpiring = children.some((child) => isWidgetVisibleChild(child));
		if (!hasActiveOrExpiring) {
			stopTick();
			return;
		}
		if (tick !== undefined) return;
		tick = setInterval(() => {
			if (!hasRows()) {
				widget.setVisible(false);
				stopTick();
			} else {
				widget.requestRender();
			}
		}, ELAPSED_TICK_MS);
	};
	syncTick();
	signal.addEventListener("abort", stopTick, { once: true });
	return {
		refresh(next): void {
			if (disposed) return;
			children = next;
			if (!hasRows()) widget.setVisible(false);
			else {
				widget.setVisible(true);
				widget.requestRender();
			}
			syncTick();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			stopTick();
			widget.dispose();
		},
	};
}
