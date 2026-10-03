import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createCodemodeGuard, isGeminiModel } from "../src/codemode-guard.js";

function makeEvent(options: {
	toolName?: string;
	parentToolCallId?: string;
	calls?: unknown[];
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
}): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: options.toolName ?? "codemode",
		...(options.parentToolCallId !== undefined
			? { parentToolCallId: options.parentToolCallId }
			: {}),
		details: { calls: options.calls ?? [{ tool: "read" }] },
		content: options.content ?? [{ type: "text", text: "ok" }],
		isError: false,
	} as unknown as ToolResultEvent;
}

describe("isGeminiModel", () => {
	it("identifies Gemini models correctly", () => {
		expect(isGeminiModel({ id: "gemini-2.5-pro", provider: "google" })).toBe(true);
		expect(isGeminiModel({ id: "gemini-1.5-flash", provider: "google" })).toBe(true);
		expect(isGeminiModel({ id: "google/gemini-2.5-pro", provider: "openrouter" })).toBe(true);
		expect(isGeminiModel({ id: "custom", name: "Gemini 2.5 Flash", provider: "custom" })).toBe(
			true,
		);
		expect(isGeminiModel({ id: "my-model", provider: "gemini" })).toBe(true);
		expect(isGeminiModel({ id: "my-model", api: "gemini" })).toBe(true);
		expect(isGeminiModel({ id: "some-model", provider: "google" })).toBe(true);
	});

	it("excludes non-Gemini models", () => {
		expect(isGeminiModel({ id: "gemma-4-31b-it", provider: "google" })).toBe(false);
		expect(isGeminiModel({ id: "deep-research-preview", provider: "google" })).toBe(false);
		expect(isGeminiModel({ id: "claude-3-7-sonnet", provider: "anthropic" })).toBe(false);
		expect(isGeminiModel({ id: "gpt-4o", provider: "openai" })).toBe(false);
		expect(isGeminiModel(undefined)).toBe(false);
		expect(isGeminiModel(null)).toBe(false);
		expect(isGeminiModel({})).toBe(false);
	});
});

describe("createCodemodeGuard", () => {
	const geminiModel = { id: "gemini-2.5-pro", provider: "google" };
	const claudeModel = { id: "claude-3-7-sonnet", provider: "anthropic" };

	it("ignores non-Gemini models and resets counter", () => {
		const guard = createCodemodeGuard();
		const event = makeEvent({
			toolName: "codemode",
			calls: [{ tool: "read" }],
			content: [{ type: "text", text: "result" }],
		});

		// Non-Gemini model
		const res = guard.recordToolResult(event, claudeModel);
		expect(res).toBeUndefined();
		expect(guard.getConsecutiveCount()).toBe(0);
	});

	it("ignores non-codemode tools", () => {
		const guard = createCodemodeGuard();
		const event = makeEvent({
			toolName: "bash",
			content: [{ type: "text", text: "output" }],
		});

		const res = guard.recordToolResult(event, geminiModel);
		expect(res).toBeUndefined();
		expect(guard.getConsecutiveCount()).toBe(0);
	});

	it("ignores nested/sub-tool calls inside codemode", () => {
		const guard = createCodemodeGuard();
		const event = makeEvent({
			toolName: "codemode",
			parentToolCallId: "parent-123",
			calls: [],
			content: [{ type: "text", text: "nested output" }],
		});

		const res = guard.recordToolResult(event, geminiModel);
		expect(res).toBeUndefined();
		expect(guard.getConsecutiveCount()).toBe(0);
	});

	it("triggers reminder after 4 consecutive single-tool codemode calls", () => {
		const guard = createCodemodeGuard();

		// Calls 1 to 3
		for (let i = 1; i <= 3; i++) {
			const res = guard.recordToolResult(
				makeEvent({
					calls: [{ tool: "read" }],
					content: [{ type: "text", text: `call ${i}` }],
				}),
				geminiModel,
			);
			expect(res).toBeUndefined();
			expect(guard.getConsecutiveCount()).toBe(i);
		}

		// Call 4: should trigger reminder!
		const res4 = guard.recordToolResult(
			makeEvent({
				calls: [{ tool: "grep" }],
				content: [{ type: "text", text: "call 4 output" }],
			}),
			geminiModel,
		);

		expect(res4).toBeDefined();
		expect(res4?.content).toHaveLength(1);
		expect((res4?.content?.[0] as { text: string })?.text).toContain("call 4 output");
		expect((res4?.content?.[0] as { text: string })?.text).toContain("<system-reminder>");
		expect((res4?.content?.[0] as { text: string })?.text).toContain(
			"Reminder: You have made 4 consecutive `codemode` calls that each executed only a single tool.",
		);

		// Counter should reset to 0 after firing
		expect(guard.getConsecutiveCount()).toBe(0);
	});

	it("resets counter if codemode batches 2 or more tools", () => {
		const guard = createCodemodeGuard();

		// 3 single-tool calls
		for (let i = 1; i <= 3; i++) {
			guard.recordToolResult(
				makeEvent({
					calls: [{ tool: "read" }],
					content: [{ type: "text", text: "ok" }],
				}),
				geminiModel,
			);
		}
		expect(guard.getConsecutiveCount()).toBe(3);

		// 4th call batches 2 tools!
		const batchedRes = guard.recordToolResult(
			makeEvent({
				calls: [{ tool: "read" }, { tool: "grep" }],
				content: [{ type: "text", text: "batched result" }],
			}),
			geminiModel,
		);

		expect(batchedRes).toBeUndefined();
		expect(guard.getConsecutiveCount()).toBe(0);

		// Next single tool call is count 1
		guard.recordToolResult(
			makeEvent({
				calls: [{ tool: "read" }],
				content: [{ type: "text", text: "ok" }],
			}),
			geminiModel,
		);
		expect(guard.getConsecutiveCount()).toBe(1);
	});

	it("supports custom threshold and reminder text", () => {
		const customReminder = "<custom-reminder>Batch your tools!</custom-reminder>";
		const guard = createCodemodeGuard({
			threshold: 2,
			reminderText: customReminder,
		});

		guard.recordToolResult(
			makeEvent({
				calls: [{ tool: "read" }],
				content: [{ type: "text", text: "1" }],
			}),
			geminiModel,
		);
		expect(guard.getConsecutiveCount()).toBe(1);

		const res = guard.recordToolResult(
			makeEvent({
				calls: [],
				content: [{ type: "text", text: "2" }],
			}),
			geminiModel,
		);

		expect(res).toBeDefined();
		expect((res?.content?.[0] as { text: string })?.text).toContain(customReminder);
		expect(guard.getConsecutiveCount()).toBe(0);
	});

	it("appends reminder as new text block if last block is not text", () => {
		const guard = createCodemodeGuard({ threshold: 1 });
		const res = guard.recordToolResult(
			makeEvent({
				calls: [{ tool: "read" }],
				content: [{ type: "image", data: "base64..." }],
			}),
			geminiModel,
		);

		expect(res?.content).toHaveLength(2);
		expect(res?.content?.[1]?.type).toBe("text");
		expect((res?.content?.[1] as { text: string })?.text).toContain("<system-reminder>");
	});
});
