import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMagicContextSubagentAccounting } from "../src/subagent-accounting.js";

type Listener = (event: unknown) => void;

interface Harness {
	readonly pi: ExtensionAPI;
	readonly emit: (event: string, data: unknown) => void;
	readonly start: (sessionId: string) => Promise<void>;
	readonly records: unknown[];
}

const previousMarker = process.env.MAGIC_CONTEXT_PI_SUBAGENT;

afterEach(() => {
	if (previousMarker === undefined) delete process.env.MAGIC_CONTEXT_PI_SUBAGENT;
	else process.env.MAGIC_CONTEXT_PI_SUBAGENT = previousMarker;
});

function createHarness(): Harness {
	const listeners = new Map<string, Listener[]>();
	const lifecycle = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const records: unknown[] = [];
	const pi = {
		events: {
			on: (event: string, listener: Listener) => {
				const registered = listeners.get(event) ?? [];
				registered.push(listener);
				listeners.set(event, registered);
			},
		},
		on: (event: string, listener: (event: unknown, ctx: unknown) => Promise<void>) => {
			lifecycle.set(event, listener);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		records,
		emit: (event, data) => {
			for (const listener of listeners.get(event) ?? []) listener(data);
		},
		start: async (sessionId) => {
			await lifecycle.get("session_start")?.(
				{},
				{ sessionManager: { getSessionId: () => sessionId } },
			);
		},
	};
}

describe("Magic Context subagent accounting", () => {
	test("records terminal metadata without retaining description or result", async () => {
		delete process.env.MAGIC_CONTEXT_PI_SUBAGENT;
		const harness = createHarness();
		registerMagicContextSubagentAccounting(harness.pi, (record) => {
			harness.records.push(record);
			return 1;
		});
		await harness.start("parent-session");

		harness.emit("subagents:started", { id: "child", type: "explorer", description: "private" });
		harness.emit("subagents:completed", {
			id: "child",
			type: "explorer",
			description: "private",
			result: "private result",
			status: "completed",
			durationMs: 10,
			tokens: { input: 12, output: 3, total: 15 },
		});

		expect(harness.records).toEqual([
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

	test("does not register in a child session", () => {
		process.env.MAGIC_CONTEXT_PI_SUBAGENT = "1";
		const harness = createHarness();
		registerMagicContextSubagentAccounting(harness.pi, () => {
			harness.records.push("unexpected");
			return 1;
		});
		harness.emit("subagents:completed", {
			id: "child",
			type: "explorer",
			status: "completed",
			durationMs: 0,
		});
		expect(harness.records).toEqual([]);
	});
});
