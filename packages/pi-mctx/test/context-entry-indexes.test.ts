import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextIndexesByEntryId } from "../src/context-entry-indexes.js";

const first = { role: "user" as const, content: "first", timestamp: 1 };
const omitted = {
	role: "assistant" as const,
	content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }],
	timestamp: 2,
};
const tail = {
	role: "toolResult" as const,
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text" as const, text: "tail" }],
	isError: false,
	timestamp: 3,
};
const entries = [
	{ type: "message", id: "first", parentId: null, timestamp: "", message: first },
	{ type: "message", id: "omitted", parentId: "first", timestamp: "", message: omitted },
	{ type: "message", id: "tail", parentId: "omitted", timestamp: "", message: tail },
] as SessionEntry[];

test("maps a live tail after injected MCTX context and omitted tool calls", (): void => {
	const indexes = contextIndexesByEntryId(
		[
			first,
			{
				role: "custom",
				customType: "pi-mctx:m0",
				content: "compact",
				display: false,
				timestamp: 0,
			},
			tail,
		],
		entries,
	);
	expect(indexes).toEqual(
		new Map([
			["first", 0],
			["tail", 2],
		]),
	);
});
