import { describe, expect, it, vi } from "vitest";

import {
	sanitizeAssistantContent,
	sanitizeRetainedAssistantMessages,
} from "../src/session-ledger/sanitize-retained.js";
import type { Entry } from "../src/session-ledger/types.js";

describe("sanitizeAssistantContent", () => {
	it("returns unchanged text content when input is string", () => {
		const result = sanitizeAssistantContent("hello world");
		expect(result.modified).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
	});

	it("preserves normal thinking blocks without encrypted_content", () => {
		const input = [
			{
				type: "thinking",
				thinking: "Detailed normal reasoning from DeepSeek or Claude...",
			},
			{
				type: "text",
				text: "Here is the answer.",
			},
		];
		const result = sanitizeAssistantContent(input);
		expect(result.modified).toBe(false);
		expect(result.content).toEqual(input);
	});

	it("strips encrypted_content from thinkingSignature and extracts summary text", () => {
		const input = [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify({
					id: "rs_123",
					type: "reasoning",
					encrypted_content: "gAAAAABqvekZ_very_large_ciphertext...",
					summary: [{ type: "summary_text", text: "Evaluating user request" }],
				}),
			},
			{
				type: "text",
				text: "Here is the result.",
			},
		];
		const result = sanitizeAssistantContent(input);
		expect(result.modified).toBe(true);
		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: "Evaluating user request",
			},
			{
				type: "text",
				text: "Here is the result.",
			},
		]);
	});

	it("preserves thinking text and strips thinkingSignature containing encrypted_content object", () => {
		const input = [
			{
				type: "thinking",
				thinking: "Important reasoning text",
				thinkingSignature: {
					encrypted_content: "gAAAAABqvekZ...",
				},
			},
			{
				type: "text",
				text: "Answer text",
			},
		];
		const result = sanitizeAssistantContent(input);
		expect(result.modified).toBe(true);
		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: "Important reasoning text",
			},
			{
				type: "text",
				text: "Answer text",
			},
		]);
	});

	it("omits thinking block if it has no text and only pure encrypted_content", () => {
		const input = [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify({
					encrypted_content: "gAAAAABqvekZ...",
					summary: [],
				}),
			},
			{
				type: "text",
				text: "Final response only",
			},
		];
		const result = sanitizeAssistantContent(input);
		expect(result.modified).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Final response only",
			},
		]);
	});

	it("omits redacted thinking block with ciphertext", () => {
		const input = [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: "redacted_opaque_data",
				redacted: true,
			},
			{
				type: "text",
				text: "Clean text",
			},
		];
		const result = sanitizeAssistantContent(input);
		expect(result.modified).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Clean text",
			},
		]);
	});

	it("falls back to empty text block when message only contains pure ciphertext", () => {
		const input = [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify({
					encrypted_content: "gAAAAAB...",
				}),
			},
		];
		const result = sanitizeAssistantContent(input);
		expect(result.modified).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "",
			},
		]);
	});

	it("does not modify clean text and tool call without encrypted signatures", () => {
		const input = [
			{
				type: "text",
				text: "Clean response",
				textSignature: '{"phase":"final_answer"}',
			},
			{
				type: "toolCall",
				id: "call_2",
				name: "read",
				arguments: { path: "foo.txt" },
			},
		];
		const result = sanitizeAssistantContent(input);
		expect(result.modified).toBe(false);
		expect(result.content).toEqual(input);
	});
});

describe("sanitizeRetainedAssistantMessages", () => {
	it("only modifies assistant messages after firstKeptEntryId containing encrypted_content", () => {
		const appendContextEdit = vi.fn();
		const sessionManager = { appendContextEdit };

		const entries: Entry[] = [
			{
				id: "msg_old_encrypted",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "",
							thinkingSignature: JSON.stringify({ encrypted_content: "old_enc" }),
						},
						{ type: "text", text: "Old response" },
					],
				},
			},
			{
				id: "cut_point",
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "What is next?" }],
				},
			},
			{
				id: "msg_retained_normal_thinking",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Normal thinking to keep" },
						{ type: "text", text: "Normal response" },
					],
				},
			},
			{
				id: "msg_retained_encrypted",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Reasoning to keep",
							thinkingSignature: JSON.stringify({ encrypted_content: "retained_enc" }),
						},
						{ type: "text", text: "Retained response" },
					],
				},
			},
		];

		const result = sanitizeRetainedAssistantMessages(entries, "cut_point", sessionManager);

		expect(result.editCount).toBe(1);
		expect(appendContextEdit).toHaveBeenCalledTimes(1);
		expect(appendContextEdit).toHaveBeenCalledWith("msg_retained_encrypted", {
			content: [
				{ type: "thinking", thinking: "Reasoning to keep" },
				{ type: "text", text: "Retained response" },
			],
		});

		// The normal thinking message should NOT be modified
		const normalEntry = result.sanitizedEntries.find(
			(e) => e.id === "msg_retained_normal_thinking",
		);
		expect(normalEntry?.message).toEqual(entries[2]?.message);

		// The old message prior to firstKeptEntryId should NOT be modified
		const oldEntry = result.sanitizedEntries.find((e) => e.id === "msg_old_encrypted");
		expect(oldEntry?.message).toEqual(entries[0]?.message);
	});
});
