import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { verifyMctxCompartmentGraph } from "./compartment-graph.js";
import type { MctxCompartment } from "./store.js";

export type MctxContextProjection =
	| { readonly kind: "unchanged"; readonly reason: "empty" | "invalid" | "unmatched" }
	| { readonly kind: "rendered"; readonly messages: readonly AgentMessage[] };

function projectEntries(entries: readonly SessionEntry[]): readonly AgentMessage[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}

function indexOfIdentitySequence(
	messages: readonly AgentMessage[],
	sequence: readonly AgentMessage[],
): number | undefined {
	// Value equality could replace another extension's equal-looking messages.
	// Identity proves this exact Pi branch segment still survived the hook chain.
	if (sequence.length === 0) return undefined;
	for (let start = 0; start <= messages.length - sequence.length; start++) {
		let matches = true;
		for (let offset = 0; offset < sequence.length; offset++) {
			if (messages[start + offset] !== sequence[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return start;
	}
	return undefined;
}

function tierMessage(tier: "m0" | "m1", compartments: readonly MctxCompartment[]): AgentMessage {
	return {
		role: "custom",
		customType: `pi-mctx:${tier}`,
		content: compartments.map((compartment) => compartment.renderedPayload).join("\n\n"),
		display: false,
		// Stable m0 metadata keeps provider prompt-prefix caches reusable.
		timestamp: 0,
	};
}

/**
 * Replaces only a live-branch segment that Pi still exposes by object identity.
 * Any transformation or branch mismatch leaves the host context untouched.
 */
export function projectMctxContext(
	eventMessages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
	compartments: readonly MctxCompartment[],
): MctxContextProjection {
	// Verify the persisted graph before matching host messages. Projection is a
	// best-effort transformation: any mismatch returns the original context.
	const graph = verifyMctxCompartmentGraph(entries, compartments);
	if (graph.kind === "empty") return { kind: "unchanged", reason: "empty" };
	if (graph.kind === "invalid") return { kind: "unchanged", reason: "invalid" };
	const rawMessages = projectEntries(entries);
	const rawStart = indexOfIdentitySequence(eventMessages, rawMessages);
	if (rawStart === undefined) return { kind: "unchanged", reason: "unmatched" };
	const prefix = projectEntries(entries.slice(0, graph.graph.sourceStartIndex));
	const tail = projectEntries(entries.slice(graph.graph.liveTailStartIndex));
	const rendered = [
		...eventMessages.slice(0, rawStart + prefix.length),
		...(graph.graph.m0.length === 0 ? [] : [tierMessage("m0", graph.graph.m0)]),
		...(graph.graph.m1.length === 0 ? [] : [tierMessage("m1", graph.graph.m1)]),
		...tail,
		...eventMessages.slice(rawStart + rawMessages.length),
	];
	return { kind: "rendered", messages: rendered };
}
