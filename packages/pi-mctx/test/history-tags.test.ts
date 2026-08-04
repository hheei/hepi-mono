import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	collectMctxHistoryTagInputs,
	collectVisibleMctxToolTags,
	MAX_CTX_EXPAND_CHARS,
	projectMctxHistoryTags,
	renderMctxHistoryTagPage,
} from "../src/history-tags.js";
import type { MctxHistoryTag } from "../src/store.js";

const userMessage = { role: "user" as const, content: "keep this", timestamp: 0 };
const userEntry = {
	type: "message",
	id: "user-entry",
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: userMessage,
} as SessionEntry;

describe("MCTX history tags", () => {
	test("binds a session tag to the entry and prefixes its live text", () => {
		const inputs = collectMctxHistoryTagInputs([userEntry]);
		expect(inputs).toEqual([{ kind: "message", entryId: "user-entry", source: "keep this" }]);
		const tag: MctxHistoryTag = { ...inputs[0]!, tagNumber: 7, status: "active" };
		const projection = projectMctxHistoryTags([userMessage], [userEntry], [tag]);
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
		const projection = projectMctxHistoryTags([userMessage], [userEntry], [tag]);
		expect(projection.messages[0]).toMatchObject({ content: "[dropped §7§]" });
		expect(projection.droppedTagNumbers).toEqual([7]);
	});

	test("renders bounded source pages with deterministic continuation", () => {
		const tag: MctxHistoryTag = {
			kind: "message",
			entryId: "user-entry",
			source: "abcdef",
			tagNumber: 7,
			status: "dropped",
		};
		expect(renderMctxHistoryTagPage([tag], 0, 5)).toEqual({ text: "§7§ (", nextOffset: 5 });
		expect(renderMctxHistoryTagPage([tag], 5, 5)).toEqual({ text: "messa", nextOffset: 10 });
		expect(renderMctxHistoryTagPage([tag], 0, MAX_CTX_EXPAND_CHARS + 1)).toBeUndefined();
	});
});

test("collects tool candidates only from the verified live tail", (): void => {
	const assistant = {
		type: "message",
		id: "assistant-tool",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: "call-1", name: "bash_status", arguments: {} }],
			timestamp: 1,
		},
	} as SessionEntry;
	const resultMessage = {
		role: "toolResult" as const,
		toolCallId: "call-1",
		content: "result",
		timestamp: 2,
	};
	const result = {
		type: "message",
		id: "tool-result",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: resultMessage,
	} as SessionEntry;
	const tag: MctxHistoryTag = {
		kind: "tool",
		entryId: "assistant-tool",
		toolCallId: "call-1",
		source: "result",
		tagNumber: 1,
		status: "active",
	};
	expect(collectVisibleMctxToolTags([resultMessage], [assistant, result], [tag], 2)).toEqual([]);
	expect(collectVisibleMctxToolTags([resultMessage], [assistant, result], [tag], 1)).toEqual([
		{ tag, toolName: "bash_status", input: {} },
	]);
});
