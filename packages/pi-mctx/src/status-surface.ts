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

function bodyRows(snapshot: MctxStatusSnapshot, theme: MctxStatusTheme, wide: boolean): string[] {
	const rows: string[] = [];
	if (snapshot.kind === "active") {
		const usage =
			snapshot.usage === undefined
				? "usage unavailable"
				: `${snapshot.usage.tokens}/${snapshot.usage.contextWindow} tokens (${snapshot.usage.percentage.toFixed(1)}%)`;
		rows.push(`${style(theme, "success", "Runtime active")}  ${usage}`);
		rows.push(`Revision  ${snapshot.partitionRevision}`);
		rows.push(
			`Historian  ${snapshot.historian.phase} · ${snapshot.historian.model}${snapshot.historian.lastFailureClass === undefined ? "" : ` · ${snapshot.historian.lastFailureClass}`}`,
		);
		rows.push(
			`Compartments  ${snapshot.compartments.total} total · ${snapshot.compartments.m0} m0 · ${snapshot.compartments.m1} m1 · seq ${snapshot.compartments.latestSequence ?? "—"} · pub ${snapshot.compartments.latestPublishedRevision ?? "—"}`,
		);
		rows.push(
			`Tags  ${snapshot.tags.total} total · ${snapshot.tags.active} active · ${snapshot.tags.pending} pending · ${snapshot.tags.dropped} dropped`,
		);
		rows.push(
			`Trigger  ${snapshot.trigger.percentage ?? "—"}% · ${snapshot.trigger.tokens ?? "—"} tokens · ${snapshot.trigger.protectedTags} protected`,
		);
		rows.push(`Augmentation  ${snapshot.pendingAugmentation ? "pending" : "idle"}`);
		rows.push(wide ? `Project  ${snapshot.projectIdentity}` : "");
		rows.push(wide ? `Session  ${snapshot.sessionId}` : "");
		rows.push("");
		return rows;
	}
	const reason =
		snapshot.kind === "inactive"
			? (snapshot.diagnostic ?? snapshot.reason)
			: snapshot.kind === "failed"
				? snapshot.reason
				: "snapshot is stale";
	rows.push(
		style(theme, snapshot.kind === "failed" ? "error" : "warning", `${snapshot.kind}: ${reason}`),
	);
	while (rows.length < 10) rows.push("");
	return rows;
}

/** Render one outer frame with ANSI-safe exact cell width and stable row count. */
export function renderMctxStatusLines(
	snapshot: MctxStatusSnapshot,
	width: number,
	theme: MctxStatusTheme,
): readonly string[] {
	const safeWidth = Math.max(8, Math.floor(width));
	const innerWidth = Math.max(1, safeWidth - 2);
	const wide = safeWidth >= 72;
	const title = style(theme, "accent", theme.bold(" MCTX STATUS "));
	const titleWidth = visibleWidth(title);
	const top = style(
		theme,
		"border",
		`╭─${title}${"─".repeat(Math.max(0, safeWidth - titleWidth - 3))}╮`,
	);
	const border = (text: string): string => style(theme, "border", text);
	const framed = bodyRows(snapshot, theme, wide).map(
		(row) =>
			`${border("│")}${padAnsi(truncateToWidth(` ${row}`, innerWidth, ""), innerWidth)}${border("│")}`,
	);
	const footerText = style(theme, "dim", " ⎋ Esc · ↵ Enter · Ctrl+C");
	framed.push(
		`${border("│")}${padAnsi(truncateToWidth(footerText, innerWidth, ""), innerWidth)}${border("│")}`,
	);
	framed.push(border(`╰${"─".repeat(innerWidth)}╯`));
	return [top, ...framed].map((line) => padAnsi(truncateToWidth(line, safeWidth, ""), safeWidth));
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
