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
	let messageIndex = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const projected = sessionEntryToContextMessages(entry);
		if (projected.length !== 1) continue;
		const expected = projected[0];
		if (expected === undefined) continue;
		while (messageIndex < messages.length && !isDeepStrictEqual(messages[messageIndex], expected))
			messageIndex++;
		if (messageIndex >= messages.length) continue;
		indexes.set(entry.id, messageIndex++);
	}
	return indexes;
}
