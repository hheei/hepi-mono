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
import { injectMctxTemporalMarkers } from "../src/temporal-awareness.js";

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

	test("projects tags into Pi's cloned context messages", () => {
		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "answer" }],
			timestamp: 1,
		};
		const assistantEntry = {
			type: "message",
			id: "assistant-entry",
			parentId: "user-entry",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: assistantMessage,
		} as SessionEntry;
		const tags: MctxHistoryTag[] = [
			{
				kind: "message",
				entryId: "user-entry",
				source: "keep this",
				tagNumber: 7,
				status: "active",
			},
			{
				kind: "message",
				entryId: "assistant-entry",
				source: '[{"type":"text","text":"answer"}]',
				tagNumber: 8,
				status: "pending",
			},
		];
		const clonedMessages = structuredClone([userMessage, assistantMessage]);
		const projection = projectMctxHistoryTags(clonedMessages, [userEntry, assistantEntry], tags);
		expect(projection.messages[0]).toMatchObject({ content: "§7§ keep this" });
		expect(projection.messages[1]).toMatchObject({
			content: [{ type: "text", text: "[dropped §8§]" }],
		});
		expect(projection.droppedTagNumbers).toEqual([8]);
	});

	test("projects duplicate content by its separate branch entries", () => {
		const duplicateEntry = { ...userEntry, id: "user-entry-2" };
		const tags: MctxHistoryTag[] = [
			{
				kind: "message",
				entryId: "user-entry",
				source: "keep this",
				tagNumber: 7,
				status: "active",
			},
			{
				kind: "message",
				entryId: "user-entry-2",
				source: "keep this",
				tagNumber: 8,
				status: "active",
			},
		];
		const projection = projectMctxHistoryTags(
			[structuredClone(userMessage), structuredClone(userMessage)],
			[userEntry, duplicateEntry],
			tags,
		);
		expect(projection.messages[0]).toMatchObject({ content: "§7§ keep this" });
		expect(projection.messages[1]).toMatchObject({ content: "§8§ keep this" });
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

test("inserts temporal markers after history tags and remains idempotent", (): void => {
	const messages = [
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "prior" }],
			timestamp: 0,
		},
		{ role: "user" as const, content: "§7§ request", timestamp: 10 * 60 * 1_000 },
	];
	const projected = injectMctxTemporalMarkers(messages);
	expect(projected[1]).toMatchObject({ content: "§7§ <!-- +10m -->\nrequest" });
	expect(injectMctxTemporalMarkers(projected)).toBe(projected);
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
		toolName: "bash_status",
		content: [{ type: "text" as const, text: "result" }],
		isError: false,
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
