import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";

/** Structural fallback. Not a model tokenizer. */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Estimates tokens for a Pi session branch entry (message, custom_message, branch_summary).
 */
export function estimateEntryTokens(entry: {
	readonly type: string;
	readonly message?: unknown;
	readonly content?: unknown;
	readonly summary?: unknown;
}): number {
	if (entry.type === "message" && entry.message) {
		return estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
	}
	if (entry.type === "custom_message" && entry.content) {
		const content = entry.content;
		if (typeof content === "string") return estimateTextTokens(content);
		if (Array.isArray(content)) {
			let total = 0;
			for (const block of content) {
				if (block.type === "text" && block.text) total += estimateTextTokens(block.text);
			}
			return total;
		}
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return estimateTextTokens(entry.summary);
	}
	return 0;
}
