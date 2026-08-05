import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ResponseStatusFeature {
	start(context: ExtensionContext): void;
	dispose(sessionId: string): void;
}

function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value)) return "?";
	if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}K`;
	return String(Math.round(value));
}

function formatDuration(value: number | null): string {
	if (value === null || !Number.isFinite(value) || value < 0) return "?";
	if (value < 1_000) return `${Math.round(value)}ms`;
	return `${(value / 1_000).toFixed(1)}s`;
}

function formatRate(value: number | null): string {
	return value === null || !Number.isFinite(value) || value < 0 ? "?" : value.toFixed(1);
}

/**
 * Produces one TUI notification for each completed assistant response. The
 * caller owns lifecycle registration; retained Pi handlers reject other sessions.
 */
export function createResponseStatusFeature(pi: ExtensionAPI): ResponseStatusFeature {
	let activeSessionId: string | undefined;
	let turnStartedAtMs: number | undefined;
	const ownsContext = (ctx: ExtensionContext): boolean =>
		activeSessionId !== undefined && ctx.sessionManager.getSessionId() === activeSessionId;

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
	});

	pi.on("turn_start", (event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = event.timestamp;
	});

	pi.on("message_end", (event, ctx) => {
		if (!ownsContext(ctx) || event.message.role !== "assistant") return;
		const startedAtMs = turnStartedAtMs;
		turnStartedAtMs = undefined;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		const totalTimeMs = startedAtMs === undefined ? null : Date.now() - startedAtMs;
		const { usage } = event.message;
		const tokensPerSecond = totalTimeMs === null ? null : usage.output / (totalTimeMs / 1_000);
		ctx.ui.notify(
			[
				`↱ ${formatCompactNumber(usage.input)}`,
				`↳ ${formatCompactNumber(usage.output)}`,
				`⚇ ${formatCompactNumber(usage.cacheRead)}`,
				`⏱ ${formatDuration(totalTimeMs)}`,
				`⚡ ${formatRate(tokensPerSecond)}/s`,
			].join("  "),
			"info",
		);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
	});

	return {
		start(context) {
			const sessionId = context.sessionManager.getSessionId();
			if (activeSessionId === sessionId) return;
			activeSessionId = context.mode === "tui" ? sessionId : undefined;
			turnStartedAtMs = undefined;
		},
		dispose(sessionId) {
			if (activeSessionId !== sessionId) return;
			activeSessionId = undefined;
			turnStartedAtMs = undefined;
		},
	};
}
