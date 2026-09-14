import { resolvePiUsableContextLimit } from "./pi-context-limit";

/**
 * Pi pressure computation from input-context semantics.
 *
 * Pi's built-in `ctx.getContextUsage()` reports a `percent` field
 * computed as `(input + output + cacheRead + cacheWrite) / contextWindow`.
 * That includes output tokens, which makes Pi's percentage drift above
 * the wire-input-only pressure tracked by the transform.
 * material:
 *
 *   - Test assertions expect exact integer percentages (40, 50, …) and
 *     Pi off-by-output produces 40.1, 46.9, … on the same inputs.
 *   - The overflow-recovery path's "use detectedContextLimit for next
 *     pressure pass" contract is unimplementable if Pi keeps reporting
 *     its own percent — that field is locked to Pi's `contextWindow`
 *     from settings/models.json and cannot be re-divided by the
 *     post-overflow limit.
 *
 * The fix is to compute pressure ourselves from the latest assistant
 * message's `usage` field.
 * `event-handler.ts` does:
 *
 *     inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
 *     percentage  = (inputTokens / contextLimit) * 100
 *
 * The contextLimit MUST already be the output-reserved safe window, with any
 * persisted `session_meta.detected_context_limit` applied to the raw window
 * first. Callers resolve that ordering before invoking this helper.
 */

interface PiAssistantUsage {
	input?: number | undefined;
	output?: number | undefined;
	cacheRead?: number | undefined;
	cacheWrite?: number | undefined;
	totalTokens?: number | undefined;
}

export interface PiPressure {
	/** Tokens charged against contextLimit. */
	inputTokens: number;
	/** Percentage of contextLimit. Capped at 0 when contextLimit is unknown. */
	percentage: number;
}

/**
 * Extract `usage` from a Pi `event.message` assistant payload.
 * Pi puts the usage in `message.usage` per its AssistantMessage type.
 * Returns null when the message is not an assistant or carries no
 * usage data (aborted/error messages have no usage).
 */
export function extractAssistantUsage(message: unknown): PiAssistantUsage | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: unknown; usage?: unknown };
	if (m.role !== "assistant") return null;
	if (!m.usage || typeof m.usage !== "object") return null;
	const u = m.usage as Record<string, unknown>;
	const result: PiAssistantUsage = {};
	if (typeof u.input === "number") result.input = u.input;
	if (typeof u.output === "number") result.output = u.output;
	if (typeof u.cacheRead === "number") result.cacheRead = u.cacheRead;
	if (typeof u.cacheWrite === "number") result.cacheWrite = u.cacheWrite;
	if (typeof u.totalTokens === "number") result.totalTokens = u.totalTokens;
	return result;
}

/**
 * Compute pressure from a Pi usage payload and the
 * effective context limit. Returns null when no usage is available.
 *
 * The formula intentionally omits output tokens — they're not part of
 * the prefix sent to the next prompt, so they don't count against
 * cacheable-prefix pressure. This matches
 * `packages/plugin/src/hooks/event-handler.ts:388-397`
 * exactly:
 *
 *     totalInputTokens = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write
 */
export function computePiPressure(
	usage: PiAssistantUsage | null,
	contextLimit: number,
): PiPressure | null {
	if (!usage) return null;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const inputTokens = input + cacheRead + cacheWrite;
	if (inputTokens === 0) return null;
	const percentage = contextLimit > 0 ? (inputTokens / contextLimit) * 100 : 0;
	return { inputTokens, percentage };
}

export type PiDisplayPressureSource = "live" | "persisted" | "prefix" | "unknown";

export interface PiDisplayPressure {
	inputTokens: number | undefined;
	percentage: number | undefined;
	contextLimit: number;
	source: PiDisplayPressureSource;
}

/**
 * Status/footer pressure. Same wire-input tokens and output-reserved
 * denominator as transform, but never uses Pi's output-inclusive `percent`
 * and never applies the scheduler's 0.85 forward-pressure scale.
 *
 * `live.tokens === null` is unknown after compaction: do not fill with
 * prefix or a stale persisted trailing reading.
 */
export function resolvePiDisplayPressure(args: {
	live?:
		| {
				tokens?: number | null | undefined;
				percent?: number | null | undefined;
				contextWindow?: number | null | undefined;
		  }
		| undefined;
	model?:
		| {
				provider?: string | undefined;
				id?: string | undefined;
				contextWindow?: number | undefined;
				maxTokens?: number | undefined;
		  }
		| undefined;
	detectedContextLimit?: number | undefined;
	lastInputTokens?: number | undefined;
	prefixTokens?: number | undefined;
}): PiDisplayPressure {
	const rawWindow =
		typeof args.live?.contextWindow === "number" && args.live.contextWindow > 0
			? args.live.contextWindow
			: args.model?.contextWindow;
	const contextLimit =
		resolvePiUsableContextLimit({
			rawContextWindow: rawWindow,
			...(args.model === undefined ? {} : { model: args.model }),
			...(args.detectedContextLimit === undefined
				? {}
				: { detectedContextLimit: args.detectedContextLimit }),
		}) ?? 0;
	const liveTokens = args.live?.tokens;
	if (liveTokens === null) {
		return { inputTokens: undefined, percentage: undefined, contextLimit, source: "unknown" };
	}

	const persisted =
		typeof args.lastInputTokens === "number" && args.lastInputTokens > 0 ? args.lastInputTokens : 0;
	const live = typeof liveTokens === "number" && liveTokens > 0 ? liveTokens : 0;
	if (live > 0) {
		const inputTokens = Math.max(live, persisted);
		return {
			inputTokens,
			percentage: percentageOf(inputTokens, contextLimit),
			contextLimit,
			source: "live",
		};
	}
	if (persisted > 0) {
		return {
			inputTokens: persisted,
			percentage: percentageOf(persisted, contextLimit),
			contextLimit,
			source: "persisted",
		};
	}
	if (liveTokens === 0) {
		const prefix =
			typeof args.prefixTokens === "number" && args.prefixTokens > 0 ? args.prefixTokens : 0;
		if (prefix > 0) {
			return {
				inputTokens: prefix,
				percentage: percentageOf(prefix, contextLimit),
				contextLimit,
				source: "prefix",
			};
		}
	}
	return { inputTokens: undefined, percentage: undefined, contextLimit, source: "unknown" };
}

function percentageOf(inputTokens: number, contextLimit: number): number | undefined {
	if (contextLimit <= 0 || inputTokens <= 0) return undefined;
	return (inputTokens / contextLimit) * 100;
}
