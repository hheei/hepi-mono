import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "@hheei/pi-basics";
import { type AdvisorAdapterFactory, createAdvisorFeature } from "../../../src/feature.js";
import type { AdvisorAdvice } from "../../../src/model.js";
import type { AdvisorAdapterOptions, AdvisorAgentAdapter } from "../../../src/runtime.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakeAdapter extends AdvisorAgentAdapter {
	createCalls: number;
	resetCalls: number;
	reviewPrompts: string[];
	createFailures: number;
	resetFailures: number;
	reconfigureCalls: Array<{ model: string | undefined; thinking: string }>;
	reconfigureFailures: number;
	nextAdvice: readonly AdvisorAdvice[] | undefined;
	deferNextReview(): void;
	resolveReview(advice?: readonly AdvisorAdvice[]): void;
}

function fakeAdapter(): FakeAdapter {
	let deferredReviews = 0;
	let deferredResolve: ((advice: readonly AdvisorAdvice[]) => void) | undefined;
	const adapter: FakeAdapter = {
		activeTools: [],
		contextBudget: () => ({ contextWindow: 32768, responseReserve: 4096 }),
		createCalls: 0,
		resetCalls: 0,
		reviewPrompts: [],
		createFailures: 0,
		resetFailures: 0,
		reconfigureCalls: [],
		reconfigureFailures: 0,
		nextAdvice: undefined,
		async create() {
			adapter.createCalls++;
			if (adapter.createFailures > 0) {
				adapter.createFailures--;
				throw new Error("bootstrap failed");
			}
		},
		async reset() {
			adapter.resetCalls++;
			if (adapter.resetFailures > 0) {
				adapter.resetFailures--;
				throw new Error("reset failed");
			}
		},
		async reconfigure(model, thinking) {
			adapter.reconfigureCalls.push({ model, thinking });
			if (adapter.reconfigureFailures > 0) {
				adapter.reconfigureFailures--;
				throw new Error("reconfigure failed");
			}
		},
		async review(prompt) {
			adapter.reviewPrompts.push(prompt);
			if (deferredReviews > 0)
				return new Promise<readonly AdvisorAdvice[]>((resolve) => {
					deferredReviews--;
					deferredResolve = resolve;
				});
			const advice = adapter.nextAdvice;
			adapter.nextAdvice = undefined;
			return advice ?? [{ severity: "blocker", note: "check auth" }];
		},
		async compact() {},
		async abort() {},
		async dispose() {},
		usage: () => ({ input: 0, output: 0, total: 0, cost: 0 }),
		deferNextReview() {
			deferredReviews++;
		},
		resolveReview(advice = []) {
			const resolve = deferredResolve;
			deferredResolve = undefined;
			resolve?.(advice);
		},
	};
	return adapter;
}

