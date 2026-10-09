import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { resolveCompactAfterTokens } from "../config.js";
import type { HindsightDiagnostics } from "../hindsight/session.js";
import type { Runtime } from "../runtime.js";
import {
	diffProjection,
	type Entry,
	foldLedger,
	fullProjection,
	latestGateEnabled,
	latestMemoryBudget,
	MEMORY_POOL_WATERMARK,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	resolveMemoryBudget,
	visibleProjection,
} from "../session-ledger/index.js";
import { reflectionLineTokenCount } from "../tokens.js";
import { renderTimeline } from "./timeline.js";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function deltaSuffix(count: number, sign: "+" | "-"): string | undefined {
	return count > 0 ? `${sign}${count.toLocaleString()}` : undefined;
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

function hindsightStatusLines(diagnostics?: HindsightDiagnostics): string[] {
	if (!diagnostics) return [];
	const isolationNote =
		diagnostics.isolationMode === "tagged-shared-bank" ? " (shared bank, not isolated)" : "";
	const overrideNote = diagnostics.fileConfigOverride
		? ` [warning: ${diagnostics.fileConfigOverride}]`
		: "";
	const lines = [
		"",
		"── Hindsight long-term memory ──",
		`Bank:           ${diagnostics.bankId} (${diagnostics.bankSource})`,
		`Isolation:      ${diagnostics.isolationMode}${isolationNote}`,
		`Endpoint:       ${diagnostics.apiUrl}`,
		`MCP server:     ${diagnostics.bankMcpUrl}${overrideNote}`,
		`Token:          ${diagnostics.tokenConfigured ? "configured" : "none"}`,
		`Auto-recall:    ${diagnostics.autoRecall ? "on" : "off"}`,
		`Session retain: ${diagnostics.retainSessions ? "on" : "off"}`,
		`Writeback:      ${diagnostics.writeback.retainedTurns} turns retained, ${diagnostics.writeback.pendingBatches} pending, ${diagnostics.writeback.inFlight ? "in flight" : "idle"}`,
	];
	if (diagnostics.scopeTags.length > 0) {
		lines.push(`Scope tags:     ${diagnostics.scopeTags.join(", ")}`);
	}
	if (diagnostics.retainTags.length > 0) {
		lines.push(`Retain tags:    ${diagnostics.retainTags.join(", ")}`);
	}
	if (diagnostics.writeback.lastError) {
		lines.push(`Last error:     ${diagnostics.writeback.lastError}`);
	}
	return lines;
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
	getHindsightDiagnostics?: () => HindsightDiagnostics | undefined,
): Promise<void> {
	await runtime.ensureConfig(ctx.cwd, runtime.lifecycleSignal);
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const visible = visibleProjection(entries);
	const full = fullProjection(entries);
	const drift = diffProjection(visible, full);

	const visibleObservationTokens = tokenSum(visible.observations);
	const visibleReflectionTokens = visible.reflections.reduce(
		(sum, reflection) => sum + reflectionLineTokenCount(reflection),
		0,
	);
	const activeObservationPool = observationPoolMetrics(
		folded.activeObservations,
		runtime.config.observationsPoolTargetTokens,
	);
	const observationLine = appendSuffixes(
		`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
		[
			deltaSuffix(drift.observationsOnlyInFull.length, "+"),
			deltaSuffix(drift.droppedOnlyInFull.length, "-"),
		],
	);
	const reflectionLine = appendSuffixes(
		`Reflections:  ${folded.reflections.length} recorded / ${folded.droppedReflectionIds.size} superseded / ${folded.activeReflections.length} active / ${visible.reflections.length} visible`,
		[
			deltaSuffix(drift.reflectionsOnlyInFull.length, "+"),
			deltaSuffix(drift.droppedReflectionsOnlyInFull.length, "-"),
		],
	);
	const obsProgress = rawTokensSinceObservationCoverage(entries);
	const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
	const compactionProgress = rawTokensSinceLastCompaction(entries);
	const contextWindow =
		typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);
	const memoryBudget = resolveMemoryBudget({ config: runtime.config, contextWindow });
	// Same basis as the pool enforcer's gate: active reflections at their rendered
	// line weight, ids included, so this line and the enforcement threshold agree.
	const activeReflectionTokens = folded.activeReflections.reduce(
		(sum, reflection) => sum + reflectionLineTokenCount(reflection),
		0,
	);
	const activeMemoryTokens = activeObservationPool.observationTokens + activeReflectionTokens;
	const lastRender = latestMemoryBudget(entries);
	const budgetLines = [
		"",
		"── Memory budget ──",
		`Cap:           ~${memoryBudget.cap.toLocaleString()} tokens (${memoryBudget.softLimit.toLocaleString()} token compaction trigger, ${runtime.config.memoryMaxTokens !== undefined ? "configured" : "derived"})`,
		`Active memory: ~${activeMemoryTokens.toLocaleString()} / ${memoryBudget.cap.toLocaleString()} tokens (${pct(activeMemoryTokens, memoryBudget.cap)}%)`,
	];
	if (lastRender) {
		const trimmed = lastRender.trimmedObservations + lastRender.trimmedReflections;
		budgetLines.push(
			[
				`Last render:   ~${lastRender.renderedTokens.toLocaleString()} / ${lastRender.maxTokens.toLocaleString()} tokens`,
				trimmed > 0 ? `trimmed ${trimmed.toLocaleString()} lines` : "nothing trimmed",
				`tail ${lastRender.tailTokens.toLocaleString()} tokens`,
			].join(" · "),
		);
	}
	// Every line is bounded to the terminal width before it is shown, so these stay
	// short enough to survive a narrow terminal with their hint intact.
	if (activeMemoryTokens > Math.floor(memoryBudget.cap * MEMORY_POOL_WATERMARK)) {
		budgetLines.push("Over watermark: next consolidation reclaims non-critical observations");
	} else if (activeMemoryTokens > memoryBudget.cap) {
		budgetLines.push("Over budget: compaction renders a trimmed view; the excess stays recallable");
	}
	if (
		activeReflectionTokens >
		Math.max(0, memoryBudget.cap - runtime.config.observationsPoolTargetTokens)
	) {
		budgetLines.push("Reflections leave under the observation target: run /om consolidate");
	}

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
		...budgetLines,
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
	lines.push(...hindsightStatusLines(getHindsightDiagnostics?.()));

	if (
		runtime.lastObserverError ||
		runtime.lastReflectorError ||
		runtime.lastDropperError ||
		runtime.lastEnforcerError
	) {
		lines.push("", "── Last error ──");
		if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
		if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
		if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
		if (runtime.lastEnforcerError) lines.push(`Enforcer: ${runtime.lastEnforcerError}`);
	}

	const width = terminalWidth();
	// Flattened into individual lines: the bound below applies per line, not to the whole
	// multi-line strip block.
	lines.push("", ...renderTimeline(entries, width).split("\n"));

	// Pi fails a render whose line overflows the terminal and does not wrap `notify`
	// text for us, so every line is bounded here — not only the timeline strip.
	ctx.ui.notify(lines.map((line) => truncateToWidth(line, width, "…")).join("\n"), "info");
}
