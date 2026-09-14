/**
 * Messages Pi still sends after native compaction.
 *
 * `getBranch()` includes pre-marker history. Pi's `buildSessionContext`
 * keeps a synthetic compaction summary plus entries from
 * `firstKeptEntryId` onward. Status estimates must use that kept tail,
 * never the full JSONL or the pre-compact `last_input_tokens` reading.
 */

import { updateSessionMeta } from "#core/features/storage";
import { tokenizePiMessages } from "./tokenize-pi-messages";

export type CompactKeptMessage = {
	role?: string | undefined;
	content?: unknown;
};

export function collectCompactKeptMessages(entries: readonly unknown[]): CompactKeptMessage[] {
	let compactionIndex = -1;
	let firstKeptEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") continue;
		const row = entry as { type?: unknown; firstKeptEntryId?: unknown };
		if (row.type !== "compaction") continue;
		compactionIndex = i;
		if (typeof row.firstKeptEntryId === "string" && row.firstKeptEntryId.length > 0) {
			firstKeptEntryId = row.firstKeptEntryId;
		}
		break;
	}

	const kept: CompactKeptMessage[] = [];
	const appendEligible = (entry: unknown): void => {
		const message = toKeptMessage(entry);
		if (message) kept.push(message);
	};

	if (compactionIndex < 0) {
		for (const entry of entries) appendEligible(entry);
		return kept;
	}

	const compaction = entries[compactionIndex] as { summary?: unknown };
	if (typeof compaction.summary === "string" && compaction.summary.length > 0) {
		kept.push({ role: "user", content: compaction.summary });
	}

	if (firstKeptEntryId !== undefined) {
		let foundFirstKept = false;
		for (let i = 0; i < compactionIndex; i++) {
			const entry = entries[i];
			const entryId = (entry as { id?: unknown } | null)?.id;
			if (typeof entryId === "string" && entryId === firstKeptEntryId) foundFirstKept = true;
			if (!foundFirstKept) continue;
			appendEligible(entry);
		}
	}

	for (let i = compactionIndex + 1; i < entries.length; i++) {
		appendEligible(entries[i]);
	}
	return kept;
}

export function persistCompactKeptPromptEstimate(args: {
	db: Parameters<typeof updateSessionMeta>[0];
	sessionId: string;
	entries: readonly unknown[];
}): void {
	const counts = tokenizePiMessages(collectCompactKeptMessages(args.entries));
	updateSessionMeta(args.db, args.sessionId, {
		conversationTokens: counts.conversation,
		toolCallTokens: counts.toolCall,
		lastInputTokens: 0,
		lastContextPercentage: 0,
	});
}

export function persistCompactKeptPromptEstimateIfCompacted(args: {
	db: Parameters<typeof updateSessionMeta>[0];
	sessionId: string;
	entries: readonly unknown[];
}): boolean {
	if (!hasCompactionEntry(args.entries)) return false;
	persistCompactKeptPromptEstimate(args);
	return true;
}

function hasCompactionEntry(entries: readonly unknown[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") continue;
		if ((entry as { type?: unknown }).type === "compaction") return true;
	}
	return false;
}

function toKeptMessage(entry: unknown): CompactKeptMessage | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const row = entry as {
		type?: unknown;
		message?: unknown;
		summary?: unknown;
	};
	if (row.type === "message") {
		const message = row.message;
		if (!message || typeof message !== "object") return undefined;
		return message as CompactKeptMessage;
	}
	if (row.type === "branch_summary" && typeof row.summary === "string" && row.summary.length > 0) {
		return { role: "user", content: row.summary };
	}
	return undefined;
}