function fixture(enabled: boolean, adapter = fakeAdapter()) {
	const entries: Array<Record<string, unknown>> = enabled
		? [
				{
					type: "custom",
					customType: "pi-basics-advisor-mode",
					data: { version: 1, enabled: true },
				},
			]
		: [];
	const handlers = new Map<string, Handler[]>();
	const messages: Array<Record<string, unknown>> = [];
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const statuses = new Map<string, string | undefined>();
	const deliveries: Array<{
		message: Record<string, unknown>;
		options: Record<string, unknown> | undefined;
	}> = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
			messages.push(message);
			deliveries.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
		},
		sessionManager: {
			getSessionId: () => "advisor-session",
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
	const runtime = {
		pi,
		ctx,
		registry: {},
		requestRender() {},
		close() {},
	} as unknown as HePiRuntimeContext;
	const factory: AdvisorAdapterFactory = (_options: AdvisorAdapterOptions) => adapter;
	const feature = createAdvisorFeature(factory);
	return {
		adapter,
		ctx,
		deliveries,
		entries,
		feature,
		handlers,
		messages,
		notifications,
		runtime,
		statuses,
	};
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
	for (let turn = 0; turn < 100; turn++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function emit(
	h: ReturnType<typeof fixture>,
	event: string,
	payload: Record<string, unknown> = {},
): Promise<void> {
	for (const handler of h.handlers.get(event) ?? []) await handler(payload, h.ctx);
}

describe("Advisor feature lifecycle", () => {
	test("publishes Advisor status for the session lifecycle", async () => {
		const h = fixture(false);
		await h.feature.start(h.runtime);
		expect(h.statuses.get("advisor")).toBe("Advisor");
		await h.feature.dispose("advisor-session");
		expect(h.statuses.get("advisor")).toBeUndefined();
	});

	test("configure failure keeps old status and records lastError", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		h.adapter.reconfigureFailures = 1;
		await expect(h.feature.configure("new/model", "high")).rejects.toThrow("reconfigure failed");
		expect(h.feature.status()).toMatchObject({
			enabled: true,
			thinking: "medium",
			lastError: "reconfigure failed",
		});
	});

	test("configure success while disabled stores pending runtime configuration", async () => {
		const h = fixture(false);
		await h.feature.start(h.runtime);
		await h.feature.configure("new/model", "off");
		expect(h.adapter.reconfigureCalls).toEqual([{ model: "new/model", thinking: "off" }]);
		expect(h.feature.status()).toMatchObject({
			enabled: false,
			model: "new/model",
			thinking: "off",
		});
		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.createCalls).toBe(1);
	});

	test("/advisor toggles while explicit on and off stay idempotent", async () => {
		const h = fixture(false);
		await h.feature.start(h.runtime);

		await h.feature.command("", h.ctx as unknown as ExtensionCommandContext);
		expect(h.feature.status()).toMatchObject({ enabled: true, phase: "idle" });
		expect(h.adapter.createCalls).toBe(1);
		expect(h.notifications.at(-1)).toEqual({ message: "※ Advisor on", level: "info" });

		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.createCalls).toBe(1);
		await h.feature.command("", h.ctx as unknown as ExtensionCommandContext);
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled" });
		expect(h.notifications.at(-1)).toEqual({ message: "※ Advisor off", level: "info" });

		await h.feature.command("off", h.ctx as unknown as ExtensionCommandContext);
		expect(h.feature.status().enabled).toBe(false);
	});

	test("/advisor on create failure stays disabled without an enabled boundary", async () => {
		const h = fixture(false);
		h.adapter.createFailures = 1;
		await h.feature.start(h.runtime);
		await expect(
			h.feature.command("on", h.ctx as unknown as ExtensionCommandContext),
		).rejects.toThrow("bootstrap failed");
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled" });
		expect(
			h.entries.some(
				(entry) => (entry.data as { enabled?: boolean } | undefined)?.enabled === true,
			),
		).toBe(false);
	});

	test("contains restored bootstrap failure and permits a later /advisor on", async () => {
		const h = fixture(true);
		h.adapter.createFailures = 1;

		await h.feature.start(h.runtime);
		expect(h.feature.status()).toMatchObject({
			enabled: false,
			phase: "disabled",
			lastError: "bootstrap failed",
		});

		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.createCalls).toBe(2);
		expect(h.feature.status()).toMatchObject({ enabled: true, phase: "idle" });
	});

	test("drops a stale reconfirm after disabling without delivering it", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		});
		await waitFor(
			() => h.adapter.reviewPrompts.length === 1 && h.feature.status().backlog === 0,
			"initial review to complete",
		);
		h.adapter.deferNextReview();
		const reconfirm = emit(h, "agent_settled");
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "deferred review to start");
		await h.feature.command("off", h.ctx as unknown as ExtensionCommandContext);
		h.adapter.resolveReview([{ severity: "blocker", note: "check auth" }]);
		await reconfirm;

		expect(h.messages).toHaveLength(0);
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled", backlog: 0 });
	});

	test("serializes reset behind a queued review and cleans stale backlog", async () => {
		for (const resetEvent of ["session_compact", "session_tree"] as const) {
			const h = fixture(true);
			await h.feature.start(h.runtime);
			h.adapter.deferNextReview();
			await emit(h, "turn_end", {
				message: { role: "assistant", content: [{ type: "text", text: "done" }] },
			});
			await waitFor(() => h.adapter.reviewPrompts.length === 1, "deferred review to start");

			const reset = emit(h, resetEvent);
			await waitFor(() => h.adapter.resetCalls === 0, "reset to remain deferred");
			expect(h.adapter.resetCalls).toBe(0);
			h.adapter.resolveReview([{ severity: "blocker", note: "stale" }]);
			await reset;

			expect(h.messages).toHaveLength(0);
			expect(h.adapter.resetCalls).toBe(1);
			expect(h.feature.status()).toMatchObject({ enabled: true, phase: "idle", backlog: 0 });
		}
	});

	test("records reset failures and skips reset while disabled", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		h.adapter.resetFailures = 1;
		await emit(h, "session_tree");
		expect(h.adapter.resetCalls).toBe(1);
		expect(h.feature.status()).toMatchObject({ phase: "error", lastError: "reset failed" });

		await h.feature.command("off", h.ctx as unknown as ExtensionCommandContext);
		await emit(h, "session_compact");
		expect(h.adapter.resetCalls).toBe(1);
	});

	test("does not decrement a newer review backlog when an old review settles", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		h.adapter.deferNextReview();
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "old" }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "old review to start");

		const compact = emit(h, "session_compact");
		h.adapter.deferNextReview();
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "new" }] },
		});
		h.adapter.resolveReview();
		await compact;
		await waitFor(
			() => h.adapter.reviewPrompts.length === 2 && h.feature.status().backlog === 1,
			"new review to start",
		);
		expect(h.feature.status().backlog).toBe(1);

		h.adapter.resolveReview();
		await waitFor(() => h.feature.status().backlog === 0, "reviews to drain");
		expect(h.feature.status()).toMatchObject({ phase: "idle", backlog: 0 });
	});

	test("ordinary nits steer once without reconfirmation", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "nit", note: "minor cleanup" }];
		await h.feature.start(h.runtime);

		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "nit review to start");
		await emit(h, "agent_settled");
		await waitFor(() => h.deliveries.length === 1, "nit delivery");

		expect(h.deliveries).toHaveLength(1);
		const delivery = h.deliveries[0];
		if (delivery === undefined) throw new Error("Expected delivery");
		expect(delivery.options).toEqual({ deliverAs: "steer", triggerTurn: false });
		expect((delivery.message.details as { notes: AdvisorAdvice[] } | undefined)?.notes).toEqual([
			{ severity: "nit", note: "minor cleanup" },
		]);
		expect(h.adapter.reviewPrompts).toHaveLength(1);
	});

	test("aborted primary turn steers without triggering a turn", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);

		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "aborted" }],
				stopReason: "aborted",
			},
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "held review to start");
		await emit(h, "agent_settled");
		await waitFor(() => h.deliveries.length === 1, "delivery");

		const delivery = h.deliveries[0];
		if (delivery === undefined) throw new Error("Expected delivery");
		expect(delivery.options).toEqual({ deliverAs: "steer", triggerTurn: false });
	});

	test("normal primary turn steers and triggers a turn", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);

		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		});
		await waitFor(() => h.adapter.reviewPrompts.length > 0, "review to start");
		await emit(h, "agent_settled");

		expect(h.deliveries).toHaveLength(1);
		expect(h.deliveries[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	test("later normal turn clears aborted primary state", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);

		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "aborted" }],
				stopReason: "aborted",
			},
		});
		await waitFor(() => h.adapter.reviewPrompts.length > 0, "review to start");
		await emit(h, "agent_settled");

		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		});
		await waitFor(() => h.adapter.reviewPrompts.length > 0, "review to start");
		await emit(h, "agent_settled");

		expect(h.deliveries).toHaveLength(2);
		expect(h.deliveries[1]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	test("reviews visible turn evidence without thinking content", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "assistant visible" },
					{ type: "thinking", thinking: "FEATURE_THINKING_SECRET" },
					{ type: "toolCall", name: "read", id: "call-feature", arguments: { path: "a.ts" } },
				],
			},
			toolResults: [
				{
					toolName: "edit",
					toolCallId: "call-feature",
					isError: false,
					content: [{ type: "text", text: "result text" }],
					details: "FEATURE_DIFF_MARKER",
				},
			],
		});
		await waitFor(() => h.adapter.reviewPrompts.length > 0, "review to start");
		const prompt = h.adapter.reviewPrompts.at(-1) ?? "";
		expect(prompt).toContain("assistant visible");
		expect(prompt).toContain("call-feature");
		expect(prompt).toContain("result text");
		expect(prompt).toContain("FEATURE_DIFF_MARKER");
		expect(prompt).not.toContain("FEATURE_THINKING_SECRET");
	});

	test("bounds generated review prompt by adapter context budget", async () => {
		const h = fixture(true);
		h.adapter.contextBudget = () => ({ contextWindow: 1100, responseReserve: 100 });
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "PROMPT_LONG ".repeat(100) }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length > 0, "review to start");
		const prompt = h.adapter.reviewPrompts.at(-1) ?? "";
		expect(prompt).toContain("advisor context truncated");
		expect(prompt.length).toBeLessThan(2400);
	});

	test("ignores lifecycle events from a disposed session", async () => {
		const first = fixture(false);
		await first.feature.start(first.runtime);
		await first.feature.dispose("advisor-session");
		const second = fixture(false, fakeAdapter());
		await second.feature.start(second.runtime);

		await emit(first, "session_compact");
		expect(first.adapter.resetCalls).toBe(0);
	});
});
