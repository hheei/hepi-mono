import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	CODEMODE_REMINDER_CUSTOM_TYPE,
	createCodemodeGuard,
	DEFAULT_CODEMODE_BATCH_REMINDER,
	isGeminiModel,
} from "../src/codemode-guard.js";

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
		const sendMessage = vi.fn();
		const guard = createCodemodeGuard({ sendMessage });
		const event = makeEvent({
			toolName: "codemode",
			calls: [{ tool: "read" }],
			content: [{ type: "text", text: "result" }],
		});

		const res = guard.recordToolResult(event, claudeModel);
		expect(res).toBeUndefined();
		expect(guard.getConsecutiveCount()).toBe(0);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("ignores non-codemode tools", () => {
		const sendMessage = vi.fn();
		const guard = createCodemodeGuard({ sendMessage });
		const event = makeEvent({
			toolName: "bash",
			content: [{ type: "text", text: "output" }],
		});

		const res = guard.recordToolResult(event, geminiModel);
		expect(res).toBeUndefined();
		expect(guard.getConsecutiveCount()).toBe(0);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("ignores nested/sub-tool calls inside codemode", () => {
		const sendMessage = vi.fn();
		const guard = createCodemodeGuard({ sendMessage });
		const event = makeEvent({
			toolName: "codemode",
			parentToolCallId: "parent-123",
			calls: [],
			content: [{ type: "text", text: "nested output" }],
		});

		const res = guard.recordToolResult(event, geminiModel);
		expect(res).toBeUndefined();
		expect(guard.getConsecutiveCount()).toBe(0);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("never modifies tool result content and injects reminder via sendMessage after 4 single-tool calls", () => {
		const sendMessage = vi.fn();
		const guard = createCodemodeGuard({ sendMessage });

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
			expect(sendMessage).not.toHaveBeenCalled();
		}

		// Call 4: triggers reminder injection via sendMessage, tool result content remains undefined (untouched)
		const res4 = guard.recordToolResult(
			makeEvent({
				calls: [{ tool: "grep" }],
				content: [{ type: "text", text: "call 4 output" }],
			}),
			geminiModel,
		);

		expect(res4).toBeUndefined();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith(
			{
				customType: CODEMODE_REMINDER_CUSTOM_TYPE,
				content: DEFAULT_CODEMODE_BATCH_REMINDER,
				display: true,
			},
			{ deliverAs: "steer" },
		);
		expect(guard.hasTriggeredInCurrentLoop()).toBe(true);
		expect(guard.getConsecutiveCount()).toBe(0);
	});

	it("only triggers ONCE per human conversation loop, and resets on resetLoop()", () => {
		const sendMessage = vi.fn();
		const guard = createCodemodeGuard({ sendMessage });

		// Trigger on 4th call
		for (let i = 1; i <= 4; i++) {
			guard.recordToolResult(makeEvent({ calls: [{ tool: "read" }] }), geminiModel);
		}
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(guard.hasTriggeredInCurrentLoop()).toBe(true);

		// Another 4 single-tool calls in the same conversation loop: should NOT trigger again!
		for (let i = 1; i <= 4; i++) {
			guard.recordToolResult(makeEvent({ calls: [{ tool: "read" }] }), geminiModel);
		}
		expect(sendMessage).toHaveBeenCalledTimes(1);

		// Now a new human prompt/loop starts (before_agent_start or agent_settled)
		guard.resetLoop();
		expect(guard.hasTriggeredInCurrentLoop()).toBe(false);
		expect(guard.getConsecutiveCount()).toBe(0);

		// In this new loop, reaching 4 single-tool calls triggers again
		for (let i = 1; i <= 4; i++) {
			guard.recordToolResult(makeEvent({ calls: [{ tool: "read" }] }), geminiModel);
		}
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it("resets counter if codemode batches 2 or more tools", () => {
		const sendMessage = vi.fn();
		const guard = createCodemodeGuard({ sendMessage });

		for (let i = 1; i <= 3; i++) {
			guard.recordToolResult(makeEvent({ calls: [{ tool: "read" }] }), geminiModel);
		}
		expect(guard.getConsecutiveCount()).toBe(3);

		// Batched call
		guard.recordToolResult(makeEvent({ calls: [{ tool: "read" }, { tool: "grep" }] }), geminiModel);
		expect(guard.getConsecutiveCount()).toBe(0);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("supports custom threshold and reminder text", () => {
		const customReminder = "<custom-reminder>Batch your tools!</custom-reminder>";
		const sendMessage = vi.fn();
		const guard = createCodemodeGuard({
			threshold: 2,
			reminderText: customReminder,
			sendMessage,
		});

		guard.recordToolResult(makeEvent({ calls: [{ tool: "read" }] }), geminiModel);
		expect(guard.getConsecutiveCount()).toBe(1);

		guard.recordToolResult(makeEvent({ calls: [] }), geminiModel);

		expect(sendMessage).toHaveBeenCalledWith(
			{
				customType: CODEMODE_REMINDER_CUSTOM_TYPE,
				content: customReminder,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});
});
