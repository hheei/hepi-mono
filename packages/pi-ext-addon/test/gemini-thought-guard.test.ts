import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { isGeminiModel } from "../src/codemode-guard.js";
import {
	registerGeminiThoughtGuard,
	sanitizeGeminiThoughtSignatures,
} from "../src/gemini-thought-guard.js";

type EventHandler = (event: unknown, ctx?: ExtensionContext) => unknown;

function createTestHarness() {
	const handlers = new Map<string, EventHandler>();
	const pi = {
		on: vi.fn((event: string, handler: EventHandler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		}),
	} as unknown as ExtensionAPI;
	registerGeminiThoughtGuard(pi);
	return { handlers, pi };
}

describe("gemini-thought-guard", () => {
	test("isGeminiModel detects Google Generative AI APIs and IDs", () => {
		expect(isGeminiModel({ id: "gemini-3.8-flash", provider: "gm" })).toBe(true);
		expect(
			isGeminiModel({
				id: "custom-flash",
				provider: "custom",
				api: "google-generative-ai",
			}),
		).toBe(true);
		expect(
			isGeminiModel({
				id: "custom-vertex",
				provider: "custom",
				api: "google-vertex",
			}),
		).toBe(true);
		expect(isGeminiModel({ id: "claude-3-7-sonnet", provider: "anthropic" })).toBe(false);
	});

	test("leaves messages without thoughtSignature on toolCalls untouched", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "thinking here" },
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
			} as AgentMessage,
		];

		const sanitized = sanitizeGeminiThoughtSignatures(messages);
		expect(sanitized).toBe(messages);
	});

	test("moves thoughtSignature from toolCall to thinking block and cleans toolCalls", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "list files" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I will list the files" },
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: "sig-12345",
					},
					{
						type: "toolCall",
						id: "c2",
						name: "read",
						arguments: { path: "foo.txt" },
					},
				],
			} as AgentMessage,
		];

		const sanitized = sanitizeGeminiThoughtSignatures(messages);
		expect(sanitized).not.toBe(messages);

		const assistant = sanitized[1];
		expect(assistant?.role).toBe("assistant");
		const content = Array.isArray(assistant?.content) ? assistant.content : [];

		const thinking = content[0];
		expect(thinking?.type).toBe("thinking");
		if (thinking?.type === "thinking") {
			expect(thinking.thinkingSignature).toBe("sig-12345");
		}

		const toolCall1 = content[1];
		expect(toolCall1?.type).toBe("toolCall");
		if (toolCall1?.type === "toolCall") {
			expect("thoughtSignature" in toolCall1).toBe(false);
		}

		const toolCall2 = content[2];
		expect(toolCall2?.type).toBe("toolCall");
		if (toolCall2?.type === "toolCall") {
			expect("thoughtSignature" in toolCall2).toBe(false);
		}
	});

	test("preserves existing thinkingSignature without overwriting while cleaning toolCall", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "existing thought",
						thinkingSignature: "original-sig",
					},
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: "call-sig",
					},
				],
			} as AgentMessage,
		];

		const sanitized = sanitizeGeminiThoughtSignatures(messages);
		const content = Array.isArray(sanitized[0]?.content) ? sanitized[0].content : [];

		const thinking = content[0];
		if (thinking?.type === "thinking") {
			expect(thinking.thinkingSignature).toBe("original-sig");
		}

		const toolCall = content[1];
		if (toolCall?.type === "toolCall") {
			expect("thoughtSignature" in toolCall).toBe(false);
		}
	});

	test("strips thoughtSignature from toolCalls when no thinking block is present", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: "call-sig",
					},
				],
			} as AgentMessage,
		];

		const sanitized = sanitizeGeminiThoughtSignatures(messages);
		const content = Array.isArray(sanitized[0]?.content) ? sanitized[0].content : [];

		const toolCall = content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect("thoughtSignature" in toolCall).toBe(false);
		}
	});

	test("registerGeminiThoughtGuard intercepts context only for Gemini models", () => {
		const { handlers } = createTestHarness();
		const contextHandler = handlers.get("context");
		expect(contextHandler).toBeDefined();

		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: {},
						thoughtSignature: "sig",
					},
				],
			} as AgentMessage,
		];

		// Non-Gemini model (e.g. Claude) -> ignored
		const nonGeminiCtx = {
			model: { id: "claude-3-7-sonnet", provider: "anthropic" } as unknown as Model<Api>,
		} as ExtensionContext;
		const resNonGemini = contextHandler?.({ type: "context", messages }, nonGeminiCtx);
		expect(resNonGemini).toBeUndefined();

		// Gemini model -> intercepted & sanitized
		const geminiCtx = {
			model: { id: "gemini-3.8-flash", provider: "gm" } as unknown as Model<Api>,
		} as ExtensionContext;
		const resGemini = contextHandler?.({ type: "context", messages }, geminiCtx) as
			| { messages: AgentMessage[] }
			| undefined;
		expect(resGemini).toBeDefined();
		expect(resGemini?.messages).toHaveLength(1);
		const tool = Array.isArray(resGemini?.messages[0]?.content)
			? resGemini.messages[0].content[0]
			: undefined;
		expect("thoughtSignature" in (tool ?? {})).toBe(false);
	});
});
