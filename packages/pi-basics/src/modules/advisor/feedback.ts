import {
	type AdvisorAdvice,
	type AdvisorSeverity,
	normalizeAdvice,
	severityRank,
} from "./model.js";
export interface FeedbackState {
	readonly held: readonly AdvisorAdvice[];
	readonly deliverable: readonly AdvisorAdvice[];
}
export function emptyFeedback(): FeedbackState {
	return { held: [], deliverable: [] };
}
export function collectFeedback(
	state: FeedbackState,
	incoming: readonly AdvisorAdvice[],
): FeedbackState {
	const byNote = new Map<string, AdvisorAdvice>();
	for (const advice of [...state.held, ...state.deliverable, ...incoming]) {
		const key = advice.note.toLowerCase().replace(/\s+/g, " ").trim();
		const prior = byNote.get(key);
		if (!prior || severityRank(advice.severity) > severityRank(prior.severity))
			byNote.set(key, advice);
	}
	const all = [...byNote.values()];
	return {
		held: all.filter((item) => item.severity !== "nit"),
		deliverable: all.filter((item) => item.severity === "nit"),
	};
}
export function reconfirmFeedback(
	state: FeedbackState,
	raised: readonly AdvisorAdvice[],
): FeedbackState {
	const raisedKeys = new Set(
		raised.map((item) => item.note.toLowerCase().replace(/\s+/g, " ").trim()),
	);
	const confirmed = state.held.filter((item) =>
		raisedKeys.has(item.note.toLowerCase().replace(/\s+/g, " ").trim()),
	);
	return { held: confirmed, deliverable: [...state.deliverable, ...confirmed] };
}
export function parseAdvice(value: unknown): AdvisorAdvice | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const item = value as { severity?: unknown; note?: unknown };
	return (item.severity === "nit" || item.severity === "concern" || item.severity === "blocker") &&
		typeof item.note === "string"
		? normalizeAdvice(item.severity, item.note)
		: undefined;
}
export type { AdvisorSeverity };
