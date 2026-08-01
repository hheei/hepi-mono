import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectMctxHistoryTagInputs, projectMctxHistoryTags } from "../src/history-tags.js";
import type { MctxHistoryTag } from "../src/store.js";

const userEntry = {
	type: "message",
	id: "user-entry",
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: "keep this", timestamp: 0 },
} as SessionEntry;

describe("MCTX history tags", () => {
	test("binds a session tag to the entry and prefixes its live text", () => {
		const inputs = collectMctxHistoryTagInputs([userEntry]);
		expect(inputs).toEqual([{ kind: "message", entryId: "user-entry", source: "keep this" }]);
		const tag: MctxHistoryTag = { ...inputs[0]!, tagNumber: 7, status: "active" };
		const projection = projectMctxHistoryTags([userEntry.message], [userEntry], [tag]);
		expect(projection.messages[0]).toMatchObject({ content: "§7§ keep this" });
	});

	test("replaces only pending verified payloads with the recovery marker", () => {
		const tag: MctxHistoryTag = {
			kind: "message",
			entryId: "user-entry",
			source: "keep this",
			tagNumber: 7,
			status: "pending",
		};
		const projection = projectMctxHistoryTags([userEntry.message], [userEntry], [tag]);
		expect(projection.messages[0]).toMatchObject({ content: "[dropped §7§]" });
		expect(projection.droppedTagNumbers).toEqual([7]);
	});
});
