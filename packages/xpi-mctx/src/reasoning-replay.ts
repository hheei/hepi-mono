import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextIndexesByEntryId } from "./context-entry-indexes.js";
import type { MctxHistoryTag } from "./store.js";

export interface MctxReasoningReplayResult {
	readonly messages: readonly AgentMessage[];
	readonly watermark: number;
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
		if (part.type === "text") {
			const text = part.text
				.replace(/<thinking>[\s\S]*?<\/thinking>\s*/giu, "")
				.replace(/<think>[\s\S]*?<\/think>\s*/giu, "");
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		}
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
	const executeCutoff = input.execute ? Math.max(0, maxTag - input.clearReasoningAge) : 0;
	if (input.watermark === 0 && executeCutoff === 0)
		return { messages: input.messages, watermark: 0 };
	const tagsByEntryId = assistantTagByEntryId(input.tags);
	const contextIndexes = contextIndexesByEntryId(input.messages, input.entries);
	const result = [...input.messages];
	let watermark = input.watermark;
	for (const entry of input.entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const tagNumber = tagsByEntryId.get(entry.id);
		if (tagNumber === undefined || (tagNumber > input.watermark && tagNumber > executeCutoff))
			continue;
		const index = contextIndexes.get(entry.id);
		if (index === undefined) continue;
		const message = result[index];
		if (message === undefined) continue;
		const cleared = clearThinking(message);
		if (cleared === undefined) continue;
		result[index] = cleared;
		if (input.execute && tagNumber <= executeCutoff) watermark = Math.max(watermark, tagNumber);
	}
	return { messages: result, watermark };
}
