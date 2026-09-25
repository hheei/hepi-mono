import { describe, expect, it, vi } from "vitest";
import { runObserver } from "../src/agents/observer/agent.js";
import { resolveWorkerStreamSimple, type WorkerStreamSimple } from "../src/agents/worker-stream.js";

const customStream = vi.fn() as unknown as WorkerStreamSimple;

describe("resolveWorkerStreamSimple", () => {
	it("prefers an explicit override", () => {
		const override = vi.fn() as unknown as WorkerStreamSimple;
		expect(resolveWorkerStreamSimple({ streamSimple: customStream }, override)).toBe(override);
	});

	it("uses ModelRegistry.streamSimple", () => {
		const registry = { streamSimple: customStream };
		const resolved = resolveWorkerStreamSimple(registry);
		const model = {} as any;
		const context = {} as any;
		resolved(model, context);
		expect(customStream).toHaveBeenCalledWith(model, context, undefined);
	});

	it("calls a class-based registry streamSimple with its receiver", () => {
		const runtimeStream = vi.fn() as unknown as WorkerStreamSimple;
		class RegistryDouble {
			runtime = { streamSimple: runtimeStream };

			streamSimple(model: any, context: any, options?: any) {
				return this.runtime.streamSimple(model, context, options);
			}
		}

		const registry = new RegistryDouble();
		const model = {} as any;
		const context = {} as any;

		resolveWorkerStreamSimple(registry as any)(model, context);
		expect(runtimeStream).toHaveBeenCalledWith(model, context, undefined);
	});
});

describe("runObserver composed stream dispatch", () => {
	it("passes the composed handler into agentLoop instead of compat streamSimple", async () => {
		const composed = vi.fn() as unknown as WorkerStreamSimple;
		let received: unknown;
		const loop = ((
			prompts: any[],
			context: any,
			config: any,
			_signal: unknown,
			streamFn: unknown,
		) => {
			received = streamFn;
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => ({}),
			};
		}) as any;

		await runObserver({
			model: { api: "cliproxyapi-codex-responses", provider: "cliproxyapi", id: "haiku" } as any,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nhello",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop: loop,
			modelRegistry: {
				streamSimple: composed,
			},
		});

		expect(received).toBeTypeOf("function");
		received?.({} as any, {} as any);
		expect(composed).toHaveBeenCalled();
	});
});
