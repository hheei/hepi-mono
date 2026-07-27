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

export const RECEIVING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export type StatusbarThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "unknown";

export type AdvisorIndicator = "ok" | "concern" | "blocker";

export type StatusbarSnapshot = Readonly<{
	model: string;
	advisorIndicator?: AdvisorIndicator;
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
export function contextMeter(percent: unknown): string {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return "??";
	const p = Math.max(0, Math.min(100, percent));
	const glyph = METER_GLYPHS[Math.max(0, Math.min(15, Math.ceil((p / 100) * 16) - 1))];
	return glyph ?? METER_GLYPHS[0];
}

export function advisorIndicatorFromStatuses(
	statuses: ReadonlyMap<string, string> | Iterable<[string, string]> | undefined,
): AdvisorIndicator | undefined {
	if (!statuses) return undefined;
	for (const [key, value] of statuses) {
		if (key === "advisor" && (value === "ok" || value === "concern" || value === "blocker"))
			return value;
	}
	return undefined;
}

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
		if (!normalized || key === "magic-context" || key === "advisor") continue;
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
	awaitingAssistantUsage = false,
): StatusbarContextUsage | undefined {
	if (awaitingAssistantUsage && previous?.tokens != null) return previous;
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
