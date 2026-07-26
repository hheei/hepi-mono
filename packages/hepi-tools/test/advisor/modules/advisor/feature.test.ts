import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "../../../../../hepi-basics/src/core/index.js";
import {
	type AdvisorAdapterFactory,
	createAdvisorFeature,
} from "../../../../src/pi-advisor/feature.js";
import type { AdvisorAdvice } from "../../../../src/pi-advisor/model.js";
import type {
	AdvisorAdapterOptions,
	AdvisorAgentAdapter,
} from "../../../../src/pi-advisor/runtime.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakeAdapter extends AdvisorAgentAdapter {
	createCalls: number;
	resetCalls: number;
	abortCalls: number;
	disposeCalls: number;
	reviewPrompts: string[];
	reviewFailures: number;
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
		abortCalls: 0,
		disposeCalls: 0,
		reviewPrompts: [],
		reviewFailures: 0,
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
			if (adapter.reviewFailures > 0) {
				adapter.reviewFailures--;
				throw new Error("review failed");
			}
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
		async abort() {
			adapter.abortCalls++;
		},
		async dispose() {
			adapter.disposeCalls++;
		},
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
			if (options?.deliverAs !== undefined || options?.triggerTurn === true)
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
	const timers = new Map<number, { readonly due: number; readonly callback: () => void }>();
	let clock = 0;
	let nextTimer = 0;
	const feature = createAdvisorFeature(factory, {
		now: () => clock,
		setTimeout(callback, delay) {
			const id = ++nextTimer;
			timers.set(id, { due: clock + delay, callback });
			return id;
		},
		clearTimeout(timer) {
			if (typeof timer === "number") timers.delete(timer);
		},
	});
	const advance = (milliseconds: number): void => {
		clock += milliseconds;
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, timer]) => timer.due <= clock)
				.sort((left, right) => left[1].due - right[1].due)[0];
			if (due === undefined) return;
			timers.delete(due[0]);
			due[1].callback();
		}
	};
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
		advance,
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
	test("publishes Advisor status only while enabled", async () => {
		const h = fixture(false);
		await h.feature.start(h.runtime);
		expect(h.statuses.get("advisor")).toBeUndefined();
		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.statuses.get("advisor")).toBe("ok");
		await h.feature.command("off", h.ctx as unknown as ExtensionCommandContext);
		expect(h.statuses.get("advisor")).toBeUndefined();
		await h.feature.dispose("advisor-session");
		expect(h.statuses.get("advisor")).toBeUndefined();
	});

	test("clears the health marker when a review fails", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		h.adapter.reviewFailures = 1;
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "failed review to settle");
		expect(h.statuses.get("advisor")).toBeUndefined();
		expect(h.feature.status()).toMatchObject({ lastError: "review failed" });
		expect(h.notifications.some((item) => item.message.includes("review failed"))).toBe(false);
	});

	test("waits 15 seconds for new material and skips the same signature", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		await h.feature.start(h.runtime);

		const turn = async (text: string): Promise<void> => {
			await emit(h, "turn_end", {
				message: { role: "assistant", content: [{ type: "text", text }] },
			});
		};

		await turn("first");
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "initial review");
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");

		await turn("second");
		h.adapter.nextAdvice = [];
		h.advance(14_999);
		await Promise.resolve();
		expect(h.adapter.reviewPrompts).toHaveLength(1);
		h.advance(1);
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "second review");
		await waitFor(() => h.feature.status().backlog === 0, "second review to settle");

		await turn("second");
		h.adapter.nextAdvice = [];
		h.advance(15_000);
		await Promise.resolve();
		expect(h.adapter.reviewPrompts).toHaveLength(2);
	});

	test("clears material signature after a session reset", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "same" }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "initial review");
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");

		await emit(h, "session_compact");
		h.advance(15_000);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "same" }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "post-reset review");
	});

	test("updates pending material evidence while a review is cooling down", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "initial review");
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");

		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "second" }] },
		});
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "latest" }] },
		});
		h.advance(15_000);
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "latest pending review");
		expect(h.adapter.reviewPrompts[1]).toContain("latest");
		expect(h.adapter.reviewPrompts[1]).not.toContain("second");
	});

	test("reconfirms a terminal blocker that arrives after cooldown", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");

		h.adapter.nextAdvice = [{ severity: "blocker", note: "late blocker" }];
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "late" }] },
		});
		await emit(h, "agent_settled");
		expect(h.adapter.reviewPrompts).toHaveLength(1);

		h.advance(15_000);
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "late terminal review");
		await waitFor(() => h.feature.status().backlog === 0, "late terminal review to settle");
		h.adapter.nextAdvice = [{ severity: "blocker", note: "late blocker" }];
		h.advance(40_000);
		await waitFor(() => h.deliveries.length === 1, "terminal blocker delivery");
	});

	test("retains pending tool evidence behind a newer ordinary turn", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");

		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "edited" }] },
			toolResults: [
				{
					toolName: "edit",
					toolCallId: "edit-pending",
					isError: false,
					content: [{ type: "text", text: "ok" }],
					details: { diff: "PENDING_MATERIAL_DIFF" },
				},
			],
		});
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "latest" }] },
		});
		h.adapter.nextAdvice = [];
		h.advance(15_000);
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "merged pending review");
		const prompt = h.adapter.reviewPrompts[1] ?? "";
		expect(prompt).toContain("latest");
		expect(prompt).toContain("PENDING_MATERIAL_DIFF");
	});

	test("does not start a normal review during reconfirmation", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "held blocker" }];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");
		h.advance(40_000);

		h.adapter.deferNextReview();
		const reconfirm = emit(h, "agent_settled");
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "reconfirmation to start");
		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "queued while reconfirming" }],
			},
		});
		expect(h.adapter.reviewPrompts).toHaveLength(2);
		h.adapter.resolveReview([{ severity: "blocker", note: "held blocker" }]);
		await reconfirm;

		h.advance(39_999);
		await Promise.resolve();
		expect(h.adapter.reviewPrompts).toHaveLength(2);
		h.advance(1);
		await waitFor(() => h.adapter.reviewPrompts.length === 3, "queued review after reconfirmation");
	});

	test("reviews identical evidence for distinct user prompts", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		await h.feature.start(h.runtime);
		await emit(h, "before_agent_start", { prompt: "same user request" });
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "same answer" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "first user review to settle");

		h.advance(15_000);
		h.adapter.nextAdvice = [];
		await emit(h, "before_agent_start", { prompt: "same user request" });
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "same answer" }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "second user review");
	});
	test("keeps the original user objective across delayed review", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		await h.feature.start(h.runtime);
		await emit(h, "before_agent_start", { prompt: "Fix the authentication flow" });
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first change" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "follow-up change" }] },
		});
		h.advance(15_000);
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "delayed review");
		expect(h.adapter.reviewPrompts[1]).toContain("Fix the authentication flow");
	});

	test("preserves a newer terminal boundary through reconfirmation", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "old blocker" }];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");
		h.advance(40_000);

		h.adapter.deferNextReview();
		const reconfirm = emit(h, "agent_settled");
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "reconfirmation to start");
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "new terminal work" }] },
		});
		await emit(h, "agent_settled");
		h.adapter.resolveReview([]);
		await reconfirm;

		h.adapter.nextAdvice = [{ severity: "blocker", note: "new blocker" }];
		h.advance(15_000);
		await waitFor(() => h.adapter.reviewPrompts.length === 3, "new terminal review");
		await waitFor(() => h.feature.status().backlog === 0, "new terminal review to settle");
		h.adapter.nextAdvice = [{ severity: "blocker", note: "new blocker" }];
		h.advance(40_000);
		await waitFor(() => h.deliveries.length === 1, "new terminal blocker delivery");
	});

	test("triggers a late nit when the primary agent is idle", async () => {
		const h = fixture(true);
		h.adapter.deferNextReview();
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 1, "deferred review to start");
		await emit(h, "agent_settled");
		h.adapter.resolveReview([{ severity: "nit", note: "small cleanup" }]);
		await waitFor(() => h.deliveries.length === 1, "late nit delivery");
		expect(h.deliveries[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	test("retains failed review evidence for a later retry", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [];
		h.adapter.reviewFailures = 1;
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "changed auth" }],
			},
			toolResults: [
				{
					toolName: "edit",
					toolCallId: "edit-1",
					isError: false,
					content: [{ type: "text", text: "done" }],
					details: { diff: "AUTH_DIFF" },
				},
			],
		});
		await waitFor(() => h.feature.status().backlog === 0, "failed review");
		h.advance(15_000);
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "retry review");
		expect(h.adapter.reviewPrompts[1]).toContain("AUTH_DIFF");
	});

	test("discards stale reconfirmation after newer primary evidence", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "old blocker" }];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "initial review");
		h.advance(40_000);
		h.adapter.deferNextReview();
		await emit(h, "agent_settled");
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "reconfirmation");
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "fixed" }] },
		});
		h.adapter.resolveReview([{ severity: "blocker", note: "old blocker" }]);
		await waitFor(() => h.feature.status().backlog === 0, "stale reconfirmation");
		expect(h.deliveries).toHaveLength(0);
	});

	test("publishes the latest review severity for the header indicator", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		expect(h.statuses.get("advisor")).toBe("ok");
		const review = async (advice: readonly AdvisorAdvice[], text: string): Promise<void> => {
			h.adapter.nextAdvice = advice;
			await emit(h, "turn_end", {
				message: { role: "assistant", content: [{ type: "text", text }] },
			});
			await waitFor(() => h.feature.status().backlog === 0, "review to complete");
		};

		await review([{ severity: "concern", note: "check this" }], "concern");
		expect(h.statuses.get("advisor")).toBe("concern");
		expect(h.messages.some((message) => message.content === "[concern] check this")).toBe(true);
		h.advance(25_000);
		await review([{ severity: "blocker", note: "stop this" }], "blocker");
		expect(h.statuses.get("advisor")).toBe("blocker");
		expect(h.messages.some((message) => message.content === "[blocker] stop this")).toBe(true);
		h.adapter.nextAdvice = [];
		h.advance(40_000);
		await waitFor(() => h.statuses.get("advisor") === "ok", "silent reconfirm");
		h.advance(15_000);
		await review([{ severity: "nit", note: "minor" }], "nit");
		expect(h.statuses.get("advisor")).toBe("ok");
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

	test("/advisor shows status while explicit on and off stay idempotent", async () => {
		const h = fixture(false);
		await h.feature.start(h.runtime);

		await h.feature.command("", h.ctx as unknown as ExtensionCommandContext);
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled" });
		expect(h.adapter.createCalls).toBe(0);
		expect(h.notifications.at(-1)?.message).toContain("model=not configured");
		expect(h.notifications.at(-1)?.message).toContain("thinking=medium");
		expect(h.notifications.at(-1)?.message).toContain("tokens=0");

		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.createCalls).toBe(1);
		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.createCalls).toBe(1);

		await h.feature.command("off", h.ctx as unknown as ExtensionCommandContext);
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled" });
		expect(h.adapter.abortCalls).toBe(1);
		expect(h.adapter.disposeCalls).toBe(1);
		await h.feature.command("off", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.disposeCalls).toBe(1);

		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.createCalls).toBe(2);
	});

	test("clearing and restoring the model requires a fresh on", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		await h.feature.configure(undefined, "medium");
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled" });
		expect(h.statuses.get("advisor")).toBeUndefined();
		await h.feature.configure("fake/fake", "medium");
		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.feature.status()).toMatchObject({ enabled: true, phase: "idle" });
		expect(h.statuses.get("advisor")).toBe("ok");
	});

	test("clearing the model persists disabled state across tree restore", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		await h.feature.configure(undefined, "medium");
		expect(h.entries.at(-1)?.data).toEqual({ version: 1, enabled: false });
		await h.feature.configure("fake/fake", "medium");
		await emit(h, "session_tree");
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled" });
		expect(h.statuses.get("advisor")).toBeUndefined();
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
		expect(h.statuses.get("advisor")).toBeUndefined();

		await h.feature.command("on", h.ctx as unknown as ExtensionCommandContext);
		expect(h.adapter.createCalls).toBe(2);
		expect(h.feature.status()).toMatchObject({ enabled: true, phase: "idle" });
		expect(h.statuses.get("advisor")).toBe("ok");
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
		h.advance(40_000);
		h.adapter.deferNextReview();
		const reconfirm = emit(h, "agent_settled");
		await waitFor(() => h.adapter.reviewPrompts.length === 2, "deferred review to start");
		await h.feature.command("off", h.ctx as unknown as ExtensionCommandContext);
		h.adapter.resolveReview([{ severity: "blocker", note: "check auth" }]);
		await reconfirm;

		expect(h.messages).toHaveLength(1);
		expect(h.deliveries).toHaveLength(0);
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
		expect(h.statuses.get("advisor")).toBeUndefined();

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

	test("reconfirms feedback when the initial review finishes after agent_settled", async () => {
		const h = fixture(true);
		h.adapter.deferNextReview();
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		});
		await waitFor(() => h.feature.status().backlog === 1, "initial review to start");
		await emit(h, "agent_settled");
		h.adapter.resolveReview([{ severity: "blocker", note: "check auth" }]);
		await waitFor(() => h.feature.status().backlog === 0, "initial review to settle");
		h.advance(40_000);
		await waitFor(() => h.deliveries.length === 1, "late blocker delivery");

		expect(h.adapter.reviewPrompts).toHaveLength(2);
		expect(h.deliveries[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	test("restores enabled state from the selected branch", async () => {
		const h = fixture(true);
		await h.feature.start(h.runtime);
		h.entries.push({
			type: "custom",
			customType: "pi-basics-advisor-mode",
			data: { version: 1, enabled: false },
		});
		await emit(h, "session_tree");
		expect(h.feature.status()).toMatchObject({ enabled: false, phase: "disabled" });
		expect(h.statuses.get("advisor")).toBeUndefined();
		expect(h.adapter.disposeCalls).toBe(1);

		h.entries.push({
			type: "custom",
			customType: "pi-basics-advisor-mode",
			data: { version: 1, enabled: true },
		});
		await emit(h, "session_tree");
		expect(h.feature.status()).toMatchObject({ enabled: true, phase: "idle" });
		expect(h.statuses.get("advisor")).toBe("ok");
		expect(h.adapter.createCalls).toBe(2);
	});

	test("delivers reconfirmed severity escalation and deduplicates it", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "concern", note: "unsafe change" }];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "concern review to complete");
		h.advance(25_000);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "unsafe change" }];
		await emit(h, "agent_settled");
		await waitFor(() => h.deliveries.length === 1, "blocker delivery");
		const delivery = h.deliveries[0];
		if (delivery === undefined) throw new Error("Expected blocker delivery");
		expect(
			(delivery.message.details as { notes?: readonly AdvisorAdvice[] } | undefined)?.notes,
		).toEqual([{ severity: "blocker", note: "unsafe change" }]);

		h.advance(40_000);
		h.adapter.nextAdvice = [{ severity: "concern", note: "unsafe change" }];
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "second" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "downgraded review to complete");
		expect(h.deliveries).toHaveLength(1);
	});

	test("does not redeliver the same nit", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "nit", note: "minor cleanup" }];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
		});
		await waitFor(() => h.deliveries.length === 1, "first nit delivery");

		h.advance(20_000);
		h.adapter.nextAdvice = [{ severity: "nit", note: " Minor   Cleanup " }];
		await emit(h, "turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "second" }] },
		});
		await waitFor(() => h.feature.status().backlog === 0, "second review to complete");
		expect(h.deliveries).toHaveLength(1);
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
		h.advance(40_000);
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
		h.advance(40_000);
		await emit(h, "agent_settled");
		await waitFor(() => h.deliveries.length === 1, "normal delivery");

		expect(h.deliveries).toHaveLength(1);
		expect(h.deliveries[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	test("preserves Advisor attribution across repeated empty start events", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "division uses addition" }];
		await h.feature.start(h.runtime);
		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Looks correct" }],
				stopReason: "stop",
			},
		});
		await waitFor(() => h.feature.status().backlog === 0, "initial review to complete");
		h.advance(40_000);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "division uses addition" }];
		await emit(h, "agent_settled");
		await waitFor(() => h.deliveries.length === 1, "advisory delivery");
		h.advance(40_000);

		await emit(h, "before_agent_start", { prompt: "" });
		await emit(h, "before_agent_start", { prompt: "" });
		h.adapter.nextAdvice = [];
		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Use a / b" }],
				stopReason: "stop",
			},
		});
		await waitFor(() => h.adapter.reviewPrompts.length === 3, "correction review to start");
		expect(h.adapter.reviewPrompts[2]).toContain(
			"USER:\nAdvisor feedback: verify against the current state before acting.\n[blocker] division uses addition",
		);
		expect(h.adapter.reviewPrompts[2]).toContain("ASSISTANT:\nUse a / b");
	});

	test("later normal turn clears aborted primary state", async () => {
		const h = fixture(true);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "first issue" }];
		await h.feature.start(h.runtime);

		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "aborted" }],
				stopReason: "aborted",
			},
		});
		await waitFor(() => h.feature.status().backlog === 0, "first review to complete");
		h.adapter.nextAdvice = [{ severity: "blocker", note: "first issue" }];
		h.advance(40_000);
		await emit(h, "agent_settled");
		await waitFor(() => h.deliveries.length === 1, "first delivery");
		h.advance(40_000);

		h.adapter.nextAdvice = [{ severity: "blocker", note: "second issue" }];
		await emit(h, "turn_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		});
		await waitFor(() => h.feature.status().backlog === 0, "second review to complete");
		h.advance(40_000);
		h.adapter.nextAdvice = [{ severity: "blocker", note: "second issue" }];
		await emit(h, "agent_settled");
		await waitFor(() => h.deliveries.length === 2, "second delivery");

		expect(h.deliveries[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
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
					details: { diff: "FEATURE_DIFF_MARKER" },
				},
			],
		});
		await waitFor(() => h.adapter.reviewPrompts.length > 0, "review to start");
		const prompt = h.adapter.reviewPrompts.at(-1) ?? "";
		expect(prompt).toContain("assistant visible");
		expect(prompt).toContain("call-feature");
		expect(prompt).not.toContain("result text");
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
