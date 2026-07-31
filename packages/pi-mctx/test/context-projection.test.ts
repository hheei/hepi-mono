import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { projectMctxContext } from "../src/context-projection.js";
import { createMctxSourceSnapshot } from "../src/source-snapshot.js";
import type { MctxCompartment } from "../src/store.js";

function entry(id: string, role: "user" | "assistant", content: string): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role, content, timestamp: 1 },
	} as SessionEntry;
}

const entries = [
	entry("user-1", "user", "old request"),
	entry("assistant-1", "assistant", "old response"),
	entry("user-2", "user", "live request"),
	entry("assistant-2", "assistant", "live response"),
];

function compartment(
	tier: "m0" | "m1",
	start: number,
	end: number,
	publishedRevision: number,
): MctxCompartment {
	const source = createMctxSourceSnapshot(entries.slice(start, end + 1));
	if (source.kind !== "valid") throw new Error("Expected valid source");
	return {
		tier,
		sequence: publishedRevision - 1,
		sourceStartEntryId: entries[start]?.id ?? "",
		sourceEndEntryId: entries[end]?.id ?? "",
		sourceFingerprint: source.snapshot.fingerprint,
		renderedPayload: `${tier} summary`,
		publishedRevision,
	};
}

function rawMessages(): AgentMessage[] {
	return entries.flatMap((value) => sessionEntryToContextMessages(value));
}

test("replaces a verified branch segment while retaining surrounding extension messages", (): void => {
	const raw = rawMessages();
	const leading: AgentMessage = {
		role: "custom",
		customType: "other-extension:leading",
		content: "leading",
		display: false,
		timestamp: 1,
	};
	const trailing: AgentMessage = {
		role: "custom",
		customType: "other-extension:trailing",
		content: "trailing",
		display: false,
		timestamp: 1,
	};
	const result = projectMctxContext([leading, ...raw, trailing], entries, [
		compartment("m0", 0, 0, 1),
		compartment("m1", 1, 1, 2),
	]);
	if (result.kind !== "rendered") throw new Error("Expected rendered context");
	expect(result.messages).toEqual([
		leading,
		{
			role: "custom",
			customType: "pi-mctx:m0",
			content: "m0 summary",
			display: false,
			timestamp: 0,
		},
		{
			role: "custom",
			customType: "pi-mctx:m1",
			content: "m1 summary",
			display: false,
			timestamp: 0,
		},
		...raw.slice(2),
		trailing,
	]);
});

test("fails open for empty, divergent, and identity-unmatched graphs", (): void => {
	const raw = rawMessages();
	expect(projectMctxContext(raw, entries, [])).toEqual({ kind: "unchanged", reason: "empty" });
	expect(
		projectMctxContext(raw, entries, [
			{ ...compartment("m0", 0, 1, 1), sourceFingerprint: "stale" },
		]),
	).toEqual({ kind: "unchanged", reason: "invalid" });
	expect(
		projectMctxContext(
			raw.map((message) => ({ ...message })),
			entries,
			[compartment("m0", 0, 1, 1)],
		),
	).toEqual({ kind: "unchanged", reason: "unmatched" });
});
