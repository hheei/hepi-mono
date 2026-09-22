/**
 * Messages Pi still sends after native compaction.
 *
 * `getBranch()` includes pre-marker history. Pi's `buildSessionProjection`
 * keeps the compaction summary plus the firstKept tail, and applies
 * `context_edit` omissions/replacements. Status estimates must use that
 * projected tail, never the full JSONL or the pre-compact `last_input_tokens`
 * reading.
 */

import { updateSessionMeta } from "#core/features/storage";
import { projectPiBranchEntries } from "./pi-session-projection";
import { tokenizePiMessages } from "./tokenize-pi-messages";

export type CompactKeptMessage = {
	role?: string | undefined;
	content?: unknown;
};

export function collectCompactKeptMessages(entries: readonly unknown[]): CompactKeptMessage[] {
	const kept: CompactKeptMessage[] = [];
	for (const message of projectPiBranchEntries(entries).messages) {
		const mapped = compactKeptFromProjectedMessage(message);
		if (mapped) kept.push(mapped);
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

function compactKeptFromProjectedMessage(message: unknown): CompactKeptMessage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const row = message as { role?: unknown; summary?: unknown };
	if (row.role === "user" || row.role === "assistant" || row.role === "toolResult") {
		return message as CompactKeptMessage;
	}
	if (
		(row.role === "compactionSummary" || row.role === "branchSummary") &&
		typeof row.summary === "string" &&
		row.summary.length > 0
	) {
		return { role: "user", content: row.summary };
	}
	return undefined;
}
