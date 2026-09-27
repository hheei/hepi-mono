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

import { getToolTui, isTuiScrolledUp } from "./tool-tui.js";

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

export type ColorFn = (text: string) => string;

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
 * When a ColorFn is provided, styles the entire status following the bottom rail's thinking border color.
 */
export function formatTelemetryStatus(
	metrics: TelemetryMetrics,
	color: ThemeLike | ColorFn,
): string {
	const tokens = [
		`↑${formatCompactNumber(metrics.input)}`,
		`↓${formatCompactNumber(metrics.output)}`,
		`⇲${formatCompactNumber(metrics.cacheRead)}`,
	].join(" ");
	const durationStr = formatDuration(metrics.durationMs ?? undefined) ?? "?";
	const rateStr = `󰓅${formatRate(metrics.tokensPerSecond)}/s`;
	const fullText = `${tokens}  󰔛${durationStr} ${rateStr}`;

	if (typeof color === "function") {
		return color(fullText);
	}
	const duration = formatDurationColor(metrics.durationMs, color);
	const rate = color.fg("dim", rateStr);
	return `${color.fg("dim", tokens)}  ${duration} ${rate}`;
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
	getStatus: (borderColor: (text: string) => string) => string | undefined,
): EditorComponent {
	const target = editor as unknown as {
		renderBottomBorder?: (width: number, hiddenLineCount: number) => string;
		borderColor?: (text: string) => string;
	};
	if (typeof target.renderBottomBorder !== "function") return editor;

	if (typeof target.borderColor !== "function") {
		target.borderColor = (text: string) => text;
	}

	const originalRenderBottomBorder = target.renderBottomBorder.bind(editor);
	target.renderBottomBorder = (width: number, hiddenLineCount: number): string => {
		const borderColor = target.borderColor?.bind(target) ?? ((text: string) => text);
		const status = getStatus(borderColor);
		return renderBottomRailBorder({
			width,
			hiddenLineCount,
			statusText: status,
			borderColor,
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

export const TELEMETRY_DISMISS_DELAY_MS = 15_000;

/** Patches the runtime ScrollView prototype on the actual TUI renderer if available. */
export function patchActualTuiScrollView(tui: unknown): void {
	if (!tui || typeof tui !== "object") return;
	let sv: unknown;
	if (
		"getPrimaryScrollView" in tui &&
		typeof (tui as { getPrimaryScrollView: unknown }).getPrimaryScrollView === "function"
	) {
		sv = (tui as { getPrimaryScrollView: () => unknown }).getPrimaryScrollView();
	}
	if (!sv && "renderer" in tui && (tui as { renderer?: unknown }).renderer) {
		const renderer = (tui as { renderer: unknown }).renderer;
		if (renderer && typeof renderer === "object") {
			if (
				"getPrimaryScrollView" in renderer &&
				typeof (renderer as { getPrimaryScrollView: unknown }).getPrimaryScrollView === "function"
			) {
				sv = (renderer as { getPrimaryScrollView: () => unknown }).getPrimaryScrollView();
			}
			if (!sv && "implicitScrollView" in renderer) {
				sv = (renderer as { implicitScrollView: unknown }).implicitScrollView;
			}
		}
	}
	if (!sv || typeof sv !== "object") return;
	const targetObj = Object.hasOwn(sv, "updateLayout")
		? (sv as {
				updateLayout?: (
					contentHeight: number,
					viewportHeight: number,
					requestRender: () => void,
				) => void;
				_viewportPatched?: boolean;
			})
		: (Object.getPrototypeOf(sv) as {
				updateLayout?: (
					contentHeight: number,
					viewportHeight: number,
					requestRender: () => void,
				) => void;
				_viewportPatched?: boolean;
			});
	if (!targetObj || targetObj._viewportPatched) return;
	targetObj._viewportPatched = true;

	const originalUpdateLayout = targetObj.updateLayout;
	if (typeof originalUpdateLayout !== "function") return;

	targetObj.updateLayout = function (
		contentHeight: number,
		viewportHeight: number,
		requestRender: () => void,
	): void {
		const target = this as unknown as {
			isFollowingEnd?: boolean;
			contentHeight?: number;
			followingEnd?: boolean;
			followSuppressedAtEnd?: boolean;
		};
		const wasFollowingEnd = target.isFollowingEnd;
		const prevContentHeight = target.contentHeight ?? 0;

		originalUpdateLayout.call(this, contentHeight, viewportHeight, requestRender);

		if (!wasFollowingEnd && contentHeight < prevContentHeight) {
			target.followingEnd = false;
			target.followSuppressedAtEnd = true;
		}
	};
}

/**
 * Manages response telemetry rendered on the editor bottom rail.
 * Shows upon response completion and automatically dismisses after 15 seconds.
 */
export function createResponseStatusFeature(pi: ExtensionAPI): ResponseStatusFeature {
	let activeSessionId: string | undefined;
	let activeContext: ExtensionContext | undefined;
	let turnStartedAtMs: number | undefined;
	let currentMetrics: TelemetryMetrics | undefined;
	let previousEditorFactory: EditorFactory | undefined;
	let installedEditorFactory: EditorFactory | undefined;
	let activeTui: TuiLike | undefined;
	let dismissTimer: NodeJS.Timeout | undefined;

	const clearDismissTimer = (): void => {
		if (dismissTimer !== undefined) {
			clearTimeout(dismissTimer);
			dismissTimer = undefined;
		}
	};

	const ownsContext = (ctx: ExtensionContext): boolean =>
		activeSessionId !== undefined && ctx.sessionManager.getSessionId() === activeSessionId;

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
		clearDismissTimer();
	});

	pi.on("turn_start", (event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = event.timestamp ?? Date.now();
		clearDismissTimer();
		currentMetrics = undefined;
		activeTui?.requestRender();
	});

	pi.on("message_end", (event, ctx) => {
		if (!ownsContext(ctx) || event.message.role !== "assistant") return;
		const startedAtMs = turnStartedAtMs;
		turnStartedAtMs = undefined;
		clearDismissTimer();

		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
			currentMetrics = undefined;
			activeTui?.requestRender();
			return;
		}

		const totalTimeMs = startedAtMs === undefined ? null : Date.now() - startedAtMs;
		const { usage } = event.message;
		const tokensPerSecond = totalTimeMs === null ? null : usage.output / (totalTimeMs / 1_000);

		currentMetrics = {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			durationMs: totalTimeMs,
			tokensPerSecond,
		};
		activeTui?.requestRender();

		dismissTimer = setTimeout(() => {
			dismissTimer = undefined;
			currentMetrics = undefined;
			activeTui?.requestRender();
		}, TELEMETRY_DISMISS_DELAY_MS);
		dismissTimer.unref?.();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
		activeTui?.requestRender();
	});

	return {
		start(context) {
			const sessionId = context.sessionManager.getSessionId();
			if (activeSessionId === sessionId) return;
			activeSessionId = context.mode === "tui" ? sessionId : undefined;
			activeContext = context.mode === "tui" ? context : undefined;
			turnStartedAtMs = undefined;
			currentMetrics = undefined;
			clearDismissTimer();

			if (context.mode !== "tui") return;

			previousEditorFactory = context.ui.getEditorComponent();
			installedEditorFactory = (tui, theme, keybindings) => {
				activeTui = tui;
				patchActualTuiScrollView(tui);
				getToolTui(pi).setScrolledUpPredicate(() => isTuiScrolledUp(activeTui));
				const baseEditor =
					previousEditorFactory?.(tui, theme, keybindings) ??
					new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
				return wrapEditorBottomRail(baseEditor, (borderColor) =>
					currentMetrics ? formatTelemetryStatus(currentMetrics, borderColor) : undefined,
				);
			};
			context.ui.setEditorComponent(installedEditorFactory);
		},
		dispose(sessionId) {
			if (activeSessionId !== sessionId) return;
			clearDismissTimer();
			getToolTui(pi).setScrolledUpPredicate(undefined);
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
			currentMetrics = undefined;
			previousEditorFactory = undefined;
			installedEditorFactory = undefined;
			activeTui = undefined;
		},
	};
}
