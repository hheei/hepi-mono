import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import { buildCompactionProjection, type Entry, renderSummary } from "../session-ledger/index.js";

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on(
		"session_before_compact",
		async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
			if (runtime.compactHookInFlight) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Observational memory: another compaction is already in progress; cancelling duplicate",
						"warning",
					);
				}
				return { cancel: true };
			}

			runtime.compactHookInFlight = true;
			try {
				runtime.ensureConfig(ctx.cwd);
				const { preparation, branchEntries } = event;
				const { firstKeptEntryId, tokensBefore } = preparation;
				const projection = buildCompactionProjection(branchEntries as Entry[], firstKeptEntryId, {
					observationsPoolMaxTokens: runtime.config.observationsPoolMaxTokens,
				});
				const summary = renderSummary(projection.reflections, projection.observations);
				if (summary.length === 0) {
					// Decline ownership so Pi's native summarizer preserves the pre-cut context.
					return;
				}

				return {
					compaction: {
						summary,
						firstKeptEntryId,
						tokensBefore,
						details: projection.details,
					},
				};
			} finally {
				runtime.compactHookInFlight = false;
			}
		},
	);
}
