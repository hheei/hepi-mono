import { estimateTokens } from "@earendil-works/pi-coding-agent";

export const METER_GLYPHS = [
	"⡀⠀",
	"⣀⠀",
	"⣀⡀",
	"⣀⣀",
	"⣄⣀",
	"⣤⣀",
	"⣤⣄",
	"⣤⣤",
	"⣦⣤",
	"⣶⣤",
	"⣶⣦",
	"⣶⣶",
	"⣷⣶",
	"⣿⣶",
	"⣿⣷",
	"⣿⣿",
] as const;

export type StatusbarThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "unknown";

export type StatusbarSnapshot = Readonly<{
	model: string;
	thinkingLevel: StatusbarThinkingLevel;
	meter: string;
	contextTokens: string;
	contextLimit: string;
	percent: number | null;
	sessionName?: string;
	statuses: readonly string[];
}>;

export function normalizeDisplayFragment(value: unknown, fallback = "?"): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.replace(/[\r\n]+/g, " ").trim();
	return normalized || fallback;
}
export function formatContextTokens(tokens: unknown): string {
	return formatContextLimit(tokens);
}
export function formatContextLimit(tokens: unknown): string {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "?";
	if (tokens < 999.5) return String(Math.round(tokens));
	if (tokens < 999_950) return `${trimNumber(Math.round(tokens / 100) / 10)}k`;
	return `${trimNumber(Math.round(tokens / 100_000) / 10)}m`;
}

function trimNumber(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function contextMeter(percent: unknown): string {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return "??";
	const p = Math.max(0, Math.min(100, percent));
	return METER_GLYPHS[Math.max(0, Math.min(15, Math.ceil((p / 100) * 16) - 1))]!;
}

export function thinkingGlyph(level: unknown): string {
	if (level === "medium") return "◒";
	if (level === "high" || level === "xhigh") return "●";
	if (level === "off" || level === "minimal" || level === "low") return "○";
	return "?";
}

export function normalizeStatuses(
	statuses: ReadonlyMap<string, string> | Iterable<[string, string]> | undefined,
): readonly string[] {
	if (!statuses) return [];
	const result: string[] = [];
	for (const [, value] of statuses) {
		const normalized = normalizeDisplayFragment(value, "");
		if (normalized) result.push(normalized);
	}
	return result;
}

function usageWithSystemPrompt(
	usage:
		| { tokens?: number | null; contextWindow?: number | null; percent?: number | null }
		| undefined,
	systemPrompt: string | undefined,
) {
	if (usage?.tokens !== 0 || !systemPrompt) return usage;
	const tokens = estimateTokens({ role: "user", content: systemPrompt } as never);
	const contextWindow = usage.contextWindow;
	return {
		...usage,
		tokens,
		percent:
			typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
				? (tokens / contextWindow) * 100
				: usage.percent,
	};
}

export function buildStatusbarSnapshot(
	input: Readonly<{
		model?: { name?: string; id?: string };
		thinkingLevel?: string;
		usage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
		systemPrompt?: string;
		sessionName?: string;
		statuses?: ReadonlyMap<string, string> | Iterable<[string, string]>;
	}>,
): StatusbarSnapshot {
	const usage = usageWithSystemPrompt(input.usage, input.systemPrompt);
	const normalizedModelName = normalizeDisplayFragment(input.model?.name, "");
	const model =
		normalizedModelName !== "" ? normalizedModelName : normalizeDisplayFragment(input.model?.id);
	const sessionName = normalizeDisplayFragment(input.sessionName, "");
	const percent =
		typeof usage?.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null;
	return {
		model,
		thinkingLevel:
			input.thinkingLevel === "off" ||
			input.thinkingLevel === "minimal" ||
			input.thinkingLevel === "low" ||
			input.thinkingLevel === "medium" ||
			input.thinkingLevel === "high" ||
			input.thinkingLevel === "xhigh"
				? input.thinkingLevel
				: "unknown",
		meter: contextMeter(usage?.percent),
		contextTokens: formatContextTokens(usage?.tokens),
		contextLimit: formatContextLimit(usage?.contextWindow),
		percent,
		...(sessionName ? { sessionName } : {}),
		statuses: normalizeStatuses(input.statuses),
	};
}
