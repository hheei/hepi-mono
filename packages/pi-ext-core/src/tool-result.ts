import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Presentation helpers for tool frames. Both read only tool-owned data: the
 * model-visible text parts of a result, and the duration Pi already measured for
 * a completed tool call.
 */

/** Joins the text parts of a tool result, ignoring images and other part kinds. */
export function agentResultText(result: AgentToolResult<unknown>): string {
	const [only] = result.content;
	if (result.content.length === 1 && only?.type === "text") return only.text;
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/**
 * Formats a measured duration for a frame footer: milliseconds below one second,
 * then one decimal of seconds. Returns undefined when there is no measurement, so
 * callers can omit the field instead of showing a zero.
 */
export function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs)) return undefined;
	const value = Math.max(0, durationMs);
	return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}
