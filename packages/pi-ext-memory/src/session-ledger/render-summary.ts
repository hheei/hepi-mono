import { estimateStringTokens } from "../tokens.js";
import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the om_recall_evidence tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use om_recall_evidence as broad search or inject raw source unless it is needed.`;

/**
 * The framing text on its own, with no memory lines.
 *
 * A budget smaller than a single memory line would otherwise render nothing at
 * all; the framing keeps the summary bounded and still tells the model how to
 * recall what did not fit.
 */
export function memoryPreamble(): string {
	return CONTEXT_USAGE_INSTRUCTIONS;
}

/**
 * Tokens occupied by the summary scaffolding (preamble and section titles).
 *
 * Worst case on purpose: it assumes both sections are present, so a budget
 * derived from it can never be undercut by the framing text.
 */
export function summaryOverheadTokens(): number {
	return estimateStringTokens(
		`${CONTEXT_USAGE_INSTRUCTIONS}\n\n## Reflections\n\n## Observations\n`,
	);
}

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

/**
 * Observations in the order the preamble promises: chronological, with lines that
 * share a minute kept in ledger order (`Array#sort` is stable).
 *
 * Timestamps are derived from source entries, so this is real conversation order.
 * Lines recorded before that change carry a model-authored time; they are not
 * migrated, and for them this ordering is only as good as that time.
 */
export function sortObservationsByTime(observations: Observation[]): Observation[] {
	return [...observations].sort((a, b) => {
		if (a.timestamp === b.timestamp) return 0;
		return a.timestamp < b.timestamp ? -1 : 1;
	});
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (observations.length > 0) {
		parts.push(
			`## Observations\n${sortObservationsByTime(observations).map(observationToSummaryLine).join("\n")}`,
		);
	}
	return parts.join("\n\n");
}
