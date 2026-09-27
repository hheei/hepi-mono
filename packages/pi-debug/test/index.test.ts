import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
		{ role: "user", content: "first turn secret" },
		{ role: "user", content: "second turn secret" },
		{ role: "user", content: "third turn secret" },
	],
};

type DebugHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
type DebugCommand = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };

function debugHost(): {
	readonly handlers: Map<string, DebugHandler>;
	readonly commands: Map<string, DebugCommand>;
	readonly pi: {
		on(event: string, handler: DebugHandler): void;
		registerCommand(name: string, command: DebugCommand): void;
	};
} {
	const handlers = new Map<string, DebugHandler>();
	const commands = new Map<string, DebugCommand>();
	const pi = {
		on(event: string, handler: DebugHandler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: DebugCommand) {
			commands.set(name, command);
		},
	};
	return { handlers, commands, pi };
}

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
			"conversation",
		]);
		expect(JSON.stringify(logged)).not.toContain("secret");
		const conversation = snapshot.modules.find((module) => module.name === "conversation");
		expect(conversation?.itemCount).toBe(3);
		expect(conversation?.startIndex).toBe(1);
		expect(conversation?.endIndex).toBe(3);
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
				index === 2 ? { ...item, content: "changed turn" } : item,
			),
		});
		const mutationComparison = comparePayloadSnapshots(first, mutated);
		expect(mutationComparison.appendOnly).toBe(false);
		expect(mutationComparison.commonPrefixItems).toBe(2);
		expect(mutationComparison.firstChangedItem?.index).toBe(2);
		expect(mutationComparison.changedModules).toContain("conversation");
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
		const { handlers, pi } = debugHost();
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
		const notifications: string[] = [];
		const { handlers, commands, pi } = debugHost();
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
