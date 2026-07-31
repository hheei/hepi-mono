export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const ADVISOR_MODE_CUSTOM_TYPE = "pi-basics-advisor-mode";
export const ADVISORY_MESSAGE_TYPE = "pi-basics-advisory";
export const ADVISOR_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export type AdvisorSeverity = "nit" | "concern" | "blocker";
export type AdvisorPhase = "disabled" | "starting" | "idle" | "reviewing" | "error";
export interface AdvisorBoundary {
	readonly version: 1;
	readonly enabled: boolean;
}
export interface AdvisorAdvice {
	readonly severity: AdvisorSeverity;
	readonly note: string;
}
export interface AdvisorUsage {
	readonly input: number;
	readonly output: number;
	readonly total: number;
	readonly cost: number;
}
export interface AdvisorStatus {
	readonly enabled: boolean;
	readonly model?: string;
	readonly thinking: ThinkingLevel;
	readonly phase: AdvisorPhase;
	readonly backlog: number;
	readonly usage: AdvisorUsage;
	readonly lastError?: string;
}
export const DEFAULT_ADVISOR_USAGE: AdvisorUsage = { input: 0, output: 0, total: 0, cost: 0 };
export function parseModelRef(value: string): { provider: string; id: string } | undefined {
	const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
	return match?.[1] && match[2] ? { provider: match[1], id: match[2] } : undefined;
}
export function parseThinking(value: unknown): ThinkingLevel | undefined {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
		? value
		: undefined;
}
export function normalizeAdvice(
	severity: AdvisorSeverity,
	note: string,
): AdvisorAdvice | undefined {
	const text = note.trim();
	return text.length > 0 && text.length <= 4000 ? { severity, note: text } : undefined;
}

/** Parses the entire Advisor response; markdown and schema drift are rejected. */
export function parseAdvisorReview(text: string): readonly AdvisorAdvice[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Advisor review must be valid JSON");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1 ||
		!("advice" in value) ||
		!Array.isArray(value.advice)
	)
		throw new Error('Advisor review must match {"advice":[...]}');
	return value.advice.map((item) => {
		if (
			typeof item !== "object" ||
			item === null ||
			Array.isArray(item) ||
			Object.keys(item).length !== 2 ||
			!("severity" in item) ||
			!("note" in item) ||
			typeof item.note !== "string" ||
			(item.severity !== "nit" && item.severity !== "concern" && item.severity !== "blocker")
		)
			throw new Error("Advisor review contains invalid advice");
		const advice = normalizeAdvice(item.severity, item.note);
		if (advice === undefined) throw new Error("Advisor review contains invalid advice");
		return advice;
	});
}
export function severityRank(value: AdvisorSeverity): number {
	return value === "blocker" ? 3 : value === "concern" ? 2 : 1;
}
