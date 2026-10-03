import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	type Entry,
	latestGateEnabled,
	type MemoryDetails,
	memoryPreamble,
	renderSummary,
	resolveMemoryBudget,
	retainedTailTokens,
	sanitizeRetainedAssistantMessages,
	selectVisibleMemory,
} from "../session-ledger/index.js";
import { estimateStringTokens } from "../tokens.js";

/**
 * Share of memory lines that must be trimmed before the user is told. Routine
 * trimming is reported by `details.budget` and `/om status` instead of a toast
 * on every compaction of a long session.
 */
const TRIM_NOTICE_ITEM_RATIO = 0.25;

/** Smallest trim worth a notice, so a tiny memory list cannot produce one per line. */
const TRIM_NOTICE_MIN_ITEMS = 5;

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on(
		"session_before_compact",
		async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
			const sessionGeneration = runtime.sessionGeneration;
			const lifecycleSignal = runtime.lifecycleSignal;
			// Gate off: memory is not driving this session, so leave compaction to Pi's
			// own summarizer rather than answering on its behalf.
			if (!latestGateEnabled(event.branchEntries as Entry[])) return;
			if (runtime.compactHookInFlight) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"om: another compaction is already in progress; cancelling duplicate",
						"warning",
					);
				}
				return { cancel: true };
			}

			runtime.compactHookInFlight = true;
			try {
				await runtime.ensureConfig(ctx.cwd, lifecycleSignal);
				if (!runtime.isSessionCurrent(sessionGeneration) || lifecycleSignal?.aborted) {
					return { cancel: true };
				}
				const { preparation, branchEntries } = event;
				const { firstKeptEntryId, tokensBefore } = preparation;
				const rawEntries = branchEntries as Entry[];
				const { sanitizedEntries } = sanitizeRetainedAssistantMessages(
					rawEntries,
					firstKeptEntryId,
					ctx.sessionManager,
				);
				const entries = sanitizedEntries;
				// Optional call: hosts older than this extension's minimum Pi version may
				// not report a system prompt, and the budget falls back to a constant.
				const systemPrompt = ctx.getSystemPrompt?.();
				const budget = resolveMemoryBudget({
					config: runtime.config,
					contextWindow: ctx.model?.contextWindow,
					tailTokens: retainedTailTokens(entries, firstKeptEntryId),
					reserveTokens: preparation.settings?.reserveTokens,
					systemTokens:
						typeof systemPrompt === "string" && systemPrompt.length > 0
							? estimateStringTokens(systemPrompt)
							: undefined,
					reason: event.reason,
				});
				const projection = buildCompactionProjection(entries, firstKeptEntryId, {
					observationsPoolMaxTokens: runtime.config.observationsPoolMaxTokens,
				});
				// Memory is bounded to what fits beside the retained tail: an unbounded
				// summary can exceed the model window, which makes compaction impossible
				// to converge on.
				const visible = selectVisibleMemory(projection, {
					maxTokens: budget.render,
					observationTargetTokens: runtime.config.observationsPoolTargetTokens,
				});
				const memoryItems = projection.observations.length + projection.reflections.length;
				let summary = renderSummary(visible.reflections, visible.observations);
				if (summary.length === 0 && memoryItems === 0) {
					if (runtime.idleCompactInFlight) {
						// Idle compaction must never fallback to slow/expensive native LLM summarizer
						return { cancel: true };
					}
					// Decline ownership so Pi's native summarizer preserves the pre-cut context.
					return;
				}
				// Memory exists but no line fits the budget. Answer with the framing text
				// alone — bounded, and it points at the recall tool — instead of handing the
				// compaction to a summarizer that respects no budget at all.
				if (summary.length === 0) summary = memoryPreamble();

				const details: MemoryDetails = {
					...projection.details,
					observations: visible.observations,
					reflections: visible.reflections,
					budget: {
						maxTokens: budget.render,
						renderedTokens: estimateStringTokens(summary),
						tailTokens: budget.tailTokens,
						softLimit: budget.softLimit,
						trimmedObservations: visible.trimmedObservations,
						trimmedReflections: visible.trimmedReflections,
					},
				};
				const trimmedItems = visible.trimmedObservations + visible.trimmedReflections;
				const nothingVisible = trimmedItems > 0 && trimmedItems === memoryItems;
				if (
					ctx.hasUI &&
					(nothingVisible ||
						trimmedItems >= Math.max(TRIM_NOTICE_MIN_ITEMS, memoryItems * TRIM_NOTICE_ITEM_RATIO))
				) {
					const tailNote =
						budget.tailTokens * 2 >= budget.softLimit
							? `; retained tail ${budget.tailTokens.toLocaleString()} tokens is close to the ${budget.softLimit.toLocaleString()} token trigger`
							: "";
					const message = nothingVisible
						? `om: memory budget (${budget.render.toLocaleString()} tokens) cannot hold a memory line — the summary carries instructions only and memory stays recallable by id${tailNote}`
						: `om: trimmed memory to its ${budget.render.toLocaleString()} token budget (${visible.observations.length} obs, ${visible.reflections.length} refl visible; ${trimmedItems.toLocaleString()} lines archived${tailNote})`;
					ctx.ui.notify(
						message,
						nothingVisible || event.reason === "overflow" ? "warning" : "info",
					);
				}

				return {
					compaction: {
						summary,
						firstKeptEntryId,
						tokensBefore,
						details,
					},
				};
			} finally {
				if (runtime.isSessionCurrent(sessionGeneration)) runtime.compactHookInFlight = false;
			}
		},
	);
}
