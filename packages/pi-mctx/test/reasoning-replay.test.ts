import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { replayMctxReasoning } from "../src/reasoning-replay.js";

const assistant: AgentMessage = {
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
	type: "message",
	message: assistant,
} as SessionEntry;
const tag = {
	tagNumber: 1,
	kind: "message" as const,
	entryId: "entry-1",
	source: "answer",
	status: "active" as const,
};

test("execute clears old typed thinking and advances the watermark", (): void => {
	const result = replayMctxReasoning({
		messages: [assistant],
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

test("does not advance a watermark when no assistant thinking was cleared", (): void => {
	const user = { role: "user" as const, content: "prompt", timestamp: 0 };
	const userEntry = {
		id: "entry-1",
		parentId: null,
		type: "message",
		message: user,
	} as SessionEntry;
	expect(
		replayMctxReasoning({
			messages: [user],
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
		messages: [inline],
		entries: [{ ...entry, message: inline }],
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
			messages: [redacted],
			entries: [{ ...entry, message: redacted }],
			tags: [tag],
			watermark: 1,
			clearReasoningAge: 50,
			execute: false,
		}).messages[0],
	).toEqual(redacted);
});
