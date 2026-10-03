import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	MEMORY_COMPACTOR_SERVICE_KEY,
	provideService,
} from "@hheei/pi-ext-core";
import { describe, expect, test, vi } from "vitest";
import {
	is409SessionError,
	isGptModel,
	registerSessionRecoveryGuard,
	stripEncryptedThinking,
} from "../src/session-recovery-guard.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createTestHarness() {
	const handlers = new Map<string, EventHandler>();
	const pi = {
		events: {},
		on: vi.fn((event: string, handler: EventHandler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		}),
	} as unknown as ExtensionAPI;
	const guard = registerSessionRecoveryGuard(pi);
	return { handlers, pi, guard };
}

describe("session-recovery-guard", () => {
	test("error and model detection", () => {
		expect(
			is409SessionError(
				'(409): {"code":"request_rejected","message":"当前会话不可用，请新开会话。"}',
			),
		).toBe(true);
		expect(is409SessionError("Error: 409 Conflict")).toBe(true);
		expect(is409SessionError(undefined)).toBe(false);
		expect(is409SessionError("Rate limit 429")).toBe(false);

		expect(isGptModel({ id: "gpt-4o", provider: "openai" } as unknown as Model<Api>)).toBe(true);
		expect(
			isGptModel({
				id: "gpt-6.1-sol",
				provider: "cx",
				api: "openai-responses",
			} as unknown as Model<Api>),
		).toBe(true);
		expect(
			isGptModel({ id: "claude-3-7-sonnet", provider: "anthropic" } as unknown as Model<Api>),
		).toBe(false);
		expect(isGptModel(undefined)).toBe(false);
	});

	test("stripEncryptedThinking removes thinking blocks", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello" } as AgentMessage,
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "internal...", thinkingSignature: "rs_xyz" } as unknown as {
						type: "thinking";
					},
					{ type: "text", text: "answer" },
				],
			} as AssistantMessage,
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "only" } as unknown as { type: "thinking" }],
			} as AssistantMessage,
		];

		const stripped = stripEncryptedThinking(messages);
		expect(stripped[0]).toEqual(messages[0]);
		expect((stripped[1] as AssistantMessage).content).toEqual([{ type: "text", text: "answer" }]);
		expect((stripped[2] as AssistantMessage).content).toEqual([
			{ type: "text", text: "(thinking omitted)" },
		]);
	});

	test("compacts via pi-ext-memory when draft is available", async () => {
		const { handlers, pi, guard } = createTestHarness();
		provideService(
			{ pi, resources: { add: () => {} } } as unknown as ExtensionLifecycleContext,
			MEMORY_COMPACTOR_SERVICE_KEY,
			{
				createCompactionDraft: (firstKeptEntryId) => ({ summary: "## Summary", firstKeptEntryId }),
			},
		);

		const branch: SessionEntry[] = [
			{
				id: "e1",
				type: "message",
				message: { role: "user", content: "do task" },
			} as unknown as SessionEntry,
			{
				id: "e2",
				type: "message",
				message: { role: "assistant", stopReason: "error", errorMessage: "409 request_rejected" },
			} as unknown as SessionEntry,
		];

		const notify = vi.fn();
		const ctx = {
			model: { id: "gpt-6.1-sol", provider: "openai" },
			sessionManager: { getBranch: () => branch },
			ui: { notify },
		} as unknown as ExtensionContext;

		const result = await handlers.get("agent_before_settle")!({}, ctx);
		expect(result).toEqual({
			entries: [
				{ type: "compaction", summary: "## Summary", firstKeptEntryId: "e1" },
				{ type: "context_edit", targetId: "e2", replacement: null },
			],
			continue: true,
		});
		expect(guard.isThinkingStripped()).toBe(false);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("pi-ext-memory"), "info");
	});

	test("strips thinking and retries when compaction is unavailable", async () => {
		const { handlers, guard } = createTestHarness();
		const branch: SessionEntry[] = [
			{
				id: "e1",
				type: "message",
				message: { role: "user", content: "do task" },
			} as unknown as SessionEntry,
			{
				id: "e2",
				type: "message",
				message: { role: "assistant", stopReason: "error", errorMessage: "409 request_rejected" },
			} as unknown as SessionEntry,
		];

		const notify = vi.fn();
		const ctx = {
			model: { id: "gpt-6.1-sol", provider: "openai" },
			sessionManager: { getBranch: () => branch },
			ui: { notify },
		} as unknown as ExtensionContext;

		const result = await handlers.get("agent_before_settle")!({}, ctx);
		expect(result).toEqual({
			entries: [{ type: "context_edit", targetId: "e2", replacement: null }],
			continue: true,
		});
		expect(guard.isThinkingStripped()).toBe(true);

		// Subsequent context calls must strip thinking
		const contextResult = handlers.get("context")!(
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "secret", thinkingSignature: "rs_abc" },
							{ type: "text", text: "answer" },
						],
					},
				],
			},
			ctx,
		) as { messages: AssistantMessage[] };
		expect(contextResult.messages[0]?.content).toEqual([{ type: "text", text: "answer" }]);
	});
});
