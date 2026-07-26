export type PlanPhase = "none" | "plan" | "plan-refine";
export type RequestedPlanAction = "new" | "compact" | "continue";

/** Suggested guidance only; parsing and persistence do not enforce this limit. */
export const MAX_PLAN_LENGTH = 4_000;
export const PLAN_MESSAGE_TYPE = "pi-basics-plan";
export const PLAN_MODE_CUSTOM_TYPE = "pi-basics-plan-mode";

export type PlanStatus = "plan" | "plan-refine";

export interface ActivePlan {
	readonly sessionId: string;
	readonly runtime: unknown;
	phase: PlanPhase;
	planEntryId?: string | undefined;
	planUrl?: string | undefined;
	requestedAction?: RequestedPlanAction | undefined;
	initialAskPending: boolean;
	disposed: boolean;
}

const PROPOSED_PLAN_PATTERN = /(^|\n)<proposed_plan>\r?\n([\s\S]*?)\r?\n<\/proposed_plan>(?=\n|$)/g;

export function extractProposedPlan(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	const matches = [...text.matchAll(PROPOSED_PLAN_PATTERN)];
	if (matches.length !== 1) return undefined;
	const body = matches[0]?.[2]?.trim();
	if (!body || body.includes("<proposed_plan>") || body.includes("</proposed_plan>"))
		return undefined;
	return body;
}

export function stripProposedPlan(text: unknown): string | undefined {
	if (typeof text !== "string" || !extractProposedPlan(text)) return undefined;
	return text.replace(PROPOSED_PLAN_PATTERN, "\n").trim();
}

export function planStatus(phase: PlanPhase): PlanStatus | undefined {
	if (phase === "plan") return "plan";
	if (phase === "plan-refine") return "plan-refine";
	return undefined;
}

export const PLAN_PROMPT_RULES = [
	"Plan Mode is for investigation, clarification, and writing an implementation plan; do not execute it automatically.",
	"Read code, configuration, documentation, and existing decisions before asking questions.",
	"Do not modify source files, install dependencies, commit, migrate, or take other implementation actions.",
	"Keep the plan concise (suggested maximum 4,000 characters; this is guidance, not a hard limit).",
	"Only when complete, end your assistant message with one <proposed_plan> block containing goal, scope, files/symbols, data flow, boundaries/failures, tests/verification, and assumptions.",
] as const;

export function buildPlanModePrompt(): string {
	return PLAN_PROMPT_RULES.join("\n");
}

export function buildPlanRefinementPrompt(planUrl: string, plan: string): string {
	return `The user requests refine the plan. Revise the plan at ${planUrl}. Return a complete replacement <proposed_plan> block, not a delta.\n\n${plan}`;
}

export function buildPlanImplementationPrompt(planUrl: string, plan: string): string {
	return `Plan Mode has ended; normal tool permissions are restored. Implement the canonical plan at ${planUrl}:\n\n${plan}`;
}
