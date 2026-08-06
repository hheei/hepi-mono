import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextIndexesByEntryId } from "./context-entry-indexes.js";
import type { MctxHistoryTag } from "./store.js";

const LARGE_IMAGE_DATA_CHARS = 200;
const STRIPPED_IMAGE_MARKER = "[image stripped]";

type ImagePart = { readonly type: "image"; readonly data: string; readonly mimeType: string };

function isLargeImagePart(value: unknown): value is ImagePart {
	return (
		value !== null &&
		typeof value === "object" &&
		"type" in value &&
		value.type === "image" &&
		"data" in value &&
		typeof value.data === "string" &&
		value.data.length > LARGE_IMAGE_DATA_CHARS &&
		"mimeType" in value &&
		typeof value.mimeType === "string" &&
		value.mimeType.startsWith("image/")
	);
}

function stripImages(message: AgentMessage): AgentMessage {
	if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content))
		return message;
	const content = message.content.map((part) =>
		isLargeImagePart(part) ? { type: "text" as const, text: STRIPPED_IMAGE_MARKER } : part,
	);
	return { ...message, content };
}

function tagNumbersByEntryId(
	entries: readonly SessionEntry[],
	tags: readonly MctxHistoryTag[],
): ReadonlyMap<string, number> {
	const tagsByIdentity = new Map<string, number>();
	for (const tag of tags)
		tagsByIdentity.set(`${tag.kind}:${tag.entryId}:${tag.toolCallId ?? ""}`, tag.tagNumber);
	const result = new Map<string, number>();
	const toolOwners = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content)
				if (part.type === "toolCall") toolOwners.set(part.id, entry.id);
			continue;
		}
		if (message.role === "user") {
			const kind =
				typeof message.content !== "string" && !message.content.some((part) => part.type === "text")
					? "reference"
					: "message";
			const tag = tagsByIdentity.get(`${kind}:${entry.id}:`);
			if (tag !== undefined) result.set(entry.id, tag);
			continue;
		}
		if (message.role !== "toolResult") continue;
		const owner = toolOwners.get(message.toolCallId);
		if (owner === undefined) continue;
		const tag = tagsByIdentity.get(`tool:${owner}:${message.toolCallId}`);
		if (tag !== undefined) result.set(entry.id, tag);
	}
	return result;
}

/** Finds aged user/tool-result images whose identity has a durable history tag. */
export function planMctxProcessedImageStrips(input: {
	readonly entries: readonly SessionEntry[];
	readonly tags: readonly MctxHistoryTag[];
	readonly reasoningWatermark: number;
	readonly execute: boolean;
}): readonly string[] {
	if (!input.execute || input.reasoningWatermark === 0) return [];
	const tagsByEntryId = tagNumbersByEntryId(input.entries, input.tags);
	const result: string[] = [];
	let hasAssistantResponse = false;
	for (let index = input.entries.length - 1; index >= 0; index--) {
		const entry = input.entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			hasAssistantResponse = true;
			continue;
		}
		if (
			!hasAssistantResponse ||
			(message.role !== "user" && message.role !== "toolResult") ||
			!Array.isArray(message.content) ||
			!message.content.some(isLargeImagePart)
		)
			continue;
		const tagNumber = tagsByEntryId.get(entry.id);
		if (tagNumber !== undefined && tagNumber <= input.reasoningWatermark) result.push(entry.id);
	}
	return result;
}

/** Replays only previously persisted strips into the cloned model context. */
export function stripMctxProcessedImages(
	messages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
	entryIds: ReadonlySet<string>,
	indexes: ReadonlyMap<string, number> = contextIndexesByEntryId(messages, entries),
): readonly AgentMessage[] {
	if (entryIds.size === 0) return messages;
	const result = [...messages];
	for (const [entryId, index] of indexes) {
		if (!entryIds.has(entryId)) continue;
		const message = result[index];
		if (message !== undefined) result[index] = stripImages(message);
	}
	return result;
}
