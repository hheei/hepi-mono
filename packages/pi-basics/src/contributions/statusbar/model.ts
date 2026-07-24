import { estimateTokens } from "@earendil-works/pi-coding-agent";

export interface StatusbarContextUsage {
	readonly tokens?: number | null;
	readonly contextWindow?: number | null;
	readonly percent?: number | null;
}

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
	const glyph = METER_GLYPHS[Math.max(0, Math.min(15, Math.ceil((p / 100) * 16) - 1))];
	return glyph ?? METER_GLYPHS[0];
}

export function thinkingGlyph(level: unknown): string {
	if (level === "off" || level === "minimal") return "○";
	if (level === "low") return "◔";
	if (level === "medium") return "◑";
	if (level === "high") return "◕";
	if (level === "xhigh" || level === "max") return "●";
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

export const RECEIVING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface FooterStatusDisplay {
	readonly values: readonly string[];
	readonly receiving: boolean;
	readonly mcpRatio?: string;
}

export function formatFooterStatuses(
	statuses: ReadonlyMap<string, string> | Iterable<[string, string]> | undefined,
	receivingFrame: string,
	previousMcpRatio?: string,
): FooterStatusDisplay {
	if (!statuses) return { values: [], receiving: false };
	let receiving = false;
	let hasMcp = false;
	let mcpRatio = previousMcpRatio;
	const remaining: string[] = [];
	for (const [key, value] of statuses) {
		const normalized = normalizeDisplayFragment(value, "");
		if (!normalized || key === "magic-context") continue;
		if (key === "mcp") {
			hasMcp = true;
			const ratio = normalized.match(/MCP:\s*(\d+)\/(\d+)\s+servers/iu);
			const connecting = normalized.match(/MCP:\s*connecting to\s+(\d+)\s+servers/iu);
			const connected = ratio?.[1];
			const total = ratio?.[2] ?? connecting?.[1];
			if (connected !== undefined && total !== undefined) mcpRatio = `${connected}/${total}`;
			else if (connecting !== null && total !== undefined) mcpRatio = `0/${total}`;
			continue;
		}
		if (normalized === "receiving") {
			receiving = true;
			continue;
		}
		remaining.push(key === "plan" || key === "goal" ? normalized.toUpperCase() : normalized);
	}
	const activeMcpRatio = hasMcp ? mcpRatio : undefined;
	return {
		values: [
			...(receiving ? [receivingFrame] : []),
			...(activeMcpRatio === undefined ? [] : [`⛁ ${activeMcpRatio}`]),
			...remaining,
		],
		receiving,
		...(activeMcpRatio === undefined ? {} : { mcpRatio: activeMcpRatio }),
	};
}

export function estimateContextUsage(
	messages: readonly unknown[],
	contextWindow: number | null | undefined,
	systemPrompt?: string,
): StatusbarContextUsage | undefined {
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
		return undefined;
	let tokens = systemPrompt ? estimateTokens({ role: "user", content: systemPrompt } as never) : 0;
	for (const message of messages) tokens += estimateTokens(message as never);
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

export function stabilizeContextUsage(
	current: StatusbarContextUsage | undefined,
	previous: StatusbarContextUsage | undefined,
	fallback: StatusbarContextUsage | undefined,
): StatusbarContextUsage | undefined {
	const tokens = current?.tokens;
	if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
		if (
			previous &&
			typeof previous.tokens === "number" &&
			previous.tokens >= 1_000 &&
			tokens < previous.tokens * 0.1
		)
			return previous;
		return current;
	}
	return fallback ?? previous ?? current;
}

function usageWithSystemPrompt(
	usage: StatusbarContextUsage | undefined,
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
		usage?: StatusbarContextUsage;
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
