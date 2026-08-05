import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cavemanCompress } from "./caveman-compression.js";
import { contextIndexesByEntryId } from "./context-entry-indexes.js";
import type { MctxHistoryTag, MctxHistoryTagInput } from "./store.js";

export const MAX_CTX_EXPAND_CHARS = 30_000;

export interface MctxHistoryTagProjection {
	readonly messages: readonly AgentMessage[];
	readonly droppedTagNumbers: readonly number[];
}

export interface MctxVisibleToolTag {
	readonly tag: MctxHistoryTag;
	readonly toolName: string;
	readonly input: unknown;
}

export function renderMctxHistoryTagPage(
	tags: readonly MctxHistoryTag[],
	offset: unknown,
	limit: unknown,
): { readonly text: string; readonly nextOffset?: number } | undefined {
	const requestedOffset = offset === undefined ? 0 : offset;
	const requestedLimit = limit === undefined ? MAX_CTX_EXPAND_CHARS : limit;
	if (
		typeof requestedOffset !== "number" ||
		!Number.isSafeInteger(requestedOffset) ||
		requestedOffset < 0 ||
		typeof requestedLimit !== "number" ||
		!Number.isSafeInteger(requestedLimit) ||
		requestedLimit < 1 ||
		requestedLimit > MAX_CTX_EXPAND_CHARS
	)
		return undefined;
	const rendered = tags
		.map((tag) => `§${tag.tagNumber}§ (${tag.kind}, ${tag.status})\n${tag.source}`)
		.join("\n\n");
	const end = Math.min(requestedOffset + requestedLimit, rendered.length);
	return {
		text: rendered.slice(requestedOffset, end),
		...(end < rendered.length ? { nextOffset: end } : {}),
	};
}

function textSource(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return JSON.stringify(
		content.map((part) =>
			part.type === "text"
				? part
				: { type: "image", mimeType: part.mimeType, byteLength: part.data.length },
		),
	);
}

function messageInput(
	entry: Extract<SessionEntry, { readonly type: "message" }>,
): MctxHistoryTagInput | undefined {
	const message = entry.message;
	if (message.role === "user") {
		return {
			kind:
				typeof message.content === "string" || message.content.some((part) => part.type === "text")
					? "message"
					: "reference",
			entryId: entry.id,
			source: textSource(message.content),
		};
	}
	if (message.role === "assistant") {
		if (typeof message.content === "string") {
			return message.content
				? { kind: "message", entryId: entry.id, source: message.content }
				: undefined;
		}
		const text = message.content.filter((part) => part.type === "text");
		return text.length === 0
			? undefined
			: { kind: "message", entryId: entry.id, source: JSON.stringify(text) };
	}
	return undefined;
}

/**
 * Tool results bind to the assistant entry that owns their call ID. A bare result
 * cannot be reduced: using its position would let a branch reuse the wrong tag.
 */
export function collectMctxHistoryTagInputs(
	entries: readonly SessionEntry[],
): readonly MctxHistoryTagInput[] {
	const toolOwners = new Map<string, string>();
	const inputs: MctxHistoryTagInput[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type === "toolCall") toolOwners.set(part.id, entry.id);
				}
			}
		}
		if (message.role === "toolResult") {
			const owner = toolOwners.get(message.toolCallId);
			if (owner !== undefined) {
				inputs.push({
					kind: "tool",
					entryId: owner,
					toolCallId: message.toolCallId,
					source: textSource(message.content),
				});
			}
			continue;
		}
		const input = messageInput(entry);
		if (input !== undefined) inputs.push(input);
	}
	return inputs;
}

/** Returns only tool tags whose bound result remains an imminent Pi message. */
export function collectVisibleMctxToolTags(
	messages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
	tags: readonly MctxHistoryTag[],
	liveTailStartIndex: number,
): readonly MctxVisibleToolTag[] {
	const byIdentity = new Map<string, MctxHistoryTag>();
	for (const tag of tags) {
		if (tag.kind === "tool" && tag.toolCallId !== undefined)
			byIdentity.set(`${tag.entryId}:${tag.toolCallId}`, tag);
	}
	const toolOwners = new Map<
		string,
		{ readonly entryId: string; readonly name: string; readonly input: unknown }
	>();
	const visible: MctxVisibleToolTag[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					toolOwners.set(part.id, { entryId: entry.id, name: part.name, input: part.arguments });
				}
			}
			continue;
		}
		if (index < liveTailStartIndex || message.role !== "toolResult" || !messages.includes(message))
			continue;
		const owner = toolOwners.get(message.toolCallId);
		if (owner === undefined) continue;
		const tag = byIdentity.get(`${owner.entryId}:${message.toolCallId}`);
		if (tag !== undefined) visible.push({ tag, toolName: owner.name, input: owner.input });
	}
	return visible;
}

