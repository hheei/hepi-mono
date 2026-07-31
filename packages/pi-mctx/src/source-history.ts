import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { MctxCompartmentSourceSnapshot } from "./compartment-validation.js";
import { createMctxSourceSnapshot } from "./source-snapshot.js";

export interface MctxCompleteTurnGroup {
	readonly entries: readonly SessionEntry[];
}

export interface MctxSourceHistory {
	readonly groups: readonly MctxCompleteTurnGroup[];
	readonly source: MctxCompartmentSourceSnapshot;
	readonly sourceText: string;
}

export type MctxSourceHistoryProjection =
	| { readonly kind: "eligible"; readonly value: MctxSourceHistory }
	| { readonly kind: "ineligible"; readonly reason: "no-complete-turn-groups" | "protected-tail" }
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
	for (const entry of entries) {
		if (isUserEntry(entry)) {
			if (current !== undefined && endsWithAssistant(current)) {
				groups.push({ entries: current });
			}
			current = [entry];
		} else if (current !== undefined) {
			current.push(entry);
		}
	}
	if (current !== undefined && endsWithAssistant(current)) groups.push({ entries: current });
	return groups;
}

function sourceText(entries: readonly SessionEntry[]): string | undefined {
	try {
		const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
		const encoded = JSON.stringify(messages);
		return typeof encoded === "string" ? encoded : undefined;
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
): MctxSourceHistoryProjection {
	if (!Number.isSafeInteger(protectedTurnGroups) || protectedTurnGroups < 0) {
		return { kind: "invalid", reason: "protected turn group count must be a non-negative integer" };
	}
	const groups = completeGroups(entries);
	if (groups.length === 0) return { kind: "ineligible", reason: "no-complete-turn-groups" };
	const eligibleGroups = groups.slice(0, Math.max(0, groups.length - protectedTurnGroups));
	if (eligibleGroups.length === 0) return { kind: "ineligible", reason: "protected-tail" };
	const eligibleEntries = eligibleGroups.flatMap((group) => group.entries);
	const snapshot = createMctxSourceSnapshot(eligibleEntries);
	if (snapshot.kind === "invalid") return snapshot;
	const text = sourceText(eligibleEntries);
	if (text === undefined)
		return { kind: "invalid", reason: "Pi source messages cannot be serialized" };
	return {
		kind: "eligible",
		value: { groups: eligibleGroups, source: snapshot.snapshot, sourceText: text },
	};
}
