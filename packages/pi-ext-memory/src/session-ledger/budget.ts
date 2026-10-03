import { type Config, resolveCompactAfterTokens } from "../config.js";
import { estimateEntryTokens } from "../tokens.js";
import type { Entry } from "./types.js";

/**
 * Memory budget: how many tokens of memory may stay visible.
 *
 * Rendered memory is what the model actually sees after a compaction, so it is
 * bounded by the same room Pi needs for the retained tail, the system prompt
 * and the next turn. Without a bound the deterministic summary grows past the
 * model's context window and compaction can no longer converge.
 */

/** Allowance for what Pi keeps outside the summarized history when the real system prompt is unavailable. */
export const MEMORY_SYSTEM_RESERVE_TOKENS = 6_000;

/** Share of the remaining room one rendered summary may occupy (the rest is headroom for the next turn). */
export const MEMORY_RENDER_HEADROOM = 0.5;

/** Floor for a derived cap: below this, memory is no longer worth maintaining. */
export const MEMORY_MIN_TOKENS = 4_000;

/** Hard cap as a share of the effective compaction trigger. */
export const MEMORY_CAP_TRIGGER_RATIO = 0.5;

/** Hard cap as a share of the model's context window. */
export const MEMORY_CAP_WINDOW_RATIO = 0.1;

/** Extra tightening applied when Pi compacts because the context already overflowed. */
export const MEMORY_OVERFLOW_RENDER_RATIO = 0.5;

/**
 * How far active memory may drift above the cap before the deterministic
 * enforcer reclaims it. The rendered summary is bounded either way; this bound
 * is about the ledger and the worker prompts, and it leaves room for the
 * dropper's judgement to act first.
 */
export const MEMORY_POOL_WATERMARK = 1.5;

export type MemoryBudgetInput = {
	config: Config;
	contextWindow: number | undefined;
	/** Tokens Pi keeps raw after the cut. Only a compaction can report this. */
	tailTokens?: number | undefined;
	/** Pi's own reserve below the window (`preparation.settings.reserveTokens`). */
	reserveTokens?: number | undefined;
	/** Real system prompt tokens when the host can report them. */
	systemTokens?: number | undefined;
	/** What triggered this compaction. */
	reason?: "manual" | "threshold" | "overflow" | undefined;
};

export type MemoryBudget = {
	/**
	 * Hard upper bound for memory. Independent of any single compaction, so it
	 * doubles as the pool-maintenance target and the worker-visibility bound.
	 */
	cap: number;
	/** Tokens one rendered compaction summary may occupy. */
	render: number;
	/** Effective compaction trigger this budget was derived from. */
	softLimit: number;
	tailTokens: number;
	systemTokens: number;
};

function positiveOrUndefined(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Default hard cap for a model: never more than half the effective compaction
 * trigger and never more than a tenth of the context window, whichever is
 * smaller. `memoryMaxTokens` overrides it.
 *
 * The floor applies to the cap only. A render budget may never exceed the room
 * left beside the retained tail, so it is floored by what is actually available.
 */
export function defaultMemoryCap(softLimit: number, contextWindow: number | undefined): number {
	const byTrigger = Math.floor(softLimit * MEMORY_CAP_TRIGGER_RATIO);
	const window = positiveOrUndefined(contextWindow);
	const byWindow = window === undefined ? byTrigger : Math.floor(window * MEMORY_CAP_WINDOW_RATIO);
	return Math.max(MEMORY_MIN_TOKENS, Math.min(byTrigger, byWindow));
}

export function resolveMemoryBudget(input: MemoryBudgetInput): MemoryBudget {
	const { config } = input;
	const contextWindow = positiveOrUndefined(input.contextWindow);
	const trigger = resolveCompactAfterTokens(config, contextWindow);
	// Pi compacts when the context exceeds the window minus its own reserve, so that
	// bound wins over a configured trigger when it is smaller. A missing reserve counts
	// as none, but the window bounds the budget either way: a window that the reserve
	// (or the retained tail and the system prompt) already fills leaves room for no
	// memory at all.
	const reserve = positiveOrUndefined(input.reserveTokens) ?? 0;
	const softLimit =
		contextWindow === undefined ? trigger : Math.min(trigger, Math.max(0, contextWindow - reserve));

	const tailTokens = Math.max(0, input.tailTokens ?? 0);
	const systemTokens = positiveOrUndefined(input.systemTokens) ?? MEMORY_SYSTEM_RESERVE_TOKENS;
	const available = Math.max(0, softLimit - tailTokens - systemTokens);
	const cap =
		positiveOrUndefined(config.memoryMaxTokens) ?? defaultMemoryCap(softLimit, contextWindow);
	// Never more than what is left after the tail and the system prompt: the floor
	// exists so a small budget stays usable, not so it can overflow the window.
	const bounded = Math.min(
		cap,
		Math.max(
			Math.min(MEMORY_MIN_TOKENS, available),
			Math.floor(available * MEMORY_RENDER_HEADROOM),
		),
	);
	const render =
		input.reason === "overflow" ? Math.floor(bounded * MEMORY_OVERFLOW_RENDER_RATIO) : bounded;

	return { cap, render, softLimit, tailTokens, systemTokens };
}

/**
 * Estimated tokens of the raw entries Pi keeps after the compaction cut,
 * starting at `firstKeptEntryId` (Pi keeps that entry).
 *
 * Counted with Pi's own per-message estimator, the same basis as
 * `estimateProjectedContextTokens`; entries Pi never turns into messages (the
 * memory ledger itself) contribute nothing, which is intended: they are not
 * part of the context.
 */
export function retainedTailTokens(entries: Entry[], firstKeptEntryId: string): number {
	const start = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (start < 0) return 0;
	let total = 0;
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		if (entry) total += estimateEntryTokens(entry);
	}
	return total;
}
