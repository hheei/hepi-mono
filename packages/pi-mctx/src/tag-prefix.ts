import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

const HISTORY_TAG_PREFIX = /^§\d+§\s*/u;

/** Removes a model-imitated MCTX tag before Pi persists an assistant response. */
export function stripMctxTagPrefix(message: AssistantMessage): AssistantMessage {
	let stripped = false;
	const content = message.content.map((part) => {
		if (stripped || part.type !== "text") return part;
		const text = part.text.replace(HISTORY_TAG_PREFIX, "");
		if (text === part.text) return part;
		stripped = true;
		return { ...part, text } satisfies TextContent;
	});
	return stripped ? { ...message, content } : message;
}
