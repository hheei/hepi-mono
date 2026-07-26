import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "../../runtime/context.js";
import {
	calculateResponseRate,
	formatResponseStatus,
	type ResponseStatusMetrics,
} from "./model.js";

type TurnTiming = {
	readonly startedAtMs: number;
};

type Owner = {
	readonly sessionId: string;
	turn: TurnTiming | undefined;
};

export interface StatusFeature {
	start(runtime: HePiRuntimeContext): void;
	dispose(sessionId: string): void;
}

function responseDuration(startedAtMs: number, endedAtMs: number): number | null {
	const durationMs = endedAtMs - startedAtMs;
	return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
}

export function createStatusFeature(pi: ExtensionAPI): StatusFeature {
	let owner: Owner | undefined;
	const ownsContext = (ctx: ExtensionContext): boolean =>
		owner !== undefined && ctx.sessionManager.getSessionId() === owner.sessionId;

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsContext(ctx) || owner === undefined) return;
		owner.turn = undefined;
	});

	pi.on("turn_start", (event, ctx) => {
		if (!ownsContext(ctx) || owner === undefined) return;
		owner.turn = { startedAtMs: event.timestamp };
	});

	pi.on("message_end", (event, ctx) => {
		if (!ownsContext(ctx) || owner === undefined || event.message.role !== "assistant") return;
		const turn = owner.turn;
		owner.turn = undefined;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		const durationMs = turn === undefined ? null : responseDuration(turn.startedAtMs, Date.now());
		const { usage } = event.message;
		const metrics: ResponseStatusMetrics = {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			durationMs,
			tokensPerSecond: calculateResponseRate(usage.output, usage.reasoning, durationMs),
		};
		ctx.ui.notify(formatResponseStatus(metrics), "info");
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsContext(ctx) || owner === undefined) return;
		owner.turn = undefined;
	});

	return {
		start(runtime) {
			const { ctx } = runtime;
			const sessionId = ctx.sessionManager.getSessionId();
			if (owner?.sessionId === sessionId) return;
			owner = ctx.mode === "tui" ? { sessionId, turn: undefined } : undefined;
		},
		dispose(sessionId) {
			if (owner?.sessionId === sessionId) owner = undefined;
		},
	};
}
