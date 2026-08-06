import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { projectMctxSourceHistory, protectedTurnGroupsForMessages } from "../src/source-history.js";

function entry(id: string, role: "user" | "assistant" | "toolResult", content = id): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role, content, timestamp: 1 },
	} as SessionEntry;
}

test("projects whole older turns and preserves a protected tail", (): void => {
	const result = projectMctxSourceHistory([
		entry("user-1", "user", "first request"),
		entry("assistant-1", "assistant", "first response"),
		entry("user-2", "user", "latest request"),
		entry("assistant-2", "assistant", "latest response"),
	]);
	expect(result.kind).toBe("eligible");
	if (result.kind !== "eligible") throw new Error("Expected eligible source history");
	expect(result.value.groups).toHaveLength(1);
	expect(result.value.groups[0]?.entries.map((item) => item.id)).toEqual(["user-1", "assistant-1"]);
	expect(result.value.source.entryIds).toEqual(["user-1", "assistant-1"]);
	expect(result.value.sourceText).toContain("first request");
	expect(result.value.sourceText).toContain("first response");
	expect(result.value.sourceText).not.toContain("latest request");
});

test("conservatively converts retained messages to complete turn groups", (): void => {
	const entries = [
		entry("user-1", "user"),
		entry("assistant-1", "assistant"),
		entry("user-2", "user"),
		entry("assistant-call", "assistant"),
		entry("tool-result", "toolResult"),
		entry("assistant-2", "assistant"),
	];
	expect(protectedTurnGroupsForMessages(entries, 1)).toBe(1);
	expect(protectedTurnGroupsForMessages(entries, 5)).toBe(2);
	expect(protectedTurnGroupsForMessages(entries, 20)).toBe(2);
	expect(() => protectedTurnGroupsForMessages(entries, 0)).toThrow(
		"messages to keep must be a positive safe integer",
	);
});

test("does not split a user-assistant-tool-result-assistant turn group", (): void => {
	const result = projectMctxSourceHistory(
		[
			entry("user-1", "user"),
			entry("assistant-call", "assistant"),
			entry("tool-result", "toolResult"),
			entry("assistant-final", "assistant"),
		],
		0,
	);
	expect(result.kind).toBe("eligible");
	if (result.kind !== "eligible") throw new Error("Expected eligible source history");
	expect(result.value.source.entryIds).toEqual([
		"user-1",
		"assistant-call",
		"tool-result",
		"assistant-final",
	]);
});

test("leaves incomplete and only protected turns ineligible", (): void => {
	expect(projectMctxSourceHistory([entry("user", "user")])).toEqual({
		kind: "ineligible",
		reason: "no-complete-turn-groups",
	});
	expect(
		projectMctxSourceHistory([entry("user", "user"), entry("assistant", "assistant")]),
	).toEqual({
		kind: "ineligible",
		reason: "protected-tail",
	});
});

test("keeps a whole source prefix inside the token budget", (): void => {
	const entries = [
		entry("user-1", "user", "first request"),
		entry("assistant-1", "assistant", "first response"),
		entry("user-2", "user", "second request"),
		entry("assistant-2", "assistant", "second response"),
		entry("user-3", "user", "protected request"),
		entry("assistant-3", "assistant", "protected response"),
	];
	const full = projectMctxSourceHistory(entries, 1);
	if (full.kind !== "eligible") throw new Error("Expected eligible source history");
	const firstOnly = projectMctxSourceHistory(
		entries,
		1,
		Math.ceil(full.value.sourceText.length / 8),
	);
	expect(firstOnly.kind).toBe("eligible");
	if (firstOnly.kind !== "eligible") throw new Error("Expected bounded source history");
	expect(firstOnly.value.groups).toHaveLength(1);
	expect(firstOnly.value.source.entryIds).toEqual(["user-1", "assistant-1"]);
	expect(projectMctxSourceHistory(entries, 1, 1)).toEqual({
		kind: "ineligible",
		reason: "source-too-large",
	});
});
