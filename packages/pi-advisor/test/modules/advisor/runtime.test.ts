import { describe, expect, test } from "bun:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADVISOR_SYSTEM_PROMPT } from "../../../src/prompt.js";
import { type AdvisorAdapterOptions, createCoreAdvisorAdapter } from "../../../src/runtime.js";

const model = {
	api: "openai-completions",
	id: "fake",
	name: "fake",
	provider: "fake",
	baseUrl: "http://fake.invalid",
	contextWindow: 4096,
	maxTokens: 512,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<Api>;

function message(
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"] = [],
	usage: { input: number; output: number; totalTokens: number; cost: number } = {
		input: 0,
		output: 0,
		totalTokens: 0,
		cost: 0,
	},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage.totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
		},
		stopReason,
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function streamScript(messages: readonly AssistantMessage[]): {
	streamFn: StreamFn;
	calls: () => number;
} {
	let index = 0;
	return {
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			const current = messages[Math.min(index++, messages.length - 1)];
			if (current === undefined) throw new Error("missing fake stream message");
			if (current.stopReason === "error" || current.stopReason === "aborted")
				stream.push({ type: "error", reason: current.stopReason, error: current });
			else stream.push({ type: "done", reason: current.stopReason, message: current });
			return stream;
		},
		calls: () => index,
	};
}

function controllableScheduler(): {
	scheduler: NonNullable<AdvisorAdapterOptions["scheduler"]>;
	delays: number[];
	fire(): void;
} {
	let callback: (() => void) | undefined;
	const delays: number[] = [];
	const timer = {};
	return {
		scheduler: {
			setTimeout(next, delay) {
				callback = next;
				delays.push(delay);
				return timer;
			},
			clearTimeout() {},
		},
		delays,
		fire() {
			callback?.();
		},
	};
}

function options(
	streamFn: StreamFn,
	scheduler?: AdvisorAdapterOptions["scheduler"],
	config: {
		sessionId?: string;
		bootstrap?: readonly unknown[];
		sessionManager?: { buildSessionContext: () => { messages: readonly unknown[] } };
		modelRegistry?: AdvisorAdapterOptions["ctx"]["modelRegistry"];
	} = {},
): AdvisorAdapterOptions {
	const sessionManager = {
		getSessionId: () => config.sessionId ?? "primary",
		...(config.sessionManager ?? {
			buildSessionContext: () => ({ messages: config.bootstrap ?? [] }),
		}),
	};
	return {
		ctx: {
			cwd: "/tmp",
			model,
			modelRegistry: config.modelRegistry ?? {
				find: (provider: string, id: string) =>
					provider === model.provider && id === model.id ? model : undefined,
				hasConfiguredAuth: () => true,
				getApiKeyForProvider: () => undefined,
			},
			sessionManager,
		} as unknown as ExtensionContext,
		model: "fake/fake",
		thinking: "off",
		streamFn,
		...(scheduler === undefined ? {} : { scheduler }),
	};
}

const adviseCall = {
	type: "toolCall" as const,
	id: "call-1",
	name: "advise",
	arguments: { severity: "blocker", note: "partial" },
};

