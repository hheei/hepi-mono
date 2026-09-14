import { createHash } from "node:crypto";
import type { RawMessage } from "#core/hooks/read-session-raw";
import type { TurnTaintStore } from "./taint";

export type HistorianEvidenceKind = "user" | "tool" | "assistant" | "retrieval" | "memory_save";

export type HistorianEvidence = {
	readonly kind: HistorianEvidenceKind;
	readonly content: string;
	readonly hostEntryId?: string | undefined;
	readonly toolCallId?: string | undefined;
	readonly toolName?: string | undefined;
	readonly contentFingerprint?: string | undefined;
	readonly derivedFromRetrieval?: boolean | undefined;
	readonly tainted?: boolean | undefined;
};

export type HistorianSourceIdentity = {
	readonly hostEntryId: string;
	readonly toolCallId?: string | undefined;
	readonly contentFingerprint: string;
};

export type HistorianCandidate = {
	readonly content: string;
	readonly sourceRefs: readonly HistorianSourceIdentity[];
};

export type CandidateAdmission =
	| { readonly accepted: true; readonly candidate: HistorianCandidate }
	| {
			readonly accepted: false;
			readonly reason:
				| "empty"
				| "tainted"
				| "no-independent-evidence"
				| "ambiguous-provenance"
				| "stale-provenance";
	  };

function normalized(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export function contentFingerprint(content: string): string {
	return createHash("sha256").update(normalized(content)).digest("hex");
}

export function isRetrievalEvidence(evidence: HistorianEvidence): boolean {
	const toolName = evidence.toolName?.trim().toLowerCase();
	return (
		evidence.kind === "retrieval" ||
		evidence.kind === "memory_save" ||
		evidence.derivedFromRetrieval === true ||
		(evidence.kind === "tool" &&
			(toolName === "memory_search" ||
				toolName === "mctx_search" ||
				toolName === "mctx_memory" ||
				toolName === "memory_save"))
	);
}

function isIndependentEvidence(evidence: HistorianEvidence): boolean {
	return (
		(evidence.kind === "user" || evidence.kind === "tool") &&
		!isRetrievalEvidence(evidence) &&
		evidence.tainted !== true &&
		evidence.content.trim().length > 0
	);
}

export function admitHistorianCandidate(args: {
	content: string;
	evidence: readonly HistorianEvidence[];
}): CandidateAdmission {
	const content = normalized(args.content);
	if (!content) return { accepted: false, reason: "empty" };
	const tainted = args.evidence.some(
		(evidence) => evidence.tainted === true || isRetrievalEvidence(evidence),
	);
	const independent = args.evidence.filter(isIndependentEvidence);
	if (independent.length === 0) {
		return { accepted: false, reason: tainted ? "tainted" : "no-independent-evidence" };
	}

	const sources: HistorianSourceIdentity[] = [];
	const seen = new Set<string>();
	for (const evidence of independent) {
		const hostEntryId = evidence.hostEntryId?.trim();
		if (!hostEntryId) return { accepted: false, reason: "stale-provenance" };
		const actualFingerprint = contentFingerprint(evidence.content);
		if (
			evidence.contentFingerprint !== undefined &&
			evidence.contentFingerprint !== actualFingerprint
		) {
			return { accepted: false, reason: "stale-provenance" };
		}
		const source = {
			hostEntryId,
			...(evidence.toolCallId?.trim() ? { toolCallId: evidence.toolCallId.trim() } : {}),
			contentFingerprint: actualFingerprint,
		};
		const key = JSON.stringify(source);
		if (!seen.has(key)) {
			seen.add(key);
			sources.push(source);
		}
	}
	const hostEntries = new Set(sources.map((source) => source.hostEntryId));
	if (
		hostEntries.size !== sources.length &&
		sources.some((source) => source.toolCallId === undefined)
	) {
		return { accepted: false, reason: "ambiguous-provenance" };
	}
	return { accepted: true, candidate: { content, sourceRefs: sources } };
}

function textParts(message: RawMessage): string[] {
	const values: string[] = [];
	for (const part of message.parts) {
		if (part === null || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") values.push(record.text);
	}
	return values;
}

function toolEvidence(message: RawMessage): HistorianEvidence[] {
	const evidence: HistorianEvidence[] = [];
	for (const part of message.parts) {
		if (part === null || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type !== "tool") continue;
		const state =
			record.state !== null && typeof record.state === "object"
				? (record.state as Record<string, unknown>)
				: undefined;
		const output = state?.output;
		const content =
			typeof output === "string" ? output : output === undefined ? "" : JSON.stringify(output);
		if (!content) continue;
		evidence.push({
			kind: "tool",
			content,
			hostEntryId: message.id,
			...(typeof record.callID === "string" ? { toolCallId: record.callID } : {}),
			...(typeof record.tool === "string" ? { toolName: record.tool } : {}),
		});
	}
	return evidence;
}

/** Admit a parsed fact only when its exact text exists in stable, untainted raw user/tool evidence. */
export function admitHistorianCandidateFromRawMessages(args: {
	content: string;
	sessionId: string;
	messages: readonly RawMessage[];
	taint: Pick<TurnTaintStore, "isHostEntryTainted">;
}): CandidateAdmission {
	const evidence: HistorianEvidence[] = [];
	for (const message of args.messages) {
		const tainted = args.taint.isHostEntryTainted(args.sessionId, message.id);
		for (const content of textParts(message)) {
			if (!content.includes(args.content)) continue;
			evidence.push({
				kind: message.role === "user" ? "user" : "assistant",
				content,
				hostEntryId: message.id,
				tainted,
			});
		}
		for (const item of toolEvidence(message)) {
			if (item.content.includes(args.content)) evidence.push({ ...item, tainted });
		}
	}
	return admitHistorianCandidate({ content: args.content, evidence });
}
