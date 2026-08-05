import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { MctxHistoryTag } from "./store.js";

export interface MctxReasoningReplayResult {
	readonly messages: readonly AgentMessage[];
	readonly watermark: number;
}

function uniqueMessageIndex(
	messages: readonly AgentMessage[],
	expected: AgentMessage,
): number | undefined {
	let found: number | undefined;
	for (const [index, message] of messages.entries()) {
		if (!isDeepStrictEqual(message, expected)) continue;
		if (found !== undefined) return undefined;
		found = index;
	}
	return found;
}

function assistantTagByEntryId(tags: readonly MctxHistoryTag[]): ReadonlyMap<string, number> {
	const result = new Map<string, number>();
	for (const tag of tags) {
		if (tag.kind !== "message") continue;
		const previous = result.get(tag.entryId) ?? 0;
		if (tag.tagNumber > previous) result.set(tag.entryId, tag.tagNumber);
	}
	return result;
}

function clearThinking(message: AgentMessage): AgentMessage | undefined {
	if (message.role !== "assistant") return undefined;
	let changed = false;
	const content = message.content.map((part) => {
		if (
			part.type !== "thinking" ||
			part.redacted === true ||
			(part.thinking === "" && part.thinkingSignature === undefined)
		)
			return part;
		changed = true;
		const { thinkingSignature: _signature, ...withoutSignature } = part;
		return { ...withoutSignature, thinking: "" };
	});
	return changed ? { ...message, content } : undefined;
}

/**
 * Replays previously cleared thinking on every pass. Execute passes extend the
 * watermark for tagged assistant turns older than the configured live window.
 */
export function replayMctxReasoning(input: {
	readonly messages: readonly AgentMessage[];
	readonly entries: readonly SessionEntry[];
	readonly tags: readonly MctxHistoryTag[];
	readonly watermark: number;
	readonly clearReasoningAge: number;
	readonly execute: boolean;
}): MctxReasoningReplayResult {
	const maxTag = input.tags.reduce((maximum, tag) => Math.max(maximum, tag.tagNumber), 0);
	const executeWatermark = input.execute ? Math.max(0, maxTag - input.clearReasoningAge) : 0;
	const watermark = Math.max(input.watermark, executeWatermark);
	if (watermark === 0) return { messages: input.messages, watermark };
	const tagsByEntryId = assistantTagByEntryId(input.tags);
	const result = [...input.messages];
	for (const entry of input.entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const tagNumber = tagsByEntryId.get(entry.id);
		if (tagNumber === undefined || tagNumber > watermark) continue;
		const expected = sessionEntryToContextMessages(entry)[0];
		if (expected === undefined) continue;
		const index = uniqueMessageIndex(input.messages, expected);
		if (index === undefined) continue;
		const cleared = clearThinking(result[index] ?? expected);
		if (cleared !== undefined) result[index] = cleared;
	}
	return { messages: result, watermark };
}
