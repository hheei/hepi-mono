import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { type BtwExecutionResult, executeBtwTurn } from "../../executor.js";

const model = { provider: "test", id: "model", api: "test" } as Model<Api>;
const messages = [{ role: "user", content: "hello", timestamp: 1 }] as Context["messages"];
const response = (
	stopReason: AssistantMessage["stopReason"],
	text = "answer",
): AssistantMessage => ({
	role: "assistant",
	content: text ? [{ type: "text", text }] : [],
	api: "test",
	provider: "test",
	model: "model",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason,
	timestamp: 1,
});

function errorMessage(result: BtwExecutionResult): string {
	if (result.status !== "error") throw new Error(`Expected an error result, got ${result.status}`);
	return result.message;
}

function registry(
	auth:
		| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string },
	configured = true,
) {
	return { hasConfiguredAuth: () => configured, getApiKeyAndHeaders: async () => auth } as never;
}

describe("BTW executor", () => {
	test("returns aborted before auth lookup", async () => {
		let lookedUp = false;
		const result = await executeBtwTurn({
			model,
			messages,
			signal: AbortSignal.abort(),
			modelRegistry: {
				hasConfiguredAuth: () => {
					lookedUp = true;
					return true;
				},
				getApiKeyAndHeaders: async () => {
					lookedUp = true;
					return { ok: false, error: "unexpected" };
				},
			} as never,
		});
		expect(result).toEqual({ status: "aborted" });
		expect(lookedUp).toBe(false);
	});

	test("handles missing auth and lookup failure", async () => {
		expect(
			(
				await executeBtwTurn({
					model,
					messages,
					signal: new AbortController().signal,
					modelRegistry: registry({ ok: true }, false),
				})
			).status,
		).toBe("error");
		expect(
			errorMessage(
				await executeBtwTurn({
					model,
					messages,
					signal: new AbortController().signal,
					modelRegistry: registry({ ok: false, error: "lookup failed" }),
				}),
			),
		).toBe("lookup failed");
	});

	test("passes prompt, empty tools, messages, signal, and auth to completion", async () => {
		let received: unknown;
		const controller = new AbortController();
		const result = await executeBtwTurn({
			model,
			messages,
			signal: controller.signal,
			modelRegistry: registry({
				ok: true,
				apiKey: "key",
				headers: { authorization: "h" },
				env: { TEST: "1" },
			}),
			complete: async (...args) => {
				received = args;
				return response("stop");
			},
		});
		expect(result.status).toBe("success");
		expect(received).toMatchObject([
			model,
			{ messages, tools: [] },
			{
				apiKey: "key",
				headers: { authorization: "h" },
				env: { TEST: "1" },
				signal: controller.signal,
			},
		]);
	});

	test.each([
		"aborted",
		"error",
		"length",
		"toolUse",
	] as const)("normalizes stop reason %s", async (stopReason) => {
		const result = await executeBtwTurn({
			model,
			messages,
			signal: new AbortController().signal,
			modelRegistry: registry({ ok: true }),
			complete: async () => response(stopReason),
		});
		expect(result.status).toBe(stopReason === "aborted" ? "aborted" : "error");
	});

	test("rejects empty text and normalizes throws, including abort", async () => {
		const base = {
			model,
			messages,
			signal: new AbortController().signal,
			modelRegistry: registry({ ok: true }),
		};
		expect(
			errorMessage(await executeBtwTurn({ ...base, complete: async () => response("stop", "") })),
		).toContain("empty");
		expect(
			errorMessage(
				await executeBtwTurn({
					...base,
					complete: async () => {
						throw new Error("boom");
					},
				}),
			),
		).toBe("boom");
		const controller = new AbortController();
		const result = await executeBtwTurn({
			...base,
			signal: controller.signal,
			complete: async () => {
				controller.abort();
				throw new Error("boom");
			},
		});
		expect(result).toEqual({ status: "aborted" });
	});
});
