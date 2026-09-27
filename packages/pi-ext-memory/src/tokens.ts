import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";

export function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Estimate the rendered footprint of an observation line as it appears in
 * summaries / pool listings: "[id] YYYY-MM-DD HH:MM [relevance] content".
 * Pool budgets that only count bare content undercount every line's
 * metadata overhead (id + timestamp + relevance tags), so the configured
 * pool target was reached later than the rendered memory actually allowed.
 */
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

export function estimateEntryTokens(entry: {
	type: string;
	message?: unknown;
	content?: unknown;
	summary?: unknown;
}): number {
	if (entry.type === "message" && entry.message) {
		return estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
	}
	if (entry.type === "custom_message" && entry.content) {
		const content = entry.content;
		if (typeof content === "string") return estimateStringTokens(content);
		if (Array.isArray(content)) {
			let total = 0;
			for (const block of content) {
				if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
			}
			return total;
		}
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return estimateStringTokens(entry.summary);
	}
	return 0;
}

/**
 * Formats token count compactly using k suffix (e.g. 7.1k, 12k, 100k, <0.1k)
 * Avoids exact numbers or tilde prefixes.
 */
export function formatTokensK(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0k";
	if (tokens < 100) return "<0.1k";
	if (tokens < 1_000) {
		const val = (tokens / 1_000).toFixed(1);
		return `${val}k`;
	}
	const k = tokens / 1_000;
	if (k >= 100) return `${Math.round(k)}k`;
	return `${k.toFixed(1).replace(/\.0$/u, "")}k`;
}
