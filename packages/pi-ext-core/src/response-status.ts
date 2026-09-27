import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./tool-result.js";

export interface ResponseStatusFeature {
	start(context: ExtensionContext): void;
	dispose(sessionId: string): void;
}

export interface TelemetryMetrics {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly durationMs: number | null;
	readonly tokensPerSecond: number | null;
}

export interface ThemeLike {
	fg(
		color: "dim" | "muted" | "success" | "warning" | "error" | "accent" | "text",
		text: string,
	): string;
}

export function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value)) return "?";
	if (Math.abs(value) >= 1_000_000)
		return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
	if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}K`;
	return String(Math.round(value));
}

export function formatRate(value: number | null): string {
	return value === null || !Number.isFinite(value) || value < 0 ? "?" : value.toFixed(1);
}

/**
 * Formats duration with semantic color:
 * - < 5s: success (green)
 * - 5s ~ 15s: warning (yellow)
 * - >= 15s: error (red)
 */
export function formatDurationColor(durationMs: number | null, theme: ThemeLike): string {
	if (durationMs === null) return theme.fg("dim", "󰔛?");
	const duration = formatDuration(durationMs) ?? "?";
	const text = `󰔛${duration}`;
	if (durationMs < 5_000) {
		return theme.fg("success", text);
	}
	if (durationMs < 15_000) {
		return theme.fg("warning", text);
	}
	return theme.fg("error", text);
}

/**
 * Formats full telemetry string:
 * ↑5.3K ↓924 ⇲62.5K  󰔛9.7s 󰓅95.1/s
 */
export function formatTelemetryStatus(metrics: TelemetryMetrics, theme: ThemeLike): string {
	const tokens = [
		`↑${formatCompactNumber(metrics.input)}`,
		`↓${formatCompactNumber(metrics.output)}`,
		`⇲${formatCompactNumber(metrics.cacheRead)}`,
	].join(" ");
	const duration = formatDurationColor(metrics.durationMs, theme);
	const rate = theme.fg("dim", `󰓅${formatRate(metrics.tokensPerSecond)}/s`);
	return `${theme.fg("dim", tokens)}  ${duration} ${rate}`;
}

export interface BottomRailBorderOptions {
	readonly width: number;
	readonly hiddenLineCount: number;
	readonly statusText: string | undefined;
	readonly borderColor: (text: string) => string;
	readonly fallback: (width: number, hiddenLineCount: number) => string;
}

/**
 * Renders the bottom rail border matching native CustomEditor.renderTopBorder layout:
 * ── ↑5.3K ↓924 ⇲62.5K  󰔛9.7s 󰓅95.1/s ───────────────────
 * When scrolling below:
 * ── ↑5.3K ↓924 ⇲62.5K  󰔛9.7s 󰓅95.1/s ─── ↓ 3 more ────────
 */
export function renderBottomRailBorder(options: BottomRailBorderOptions): string {
	const { width, hiddenLineCount, statusText, borderColor, fallback } = options;
	if (statusText === undefined || statusText.length === 0 || width <= 0) {
		return fallback(width, hiddenLineCount);
	}
	const statusWidth = visibleWidth(statusText);
	if (statusWidth === 0) {
		return fallback(width, hiddenLineCount);
	}

	const overflowLabel = hiddenLineCount > 0 ? ` ↓ ${hiddenLineCount} more ` : undefined;
	const overflowLabelWidth = overflowLabel === undefined ? 0 : visibleWidth(overflowLabel);
	const leftBlockWidth = 3 + statusWidth + 1;

	if (overflowLabel !== undefined && width >= leftBlockWidth + overflowLabelWidth + 2) {
		const centerStart = Math.floor((width - overflowLabelWidth) / 2);
		const overflowStart = Math.max(centerStart, leftBlockWidth + 1);
		const middleFill = "─".repeat(overflowStart - leftBlockWidth);
		const rightFill = "─".repeat(Math.max(0, width - overflowStart - overflowLabelWidth));
		return (
			borderColor("── ") + statusText + borderColor(` ${middleFill}${overflowLabel}${rightFill}`)
		);
	}

	if (width >= statusWidth + 5) {
		const remaining = Math.max(0, width - statusWidth - 4);
		return borderColor("── ") + statusText + borderColor(` ${"─".repeat(remaining)}`);
	}

	const truncated = truncateToWidth(statusText, Math.max(0, width - 4), "");
	const truncatedWidth = visibleWidth(truncated);
	const prefixWidth = Math.min(3, Math.max(0, width - truncatedWidth));
	const suffixWidth = Math.max(0, width - prefixWidth - truncatedWidth);
	return borderColor("─".repeat(prefixWidth)) + truncated + borderColor("─".repeat(suffixWidth));
}

export function wrapEditorBottomRail(
	editor: EditorComponent,
	getStatus: () => string | undefined,
): EditorComponent {
	const target = editor as unknown as {
		renderBottomBorder?: (width: number, hiddenLineCount: number) => string;
		borderColor?: (text: string) => string;
	};
	if (typeof target.renderBottomBorder !== "function") return editor;

	const originalRenderBottomBorder = target.renderBottomBorder.bind(editor);
	target.renderBottomBorder = (width: number, hiddenLineCount: number): string => {
		const status = getStatus();
		return renderBottomRailBorder({
			width,
			hiddenLineCount,
			statusText: status,
			borderColor: (text) =>
				typeof target.borderColor === "function" ? target.borderColor(text) : text,
			fallback: originalRenderBottomBorder,
		});
	};
	return editor;
}

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;

interface TuiLike {
	requestRender(): void;
}

/**
 * Manages live response telemetry rendered dynamically on the editor bottom rail.
 * Eliminates noisy turn notifications by embedding status into the bottom border.
 */
export function createResponseStatusFeature(pi: ExtensionAPI): ResponseStatusFeature {
	let activeSessionId: string | undefined;
	let activeContext: ExtensionContext | undefined;
	let turnStartedAtMs: number | undefined;
	let currentStatusText: string | undefined;
	let previousEditorFactory: EditorFactory | undefined;
	let installedEditorFactory: EditorFactory | undefined;
	let activeTui: TuiLike | undefined;
	let activeTheme: ThemeLike | undefined;
	let liveTimer: NodeJS.Timeout | undefined;

	const clearLiveTimer = (): void => {
		if (liveTimer !== undefined) {
			clearInterval(liveTimer);
			liveTimer = undefined;
		}
	};

	const ownsContext = (ctx: ExtensionContext): boolean =>
		activeSessionId !== undefined && ctx.sessionManager.getSessionId() === activeSessionId;

	const currentTheme = (): ThemeLike =>
		activeTheme ?? activeContext?.ui.theme ?? { fg: (_c, t) => t };

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
		clearLiveTimer();
	});

	pi.on("turn_start", (event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = event.timestamp ?? Date.now();
		clearLiveTimer();

		// Start dynamic timer to update elapsed duration on the bottom rail
		liveTimer = setInterval(() => {
			if (turnStartedAtMs === undefined) return;
			const elapsedMs = Date.now() - turnStartedAtMs;
			currentStatusText = formatDurationColor(elapsedMs, currentTheme());
			activeTui?.requestRender();
		}, 100);
		liveTimer.unref();

		// Initial frame
		currentStatusText = formatDurationColor(0, currentTheme());
		activeTui?.requestRender();
	});

	pi.on("message_end", (event, ctx) => {
		if (!ownsContext(ctx) || event.message.role !== "assistant") return;
		const startedAtMs = turnStartedAtMs;
		turnStartedAtMs = undefined;
		clearLiveTimer();

		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;

		const totalTimeMs = startedAtMs === undefined ? null : Date.now() - startedAtMs;
		const { usage } = event.message;
		const tokensPerSecond = totalTimeMs === null ? null : usage.output / (totalTimeMs / 1_000);

		const metrics: TelemetryMetrics = {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			durationMs: totalTimeMs,
			tokensPerSecond,
		};

		currentStatusText = formatTelemetryStatus(metrics, currentTheme());
		activeTui?.requestRender();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
		clearLiveTimer();
		activeTui?.requestRender();
	});

	return {
		start(context) {
			const sessionId = context.sessionManager.getSessionId();
			if (activeSessionId === sessionId) return;
			activeSessionId = context.mode === "tui" ? sessionId : undefined;
			activeContext = context.mode === "tui" ? context : undefined;
			turnStartedAtMs = undefined;
			clearLiveTimer();

			if (context.mode !== "tui") return;

			activeTheme = context.ui.theme;
			previousEditorFactory = context.ui.getEditorComponent();
			installedEditorFactory = (tui, theme, keybindings) => {
				activeTui = tui;
				const baseEditor =
					previousEditorFactory?.(tui, theme, keybindings) ??
					new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
				return wrapEditorBottomRail(baseEditor, () => currentStatusText);
			};
			context.ui.setEditorComponent(installedEditorFactory);
		},
		dispose(sessionId) {
			if (activeSessionId !== sessionId) return;
			clearLiveTimer();
			if (
				activeContext !== undefined &&
				installedEditorFactory !== undefined &&
				activeContext.ui.getEditorComponent() === installedEditorFactory
			) {
				activeContext.ui.setEditorComponent(previousEditorFactory);
			}
			activeSessionId = undefined;
			activeContext = undefined;
			turnStartedAtMs = undefined;
			currentStatusText = undefined;
			previousEditorFactory = undefined;
			installedEditorFactory = undefined;
			activeTui = undefined;
			activeTheme = undefined;
		},
	};
}
