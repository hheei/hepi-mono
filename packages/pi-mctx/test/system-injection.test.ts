import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripMctxSystemInjection, stripMctxSystemInjections } from "../src/system-injection.js";

test("preserves ordinary message content", (): void => {
	expect(stripMctxSystemInjection("Keep this request.")).toBeUndefined();
});

test("strips upstream system-reminder blocks", (): void => {
	expect(
		stripMctxSystemInjection("Keep <system-reminder>ignore this</system-reminder> request."),
	).toBe("Keep  request.");
});

test("strips upstream directive and emergency blocks", (): void => {
	expect(
		stripMctxSystemInjection(
			"Before\n[SYSTEM DIRECTIVE: OH-MY-CLAUDE] injected\n\nAfter\n\n[EMERGENCY CONTEXT WINDOW WARNING] injected",
		),
	).toBe("Before\n\n\nAfter");
});

test("strips only non-protected verified user tags", (): void => {
	const old = {
		role: "user" as const,
		content: "<system-reminder>injected</system-reminder> keep",
		timestamp: 0,
	};
	const recent = {
		role: "user" as const,
		content: "<system-reminder>keep</system-reminder>",
		timestamp: 1,
	};
	const entries = [
		{ type: "message", id: "old", parentId: null, message: old },
		{ type: "message", id: "recent", parentId: "old", message: recent },
	] as SessionEntry[];
	const result = stripMctxSystemInjections({
		messages: [old, recent],
		entries,
		tags: [
			{ tagNumber: 1, kind: "message", entryId: "old", source: old.content, status: "active" },
			{
				tagNumber: 2,
				kind: "message",
				entryId: "recent",
				source: recent.content,
				status: "active",
			},
		],
		protectedTags: 1,
	});
	expect(result.messages[0]).toMatchObject({ content: "keep" });
	expect(result.messages[1]).toEqual(recent);
	expect(result.updates).toEqual([{ tagNumber: 1, source: "keep" }]);
});
