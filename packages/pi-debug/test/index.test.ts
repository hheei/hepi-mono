import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	comparePayloadSnapshots,
	createDebugSettingsProvider,
	DEBUG_GUIDE_URL,
	registerCacheDebug,
	requestLogSnapshot,
	snapshotProviderPayload,
} from "../src/index.js";

const basePayload = {
	model: "gpt-test",
	prompt_cache_key: "session-secret-key",
	tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
	input: [
		{ role: "developer", content: "system secret" },
		{ role: "user", content: "<project-memory>m0 secret</project-memory>" },
		{ role: "user", content: "<session-history>m1 secret</session-history>" },
		{ role: "user", content: "conversation secret" },
	],
};

describe("provider payload probe", () => {
	test("hashes logical cache modules without retaining prompt text", () => {
		const snapshot = snapshotProviderPayload(basePayload);
		const logged = requestLogSnapshot(snapshot);

		expect(snapshot.inputKey).toBe("input");
		expect(snapshot.items).toHaveLength(4);
		expect(snapshot.modules.map((module) => module.name)).toEqual([
			"envelope",
			"tools",
			"system",
			"magic-context:m0",
			"magic-context:m1",
			"conversation",
		]);
		expect(JSON.stringify(logged)).not.toContain("secret");
		expect(snapshot.modules.find((module) => module.name === "magic-context:m1")?.startIndex).toBe(
			2,
		);
	});

	test("distinguishes append-only growth from an old-prefix mutation", () => {
		const first = snapshotProviderPayload(basePayload);
		const appended = snapshotProviderPayload({
			...basePayload,
			input: [...basePayload.input, { role: "assistant", content: "new suffix" }],
		});
		const appendComparison = comparePayloadSnapshots(first, appended);
		expect(appendComparison.appendOnly).toBe(true);
		expect(appendComparison.commonPrefixItems).toBe(4);
		expect(appendComparison.firstChangedItem?.index).toBe(4);

		const mutated = snapshotProviderPayload({
			...basePayload,
			input: basePayload.input.map((item, index) =>
				index === 2 ? { ...item, content: "<session-history>changed</session-history>" } : item,
			),
		});
		const mutationComparison = comparePayloadSnapshots(first, mutated);
		expect(mutationComparison.appendOnly).toBe(false);
		expect(mutationComparison.commonPrefixItems).toBe(2);
		expect(mutationComparison.firstChangedItem?.index).toBe(2);
		expect(mutationComparison.changedModules).toContain("magic-context:m1");
	});
});

describe("debug extension", () => {
	test("loads cache diagnostics as disabled unless settings enable it", async () => {
		const changes: Array<{ readonly sessionId: string; readonly enabled: boolean }> = [];
		const provider = createDebugSettingsProvider((sessionId, enabled) => {
			changes.push({ sessionId, enabled });
		});
		await provider.onLoad?.({}, { sessionId: "session-1" });
		await provider.onLoad?.({ cache: { enabled: true } }, { sessionId: "session-1" });
		expect(changes).toEqual([
			{ sessionId: "session-1", enabled: false },
			{ sessionId: "session-1", enabled: true },
		]);
	});

	test("does not write provider diagnostics while disabled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-debug-test-"));
		const logPath = join(directory, "requests.jsonl");
		const handlers = new Map<
			string,
			(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown
		>();
		const pi = {
			on(
				event: string,
				handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
			) {
				handlers.set(event, handler);
			},
			registerCommand() {},
		};
		registerCacheDebug(pi as never, { logPath, isEnabled: () => false });
		const ctx = {
			sessionManager: { getSessionId: () => "session-1" },
			ui: { notify() {} },
		};
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await handlers.get("before_provider_request")?.({ payload: basePayload }, ctx);
		await expect(access(logPath)).rejects.toThrow();
	});

	test("correlates request hashes with provider usage in JSONL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-debug-test-"));
		const logPath = join(directory, "requests.jsonl");
		const handlers = new Map<
			string,
			(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown
		>();
		const commands = new Map<
			string,
			{
				handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
			}
		>();
		const notifications: string[] = [];
		const pi = {
			on(
				event: string,
				handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
			) {
				handlers.set(event, handler);
			},
			registerCommand(
				name: string,
				command: {
					handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
				},
			) {
				commands.set(name, command);
			},
		};
		registerCacheDebug(pi as never, { logPath });

		const ctx = {
			model: { provider: "cx", id: "gpt-test", api: "openai-responses" },
			sessionManager: { getSessionId: () => "session-1" },
			ui: { notify: (message: string) => notifications.push(message) },
		};
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await handlers.get("before_provider_request")?.({ payload: basePayload }, ctx);
		await handlers.get("after_provider_response")?.({ status: 200, headers: {} }, ctx);
		await handlers.get("message_end")?.(
			{
				message: {
					role: "assistant",
					stopReason: "stop",
					usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 20 },
				},
			},
			ctx,
		);

		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.type)).toEqual([
			"session",
			"request",
			"http-response",
			"usage",
		]);
		expect(records[0]?.debugGuide).toBe(DEBUG_GUIDE_URL);
		expect(records[1]?.request).toBe(1);
		expect(records[3]?.request).toBe(1);
		expect(JSON.stringify(records)).not.toContain("system secret");
		expect(records[3]?.usage).toEqual({
			input: 10,
			output: 2,
			cacheRead: 100,
			cacheWrite: 20,
		});

		await commands.get("cache-debug")?.handler("", ctx);
		expect(notifications.at(-1)).toBe(`Log: ${logPath}\nGuide: ${DEBUG_GUIDE_URL}`);
	});
});
