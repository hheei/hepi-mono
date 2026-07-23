import {
	type GoalDurableEffect,
	type GoalState,
	normalizeObjective,
	normalizeSummary,
	reconstructStored,
	type StoredGoal,
} from "./model.js";

export const GOAL_CUSTOM_TYPE = "goal";

export type GoalEntryPayload =
	| {
			readonly version: 1;
			readonly kind: "snapshot";
			readonly objective: string;
			readonly status: "active" | "suspended" | "blocked";
			readonly summary?: string;
	  }
	| {
			readonly version: 1;
			readonly kind: "complete";
			readonly objective: string;
			readonly summary: string;
	  };

export interface SessionEntry {
	readonly type?: unknown;
	readonly customType?: unknown;
	readonly data?: unknown;
}

export interface GoalEntryAppender {
	appendEntry<T>(customType: string, data: T): void;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noUnknownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

const SNAPSHOT_STATUSES = ["active", "suspended", "blocked"] as const;
type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

function normalizeSnapshot(
	objective: unknown,
	status: unknown,
	summary: unknown,
): { objective: string; status: SnapshotStatus; summary?: string } | undefined {
	const normalizedObjective = normalizeObjective(objective);
	const normalizedStatus = SNAPSHOT_STATUSES.includes(status as SnapshotStatus)
		? (status as SnapshotStatus)
		: undefined;
	const normalizedSummary = normalizeSummary(summary);
	if (
		!normalizedObjective ||
		!normalizedStatus ||
		(summary !== undefined && normalizedSummary === undefined)
	)
		return undefined;
	return normalizedSummary === undefined
		? { objective: normalizedObjective, status: normalizedStatus }
		: { objective: normalizedObjective, status: normalizedStatus, summary: normalizedSummary };
}

export function encodeGoalEntry(effect: GoalDurableEffect): GoalEntryPayload | undefined {
	if (!record(effect)) return undefined;
	if (effect.kind === "snapshot") {
		const normalized = normalizeSnapshot(effect.objective, effect.status, effect.summary);
		return normalized === undefined ? undefined : { version: 1, kind: "snapshot", ...normalized };
	}
	if (effect.kind !== "complete") return undefined;
	const objective = normalizeObjective(effect.objective);
	const summary = normalizeSummary(effect.summary);
	if (!objective || !summary) return undefined;
	return { version: 1, kind: "complete", objective, summary };
}

export function decodeGoalEntry(value: unknown): GoalEntryPayload | undefined {
	if (!record(value) || value.version !== 1 || typeof value.kind !== "string") return undefined;
	if (value.kind === "snapshot") {
		if (!noUnknownKeys(value, ["version", "kind", "objective", "status", "summary"]))
			return undefined;
		const normalized = normalizeSnapshot(value.objective, value.status, value.summary);
		return normalized === undefined ? undefined : { version: 1, kind: "snapshot", ...normalized };
	}
	if (
		value.kind !== "complete" ||
		!noUnknownKeys(value, ["version", "kind", "objective", "summary"])
	)
		return undefined;
	const objective = normalizeObjective(value.objective);
	const summary = normalizeSummary(value.summary);
	if (!objective || !summary) return undefined;
	return { version: 1, kind: "complete", objective, summary };
}

export type GoalReplayWarning = (malformedCount: number) => void;

export function replayGoal(
	entries: readonly SessionEntry[],
	onMalformed?: GoalReplayWarning,
): GoalState {
	let stored: StoredGoal | undefined;
	let malformedCount = 0;
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_TYPE)
			continue;
		const payload = decodeGoalEntry(entry.data);
		if (!payload) {
			malformedCount++;
			continue;
		}
		if (payload.kind === "complete") stored = undefined;
		else
			stored = {
				objective: payload.objective,
				status: payload.status === "active" ? "suspended" : payload.status,
				...(payload.summary === undefined ? {} : { summary: payload.summary }),
			};
	}
	if (malformedCount > 0) onMalformed?.(malformedCount);
	return reconstructStored(stored);
}

export function appendGoalEntry(appender: GoalEntryAppender, effect: GoalDurableEffect): void {
	const payload = encodeGoalEntry(effect);
	if (!payload) throw new Error("invalid goal durable effect");
	appender.appendEntry(GOAL_CUSTOM_TYPE, payload);
}
