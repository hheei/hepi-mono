import {
	estimateTokens,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { MctxCompartmentSourceSnapshot } from "./compartment-validation.js";
import { createMctxSourceSnapshot } from "./source-snapshot.js";

export interface MctxCompleteTurnGroup {
	readonly entries: readonly SessionEntry[];
}

function sourceTokens(text: string): number | undefined {
	try {
		const tokens = estimateTokens({ role: "user", content: text, timestamp: 0 });
		return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Converts a user-facing retained message count to whole turn groups. MCTX
 * never splits a turn, so this may conservatively retain extra messages.
 */
export function protectedTurnGroupsForMessages(
	entries: readonly SessionEntry[],
	messagesToKeep: number,
): number {
	if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep < 1) {
		throw new Error("messages to keep must be a positive safe integer");
	}
	const groups = completeGroups(entries);
	let retainedMessages = 0;
	let protectedGroups = 0;
	for (let index = groups.length - 1; index >= 0 && retainedMessages < messagesToKeep; index--) {
		const group = groups[index];
		if (group === undefined) continue;
		protectedGroups++;
		retainedMessages += group.entries.filter((entry) => entry.type === "message").length;
	}
	return Math.max(1, protectedGroups);
}

export interface MctxSourceHistory {
	readonly groups: readonly MctxCompleteTurnGroup[];
	readonly source: MctxCompartmentSourceSnapshot;
	readonly sourceText: string;
}

export type MctxSourceHistoryProjection =
	| { readonly kind: "eligible"; readonly value: MctxSourceHistory }
	| {
			readonly kind: "ineligible";
			readonly reason: "no-complete-turn-groups" | "protected-tail" | "source-too-large";
	  }
	| { readonly kind: "invalid"; readonly reason: string };

function isUserEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function endsWithAssistant(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message") return isAssistantEntry(entry);
	}
	return false;
}

function completeGroups(entries: readonly SessionEntry[]): readonly MctxCompleteTurnGroup[] {
	const groups: MctxCompleteTurnGroup[] = [];
	let current: SessionEntry[] | undefined;
	let leading: SessionEntry[] = [];
	for (const entry of entries) {
		if (isUserEntry(entry)) {
			// A new user entry closes the previous group only after its assistant
			// response. Interrupted/tool-only work must remain in the live tail.
			if (current !== undefined && endsWithAssistant(current)) {
				groups.push({ entries: current });
			}
			// Pi compaction markers are branch entries, not messages. A live tail can
			// start with one, so retain it in the next source snapshot or the next
			// compartment would leave a graph gap.
			current = [...leading, entry];
			leading = [];
		} else if (current !== undefined) {
			current.push(entry);
		} else {
			leading.push(entry);
		}
	}
	if (current !== undefined && endsWithAssistant(current)) groups.push({ entries: current });
	return groups;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!isRecord(part)) return [];
			if (typeof part.text === "string") return [part.text];
			if (part.type === "toolCall" && typeof part.name === "string")
				return [`[tool call: ${part.name}]`];
			if (part.type === "image") return ["[image omitted]"];
			return [];
		})
		.join("\n");
}

function sourceText(entries: readonly SessionEntry[]): string | undefined {
	try {
		const lines = entries.flatMap((entry) => {
			if (entry.type !== "message") return [];
			return sessionEntryToContextMessages(entry).map(
				(message) =>
					`[${entry.id}] ${message.role}\n${compactContent(
						isRecord(message) && "content" in message ? message.content : undefined,
					)}`,
			);
		});
		return lines.join("\n\n");
	} catch {
		return undefined;
	}
}

/**
 * Selects only whole, completed older turns for historian input. Pi owns entry
 * projection; this module owns only group boundaries and source snapshot fencing.
 */
export function projectMctxSourceHistory(
	entries: readonly SessionEntry[],
	protectedTurnGroups: number = 1,
	maxSourceTokens?: number,
): MctxSourceHistoryProjection {
	if (!Number.isSafeInteger(protectedTurnGroups) || protectedTurnGroups < 0) {
		return { kind: "invalid", reason: "protected turn group count must be a non-negative integer" };
	}
	const groups = completeGroups(entries);
	if (groups.length === 0) return { kind: "ineligible", reason: "no-complete-turn-groups" };
	// Keep recent complete turns raw so the model retains immediate conversational
	// detail even after older history becomes a compartment.
	const eligibleGroups = groups.slice(0, Math.max(0, groups.length - protectedTurnGroups));
	if (eligibleGroups.length === 0) return { kind: "ineligible", reason: "protected-tail" };
	if (
		maxSourceTokens !== undefined &&
		(!Number.isSafeInteger(maxSourceTokens) || maxSourceTokens < 1)
	) {
		return { kind: "ineligible", reason: "source-too-large" };
	}
	const boundedGroups: MctxCompleteTurnGroup[] = [];
	let totalTokens = 0;
	for (const group of eligibleGroups) {
		const text = sourceText(group.entries);
		if (text === undefined)
			return { kind: "invalid", reason: "Pi source messages cannot be serialized" };
		const tokens = sourceTokens(text);
		if (tokens === undefined)
			return { kind: "invalid", reason: "Pi source messages cannot be tokenized" };
		if (maxSourceTokens !== undefined && totalTokens + tokens > maxSourceTokens) break;
		boundedGroups.push(group);
		totalTokens += tokens;
	}
	if (boundedGroups.length === 0) return { kind: "ineligible", reason: "source-too-large" };
	const eligibleEntries = boundedGroups.flatMap((group) => group.entries);
	const snapshot = createMctxSourceSnapshot(eligibleEntries);
	if (snapshot.kind === "invalid") return snapshot;
	const text = sourceText(eligibleEntries);
	if (text === undefined)
		return { kind: "invalid", reason: "Pi source messages cannot be serialized" };
	return {
		kind: "eligible",
		value: { groups: boundedGroups, source: snapshot.snapshot, sourceText: text },
	};
}
