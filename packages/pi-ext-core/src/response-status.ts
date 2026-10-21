import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./tool-result.js";

export interface ResponseStatusFeature {
	start(context: ExtensionContext): void;
	dispose(sessionId: string): void;
	getMetrics(): TelemetryMetrics | undefined;
	getStatus(theme: ThemeLike | ColorFn): string | undefined;
	onUpdate(listener: () => void): () => void;
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
 * - When ThemeLike is provided:
 *   [tokens (dim)] [duration (semantic)] [rate (dim)]
 * - When ColorFn is provided:
 *   entire formatted string wrapped in ColorFn
 */
export function formatTelemetryStatus(
	metrics: TelemetryMetrics,
	color: ThemeLike | ColorFn,
): string {
	const tokens = `↑${formatCompactNumber(metrics.input)} ↓${formatCompactNumber(metrics.output)} ⇲${formatCompactNumber(metrics.cacheRead)}`;
	const rateStr = `󰓅${formatRate(metrics.tokensPerSecond)}/s`;
	const durationPlain = `󰔛${formatDuration(metrics.durationMs ?? undefined) ?? "?"}`;
	const fullText = `${tokens} ${durationPlain} ${rateStr}`;

	if (typeof color === "function") {
		return color(fullText);
	}
	const duration = formatDurationColor(metrics.durationMs, color);
	const rate = color.fg("dim", rateStr);
	return `${color.fg("dim", tokens)} ${duration} ${rate}`;
}

export const TELEMETRY_DISMISS_DELAY_MS = 15_000;

/**
 * Manages completed response telemetry.
 * Captures metrics on message_end and notifies listeners; once a run ends,
 * the metrics are cleared after TELEMETRY_DISMISS_DELAY_MS.
 */
export function createResponseStatusFeature(pi: ExtensionAPI): ResponseStatusFeature {
	let activeSessionId: string | undefined;
	let turnStartedAtMs: number | undefined;
	let currentMetrics: TelemetryMetrics | undefined;
	let dismissTimer: NodeJS.Timeout | undefined;
	const listeners = new Set<() => void>();

	const notify = (): void => {
		for (const listener of listeners) {
			listener();
		}
	};

	const clearDismissTimer = (): void => {
		if (dismissTimer !== undefined) {
			clearTimeout(dismissTimer);
			dismissTimer = undefined;
		}
	};

	const scheduleDismiss = (): void => {
		clearDismissTimer();
		if (currentMetrics === undefined) return;
		dismissTimer = setTimeout(() => {
			dismissTimer = undefined;
			currentMetrics = undefined;
			notify();
		}, TELEMETRY_DISMISS_DELAY_MS);
		dismissTimer.unref?.();
	};

	const ownsContext = (ctx: ExtensionContext): boolean =>
		activeSessionId !== undefined && ctx.sessionManager.getSessionId() === activeSessionId;

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
	});

	pi.on("turn_start", (event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = event.timestamp ?? Date.now();
	});

	pi.on("message_end", (event, ctx) => {
		if (!ownsContext(ctx) || event.message.role !== "assistant") return;
		const startedAtMs = turnStartedAtMs;
		turnStartedAtMs = undefined;

		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
			clearDismissTimer();
			currentMetrics = undefined;
			notify();
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
		notify();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
		scheduleDismiss();
	});

	return {
		start(context) {
			const sessionId = context.sessionManager.getSessionId();
			if (activeSessionId === sessionId) return;
			activeSessionId = sessionId;
			turnStartedAtMs = undefined;
			clearDismissTimer();
			currentMetrics = undefined;
		},
		dispose(sessionId) {
			if (activeSessionId !== sessionId) return;
			clearDismissTimer();
			activeSessionId = undefined;
			turnStartedAtMs = undefined;
			currentMetrics = undefined;
			listeners.clear();
		},
		getMetrics() {
			return currentMetrics;
		},
		getStatus(theme) {
			return currentMetrics ? formatTelemetryStatus(currentMetrics, theme) : undefined;
		},
		onUpdate(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