describe("advisor runtime outcomes", () => {
	test("context budget uses configured Advisor model, with response reserve capped", async () => {
		const primary = { ...model, id: "primary", contextWindow: 2222, maxTokens: 111 } as Model<Api>;
		const configured = {
			...model,
			id: "configured",
			contextWindow: 12000,
			maxTokens: 7000,
		} as Model<Api>;
		const base = options(streamScript([message("stop")]).streamFn);
		const ctx = {
			...base.ctx,
			model: primary,
			modelRegistry: {
				...base.ctx.modelRegistry,
				find: (_provider: string, id: string) => (id === "configured" ? configured : undefined),
			},
		};
		const adapter = createCoreAdvisorAdapter({
			...base,
			ctx,
			model: "fake/configured",
		} as unknown as AdvisorAdapterOptions);
		await adapter.create();
		expect(adapter.contextBudget()).toEqual({ contextWindow: 12000, responseReserve: 4096 });

		const smaller = { ...configured, maxTokens: 300 } as Model<Api>;
		const smallAdapter = createCoreAdvisorAdapter({
			...base,
			ctx: { ...ctx, modelRegistry: { ...ctx.modelRegistry, find: () => smaller } },
			model: "fake/configured",
		} as unknown as AdvisorAdapterOptions);
		await smallAdapter.create();
		expect(smallAdapter.contextBudget().responseReserve).toBe(300);
	});
	test("uses the formal fixed system prompt", async () => {
		let systemPrompt: unknown;
		const scripted = streamScript([message("stop")]);
		const adapter = createCoreAdvisorAdapter(
			options((_model, context) => {
				systemPrompt = context.systemPrompt;
				return scripted.streamFn(_model, context, undefined);
			}),
		);
		await adapter.create();
		await adapter.review("review");
		expect(systemPrompt).toBe(ADVISOR_SYSTEM_PROMPT);
	});

	test("exposes only the Advisor tool allowlist", async () => {
		let toolNames: readonly string[] = [];
		const scripted = streamScript([message("stop")]);
		const adapter = createCoreAdvisorAdapter(
			options((_model, context, streamOptions) => {
				toolNames = (context.tools ?? []).map((tool) => tool.name);
				return scripted.streamFn(_model, context, streamOptions);
			}),
		);
		await adapter.create();
		await adapter.review("review");
		expect(toolNames).toEqual(["advise", "read", "grep", "find", "ls"]);
		expect(toolNames).not.toContain("bash");
		expect(toolNames).not.toContain("edit");
		expect(toolNames).not.toContain("write");
	});

	test("keeps an append-only provider prefix across reviews", async () => {
		const contexts: Array<{ readonly messages: readonly unknown[] }> = [];
		const bootstrap = [{ role: "user", content: [{ type: "text", text: "bootstrap" }] }];
		const scripted = streamScript([
			message("stop", [{ type: "text", text: "first response" } as never]),
			message("stop", [{ type: "text", text: "second response" } as never]),
		]);
		const adapter = createCoreAdvisorAdapter(
			options(
				(modelArg, context, streamOptions) => {
					contexts.push(structuredClone({ messages: context.messages }));
					return scripted.streamFn(modelArg, context, streamOptions);
				},
				undefined,
				{ bootstrap },
			),
		);
		await adapter.create();
		await adapter.review("first delta");
		await adapter.review("second delta");
		const first = contexts[0]?.messages;
		const second = contexts[1]?.messages;
		expect(first).toBeDefined();
		expect(second?.slice(0, first?.length ?? 0)).toEqual(
			first === undefined ? undefined : [...first],
		);
		expect(second?.slice(first?.length ?? 0)).toHaveLength(2);
		expect(
			second?.slice(first?.length ?? 0).map((item) => (item as { role: string }).role),
		).toEqual(["assistant", "user"]);
		expect(second?.filter((item) => (item as { role: string }).role === "system")).toHaveLength(0);
		expect(contexts[0]?.messages.slice(0, 1)).toEqual(contexts[1]?.messages.slice(0, 1));
	});

	test("keeps a stable Advisor session id within a primary session", async () => {
		const sessionIds: unknown[] = [];
		const scripted = streamScript([message("stop"), message("stop"), message("stop")]);
		const streamFn: StreamFn = (modelArg, context, streamOptions) => {
			sessionIds.push(streamOptions?.sessionId);
			return scripted.streamFn(modelArg, context, streamOptions);
		};
		const adapter = createCoreAdvisorAdapter(
			options(streamFn, undefined, { sessionId: "primary" }),
		);
		await adapter.create();
		await adapter.review("first");
		await adapter.compact();
		await adapter.reconfigure("fake/fake", "off");
		await adapter.review("second");
		expect(sessionIds).toEqual(["pi-basics-advisor:primary", "pi-basics-advisor:primary"]);
		const other = createCoreAdvisorAdapter(options(streamFn, undefined, { sessionId: "other" }));
		await other.create();
		await other.review("other");
		expect(sessionIds[2]).toBe("pi-basics-advisor:other");
	});

	test("create rejects an unconfigured Advisor model even when the primary has one", async () => {
		const base = options(streamScript([message("stop")]).streamFn);
		const adapter = createCoreAdvisorAdapter({ ...base, model: "" });
		await expect(adapter.create()).rejects.toThrow(/configure an Advisor model in \/ext-settings/i);

		const missing = createCoreAdvisorAdapter({ ...base, model: undefined });
		await expect(missing.create()).rejects.toThrow(/configure an Advisor model in \/ext-settings/i);
	});

	test("create rejects an unavailable configured provider/model", async () => {
		const adapter = createCoreAdvisorAdapter({
			...options(streamScript([message("stop")]).streamFn),
			model: "missing/model",
		});
		await expect(adapter.create()).rejects.toThrow(/unavailable/i);
	});

	test("create rejects a model without configured auth", async () => {
		const base = options(streamScript([message("stop")]).streamFn);
		const ctx = {
			...base.ctx,
			modelRegistry: { ...base.ctx.modelRegistry, hasConfiguredAuth: () => false },
		};
		const adapter = createCoreAdvisorAdapter({ ...base, ctx } as unknown as AdvisorAdapterOptions);
		await expect(adapter.create()).rejects.toThrow(/configured auth/i);
	});

	test("forces thinking off for non-reasoning models in Core", async () => {
		let observed: unknown;
		const scripted = streamScript([message("stop")]);
		const base = options((modelArg, contextArg, streamOptions) => {
			observed = streamOptions;
			return scripted.streamFn(modelArg, contextArg, streamOptions);
		});
		const adapter = createCoreAdvisorAdapter({ ...base, thinking: "high" });
		await adapter.create();
		await adapter.review("review");
		expect((observed as { reasoning?: unknown } | undefined)?.reasoning).toBeUndefined();
	});

	test("rejects unsupported thinking levels without a thinking level map", async () => {
		const reasoningModel = { ...model, reasoning: true } as Model<Api>;
		const base = options(streamScript([message("stop")]).streamFn);
		const ctx = {
			...base.ctx,
			model: reasoningModel,
			modelRegistry: {
				...base.ctx.modelRegistry,
				find: () => reasoningModel,
				hasConfiguredAuth: () => true,
			},
		};
		const adapter = createCoreAdvisorAdapter({
			...base,
			ctx,
			model: "fake/fake",
			thinking: "xhigh",
		} as unknown as AdvisorAdapterOptions);
		await expect(adapter.create()).rejects.toThrow(/unsupported/i);
	});

	test("failed reconfigure preserves the active agent and lifetime usage", async () => {
		const scripted = streamScript([
			message("stop", [], { input: 2, output: 1, totalTokens: 3, cost: 0.1 }),
		]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();
		await adapter.review("before");
		const before = adapter.usage();
		await expect(adapter.reconfigure("missing/model", "off")).rejects.toThrow();
		expect(adapter.usage()).toEqual(before);
		await expect(adapter.review("after")).resolves.toEqual([]);
	});

	test("clearing the model disables the active adapter without creating an agent", async () => {
		const adapter = createCoreAdvisorAdapter(options(streamScript([message("stop")]).streamFn));
		await adapter.create();
		await adapter.reconfigure(undefined, "off");
		await expect(adapter.review("unconfigured")).rejects.toThrow(/not active/i);
		expect(adapter.usage()).toEqual({ input: 0, output: 0, total: 0, cost: 0 });
	});

	test("successful reconfigure resets usage and uses the replacement model", async () => {
		const replacement = { ...model, id: "replacement" } as Model<Api>;
		const scripted = streamScript([
			message("stop", [], { input: 2, output: 1, totalTokens: 3, cost: 0.1 }),
			message("stop"),
		]);
		const modelIds: string[] = [];
		const base = options((modelArg, contextArg, streamOptions) => {
			modelIds.push(modelArg.id);
			return scripted.streamFn(modelArg, contextArg, streamOptions);
		});
		const ctx = {
			...base.ctx,
			modelRegistry: {
				...base.ctx.modelRegistry,
				find: (_provider: string, id: string) => (id === "replacement" ? replacement : model),
			},
		};
		const adapter = createCoreAdvisorAdapter({ ...base, ctx } as unknown as AdvisorAdapterOptions);
		await adapter.create();
		await adapter.review("before");
		await adapter.reconfigure("fake/replacement", "off");
		expect(adapter.usage()).toEqual({ input: 0, output: 0, total: 0, cost: 0 });
		await adapter.review("after");
		expect(scripted.calls()).toBe(2);
		expect(modelIds).toEqual(["fake", "replacement"]);
	});

	test("reconfigure while disabled validates pending options without activating", async () => {
		const replacement = { ...model, id: "replacement" } as Model<Api>;
		const base = options(streamScript([message("stop")]).streamFn);
		const ctx = {
			...base.ctx,
			modelRegistry: { ...base.ctx.modelRegistry, find: () => replacement },
		};
		const adapter = createCoreAdvisorAdapter({ ...base, ctx } as unknown as AdvisorAdapterOptions);
		await adapter.reconfigure("fake/replacement", "off");
		await expect(adapter.review("inactive")).rejects.toThrow(/not active/i);
		await adapter.create();
		await expect(adapter.review("active")).resolves.toEqual([]);
	});
	test("does not proactively compact below the context threshold", async () => {
		const scripted = streamScript([
			message("stop", [], { input: 3276, output: 1, totalTokens: 3277, cost: 0.1 }),
		]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();
		await adapter.review("review");
		expect(scripted.calls()).toBe(1);
	});

	test("proactively compacts at 80 percent using bootstrap replay and preserves lifetime usage", async () => {
		let bootstrapCalls = 0;
		const source = [{ role: "user", content: [{ type: "text", text: "history" }] }] as never[];
		const sessionManager = {
			buildSessionContext: () => {
				bootstrapCalls += 1;
				return { messages: source };
			},
		};
		const seenContexts: number[] = [];
		const scripted = streamScript([
			message("stop", [], { input: 3277, output: 2, totalTokens: 3279, cost: 0.2 }),
			message("stop", [], { input: 10, output: 1, totalTokens: 11, cost: 0.01 }),
		]);
		const adapter = createCoreAdvisorAdapter(
			options(
				(modelArg, contextArg, streamOptions) => {
					seenContexts.push(contextArg.messages.length);
					return scripted.streamFn(modelArg, contextArg, streamOptions);
				},
				undefined,
				{ sessionManager },
			),
		);
		await adapter.create();
		await adapter.review("first");
		await adapter.review("second");
		expect(seenContexts.length).toBe(2);
		expect(adapter.usage()).toMatchObject({ input: 3287, output: 3, total: 3290 });
		expect(adapter.usage().cost).toBeCloseTo(0.21);
		expect(bootstrapCalls).toBe(2);
	});

	test("does not compact repeatedly without new context growth", async () => {
		const scripted = streamScript([
			message("stop", [], { input: 3277, output: 1, totalTokens: 3278, cost: 0.1 }),
		]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();
		await adapter.review("first");
		await adapter.review("second");
		expect(scripted.calls()).toBe(2);
	});

	test("normalizes totalTokens and cost.total", async () => {
		const scripted = streamScript([
			message("stop", [], { input: 7, output: 3, totalTokens: 99, cost: 0.25 }),
		]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();

		await adapter.review("review");
		expect(adapter.usage()).toEqual({ input: 7, output: 3, total: 99, cost: 0.25 });
	});

	test("preserves usage through soft compaction and clears it on full reset", async () => {
		const scripted = streamScript([
			message("stop", [], { input: 2, output: 1, totalTokens: 3, cost: 0.1 }),
		]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();

		await adapter.review("review");
		await adapter.compact();
		expect(adapter.usage().total).toBe(3);
		await adapter.reset();
		expect(adapter.usage()).toEqual({ input: 0, output: 0, total: 0, cost: 0 });
	});

	test("discards advice when the final assistant turn errors", async () => {
		const scripted = streamScript([message("toolUse", [adviseCall]), message("error")]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();

		expect(await adapter.review("review")).toEqual([]);
		expect(scripted.calls()).toBe(2);
	});

	test("counts length attempts and successful replay exactly once", async () => {
		const scripted = streamScript([
			message("length", [], { input: 4, output: 1, totalTokens: 5, cost: 0.04 }),
			message("stop", [], { input: 6, output: 2, totalTokens: 8, cost: 0.06 }),
		]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();

		await adapter.review("review");
		expect(adapter.usage()).toEqual({ input: 10, output: 3, total: 13, cost: 0.1 });
	});

	test("replays once after length and fails closed if fresh replay also overflows", async () => {
		const scripted = streamScript([message("length"), message("length")]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();

		expect(await adapter.review("review")).toEqual([]);
		expect(scripted.calls()).toBe(2);
	});

	test("uses a 30 second review timeout", async () => {
		const controls = controllableScheduler();
		const adapter = createCoreAdvisorAdapter(
			options(streamScript([message("stop")]).streamFn, controls.scheduler),
		);
		await adapter.create();
		await adapter.review("review");
		expect(controls.delays).toEqual([30_000]);
	});

	test("timeout aborts, waits for idle, and discards earlier advice", async () => {
		const controls = controllableScheduler();
		const first = createAssistantMessageEventStream();
		let calls = 0;
		const streamFn: StreamFn = (_model, _context, streamOptions) => {
			calls += 1;
			if (calls === 1) {
				first.push({ type: "done", reason: "toolUse", message: message("toolUse", [adviseCall]) });
				return first;
			}
			if (calls === 3)
				return streamScript([message("stop")]).streamFn(_model, _context, streamOptions);
			const pending = createAssistantMessageEventStream();
			const abort = () =>
				pending.push({ type: "error", reason: "aborted", error: message("aborted") });
			if (streamOptions?.signal?.aborted === true) abort();
			else streamOptions?.signal?.addEventListener("abort", abort, { once: true });
			return pending;
		};
		const adapter = createCoreAdvisorAdapter(options(streamFn, controls.scheduler));
		await adapter.create();
		const review = adapter.review("review");
		controls.fire();
		await expect(review).rejects.toThrow(/timed out/i);
		await expect(adapter.review("next")).resolves.toEqual([]);
	});

	test("a later review succeeds after timeout without another abort", async () => {
		const controls = controllableScheduler();
		let calls = 0;
		const streamFn: StreamFn = (_model, _context, streamOptions) => {
			calls += 1;
			if (calls === 1) {
				const pending = createAssistantMessageEventStream();
				const abort = () =>
					pending.push({ type: "error", reason: "aborted", error: message("aborted") });
				if (streamOptions?.signal?.aborted === true) abort();
				else streamOptions?.signal?.addEventListener("abort", abort, { once: true });
				return pending;
			}
			return streamScript([message("stop")]).streamFn(_model, _context, streamOptions);
		};
		const adapter = createCoreAdvisorAdapter(options(streamFn, controls.scheduler));
		await adapter.create();
		const first = adapter.review("first");
		controls.fire();
		await expect(first).rejects.toThrow(/timed out/i);
		await expect(adapter.review("second")).resolves.toEqual([]);
		expect(calls).toBe(2);
	});

	test("honors an already-aborted and a later AbortSignal", async () => {
		const already = new AbortController();
		already.abort();
		const scripted = streamScript([message("stop")]);
		const adapter = createCoreAdvisorAdapter(options(scripted.streamFn));
		await adapter.create();
		await expect(adapter.review("review", already.signal)).rejects.toThrow();
		expect(scripted.calls()).toBe(0);

		const later = new AbortController();
		const pending = createAssistantMessageEventStream();
		let laterCalls = 0;
		const delayed: StreamFn = () => {
			laterCalls += 1;
			const finish = () =>
				pending.push({ type: "error", reason: "aborted", error: message("aborted") });
			if (later.signal.aborted) finish();
			else later.signal.addEventListener("abort", finish, { once: true });
			return pending;
		};
		const laterAdapter = createCoreAdvisorAdapter(options(delayed));
		await laterAdapter.create();
		const review = laterAdapter.review("review", later.signal);
		later.abort();
		await expect(review).rejects.toThrow(/abort/i);
		expect(laterCalls).toBe(1);
	});
});
