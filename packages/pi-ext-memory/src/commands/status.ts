import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { resolveCompactAfterTokens } from "../config.js";
import type { Runtime } from "../runtime.js";
import {
	diffProjection,
	type Entry,
	foldLedger,
	fullProjection,
	latestGateEnabled,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	visibleProjection,
} from "../session-ledger/index.js";
import { renderTimeline } from "./timeline.js";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

/**
 * Terminal width for the status report.
 *
 * Pi fails a render whose line overflows the terminal, so every line is bounded to the real
 * width; fall back to the conventional 80 columns when the host does not report one.
 */
function terminalWidth(): number {
	const columns = process.stdout.columns;
	return typeof columns === "number" && columns > 0 ? columns : 80;
}

function workerCostLines(runtime: Runtime): string[] {
	const { runs } = runtime.workerCost;
	const total = runs.observer + runs.reflector + runs.dropper;
	const breakdown =
		total === 0
			? "(0 runs)"
			: `(${total} run${total === 1 ? "" : "s"}: ${runs.observer} obs, ${runs.reflector} refl, ${runs.dropper} drop)`;
	return [
		"",
		"── Cost ──",
		`Worker spend:  $${runtime.workerCost.totalUsd.toFixed(4)} ${breakdown}`,
	];
}

export async function runStatusCommand(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	await runtime.ensureConfig(ctx.cwd, runtime.lifecycleSignal);
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const visible = visibleProjection(entries);
	const full = fullProjection(entries);
	const drift = diffProjection(visible, full);

	const visibleObservationTokens = tokenSum(visible.observations);
	const visibleReflectionTokens = tokenSum(visible.reflections);
	const activeObservationPool = observationPoolMetrics(
		folded.activeObservations,
		runtime.config.observationsPoolTargetTokens,
	);
	const observationLine = appendSuffixes(
		`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
		[
			addedSuffix(drift.observationsOnlyInFull.length),
			removedSuffix(drift.droppedOnlyInFull.length),
		],
	);
	const reflectionLine = appendSuffixes(
		`Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
		[addedSuffix(drift.reflectionsOnlyInFull.length)],
	);
	const obsProgress = rawTokensSinceObservationCoverage(entries);
	const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
	const compactionProgress = rawTokensSinceLastCompaction(entries);
	const contextWindow =
		typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);

	const passiveLines =
		runtime.config.passive === true
			? [
					"Passive: automatic memory workers and auto-compaction disabled; manual/Pi compaction, commands, and recall remain active",
				]
			: [];

	const lines = [
		"── Mode ──",
		latestGateEnabled(entries)
			? "Gate: on"
			: "Gate: off — memory is not read, written, or recalled this session (use /om on)",
		...passiveLines,
		"",
		"── Memory ──",
		observationLine,
		reflectionLine,
		"",
		"── Activity ──",
		`Next observation: ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
		`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%)`,
		`Next compaction:  ~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} estimated source tokens (${pct(compactionProgress, compactThreshold)}%)`,
		`Visible observation pool: ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
		`Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%)`,
		`Reflection pool:         ~${visibleReflectionTokens.toLocaleString()} tokens`,
	];

	if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
		lines.push("", "── In flight ──");
		if (runtime.consolidationInFlight) {
			const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
			lines.push(`Consolidation: running${phase}`);
		}
		if (runtime.compactInFlight) lines.push("Auto-compaction: running");
		if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
	}

	lines.push(...workerCostLines(runtime));

	if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError) {
		lines.push("", "── Last error ──");
		if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
		if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
		if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
	}

	const width = terminalWidth();
	// Flattened into individual lines: the bound below applies per line, not to the whole
	// multi-line strip block.
	lines.push("", ...renderTimeline(entries, width).split("\n"));

	// Pi fails a render whose line overflows the terminal and does not wrap `notify`
	// text for us, so every line is bounded here — not only the timeline strip.
	ctx.ui.notify(lines.map((line) => truncateToWidth(line, width, "…")).join("\n"), "info");
}