function tagPrefix(tagNumber: number): string {
	return `§${tagNumber}§ `;
}

function marker(tagNumber: number): string {
	return `[dropped §${tagNumber}§]`;
}

function taggedContent(
	content: string | readonly (TextContent | ImageContent)[],
	tag: MctxHistoryTag,
): { readonly content: string | (TextContent | ImageContent)[]; readonly dropped: boolean } {
	const replacement = tag.status === "active" ? undefined : marker(tag.tagNumber);
	if (typeof content === "string") {
		const source = cavemanCompress(content, tag.cavemanDepth);
		return {
			content: replacement ?? `${tagPrefix(tag.tagNumber)}${source}`,
			dropped: replacement !== undefined,
		};
	}
	if (replacement !== undefined)
		return { content: [{ type: "text", text: replacement }], dropped: true };
	const firstText = content.findIndex((part) => part.type === "text");
	if (firstText >= 0) {
		return {
			content: [...content].map((part, index) =>
				index === firstText && part.type === "text"
					? { ...part, text: `${tagPrefix(tag.tagNumber)}${part.text}` }
					: part,
			),
			dropped: false,
		};
	}
	return {
		content: [{ type: "text", text: tagPrefix(tag.tagNumber) }, ...content],
		dropped: false,
	};
}

function taggedAssistantContent(
	content: AssistantMessage["content"],
	tag: MctxHistoryTag,
): { readonly content: AssistantMessage["content"]; readonly dropped: boolean } {
	const replacement = tag.status === "active" ? undefined : marker(tag.tagNumber);
	let sourceTextParts: readonly string[] | undefined;
	try {
		const parsed: unknown = JSON.parse(tag.source);
		if (
			Array.isArray(parsed) &&
			parsed.every(
				(part) =>
					part !== null &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			)
		)
			sourceTextParts = parsed.map((part) => part.text);
	} catch {
		// Historical malformed sources retain the verified Pi projection.
	}
	let replaced = false;
	let sourceIndex = 0;
	return {
		content: content.map((part) => {
			if (part.type !== "text") return part;
			if (replacement !== undefined) {
				if (replaced) return { ...part, text: "" };
				replaced = true;
				return { ...part, text: replacement };
			}
			if (replaced) return part;
			replaced = true;
			const source = sourceTextParts?.[sourceIndex++] ?? part.text;
			return {
				...part,
				text: `${tagPrefix(tag.tagNumber)}${cavemanCompress(source, tag.cavemanDepth)}`,
			};
		}),
		dropped: replacement !== undefined,
	};
}

/** Applies tags only when a cloned Pi context message has one unambiguous branch origin. */
export function projectMctxHistoryTags(
	messages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
	tags: readonly MctxHistoryTag[],
): MctxHistoryTagProjection {
	const byIdentity = new Map<string, MctxHistoryTag>();
	for (const tag of tags) {
		byIdentity.set(`${tag.kind}:${tag.entryId}:${tag.toolCallId ?? ""}`, tag);
	}
	const contextIndexes = contextIndexesByEntryId(messages, entries);
	const result: AgentMessage[] = [];
	const dropped: number[] = [];
	const toolOwners = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
			continue;
		}
		if (message.role === "assistant") {
			for (const part of message.content)
				if (part.type === "toolCall") toolOwners.set(part.id, entry.id);
		}
		const tag =
			message.role === "toolResult"
				? byIdentity.get(`tool:${toolOwners.get(message.toolCallId) ?? ""}:${message.toolCallId}`)
				: byIdentity.get(
						`${message.role === "user" && typeof message.content !== "string" && !message.content.some((part) => part.type === "text") ? "reference" : "message"}:${entry.id}:`,
					);
		if (tag === undefined) continue;
		const index = contextIndexes.get(entry.id);
		if (index === undefined) continue;
		if (message.role === "assistant") {
			const projected = taggedAssistantContent(message.content, tag);
			result[index] = { ...message, content: projected.content };
			if (tag.status === "pending" && projected.dropped) dropped.push(tag.tagNumber);
			continue;
		}
		const projected = taggedContent(
			message.role === "user" && typeof message.content === "string" ? tag.source : message.content,
			tag,
		);
		if (message.role === "user") {
			result[index] = { ...message, content: projected.content };
		} else {
			if (typeof projected.content === "string") continue;
			result[index] = { ...message, content: projected.content };
		}
		if (tag.status === "pending" && projected.dropped) dropped.push(tag.tagNumber);
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message !== undefined && result[index] === undefined) result[index] = message;
	}
	return { messages: result, droppedTagNumbers: dropped };
}
