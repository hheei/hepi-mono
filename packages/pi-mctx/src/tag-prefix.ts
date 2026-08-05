import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

const HISTORY_TAG_PREFIX = /^(?:§\d+§\s*)+/u;

/** Removes model-imitated MCTX tag notation before Pi persists assistant text. */
export function stripMctxTagPrefix(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "text") return part;
		const text = part.text
			.replace(HISTORY_TAG_PREFIX, "")
			.replace(/§\d+§/gu, "")
			.replace(/§\d+">(?:§(?:\d+§)?)?/gu, "")
			.replace(/§\d+(?!\.\d)[^\s§\w.]?/gu, "")
			.replace(/§/gu, "")
			.trim();
		if (text === part.text) return part;
		changed = true;
		return { ...part, text } satisfies TextContent;
	});
	return changed ? { ...message, content } : message;
}
