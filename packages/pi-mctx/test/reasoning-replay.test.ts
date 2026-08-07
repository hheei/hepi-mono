import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { replayMctxReasoning } from "../src/reasoning-replay.js";

const assistant = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "private", thinkingSignature: "sig" },
		{ type: "text", text: "answer" },
	],
	timestamp: 0,
};
const entry = {
	id: "entry-1",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	type: "message",
	message: assistant,
} as unknown as SessionEntry;
const tag = {
	tagNumber: 1,
	kind: "message" as const,
	entryId: "entry-1",
	source: "answer",
	status: "active" as const,
};

test("execute clears old typed thinking and advances the watermark", (): void => {
	const result = replayMctxReasoning({
		messages: [assistant] as unknown as AgentMessage[],
		entries: [entry],
		tags: [tag],
		watermark: 0,
		clearReasoningAge: 0,
		execute: true,
	});
	expect(result.watermark).toBe(1);
	const first = result.messages[0];
	if (first === undefined || first.role !== "assistant")
		throw new Error("missing assistant message");
	expect(first.content[0]).toMatchObject({ type: "thinking", thinking: "" });
	expect(first.content[0]).not.toHaveProperty("thinkingSignature");
});

test("keeps reasoning inside the configured newest-tag window", (): void => {
	const newer = {
		...assistant,
		content: [{ type: "thinking" as const, thinking: "new", thinkingSignature: "new-sig" }],
	};
	const result = replayMctxReasoning({
		messages: [assistant, newer] as unknown as AgentMessage[],
		entries: [entry, { ...entry, id: "entry-2", message: newer } as unknown as SessionEntry],
		tags: [tag, { ...tag, tagNumber: 2, entryId: "entry-2" }],
		watermark: 0,
		clearReasoningAge: 1,
		execute: true,
	});
	expect(result.watermark).toBe(1);
	expect(result.messages[1]).toMatchObject(newer);
});

test("does not advance a watermark when no assistant thinking was cleared", (): void => {
	const user = { role: "user" as const, content: "prompt", timestamp: 0 };
	const userEntry = {
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "message",
		message: user,
	} as unknown as SessionEntry;
	expect(
		replayMctxReasoning({
			messages: [user] as AgentMessage[],
			entries: [userEntry],
			tags: [tag],
			watermark: 0,
			clearReasoningAge: 0,
			execute: true,
		}).watermark,
	).toBe(0);
});

test("replays inline thinking cleanup from the watermark", (): void => {
	const inline = {
		...assistant,
		content: [{ type: "text" as const, text: "<think>private</think> public" }],
	};
	const result = replayMctxReasoning({
		messages: [inline] as unknown as AgentMessage[],
		entries: [{ ...entry, message: inline } as unknown as SessionEntry],
		tags: [tag],
		watermark: 1,
		clearReasoningAge: 50,
		execute: false,
	});
	expect(result.messages[0]).toMatchObject({ content: [{ type: "text", text: "public" }] });
});

test("defer replays a persisted watermark without clearing redacted thinking", (): void => {
	const redacted = {
		...assistant,
		content: [{ type: "thinking" as const, thinking: "opaque", redacted: true }],
	};
	expect(
		replayMctxReasoning({
			messages: [redacted] as unknown as AgentMessage[],
			entries: [{ ...entry, message: redacted } as unknown as SessionEntry],
			tags: [tag],
			watermark: 1,
			clearReasoningAge: 50,
			execute: false,
		}).messages[0],
	).toMatchObject(redacted);
});

test("replays only the matching entry when assistant messages are identical", (): void => {
	const duplicate = structuredClone(assistant);
	const result = replayMctxReasoning({
		messages: [assistant, duplicate] as unknown as AgentMessage[],
		entries: [entry, { ...entry, id: "entry-2", message: duplicate } as unknown as SessionEntry],
		tags: [tag, { ...tag, tagNumber: 2, entryId: "entry-2" }],
		watermark: 1,
		clearReasoningAge: 1,
		execute: false,
	});
	const first = result.messages[0];
	if (first === undefined || first.role !== "assistant")
		throw new Error("missing assistant message");
	expect(first.content[0]).toMatchObject({ type: "thinking", thinking: "" });
	expect(result.messages[1]).toMatchObject(duplicate);
});
