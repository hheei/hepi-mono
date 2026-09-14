import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimatePiPrefixTokens, type PiPrefixTool } from "@hheei/pi-ext-core";
import type { ContextDatabase } from "#core/features/storage";
import { getOverflowState } from "#core/features/storage-meta-persisted";
import { estimateTokens } from "#core/hooks/read-session-formatting";
import { resolvePiDisplayPressure } from "./pi-pressure";

const STATUS_KEY = "magic-context";
const RECENT_FAILURE_MS = 60_000;
const recompSessions = new Set<string>();
let listedTools: () => ReadonlyArray<PiPrefixTool> = () => [];

export interface StatusLineDeps {
	db: ContextDatabase;
	projectIdentity: string;
}

export function setMagicContextRecompActive(sessionId: string, active: boolean): void {
	if (active) recompSessions.add(sessionId);
	else recompSessions.delete(sessionId);
}

type SessionMetaStatus = {
	compartment_in_progress: number | null;
	historian_failure_count: number | null;
	historian_last_failure_at: number | null;
	last_input_tokens: number | null;
	conversation_tokens: number | null;
	tool_call_tokens: number | null;
};

const lastRenderedBySession = new Map<string, string>();

/**
 * Persistent Magic Context footer status for Pi.
 *
 * Hot path: one session_meta row, overflow state, and wire-input pressure.
 * Prefix tokenize (system prompt + tool defs) runs only for a new session
 * (`tokens === 0`) or compaction (`tokens === null`). Percentage uses the
 * output-reserved window, never Pi's output-inclusive `percent`. Compaction
 * uses prefix + kept-tail conversation/tool buckets, not the pre-compact
 * trailing reading.
 */

export function registerStatusLine(pi: ExtensionAPI, deps: StatusLineDeps): void {
	void deps.projectIdentity;
	listedTools = () => {
		try {
			return pi.getAllTools?.() ?? [];
		} catch {
			return [];
		}
	};

	pi.on("session_start", async (_event, ctx) => updateStatusLine(ctx, deps, true));
	pi.on("agent_end", async (_event, ctx) => updateStatusLine(ctx, deps));
	pi.on("session_compact", async (_event, ctx) => updateStatusLine(ctx, deps, true));
	pi.on("tool_execution_end", async (_event, ctx) => updateStatusLine(ctx, deps));
	pi.on("message_end", async (event, ctx) => {
		const role = (event.message as { role?: unknown } | undefined)?.role;
		if (role === "assistant") updateStatusLine(ctx, deps);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = resolveSessionId(ctx);
		if (sessionId) lastRenderedBySession.delete(sessionId);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

export function updateStatusLine(ctx: ExtensionContext, deps: StatusLineDeps, force = false): void {
	const sessionId = resolveSessionId(ctx);
	if (!sessionId) return;
	const text = renderStatusText(ctx, deps.db, sessionId);
	if (!force && lastRenderedBySession.get(sessionId) === text) return;
	lastRenderedBySession.set(sessionId, text);
	ctx.ui.setStatus(STATUS_KEY, text);
}

function renderStatusText(ctx: ExtensionContext, db: ContextDatabase, sessionId: string): string {
	const usage = ctx.getContextUsage?.();
	const liveTokens = usage?.tokens;
	const compactionUnknown = liveTokens === null;
	const liveReady = typeof liveTokens === "number" && liveTokens > 0;
	const meta = readSessionMetaStatus(db, sessionId);
	let prefixTokens: number | undefined;
	if (compactionUnknown || !liveReady) {
		const systemPrompt = readSystemPrompt(ctx);
		prefixTokens = estimatePiPrefixTokens({
			...(systemPrompt === undefined ? {} : { systemPrompt }),
			tools: listedTools(),
			estimateTokens,
		}).tokens;
	}
	let detectedContextLimit: number | undefined;
	try {
		const detected = getOverflowState(db, sessionId).detectedContextLimit;
		if (detected > 0) detectedContextLimit = detected;
	} catch {
		// Footer remains available when overflow metadata cannot be read.
	}
	const conversationTokens =
		typeof meta?.conversation_tokens === "number" && meta.conversation_tokens > 0
			? meta.conversation_tokens
			: 0;
	const toolCallTokens =
		typeof meta?.tool_call_tokens === "number" && meta.tool_call_tokens > 0
			? meta.tool_call_tokens
			: 0;
	const estimatedTokens = compactionUnknown
		? (prefixTokens ?? 0) + conversationTokens + toolCallTokens
		: undefined;
	const pressure = resolvePiDisplayPressure({
		...(usage === undefined ? {} : { live: usage }),
		...(ctx.model === undefined ? {} : { model: ctx.model }),
		...(detectedContextLimit === undefined ? {} : { detectedContextLimit }),
		...(!compactionUnknown &&
		typeof meta?.last_input_tokens === "number" &&
		meta.last_input_tokens > 0
			? { lastInputTokens: meta.last_input_tokens }
			: {}),
		...(!compactionUnknown && prefixTokens !== undefined ? { prefixTokens } : {}),
		...(estimatedTokens !== undefined && estimatedTokens > 0 ? { estimatedTokens } : {}),
	});
	const state = renderHistorianState(meta, recompSessions.has(sessionId));
	const inputTokens = pressure.inputTokens;
	const pct = pressure.percentage;
	return `mc: ${inputTokens === undefined ? "--" : fmt(inputTokens)} (${pct === undefined ? "--" : `${Math.round(pct)}%`}) · ${state}`;
}

function renderHistorianState(meta: SessionMetaStatus | undefined, recompActive: boolean): string {
	const failureCount = meta?.historian_failure_count ?? 0;
	const lastFailureAt = meta?.historian_last_failure_at ?? 0;
	if (failureCount > 0 && lastFailureAt > 0) {
		const ageMs = Date.now() - lastFailureAt;
		if (ageMs >= 0 && ageMs < RECENT_FAILURE_MS) return "⚠ historian failed";
	}
	if (recompActive) return "recomp";
	if ((meta?.compartment_in_progress ?? 0) !== 0) return "historian";
	return "idle";
}

function readSessionMetaStatus(
	db: ContextDatabase,
	sessionId: string,
): SessionMetaStatus | undefined {
	try {
		return db
			.prepare<[string], SessionMetaStatus>(
				"SELECT compartment_in_progress, historian_failure_count, historian_last_failure_at, last_input_tokens, conversation_tokens, tool_call_tokens FROM session_meta WHERE session_id = ?",
			)
			.get(sessionId);
	} catch {
		return undefined;
	}
}

function readSystemPrompt(ctx: ExtensionContext): string | undefined {
	try {
		const prompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined;
		return typeof prompt === "string" && prompt.length > 0 ? prompt : undefined;
	} catch {
		return undefined;
	}
}

function resolveSessionId(ctx: ExtensionContext): string | undefined {
	const getSessionId = (ctx.sessionManager as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(ctx.sessionManager);
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function fmt(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
	if (abs >= 1_000) return `${trim1(n / 1_000)}K`;
	return String(Math.round(n));
}

function trim1(n: number): string {
	const rounded = n.toFixed(1);
	return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}
