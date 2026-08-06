import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

/**
 * Resolves Pi context messages back to durable branch entry IDs. Matching stays
 * ordered so cloned or byte-identical repeated messages retain distinct IDs.
 */
export function contextIndexesByEntryId(
	messages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
): ReadonlyMap<string, number> {
	const indexes = new Map<string, number>();
	let entryIndex = 0;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const message = messages[messageIndex];
		if (message === undefined) continue;
		for (let candidateIndex = entryIndex; candidateIndex < entries.length; candidateIndex += 1) {
			const entry = entries[candidateIndex];
			if (entry === undefined || entry.type !== "message") continue;
			const projected = sessionEntryToContextMessages(entry);
			const expected = projected.length === 1 ? projected[0] : undefined;
			if (expected === undefined || !sameContextMessage(message, expected)) continue;
			indexes.set(entry.id, messageIndex);
			entryIndex = candidateIndex + 1;
			break;
		}
	}
	return indexes;
}

/** Reasoning replay clears private thinking before history-tag projection. */
function sameContextMessage(actual: AgentMessage, expected: AgentMessage): boolean {
	if (isDeepStrictEqual(actual, expected)) return true;
	if (actual.role !== "assistant" || expected.role !== "assistant") return false;
	if (!Array.isArray(actual.content) || !Array.isArray(expected.content)) return false;
	const normalizeThinking = (message: AgentMessage): AgentMessage => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
		return {
			...message,
			content: message.content.map((part) =>
				part.type === "thinking"
					? (() => {
							const { thinkingSignature: _thinkingSignature, ...rest } = part;
							return { ...rest, thinking: "" };
						})()
					: part,
			),
		};
	};
	return isDeepStrictEqual(normalizeThinking(actual), normalizeThinking(expected));
}
