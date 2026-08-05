import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextIndexesByEntryId } from "./context-entry-indexes.js";
import type { MctxHistoryTag, MctxHistoryTagSourceUpdate } from "./store.js";

const markers = [
	"<!-- OMO_INTERNAL_INITIATOR -->",
	"[SYSTEM DIRECTIVE: MAGIC-CONTEXT",
	"[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
	"[Category+Skill Reminder]",
	"[EDIT ERROR - IMMEDIATE ACTION REQUIRED]",
	"[task CALL FAILED - IMMEDIATE RETRY REQUIRED]",
	"[EMERGENCY CONTEXT WINDOW WARNING]",
	"Unstable background agent appears idle",
	"**THE SUBAGENT JUST CLAIMED THIS TASK IS DONE.",
] as const;

const systemReminder = /<system-reminder>[\s\S]*?<\/system-reminder>/giu;
const omoInitiator = /<!-- OMO_INTERNAL_INITIATOR -->/gu;
const ohMyDirective =
	/\[SYSTEM DIRECTIVE: OH-MY-(?:OPENCODE|CLAUDE)[^\]]*\][\s\S]*?(?=\n\n(?!\s*[-*])|$)/gu;

/** Returns the upstream-compatible stripped content, or undefined when unchanged. */
export function stripMctxSystemInjection(source: string): string | undefined {
	if (!markers.some((marker) => source.includes(marker)) && !systemReminder.test(source)) {
		systemReminder.lastIndex = 0;
		return undefined;
	}
	systemReminder.lastIndex = 0;
	let cleaned = source
		.replace(systemReminder, "")
		.replace(omoInitiator, "")
		.replace(ohMyDirective, "");
	for (const marker of markers) {
		if (marker.startsWith("<!-- ") || marker.startsWith("[SYSTEM DIRECTIVE")) continue;
		const index = cleaned.indexOf(marker);
		if (index < 0) continue;
		const end = cleaned.indexOf("\n\n", index + marker.length);
		cleaned = end < 0 ? cleaned.slice(0, index) : `${cleaned.slice(0, index)}${cleaned.slice(end)}`;
	}
	return cleaned.trim();
}

/** Strips only identity-verified, non-protected user text tags. */
export function stripMctxSystemInjections(input: {
	readonly messages: readonly AgentMessage[];
	readonly entries: readonly SessionEntry[];
	readonly tags: readonly MctxHistoryTag[];
	readonly protectedTags: number;
}): {
	readonly messages: readonly AgentMessage[];
	readonly updates: readonly MctxHistoryTagSourceUpdate[];
} {
	const active = input.tags.filter((tag) => tag.status === "active");
	const protectedNumbers = new Set(
		[...active]
			.sort((left, right) => right.tagNumber - left.tagNumber)
			.slice(0, input.protectedTags)
			.map((tag) => tag.tagNumber),
	);
	const byEntryId = new Map(
		active
			.filter((tag) => tag.kind === "message" && !protectedNumbers.has(tag.tagNumber))
			.map((tag) => [tag.entryId, tag]),
	);
	const indexes = contextIndexesByEntryId(input.messages, input.entries);
	const result = [...input.messages];
	const updates: MctxHistoryTagSourceUpdate[] = [];
	for (const entry of input.entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const tag = byEntryId.get(entry.id);
		const index = indexes.get(entry.id);
		if (index === undefined || tag === undefined) continue;
		const message = result[index];
		if (message?.role !== "user" || typeof message.content !== "string") continue;
		const source = stripMctxSystemInjection(message.content);
		if (source === undefined) continue;
		result[index] = { ...message, content: source };
		updates.push({ tagNumber: tag.tagNumber, source });
	}
	return { messages: updates.length === 0 ? input.messages : result, updates };
}
