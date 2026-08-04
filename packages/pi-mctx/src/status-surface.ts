import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { openTuiSurface, TuiSurfaceQueueFullError } from "@hheei/pi-ext-core";
import type { MctxFeature, MctxStatusResult } from "./feature.js";

type MctxStatusSnapshot = MctxStatusResult;

export interface MctxStatusTheme {
	readonly fg: (role: Parameters<Theme["fg"]>[0], text: string) => string;
	readonly bold: (text: string) => string;
}
export type MctxStatusTimerFactory = (callback: () => void, delay: number) => () => void;

interface StatusSurfaceOptions {
	readonly feature: Pick<MctxFeature, "status">;
	readonly context: ExtensionContext;
	readonly host: {
		readonly theme: MctxStatusTheme;
		requestRender(): void;
		close(value: undefined): void;
	};
	readonly startTimer?: MctxStatusTimerFactory;
}

/** MCTX owns this read-only view; host owns slot/input admission and lifecycle abort. */
export interface MctxStatusComponent extends Component {
	handleInput(data: string): void;
	/** Stops refresh and releases view-local resources; safe repeatedly. */
	dispose(): void;
}

function style(theme: MctxStatusTheme, role: Parameters<Theme["fg"]>[0], text: string): string {
	return theme.fg(role, text);
}

function padAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function inlineStatusText(text: string): string {
	let safe = "";
	for (const character of stripVTControlCharacters(text)) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		safe += codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
	}
	return safe.replace(/ +/gu, " ").trim();
}

function compactNumber(value: number): string {
	if (!Number.isFinite(value)) return "—";
	const absolute = Math.abs(value);
	if (absolute < 1000) return String(value);
	const units = ["K", "M", "B"];
	let scaled = absolute;
	let unit = "";
	for (const candidate of units) {
		scaled /= 1000;
		unit = candidate;
		if (scaled < 1000) break;
	}
	const rounded = Number(scaled.toFixed(1));
	return `${value < 0 ? "-" : ""}${rounded}${unit}`;
}

function bodyRows(
	snapshot: MctxStatusSnapshot,
	theme: MctxStatusTheme,
	wide: boolean,
	contentWidth: number,
): string[] {
	const runtime =
		snapshot.kind === "active"
			? style(theme, "success", "Runtime active")
			: snapshot.kind === "inactive"
				? style(theme, "warning", "Runtime inactive")
				: snapshot.kind === "failed"
					? style(theme, "error", "Runtime failed")
					: style(theme, "warning", "Runtime stale");
	const active = snapshot.kind === "active" ? snapshot : undefined;
	const usage = active?.usage;
	const usageRole =
		usage === undefined
			? undefined
			: usage.percentage >= 80
				? "error"
				: usage.percentage >= 65
					? "warning"
					: "success";
	const percentage = usage === undefined ? "—" : `${usage.percentage.toFixed(1)}%`;
	const used = usage === undefined ? "—" : compactNumber(usage.tokens);
	const limit = usage === undefined ? "—" : compactNumber(usage.contextWindow);
	const filled =
		usage === undefined
			? 0
			: Math.round((Math.max(0, Math.min(100, usage.percentage)) / 100) * contentWidth);
	const bar =
		usage === undefined || usageRole === undefined
			? ""
			: style(theme, usageRole, "█".repeat(filled) + "░".repeat(contentWidth - filled));
	const triggerPercentage =
		active?.trigger.percentage === undefined
			? "—"
			: `${Number(active.trigger.percentage.toFixed(1))}%`;
	const triggerTokens =
		active?.trigger.tokens === undefined ? "—" : compactNumber(active.trigger.tokens);
	const historian =
		active === undefined
			? ""
			: active.historian.kind === "disabled"
				? `Historian  ${style(theme, "muted", "disabled")}`
				: active.historian.kind === "unavailable"
					? `Historian  ${style(theme, "warning", "unavailable")} · ${style(theme, "muted", inlineStatusText(active.historian.diagnostic))}`
					: `Historian  ${style(theme, active.historian.phase === "idle" ? "success" : "warning", active.historian.phase)} · ${style(theme, "muted", inlineStatusText(active.historian.model))}${active.historian.lastFailureClass === undefined ? "" : ` · ${style(theme, "error", inlineStatusText(active.historian.lastFailureClass))}`}`;
	const partition =
		active === undefined
			? ""
			: `Partition  revision: ${active.partitionRevision} · sidekick augmentation ${style(theme, active.pendingAugmentation ? "warning" : "muted", active.pendingAugmentation ? "pending" : "idle")}`;
	const reason =
		snapshot.kind === "inactive"
			? inlineStatusText(snapshot.diagnostic ?? snapshot.reason)
			: snapshot.kind === "failed"
				? inlineStatusText(snapshot.reason)
				: snapshot.kind === "stale"
					? "snapshot is stale"
					: undefined;
	return [
		`${style(theme, "accent", theme.bold("⚡ Magic Context Status"))} · ${runtime}`,
		"",
		style(theme, "muted", "Context"),
		reason === undefined
			? `Context  ${usageRole === undefined ? percentage : style(theme, usageRole, theme.bold(percentage))} · ${used} / ${limit} tokens`
			: style(theme, snapshot.kind === "failed" ? "error" : "warning", `Reason  ${reason}`),
		bar,
		"",
		"Counts:",
		active === undefined
			? ""
			: `Compartments  m0: ${active.compartments.m0} · m1: ${active.compartments.m1} · total: ${active.compartments.total}`,
		style(theme, "muted", "Tags"),
		active === undefined
			? ""
			: `Tags  active: ${active.tags.active} · pending: ${active.tags.pending} · dropped: ${active.tags.dropped} · protected: ${active.trigger.protectedTags}`,
		"",
		"Historian:",
		historian,
		active === undefined ? "" : `Trigger  ${triggerPercentage} · ${triggerTokens} tokens`,
		partition,
		wide && active !== undefined ? `Project  ${inlineStatusText(active.projectIdentity)}` : "",
		wide && active !== undefined ? `Session  ${inlineStatusText(active.sessionId)}` : "",
	];
}

