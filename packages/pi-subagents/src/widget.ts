import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { registerWidget, type WidgetHandle } from "@hheei/pi-ext-core";
import type { PublicSubagent, SubagentState } from "./domain.js";

const WIDGET_ID = "@hheei/pi-subagents:status";
const CHILD_WIDGET_ID = "@hheei/pi-subagents:child-identity";
const MAX_ROWS = 8;
const ELAPSED_TICK_MS = 1_000;

export interface SubagentWidget {
	refresh(children: readonly PublicSubagent[]): void;
	dispose(): void;
}

export function isWidgetVisibleChild(child: PublicSubagent): boolean {
	return child.state === "starting" || child.state === "running" || child.state === "idle";
}

function visibleChildren(children: readonly PublicSubagent[]): PublicSubagent[] {
	return children.filter(isWidgetVisibleChild);
}

function stateGlyph(state: SubagentState, theme: Theme): string {
	if (state === "running") return theme.fg("accent", "◐");
	if (state === "starting") return theme.fg("muted", "○");
	return theme.fg("dim", "○");
}

function stateLabel(child: PublicSubagent, theme: Theme): string {
	const mode = child.mode === "tui" ? ` ${child.state} tui` : ` ${child.state}`;
	const freshness = child.freshness === "last_known" ? " last known" : "";
	const label = `${mode.trim()}${freshness}`;
	if (child.state === "running" && child.freshness === "live") return theme.fg("accent", label);
	if (child.interrupted !== undefined || child.freshness === "last_known") {
		return theme.fg("warning", label);
	}
	return theme.fg("dim", label);
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
	const visible = visibleChildren(children);
	if (visible.length === 0) return [];
	const running = visible.filter((child) => child.state === "running").length;
	const headingColor = running > 0 ? "accent" : "dim";
	const heading = `${theme.fg(headingColor, running > 0 ? "●" : "○")} ${theme.fg("text", `Subagents (${visible.length})`)}`;
	const lines = [truncateToWidth(heading, width, "...")];
	const rows = visible.slice(0, MAX_ROWS);
	for (let index = 0; index < rows.length; index++) {
		const child = rows[index];
		if (child === undefined) continue;
		const last = index === rows.length - 1 && visible.length <= MAX_ROWS;
		const branch = theme.fg("dim", last ? "└─" : "├─");
		const name = theme.fg("text", child.displayName ?? child.agent);
		const elapsed = formatElapsed(child.createdAt, nowMs);
		const age = elapsed === "" ? "" : `  ${theme.fg("dim", `· ${elapsed}`)}`;
		const snippet = child.summary === undefined ? "" : child.summary.replace(/\s+/g, " ").trim();
		const summary = snippet === "" ? "" : `  ${theme.fg("dim", snippet)}`;
		const id = theme.fg("dim", child.id);
		lines.push(
			truncateToWidth(
				`${branch} ${stateGlyph(child.state, theme)} ${name}  ${stateLabel(child, theme)}${age}${summary}  ${id}`,
				width,
				"...",
			),
		);
	}
	if (visible.length > MAX_ROWS) {
		lines.push(
			truncateToWidth(theme.fg("dim", `└─ +${visible.length - MAX_ROWS} more`), width, "..."),
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
		if (tick !== undefined) return;
		tick = setInterval(() => {
			widget.requestRender();
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

export interface ChildIdentityWidgetOptions {
	readonly agent: string;
	readonly toolCount: number;
}

export function renderChildIdentityWidget(
	options: ChildIdentityWidgetOptions,
	width: number,
	theme: Theme,
): string[] {
	const label = options.agent.trim() === "" ? "child" : options.agent.trim();
	const line = `${theme.fg("accent", `[${label}]`)} ${theme.fg("dim", "child")}  ${theme.fg("muted", "report via contact_parent")}  ${theme.fg("dim", `${options.toolCount} tools`)}`;
	return [truncateToWidth(line, width, "..."), ""];
}

export function createChildIdentityWidget(
	pi: ExtensionAPI,
	context: ExtensionContext,
	signal: AbortSignal,
	options: ChildIdentityWidgetOptions,
): SubagentWidget | undefined {
	if (context.mode !== "tui") return undefined;
	const widget = registerWidget(pi, context, signal, {
		id: CHILD_WIDGET_ID,
		placement: "aboveEditor",
		visible: true,
		create: (_tui, theme): Component & { dispose(): void } => ({
			render: (width) => renderChildIdentityWidget(options, width, theme),
			invalidate: () => undefined,
			dispose: () => undefined,
		}),
	});
	return {
		refresh(_next?: readonly PublicSubagent[]): void {
			widget.requestRender();
		},
		dispose(): void {
			widget.dispose();
		},
	};
}
