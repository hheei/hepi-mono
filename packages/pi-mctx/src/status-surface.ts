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

function formatDuration(milliseconds: number): string {
	if (milliseconds >= 60 * 60 * 1000 && milliseconds % (60 * 60 * 1000) === 0)
		return `${milliseconds / (60 * 60 * 1000)}h`;
	if (milliseconds >= 60 * 1000 && milliseconds % (60 * 1000) === 0)
		return `${milliseconds / (60 * 1000)}m`;
	return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
}

function relativeTime(timestamp: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.round(minutes / 60)}h ago`;
}

type StatusRole = Parameters<Theme["fg"]>[0];
type TokenSegment = {
	readonly label: string;
	readonly tokens: number;
	readonly role: StatusRole;
	readonly detail?: string;
};

function tokenSegments(
	snapshot: Extract<MctxStatusSnapshot, { readonly kind: "active" }>,
): TokenSegment[] {
	const tokens = snapshot.accounting.tokens;
	const segments: TokenSegment[] = [];
	const add = (segment: TokenSegment): void => {
		if (segment.tokens > 0) segments.push(segment);
	};
	add({ label: "System", tokens: tokens.systemPrompt, role: "thinkingText" });
	add({ label: "Docs", tokens: tokens.docs, role: "mdLink" });
	add({
		label: "Compartments",
		tokens: tokens.compartments,
		role: "accent",
		detail: `(${snapshot.compartments.total})`,
	});
	add({ label: "Conversation", tokens: tokens.conversation, role: "userMessageText" });
	add({ label: "Tool Calls", tokens: tokens.toolCalls, role: "toolTitle" });
	add({ label: "Tool Defs", tokens: tokens.toolDefinitions, role: "customMessageLabel" });
	return segments;
}

function renderTokenBar(
	segments: readonly TokenSegment[],
	inputTokens: number,
	theme: MctxStatusTheme,
	width: number,
): string {
	if (segments.length === 0 || width === 0) return "";
	const denominator =
		inputTokens > 0 ? inputTokens : segments.reduce((sum, segment) => sum + segment.tokens, 0);
	const widths = segments.map((segment) =>
		Math.max(1, Math.round((segment.tokens / denominator) * width)),
	);
	let total = widths.reduce((sum, value) => sum + value, 0);
	while (total > width) {
		const index = widths.indexOf(Math.max(...widths));
		if (widths[index] === undefined || widths[index] <= 1) break;
		widths[index] -= 1;
		total -= 1;
	}
	while (total < width) {
		const index = widths.indexOf(Math.max(...widths));
		if (widths[index] === undefined) break;
		widths[index] += 1;
		total += 1;
	}
	return segments
		.map((segment, index) => style(theme, segment.role, "█".repeat(widths[index] ?? 0)))
		.join("");
}

function bodyRows(
	snapshot: MctxStatusSnapshot,
	theme: MctxStatusTheme,
	contentWidth: number,
): string[] {
	const title = `${style(theme, "accent", theme.bold("⚡ Magic Context Status"))}`;
	if (snapshot.kind !== "active") {
		const reason =
			snapshot.kind === "inactive"
				? (snapshot.diagnostic ?? snapshot.reason)
				: snapshot.kind === "failed"
					? snapshot.reason
					: "snapshot is stale";
		return [title, "", style(theme, "error", `Status: ${inlineStatusText(reason)}`)];
	}

	const usage = snapshot.usage;
	const percentage = usage === undefined ? "?" : `${usage.percentage.toFixed(1)}%`;
	const contextLimit = usage === undefined ? "?" : compactNumber(usage.contextWindow);
	const contextTokens = usage === undefined ? "?" : compactNumber(usage.tokens);
	const segments = tokenSegments(snapshot);
	const accounting = snapshot.accounting;
	const cacheRemaining =
		accounting.lastResponseAtMs > 0
			? Math.max(0, accounting.cacheTtlMs - (Date.now() - accounting.lastResponseAtMs))
			: accounting.cacheTtlMs;
	const cacheExpired = accounting.lastResponseAtMs > 0 && cacheRemaining === 0;
	const historian =
		snapshot.historian.kind === "disabled"
			? style(theme, "accent", "idle")
			: snapshot.historian.kind === "unavailable"
				? `${style(theme, "warning", "unavailable")} · ${style(theme, "muted", inlineStatusText(snapshot.historian.diagnostic))}`
				: `${style(theme, snapshot.historian.phase === "idle" ? "accent" : "warning", snapshot.historian.phase)}${snapshot.historian.lastFailureClass === undefined ? "" : ` · ${style(theme, "error", inlineStatusText(snapshot.historian.lastFailureClass))}`}`;
	const threshold =
		snapshot.trigger.percentage === undefined
			? "?"
			: `${Number(snapshot.trigger.percentage.toFixed(1))}%`;
	const legend =
		contentWidth < 60
			? []
			: segments.map((segment) => {
					const percent =
						usage === undefined ? "?" : ((segment.tokens / (usage.tokens || 1)) * 100).toFixed(1);
					return `${style(theme, segment.role, `${segment.label}${segment.detail === undefined ? "" : ` ${segment.detail}`}`)}   ${style(theme, "muted", `${compactNumber(segment.tokens)} (${percent}%)`)}`;
				});
	return [
		title,
		"",
		`Context  ${style(theme, percentage === "?" ? "muted" : percentageValueRole(usage?.percentage), theme.bold(percentage))} · ${contextTokens} / ${contextLimit} tokens`,
		`Work tokens ${compactNumber(accounting.work.newWorkTokens)} new · ${compactNumber(accounting.work.totalInputTokens)} total input`,
		renderTokenBar(segments, usage === undefined ? 0 : usage.tokens, theme, contentWidth),
		...legend,
		"",
		`Counts: ${snapshot.compartments.total} compartments`,
		`Historian: ${historian}`,
		`Cache TTL: ${formatDuration(accounting.cacheTtlMs)} · last response ${accounting.lastResponseAtMs > 0 ? relativeTime(accounting.lastResponseAtMs) : "never"} · ${cacheExpired ? style(theme, "warning", "expired") : `${formatDuration(cacheRemaining)} remaining`}`,
		"",
		style(theme, "muted", "Tags"),
		`Active ${snapshot.tags.active} · Pending ${snapshot.tags.pending} · Dropped ${snapshot.tags.dropped} · Total ${snapshot.tags.total}`,
		"",
		style(theme, "muted", "Context"),
		`Execute threshold ${threshold}`,
		`Protected tags ${snapshot.trigger.protectedTags}`,
	];
}

function percentageValueRole(percentage: number | undefined): Parameters<Theme["fg"]>[0] {
	if (percentage === undefined) return "muted";
	return percentage >= 80 ? "error" : percentage >= 65 ? "warning" : "accent";
}

/** Render one outer frame with ANSI-safe exact cell width. */
export function renderMctxStatusLines(
	snapshot: MctxStatusSnapshot,
	width: number,
	theme: MctxStatusTheme,
): readonly string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const contentWidth = Math.max(0, safeWidth - 4);
	const border = (text: string): string => style(theme, "borderMuted", text);
	const top = border(safeWidth === 1 ? "╭" : `╭${"─".repeat(Math.max(0, safeWidth - 2))}╮`);
	const frameRow = (row: string): string => {
		if (safeWidth === 1) return border("│");
		if (safeWidth === 2) return border("││");
		if (safeWidth === 3) return border("│ │");
		return `${border("│")} ${padAnsi(truncateToWidth(row, contentWidth, "…"), contentWidth)} ${border("│")}`;
	};
	const framed = bodyRows(snapshot, theme, contentWidth).map(frameRow);
	framed.push(frameRow(style(theme, "dim", "⎋ close")));
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
