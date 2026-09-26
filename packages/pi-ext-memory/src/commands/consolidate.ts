import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ConsolidationCtx, runForcedConsolidation } from "../hooks/consolidation-trigger.js";
import type { Runtime } from "../runtime.js";
import {
	type Entry,
	foldLedger,
	latestGateEnabled,
	rawTokensSinceObservationCoverage,
} from "../session-ledger/index.js";

/**
 * Register `/om:consolidate`: run one consolidation cycle now instead of waiting for the
 * observation/reflection token thresholds.
 *
 * The run goes through `runForcedConsolidation`, so it shares the in-flight lock with the
 * automatic path and the dropper still only acts when the active pool is actually over
 * target — forcing is about *when* the pipeline runs, not about skipping its safety rails.
 */
export function registerConsolidateCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:consolidate", {
		description: "Run observational-memory consolidation now instead of waiting for the thresholds",
		handler: async (_args, ctx) => {
			const notify = (message: string, level: "info" | "warning") => ctx.ui.notify(message, level);
			const sessionGeneration = runtime.sessionGeneration;

			// Refusals are reported from both sides of the awaits below: the state checked at
			// entry can be obsolete by the time the pipeline actually launches.
			const refuse = (entries: Entry[]): boolean => {
				if (!latestGateEnabled(entries)) {
					notify("Observational memory is off for this session (use /om on to enable).", "info");
					return true;
				}
				if (runtime.consolidationInFlight) {
					notify("Observational memory: a consolidation is already in progress.", "warning");
					return true;
				}
				if (runtime.compactInFlight) {
					notify("Observational memory: a compaction is in progress; retry afterwards.", "warning");
					return true;
				}
				return false;
			};

			if (refuse(ctx.sessionManager.getBranch() as Entry[])) return;
			await runtime.ensureConfig(ctx.cwd, runtime.lifecycleSignal);
			if (!runtime.isSessionCurrent(sessionGeneration)) return;

			const entries = ctx.sessionManager.getBranch() as Entry[];
			if (refuse(entries)) return;

			const folded = foldLedger(entries);
			if (
				rawTokensSinceObservationCoverage(entries) === 0 &&
				folded.activeObservations.length === 0 &&
				folded.reflections.length === 0
			) {
				notify(
					"Observational memory: nothing to consolidate yet (no uncovered conversation and no memories).",
					"info",
				);
				return;
			}

			// No await between the checks above and this launch: `launchConsolidationTask`
			// claims the in-flight lock unconditionally, so the check-then-claim must be atomic.
			await runForcedConsolidation(pi, runtime, ctx as unknown as ConsolidationCtx);
		},
	});
}
