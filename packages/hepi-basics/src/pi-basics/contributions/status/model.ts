export interface ResponseStatusMetrics {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly durationMs: number | null;
	readonly tokensPerSecond: number | null;
}

function trimNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatStatusTokens(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
	if (value < 999.5) return String(Math.round(value));
	if (value < 999_950) return `${trimNumber(Math.round(value / 100) / 10)}K`;
	return `${trimNumber(Math.round(value / 100_000) / 10)}M`;
}

export function formatStatusDuration(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "?";
	if (value < 1_000) return `${Math.round(value)}ms`;
	return `${(value / 1_000).toFixed(1)}s`;
}

export function formatStatusRate(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
	return value.toFixed(1);
}

export function calculateResponseRate(
	output: unknown,
	reasoning: unknown,
	durationMs: unknown,
): number | null {
	if (
		typeof output !== "number" ||
		!Number.isFinite(output) ||
		output < 0 ||
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs) ||
		durationMs <= 0
	)
		return null;
	const reasoningTokens =
		typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0 ? reasoning : 0;
	return Math.max(0, output - reasoningTokens) / (durationMs / 1_000);
}

export function formatResponseStatus(metrics: ResponseStatusMetrics): string {
	return [
		`↱ ${formatStatusTokens(metrics.input)}`,
		`↳ ${formatStatusTokens(metrics.output)}`,
		`⚇ ${formatStatusTokens(metrics.cacheRead)}`,
		`⏱ ${formatStatusDuration(metrics.durationMs)}`,
		`⚡ ${formatStatusRate(metrics.tokensPerSecond)}/s`,
	].join("  ");
}
