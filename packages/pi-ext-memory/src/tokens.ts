import {
	estimateEntryTokens,
	estimateTextTokens as estimateStringTokens,
	formatCompactNumber,
} from "@hheei/pi-ext-core";

export { estimateEntryTokens, estimateStringTokens };

/**
 * Estimate the rendered footprint of an observation line as it appears in
 * summaries / pool listings: "[id] YYYY-MM-DD HH:MM [relevance] content".
 */
export function reflectionLineTokenCount(reflection: { id: string; content: string }): number {
	return estimateStringTokens(`[${reflection.id}] ${reflection.content}\n`);
}

export function observationLineTokenCount(observation: {
	id: string;
	timestamp: string;
	relevance: string;
	content: string;
}): number {
	return estimateStringTokens(
		`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
	);
}

/**
 * Formats token count compactly by delegating to ext-core's formatCompactNumber
 * to maintain a single token/number formatting source across the repo.
 */
export function formatTokensK(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	return formatCompactNumber(tokens);
}
