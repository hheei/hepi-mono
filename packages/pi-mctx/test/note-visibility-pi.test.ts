import { describe, expect, it } from "vitest";
import { hasVisibleNoteReadCallPi } from "../src/note-visibility-pi";

describe("hasVisibleNoteReadCallPi", () => {
	it("returns true when an assistant has a mctx_note(action='read') tool call", () => {
		const messages = [
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Reading notes..." },
					{
						type: "toolCall",
						id: "call_1",
						name: "mctx_note",
						arguments: { action: "read" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(true);
	});

	it("returns true for a registered mctx_note(action='read') tool call", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_mctx",
						name: "mctx_note",
						arguments: { action: "read" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(true);
	});

	it("returns false when mctx_note action is not 'read'", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "mctx_note",
						arguments: { action: "write", content: "save this" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});

	it("returns false when no mctx_note call is present", () => {
		const messages = [
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Hello" },
					{
						type: "toolCall",
						id: "call_1",
						name: "mctx_search",
						arguments: { query: "anything" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});

	it("returns true if any assistant in the array has a visible read", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_old",
						name: "mctx_note",
						arguments: { action: "read" },
					},
				],
			},
			{ role: "user", content: "follow-up" },
			{
				role: "assistant",
				content: [{ type: "text", text: "no tool here" }],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(true);
	});

	it("returns false for a sentinel-stripped mctx_note read", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "[dropped]" }],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});

	it("returns false on empty array", () => {
		expect(hasVisibleNoteReadCallPi([])).toBe(false);
	});

	it("ignores user messages even if they contain a toolCall-shaped object", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "toolCall",
						name: "mctx_note",
						arguments: { action: "read" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});
});
