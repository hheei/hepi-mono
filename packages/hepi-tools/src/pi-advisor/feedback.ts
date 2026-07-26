import {
	type AdvisorAdvice,
	type AdvisorSeverity,
	normalizeAdvice,
	severityRank,
} from "./model.js";
export interface FeedbackState {
	readonly held: readonly AdvisorAdvice[];
	readonly deliverable: readonly AdvisorAdvice[];
	readonly delivered: readonly AdvisorAdvice[];
}
function adviceKey(advice: AdvisorAdvice): string {
	return advice.note.toLowerCase().replace(/\s+/g, " ").trim();
}
function strongestByNote(advice: readonly AdvisorAdvice[]): readonly AdvisorAdvice[] {
	const byNote = new Map<string, AdvisorAdvice>();
	for (const item of advice) {
		const key = adviceKey(item);
		const prior = byNote.get(key);
		if (!prior || severityRank(item.severity) > severityRank(prior.severity)) byNote.set(key, item);
	}
	return [...byNote.values()];
}
export function emptyFeedback(): FeedbackState {
	return { held: [], deliverable: [], delivered: [] };
}
export function collectFeedback(
	state: FeedbackState,
	incoming: readonly AdvisorAdvice[],
): FeedbackState {
	const delivered = new Map(state.delivered.map((item) => [adviceKey(item), item]));
	const pending = strongestByNote([...state.held, ...state.deliverable, ...incoming]).filter(
		(item) => {
			const prior = delivered.get(adviceKey(item));
			return prior === undefined || severityRank(item.severity) > severityRank(prior.severity);
		},
	);
	return {
		held: pending.filter((item) => item.severity !== "nit"),
		deliverable: pending.filter((item) => item.severity === "nit"),
		delivered: state.delivered,
	};
}
export function reconfirmFeedback(
	state: FeedbackState,
	raised: readonly AdvisorAdvice[],
): FeedbackState {
	const raisedByNote = new Map(strongestByNote(raised).map((item) => [adviceKey(item), item]));
	const confirmed = state.held.flatMap((item) => {
		const next = raisedByNote.get(adviceKey(item));
		if (next === undefined) return [];
		return severityRank(next.severity) > severityRank(item.severity)
			? [{ ...item, severity: next.severity }]
			: [item];
	});
	return {
		held: confirmed,
		deliverable: [...state.deliverable, ...confirmed],
		delivered: state.delivered,
	};
}
export function markFeedbackDelivered(
	state: FeedbackState,
	delivered: readonly AdvisorAdvice[],
): FeedbackState {
	const deliveredKeys = new Set(delivered.map(adviceKey));
	return {
		held: state.held.filter((item) => !deliveredKeys.has(adviceKey(item))),
		deliverable: state.deliverable.filter((item) => !deliveredKeys.has(adviceKey(item))),
		delivered: strongestByNote([...state.delivered, ...delivered]),
	};
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
