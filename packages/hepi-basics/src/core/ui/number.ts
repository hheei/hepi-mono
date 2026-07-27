export type CompactNumberSuffixCase = "lower" | "upper";

function trimDecimal(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function fmtCompactNumber(
	value: unknown,
	suffixCase: CompactNumberSuffixCase = "upper",
): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
	const suffixes = suffixCase === "upper" ? ["K", "M"] : ["k", "m"];
	if (value < 999.5) return String(Math.round(value));
	if (value < 999_950) return `${trimDecimal(Math.round(value / 100) / 10)}${suffixes[0]}`;
	return `${trimDecimal(Math.round(value / 100_000) / 10)}${suffixes[1]}`;
}

export function fmtDuration(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "?";
	if (value < 1_000) return `${Math.round(value)}ms`;
	return `${(value / 1_000).toFixed(1)}s`;
}

export function fmtRate(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
	return value.toFixed(1);
}
