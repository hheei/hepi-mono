import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiRuntimeBridges } from "./pi-runtime-bridges";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type EventListener = (event: unknown) => void;

interface Harness {
	readonly pi: ExtensionAPI;
	readonly emit: (event: string, data: unknown) => void;
	readonly invoke: (event: string, data: unknown) => Promise<unknown>;
	readonly start: (sessionId: string) => Promise<void>;
	readonly shutdown: (sessionId: string) => Promise<void>;
}

const previousMarker = process.env.MAGIC_CONTEXT_PI_SUBAGENT;

afterEach(() => {
	if (previousMarker === undefined) delete process.env.MAGIC_CONTEXT_PI_SUBAGENT;
	else process.env.MAGIC_CONTEXT_PI_SUBAGENT = previousMarker;
});

function createHarness(): Harness {
	const eventListeners = new Map<string, EventListener[]>();
	const handlers = new Map<string, Handler[]>();
	let sessionId = "";
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
	};
	const pi = {
		events: {
			on: (event: string, listener: EventListener) => {
				const registered = eventListeners.get(event) ?? [];
				registered.push(listener);
				eventListeners.set(event, registered);
			},
		},
		on: (event: string, listener: Handler) => {
				const registered = handlers.get(event) ?? [];
				registered.push(listener);
				handlers.set(event, registered);
			},
	} as unknown as ExtensionAPI;

	const setSession = (nextSessionId: string): void => {
		sessionId = nextSessionId;
	};
	return {
		pi,
		emit: (event, data) => {
			for (const listener of eventListeners.get(event) ?? []) listener(data);
		},
		invoke: async (event, data) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(data, ctx);
			}
			return result;
		},
		start: async (nextSessionId) => {
			setSession(nextSessionId);
			await Promise.all(
				(handlers.get("session_start") ?? []).map((handler) => handler({}, ctx)),
			);
		},
		shutdown: async (nextSessionId) => {
			setSession(nextSessionId);
			await Promise.all(
				(handlers.get("session_shutdown") ?? []).map((handler) => handler({}, ctx)),
			);
		},
	};
}

describe("Pi runtime bridges", () => {
	test("strips reminders from tool results and re-injects them into context", async () => {
		const harness = createHarness();
		registerPiRuntimeBridges(harness.pi, () => 1);
		await harness.start("parent-session");

		const reminder = {
			type: "text",
			text: "<system-reminder>There are 100 tokens of unreduced tool output. Use ctx_reduce.</system-reminder>",
		};
		const result = await harness.invoke("tool_result", {
			content: [{ type: "text", text: "tool output" }, reminder],
		});
		expect(result).toEqual({ content: [{ type: "text", text: "tool output" }] });

		const contextResult = await harness.invoke("context", { messages: [] });
		expect(contextResult).toMatchObject({
			messages: [
				{
					customType: "magic-context-context-reminder",
					content: reminder.text,
					display: false,
				},
			],
		});
	});

	test("clears pending reminders on session shutdown", async () => {
		const harness = createHarness();
		registerPiRuntimeBridges(harness.pi, () => 1);
		await harness.start("parent-session");
		await harness.invoke("tool_result", {
			content: [
				{
					type: "text",
					text: "<system-reminder>Use ctx_reduce for tokens of tool output you have not reduced.</system-reminder>",
				},
			],
		});
		await harness.shutdown("parent-session");
		await expect(harness.invoke("context", { messages: [] })).resolves.toBeUndefined();
	});

	test("records subagent terminal metadata without retaining output", async () => {
		const harness = createHarness();
		const records: unknown[] = [];
		registerPiRuntimeBridges(harness.pi, (record) => {
			records.push(record);
			return 1;
		});
		await harness.start("parent-session");
		harness.emit("subagents:started", { id: "child" });
		harness.emit("subagents:completed", {
			id: "child",
			type: "explorer",
			description: "private",
			result: "private result",
			status: "completed",
			durationMs: 10,
			tokens: { input: 12, output: 3 },
		});

		expect(records).toEqual([
			{
				parentSessionId: "parent-session",
				type: "explorer",
				startedAt: expect.any(Number),
				endedAt: expect.any(Number),
				status: "completed",
				inputTokens: 12,
				outputTokens: 3,
			},
		]);
	});

	test("does not register subagent accounting in a child session", async () => {
		process.env.MAGIC_CONTEXT_PI_SUBAGENT = "1";
		const harness = createHarness();
		const records: unknown[] = [];
		registerPiRuntimeBridges(harness.pi, (record) => {
			records.push(record);
			return 1;
		});
		await harness.start("child-session");
		harness.emit("subagents:completed", {
			id: "child",
			type: "explorer",
			status: "completed",
			durationMs: 0,
		});
		expect(records).toEqual([]);
	});
});