/** Render one outer frame with ANSI-safe exact cell width and stable row count. */
export function renderMctxStatusLines(
	snapshot: MctxStatusSnapshot,
	width: number,
	theme: MctxStatusTheme,
): readonly string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const contentWidth = Math.max(0, safeWidth - 4);
	const wide = safeWidth >= 72;
	const border = (text: string): string => style(theme, "borderMuted", text);
	const top = border(safeWidth === 1 ? "╭" : `╭${"─".repeat(Math.max(0, safeWidth - 2))}╮`);
	const frameRow = (row: string): string => {
		if (safeWidth === 1) return border("│");
		if (safeWidth === 2) return border("││");
		if (safeWidth === 3) return border("│ │");
		return `${border("│")} ${padAnsi(truncateToWidth(row, contentWidth, ""), contentWidth)} ${border("│")}`;
	};
	const framed = bodyRows(snapshot, theme, wide, contentWidth).map(frameRow);
	framed.push(frameRow(style(theme, "dim", "Press Escape to close · Enter / Ctrl+C also close")));
	framed.push(border(safeWidth === 1 ? "╰" : `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`));
	return [top, ...framed];
}

/** Feature owns snapshot/refresh; component never reads SQLite and clears timer on cleanup. */
export function createMctxStatusComponent(options: StatusSurfaceOptions): MctxStatusComponent {
	let snapshot = options.feature.status(options.context);
	let theme = options.host.theme;
	let disposed = false;
	const refresh = (): void => {
		if (disposed) return;
		snapshot = options.feature.status(options.context);
		options.host.requestRender();
	};
	const stopTimer = (
		options.startTimer ??
		((callback, delay) => {
			const timer = setInterval(callback, delay);
			return () => clearInterval(timer);
		})
	)(refresh, 1000);
	const close = (): void => {
		if (disposed) return;
		disposed = true;
		stopTimer();
		options.host.close(undefined);
	};
	return {
		render(width: number): string[] {
			return [...renderMctxStatusLines(snapshot, width, theme)];
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "ctrl+c"))
				close();
		},
		invalidate: (): void => {
			theme = options.context.ui.theme;
			options.host.requestRender();
		},
		dispose: (): void => {
			if (!disposed) {
				disposed = true;
				stopTimer();
			}
		},
	};
}

/** Opens status only after ext-core admission; queue-full warning belongs to command owner. */
export async function openMctxStatusSurface(
	pi: Parameters<typeof openTuiSurface>[0],
	command: ExtensionCommandContext,
	feature: MctxFeature,
	context: ExtensionContext,
	signal: AbortSignal,
): Promise<void> {
	try {
		await openTuiSurface<void>(pi, command, {
			hostId: "@hheei/pi-mctx/status",
			signal,
			maxPending: 1,
			overlay: true,
			overlayOptions: { width: 78, anchor: "center" },
			create: (host) => createMctxStatusComponent({ feature, context, host }),
		});
	} catch (error: unknown) {
		if (error instanceof TuiSurfaceQueueFullError)
			context.ui.notify("MCTX status is already queued", "warning");
		else if (!(error instanceof Error && error.name === "AbortError")) throw error;
	}
}
