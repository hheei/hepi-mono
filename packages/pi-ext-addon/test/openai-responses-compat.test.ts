import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
	test("strips status from replayed assistant and reasoning input items without mutating payload", () => {
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
				{ type: "reasoning", id: "item_reasoning" },
				payload.input[3],
			],
		});
		expect(payload.input[1].status).toBe("completed");
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
				{ type: "reasoning", id: "item_reasoning" },
				payload.input[3],
			],
		});
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
			input: [{ type: "reasoning" }],
		});
	});

	test("reads only the addon settings section", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ext-addon-responses-"));
		await writeFile(
			join(cwd, "settings.json"),
			JSON.stringify({
				"pi-basics": { "openai-responses-compat": { stripAssistantMessageStatus: true } },
				"pi-ext-addon": { "openai-responses-compat": { stripAssistantMessageStatus: true } },
			}),
		);
		let hook: ((event: { payload: unknown }, context: unknown) => Promise<unknown>) | undefined;
		createOpenAIResponsesCompatFeature(
			{
				on(event: string, handler: typeof hook) {
					if (event === "before_provider_request") hook = handler;
				},
			} as never,
			{ settingsFilePath: join(cwd, "settings.json") },
		);
		if (hook === undefined) throw new Error("Expected before_provider_request hook");
		expect(
			await hook(
				{ payload },
				{ model: { api: "openai-responses" }, sessionManager: { getSessionId: () => "session-1" } },
			),
		).toEqual(
			applyOpenAIResponsesCompat(payload, {
				stripAssistantMessageStatus: true,
				normalizeAssistantMessageId: true,
			}),
		);
	});

	test("saves only the addon settings section", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ext-addon-responses-save-"));
		const settingsFilePath = join(cwd, "settings.json");
		await writeFile(
			settingsFilePath,
			JSON.stringify({ theme: "dark", "pi-basics": { rtk: { enabled: true } } }),
		);
		const provider = createOpenAIResponsesCompatSettingsProvider({ settingsFilePath });
		await provider.storage.save(
			{ "openai-responses-compat": { stripAssistantMessageStatus: true } },
			{ cwd, sessionId: "session-1" },
		);
		const saved: unknown = JSON.parse(await readFile(settingsFilePath, "utf8"));
		expect(saved).toEqual({
			theme: "dark",
			"pi-basics": { rtk: { enabled: true } },
			"pi-ext-addon": {
				"openai-responses-compat": {
					stripAssistantMessageStatus: true,
					normalizeAssistantMessageId: true,
				},
			},
		});
	});

	test("rejects invalid addon settings fields with paths", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ext-addon-responses-invalid-"));
		const settingsFilePath = join(cwd, "settings.json");
		await writeFile(
			settingsFilePath,
			JSON.stringify({ "pi-ext-addon": { "openai-responses-compat": { unexpected: false } } }),
		);
		const provider = createOpenAIResponsesCompatSettingsProvider({ settingsFilePath });
		const load = provider.storage.load;
		if (load === undefined) throw new Error("Expected settings loader");
		await expect(load({ cwd } as never)).rejects.toThrow(
			"pi-ext-addon.openai-responses-compat.unexpected",
		);
	});
});
