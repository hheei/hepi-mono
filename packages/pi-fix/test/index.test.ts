import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyOpenAIResponsesCompat,
	createOpenAIResponsesCompatFeature,
	createOpenAIResponsesCompatSettingsProvider,
	normalizeAssistantMessageId,
	stripAssistantMessageStatus,
} from "../src/index.js";

const payload = {
	model: "gpt-test",
	input: [
		{ type: "message", role: "user", status: "completed", content: "hello" },
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "item_1897cee2cf04599211fdda0d",
			content: [{ type: "output_text", text: "answer", annotations: [] }],
		},
		{ type: "reasoning", status: "completed", id: "item_reasoning" },
		{ type: "function_call", status: "completed", call_id: "call_1" },
	],
};

describe("OpenAI Responses compatibility", () => {
	test("strips status only from assistant message input items without mutating payload", () => {
		const rewritten = stripAssistantMessageStatus(payload);

		expect(rewritten).not.toBe(payload);
		expect(rewritten).toEqual({
			...payload,
			input: [
				payload.input[0],
				{
					type: "message",
					role: "assistant",
					id: "item_1897cee2cf04599211fdda0d",
					content: [{ type: "output_text", text: "answer", annotations: [] }],
				},
				payload.input[2],
				payload.input[3],
			],
		});
		const originalAssistant = payload.input[1]!;
		expect(originalAssistant.status).toBe("completed");
	});

	test("normalizes only item-prefixed assistant message IDs", () => {
		const normalizedId = normalizeAssistantMessageId("item_1897cee2cf04599211fdda0d");
		expect(normalizedId).toMatch(/^msg_pi_[0-9a-f]{40}$/);
		expect(normalizeAssistantMessageId("item_1897cee2cf04599211fdda0d")).toBe(normalizedId);
		expect(normalizeAssistantMessageId("msg_existing")).toBe("msg_existing");

		const rewritten = applyOpenAIResponsesCompat(payload, {
			stripAssistantMessageStatus: true,
			normalizeAssistantMessageId: true,
		});
		expect(rewritten).toEqual({
			...payload,
			input: [
				payload.input[0],
				{
					type: "message",
					role: "assistant",
					id: normalizedId,
					content: [{ type: "output_text", text: "answer", annotations: [] }],
				},
				payload.input[2],
				payload.input[3],
			],
		});
		expect(payload.input[1]!.id).toBe("item_1897cee2cf04599211fdda0d");
		expect(payload.input[2]!.id).toBe("item_reasoning");
		expect(
			applyOpenAIResponsesCompat(rewritten, {
				stripAssistantMessageStatus: true,
				normalizeAssistantMessageId: true,
			}),
		).toBe(rewritten);
	});

	test("returns unrelated payloads unchanged", () => {
		const chatPayload = {
			model: "gpt-test",
			messages: [{ role: "assistant", status: "completed" }],
		};
		expect(stripAssistantMessageStatus(chatPayload)).toBe(chatPayload);
		expect(
			stripAssistantMessageStatus({ input: [{ type: "reasoning", status: "completed" }] }),
		).toEqual({
			input: [{ type: "reasoning", status: "completed" }],
		});
	});

	test("hook is disabled by default and applies after the persisted toggle is enabled", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-basics-responses-"));
		const handlers = new Map<string, (event: { payload: unknown }, context: unknown) => unknown>();
		const pi = {
			on(event: string, handler: (event: { payload: unknown }, context: unknown) => unknown) {
				handlers.set(event, handler);
			},
		};
		const feature = createOpenAIResponsesCompatFeature(pi as never);
		const context = {
			cwd,
			model: { api: "openai-responses" },
			sessionManager: { getSessionId: () => "session-1" },
		};
		await feature.start({ ctx: context as never });
		const hook = handlers.get("before_provider_request");
		if (!hook) throw new Error("Expected before_provider_request hook");

		expect(await hook({ payload }, context)).toBeUndefined();

		const provider = createOpenAIResponsesCompatSettingsProvider(feature);
		await provider.storage.save(
			{ "openai-responses-compat": { stripAssistantMessageStatus: true } },
			{ cwd, sessionId: "session-1" },
		);
		const rewritten = await hook({ payload }, context);
		expect(rewritten).not.toBeUndefined();
		expect(JSON.stringify(rewritten)).not.toContain('"id":"item_1897cee2cf04599211fdda0d"');
		expect(JSON.stringify(rewritten)).toMatch(/"id":"msg_pi_[0-9a-f]{40}"/);

		const saved = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(saved["pi-basics"]["openai-responses-compat"].stripAssistantMessageStatus).toBe(true);
		expect(saved["pi-basics"]["openai-responses-compat"].normalizeAssistantMessageId).toBe(true);
	});

	test("lazy-loads an enabled toggle after extension reload in an active session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-basics-responses-reload-"));
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				"pi-basics": {
					"openai-responses-compat": { stripAssistantMessageStatus: true },
				},
			}),
		);
		let hook: ((event: { payload: unknown }, context: unknown) => Promise<unknown>) | undefined;
		createOpenAIResponsesCompatFeature({
			on(event: string, handler: typeof hook) {
				if (event === "before_provider_request") hook = handler;
			},
		} as never);
		if (!hook) throw new Error("Expected before_provider_request hook");

		const rewritten = await hook(
			{ payload },
			{
				cwd,
				model: { api: "openai-responses" },
				sessionManager: { getSessionId: () => "already-active-session" },
			},
		);
		expect(rewritten).toEqual(
			applyOpenAIResponsesCompat(payload, {
				stripAssistantMessageStatus: true,
				normalizeAssistantMessageId: true,
			}),
		);
	});

	test("rejects invalid canonical and unknown group fields with paths", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-basics-responses-invalid-"));
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				"pi-basics": { "openai-responses-compat": { stripAssistantMessageStatus: "true" } },
			}),
		);
		const feature = createOpenAIResponsesCompatFeature({ on() {} } as never);
		const provider = createOpenAIResponsesCompatSettingsProvider(feature);
		const load = provider.storage.load;
		if (load === undefined) throw new Error("Expected settings loader");
		let invalidTypeError: unknown;
		try {
			await load({ cwd } as never);
		} catch (error) {
			invalidTypeError = error;
		}
		expect(String(invalidTypeError)).toContain(
			"pi-basics.openai-responses-compat.stripAssistantMessageStatus",
		);
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ "pi-basics": { "openai-responses-compat": { unexpected: false } } }),
		);
		let unknownFieldError: unknown;
		try {
			await load({ cwd } as never);
		} catch (error) {
			unknownFieldError = error;
		}
		expect(String(unknownFieldError)).toContain("pi-basics.openai-responses-compat.unexpected");
	});

	test("serializes concurrent saves without losing unrelated updates", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-basics-responses-concurrent-"));
		const feature = createOpenAIResponsesCompatFeature({ on() {} } as never);
		const provider = createOpenAIResponsesCompatSettingsProvider(feature);
		await Promise.all([
			provider.storage.save(
				{ "openai-responses-compat": { stripAssistantMessageStatus: true } },
				{ cwd, sessionId: "session-1" },
			),
			provider.storage.save(
				{ "openai-responses-compat": { normalizeAssistantMessageId: true } },
				{ cwd, sessionId: "session-2" },
			),
		]);
		const saved = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(saved["pi-basics"]["openai-responses-compat"]).toEqual({
			stripAssistantMessageStatus: true,
			normalizeAssistantMessageId: true,
		});
	});

	test("preserves unrelated project settings when saving", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-basics-responses-save-"));
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ theme: "dark", "pi-basics": { rtk: { enabled: true } } }),
		);
		const feature = createOpenAIResponsesCompatFeature({ on() {} } as never);
		const provider = createOpenAIResponsesCompatSettingsProvider(feature);
		await provider.storage.save(
			{ "openai-responses-compat": { stripAssistantMessageStatus: true } },
			{ cwd, sessionId: "session-1" },
		);

		const saved = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(saved.theme).toBe("dark");
		expect(saved["pi-basics"].rtk).toEqual({ enabled: true });
	});
});
