export type StoredGoalStatus = "suspended" | "blocked";

export interface StoredGoal {
	readonly objective: string;
	readonly status: StoredGoalStatus;
	readonly summary?: string;
}

export interface ActiveGoal {
	readonly goalId: string;
	readonly objective: string;
	readonly continuationCount: number;
}

export interface InactiveGoalState {
	readonly mode: "inactive";
	readonly stored?: StoredGoal;
	readonly active?: never;
}

export interface ActiveGoalState {
	readonly mode: "active";
	readonly stored: StoredGoal;
	readonly active: ActiveGoal;
}

export type GoalState = InactiveGoalState | ActiveGoalState;

export type GoalIdFactory = () => string;
export const MAX_CONTINUATIONS = 20;
export const MAX_OBJECTIVE_LENGTH = 2_000;
export const MAX_SUMMARY_LENGTH = 4_000;

export interface GoalSnapshot {
	readonly kind: "snapshot";
	readonly objective: string;
	readonly status: "active" | StoredGoalStatus;
	readonly summary?: string;
}

export interface GoalComplete {
	readonly kind: "complete";
	readonly objective: string;
	readonly summary: string;
}

export type GoalDurableEffect = GoalSnapshot | GoalComplete;
export type GoalFailure = { readonly ok: false; readonly state: GoalState; readonly error: string };
export type ActiveGoalResult = {
	readonly ok: true;
	readonly state: ActiveGoalState;
	readonly durable: GoalSnapshot;
};
export type ActiveGoalTransition = ActiveGoalResult | GoalFailure;
export type DurableGoalResult = {
	readonly ok: true;
	readonly state: GoalState;
	readonly durable: GoalDurableEffect;
};
export type DurableGoalTransition = DurableGoalResult | GoalFailure;

const inactive = (stored?: StoredGoal): GoalState =>
	stored ? { mode: "inactive", stored } : { mode: "inactive" };

export function normalizeObjective(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length > 0 && text.length <= MAX_OBJECTIVE_LENGTH ? text : undefined;
}

export function normalizeSummary(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length > 0 && text.length <= MAX_SUMMARY_LENGTH ? text : undefined;
}

function snapshot(
	objective: string,
	status: GoalSnapshot["status"],
	summary?: string,
): GoalSnapshot {
	return summary === undefined
		? { kind: "snapshot", objective, status }
		: { kind: "snapshot", objective, status, summary };
}

function invalid(state: GoalState, message: string): GoalFailure {
	return { ok: false, state, error: message };
}

function activeResult(
	objective: string,
	idFactory: GoalIdFactory,
	stored?: StoredGoal,
): ActiveGoalTransition {
	const id = idFactory();
	if (typeof id !== "string" || id.length === 0)
		return invalid({ mode: "inactive" }, "id factory returned invalid id");
	const active: ActiveGoal = { goalId: id, objective, continuationCount: 0 };
	const activeStored = stored ?? { objective, status: "suspended" as const };
	return {
		ok: true,
		state: { mode: "active", active, stored: activeStored },
		durable: snapshot(objective, "active", activeStored.summary),
	};
}

export function startNew(objective: unknown, idFactory: GoalIdFactory): ActiveGoalTransition {
	const value = normalizeObjective(objective);
	return value === undefined
		? invalid(
				{ mode: "inactive" },
				`objective must be non-empty and at most ${MAX_OBJECTIVE_LENGTH} characters`,
			)
		: activeResult(value, idFactory);
}

export function restoreStored(
	stored: StoredGoal | undefined,
	idFactory: GoalIdFactory,
): ActiveGoalTransition {
	if (!stored || (stored.status !== "suspended" && stored.status !== "blocked"))
		return invalid({ mode: "inactive" }, "no valid stored goal");
	const objective = normalizeObjective(stored.objective);
	const summary = normalizeSummary(stored.summary);
	if (!objective || (stored.summary !== undefined && summary === undefined))
		return invalid(inactive(), "stored goal is malformed");
	return activeResult(objective, idFactory, {
		objective,
		status: stored.status,
		...(summary === undefined ? {} : { summary }),
	});
}

export function recordBlocked(state: GoalState, summary: unknown): DurableGoalTransition {
	if (state.mode !== "active" || !state.active) return invalid(state, "goal is not active");
	const evidence = normalizeSummary(summary);
	if (evidence === undefined)
		return invalid(state, `summary must be non-empty and at most ${MAX_SUMMARY_LENGTH} characters`);
	const stored = {
		objective: state.active.objective,
		status: "blocked" as const,
		summary: evidence,
	};
	return {
		ok: true,
		state: inactive(stored),
		durable: snapshot(stored.objective, stored.status, evidence),
	};
}

export function recordComplete(state: GoalState, summary: unknown): DurableGoalTransition {
	if (state.mode !== "active" || !state.active) return invalid(state, "goal is not active");
	const evidence = normalizeSummary(summary);
	if (evidence === undefined)
		return invalid(state, `summary must be non-empty and at most ${MAX_SUMMARY_LENGTH} characters`);
	return {
		ok: true,
		state: inactive(),
		durable: { kind: "complete", objective: state.active.objective, summary: evidence },
	};
}

export function suspend(state: GoalState): DurableGoalTransition {
	if (state.mode !== "active" || !state.active) return invalid(state, "goal is not active");
	const summary = state.stored?.summary;
	const stored =
		summary === undefined
			? { objective: state.active.objective, status: "suspended" as const }
			: { objective: state.active.objective, status: "suspended" as const, summary };
	return {
		ok: true,
		state: inactive(stored),
		durable: snapshot(state.active.objective, "suspended", summary),
	};
}

export function safetyStop(state: GoalState, summary?: unknown): DurableGoalTransition {
	if (state.mode !== "active" || !state.active) return invalid(state, "goal is not active");
	const evidence = normalizeSummary(summary);
	if (summary !== undefined && evidence === undefined)
		return invalid(state, `summary must be non-empty and at most ${MAX_SUMMARY_LENGTH} characters`);
	const preservedSummary = evidence ?? state.stored?.summary;
	const stored =
		preservedSummary === undefined
			? { objective: state.active.objective, status: "suspended" as const }
			: {
					objective: state.active.objective,
					status: "suspended" as const,
					summary: preservedSummary,
				};
	return {
		ok: true,
		state: inactive(stored),
		durable: snapshot(stored.objective, stored.status, stored.summary),
	};
}

export function incrementContinuation(
	state: GoalState,
):
	| { readonly ok: true; readonly state: GoalState; readonly durable?: GoalDurableEffect }
	| GoalFailure {
	if (state.mode !== "active" || !state.active) return invalid(state, "goal is not active");
	if (state.active.continuationCount >= MAX_CONTINUATIONS)
		return safetyStop(state, "continuation limit reached");
	const active = { ...state.active, continuationCount: state.active.continuationCount + 1 };
	return { ok: true, state: { ...state, active } };
}

export function reconstructStored(stored: StoredGoal | undefined): GoalState {
	if (!stored || (stored.status !== "suspended" && stored.status !== "blocked")) return inactive();
	const objective = normalizeObjective(stored.objective);
	const summary = normalizeSummary(stored.summary);
	if (!objective || (stored.summary !== undefined && summary === undefined)) return inactive();
	return summary === undefined
		? inactive({ objective, status: stored.status })
		: inactive({ objective, status: stored.status, summary });
}
