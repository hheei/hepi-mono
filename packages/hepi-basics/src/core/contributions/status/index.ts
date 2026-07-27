import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HepiRuntimeContext } from "../../runtime/context.js";
import { fmtCompactNumber, fmtDuration, fmtRate } from "../../ui/number.js";

export interface StatusFeature {
	start(runtime: HepiRuntimeContext): void;
	dispose(sessionId: string): void;
}

export function createStatusFeature(pi: ExtensionAPI): StatusFeature {
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
		const endedAtMs = Date.now();
		const totalTimeMs = startedAtMs === undefined ? null : endedAtMs - startedAtMs;
		const { usage } = event.message;
		const tokensPerSecond = totalTimeMs === null ? null : usage.output / (totalTimeMs / 1_000);
		ctx.ui.notify(
			[
				`↱ ${fmtCompactNumber(usage.input)}`,
				`↳ ${fmtCompactNumber(usage.output)}`,
				`⚇ ${fmtCompactNumber(usage.cacheRead)}`,
				`⏱ ${fmtDuration(totalTimeMs)}`,
				`⚡ ${fmtRate(tokensPerSecond)}/s`,
			].join("  "),
			"info",
		);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsContext(ctx)) return;
		turnStartedAtMs = undefined;
	});

	return {
		start(runtime) {
			const { ctx } = runtime;
			const sessionId = ctx.sessionManager.getSessionId();
			if (activeSessionId === sessionId) return;
			activeSessionId = ctx.mode === "tui" ? sessionId : undefined;
			turnStartedAtMs = undefined;
		},
		dispose(sessionId) {
			if (activeSessionId !== sessionId) return;
			activeSessionId = undefined;
			turnStartedAtMs = undefined;
		},
	};
}
