import type { AgentEvent, AgentMessage, agentLoop } from "@earendil-works/pi-agent-core";
import { type Api, type Context, EventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runObserver } from "../src/agents/observer/agent.js";
import { resolveWorkerStreamSimple, type WorkerStreamSimple } from "../src/agents/worker-stream.js";

const TEST_MODEL: Model<Api> = {
	id: "haiku",
	name: "Haiku",
	api: "cliproxyapi-codex-responses",
	provider: "cliproxyapi",
	baseUrl: "http://127.0.0.1:8317",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};
const TEST_CONTEXT: Context = { messages: [] };

describe("resolveWorkerStreamSimple", () => {
	it("prefers an explicit override", () => {
		const customStream = vi.fn() as unknown as WorkerStreamSimple;
		const override = vi.fn() as unknown as WorkerStreamSimple;
		expect(resolveWorkerStreamSimple({ streamSimple: customStream }, override)).toBe(override);
	});

	it("uses ModelRegistry.streamSimple", () => {
		const customStream = vi.fn() as unknown as WorkerStreamSimple;
		const resolved = resolveWorkerStreamSimple({ streamSimple: customStream });
		resolved(TEST_MODEL, TEST_CONTEXT);
		expect(customStream).toHaveBeenCalledWith(TEST_MODEL, TEST_CONTEXT, undefined);
	});

	it("calls a class-based registry streamSimple with its receiver", () => {
		const runtimeStream = vi.fn() as unknown as WorkerStreamSimple;
		class RegistryDouble {
			runtime = { streamSimple: runtimeStream };

			streamSimple(...args: Parameters<WorkerStreamSimple>): ReturnType<WorkerStreamSimple> {
				return this.runtime.streamSimple(...args);
			}
		}

		resolveWorkerStreamSimple(new RegistryDouble())(TEST_MODEL, TEST_CONTEXT);
		expect(runtimeStream).toHaveBeenCalledWith(TEST_MODEL, TEST_CONTEXT, undefined);
	});
});

describe("runObserver composed stream dispatch", () => {
	it("passes the composed handler into agentLoop instead of compat streamSimple", async () => {
		const composed = vi.fn() as unknown as WorkerStreamSimple;
		let received: WorkerStreamSimple | undefined;
		const loop: typeof agentLoop = (_prompts, _context, _config, _signal, streamFn) => {
			received = streamFn as WorkerStreamSimple;
			const stream = new EventStream<AgentEvent, AgentMessage[]>(
				() => true,
				() => [],
			);
			stream.end([]);
			return stream;
		};

		await runObserver({
			model: TEST_MODEL,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nhello",
			allowedSourceEntryIds: ["entry-a"],
			resolveTimestamp: () => "2026-05-02 10:30",
			agentLoop: loop,
			modelRegistry: {
				streamSimple: composed,
			},
		});

		expect(received).toBeTypeOf("function");
		received?.(TEST_MODEL, TEST_CONTEXT);
		expect(composed).toHaveBeenCalled();
	});
});
