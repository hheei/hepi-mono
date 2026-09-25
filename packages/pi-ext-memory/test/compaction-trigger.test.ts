import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type IdleCompactionContext,
	registerCompactionTrigger,
	scheduleColdResumeCompaction,
} from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	rawMessage,
	type TestEntry,
	textCustomMessage,
} from "./fixtures/session.js";

function captureHandler(
	args: {
		compactAfterTokens?: number;
		compactAfterTokensMode?: "calibrated" | "ratio";
		idleCompactionTtlSeconds?: number;
		idleCompactionMinTokens?: number;
		passive?: boolean;
		compactInFlight?: boolean;
	} = {},
) {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			if (cb) handlers.set(name, cb);
			if (name === "agent_settled") handler = cb;
		}),
	};
	const runtime = new Runtime();
	runtime.config = {
		...runtime.config,
		compactAfterTokens: args.compactAfterTokens ?? 3,
		compactAfterTokensMode: args.compactAfterTokensMode ?? "calibrated",
		compactAfterTokensRatio: args.compactAfterTokensRatio ?? 0.68,
		idleCompactionMinTokens: args.idleCompactionMinTokens ?? 75_000,
		passive: args.passive ?? false,
	};
	runtime.config.idleCompactionTtlSeconds = args.idleCompactionTtlSeconds;
	runtime.configLoaded = true;
	runtime.ensureConfig = vi.fn();
	runtime.compactInFlight = args.compactInFlight ?? false;
	registerCompactionTrigger(pi as ExtensionAPI, runtime);
	if (!handler) throw new Error("agent_settled handler was not registered");
	return { handler, handlers, runtime };
}

function agentSettled() {
	return { type: "agent_settled" };
}

function fakeCtx(
	branches: TestEntry[][],
	overrides: Record<string, unknown> = {},
): IdleCompactionContext {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: { getBranch },
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		model: undefined,
		...overrides,
	};
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

describe("V3 compaction trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 estimated source tokens); triggering compaction",
			"info",
		);
	});

	it("skips passive mode", async () => {
		const { handler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		];
		const ctx = fakeCtx([branch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("does not compact when provider context and anchored growth exceed the threshold but raw progress does not", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 130000 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "baseline" }),
			rawMessage("baseline", "baseline", {
				message: {
					role: "assistant",
					content: "baseline",
					stopReason: "end_turn",
					usage: { totalTokens: 5000 },
				},
			}),
			textCustomMessage("raw-1", "a".repeat(302_248)), // 75,562 tokens plus the 2-token baseline message
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 135636, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("uses raw progress from the first kept entry through the current branch", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("old", "bbbbbbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "kept" }),
			textCustomMessage("kept", "aaaaaaaa"),
			textCustomMessage("new", "bbbbbbbbbbbb"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses the same raw metric after deferred re-check", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(runtime.compactInFlight).toBe(true);
	});

	it("compacts when raw progress equals the threshold", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: {
					role: "assistant",
					content: "done",
					stopReason: "end_turn",
					usage: { totalTokens: 100 },
				},
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 101, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress when provider usage is unknown or has no baseline", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [compactionEntry("cmp-1"), textCustomMessage("raw-1", "aaaa")];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: null, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("falls back to raw progress after a model change", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1"),
			rawMessage("assistant-1", "done", {
				message: {
					role: "assistant",
					content: "done",
					stopReason: "end_turn",
					usage: { totalTokens: 60000 },
				},
			}),
			{
				type: "model_change",
				id: "model-1",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
			},
			textCustomMessage("raw-1", "aaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 190000, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	describe("ratio mode", () => {
		it("scales the compaction threshold by model.contextWindow", async () => {
			// 3 tokens raw; ratio 0.5 of 4-token window = 2 -> threshold 2, so 3 >= 2 fires.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not compact when raw tokens are below the scaled threshold", async () => {
			// 1 token raw (belowBranch); ratio 0.5 of 4 = 2 -> threshold 2, so 1 < 2 does not fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([belowBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the model context window in ratio mode", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], {
				model: { contextWindow: 4 },
				getContextUsage: vi.fn(() => ({ tokens: 2, contextWindow: 10 })),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("falls back to calibrated value when model.contextWindow is unavailable", async () => {
			// ratio mode but no model -> falls back to compactAfterTokens=81000, so 3 tokens won't fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: undefined });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when contextWindow is zero", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 0 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the same resolved threshold on deferred re-check", async () => {
			// threshold = 0.5 * 4 = 2; first branch has 3 (fires, deferred), isIdle=false defers,
			// second branch has 1 (< 2) -> skipped because another compaction reduced pressure.
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch, belowBranch], {
				model: { contextWindow: 4 },
				isIdle: vi.fn(() => false),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});
	});

	describe("cleanup and lifecycle abortion", () => {
		it("cancels pending compaction callback when clearPendingCompactionTimer is called", async () => {
			const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
			const ctx = fakeCtx([dueBranch]);

			handler(agentSettled(), ctx);
			expect(runtime.compactInFlight).toBe(true);
			expect(runtime.pendingCompactionTimer).toBeDefined();

			runtime.clearPendingCompactionTimer();
			expect(runtime.pendingCompactionTimer).toBeUndefined();

			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(ctx.isIdle).not.toHaveBeenCalled();
		});

		it("ignores a late compact result from an older session", async () => {
			const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
			let callbacks:
				| {
						onComplete: () => void;
						onError: (error: { message: string }) => void;
				  }
				| undefined;
			const ctx = fakeCtx([dueBranch], {
				compact: vi.fn((options: typeof callbacks) => {
					callbacks = options;
				}),
			});

			runtime.sessionGeneration = 1;
			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();
			expect(callbacks).toBeDefined();

			runtime.sessionGeneration = 2;
			runtime.compactInFlight = false;
			callbacks?.onComplete();
			callbacks?.onError({ message: "late compaction failure" });

			expect(runtime.compactInFlight).toBe(false);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				"Observational memory: compaction complete",
				"info",
			);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				"Observational memory: late compaction failure",
				"error",
			);
		});

		it("skips compaction and UI notifications if lifecycleSignal is aborted before callback runs", async () => {
			const controller = new AbortController();
			const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
			const ctx = fakeCtx([dueBranch]);
			runtime.lifecycleSignal = controller.signal;

			handler(agentSettled(), ctx);
			expect(runtime.compactInFlight).toBe(true);

			controller.abort();

			await vi.runAllTimersAsync();

			expect(runtime.compactInFlight).toBe(false);
			expect(ctx.compact).not.toHaveBeenCalled();
			expect(ctx.isIdle).not.toHaveBeenCalled();
		});

		it("silently swallows stale context errors thrown or returned by compact", async () => {
			const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
			const ctx = fakeCtx([dueBranch], {
				compact: vi.fn(() => {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				}),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(runtime.compactInFlight).toBe(false);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringContaining("compact threw:"),
				"error",
			);
		});
	});

	describe("idle compaction", () => {
		const validObsEntry = observationsRecordedEntry("obs-1", {
			observations: [observation("0123456789ab")],
			coversUpToId: "raw-1",
		});

		it("does not schedule idle compaction if idleCompactionTtl is disabled", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: undefined,
				idleCompactionMinTokens: 1,
			});
			const ctx = fakeCtx([[rawMessage("raw-1", "hello"), validObsEntry]]);

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();
		});

		it("does not schedule idle compaction if tokens are below idleCompactionMinTokens", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 1800,
				idleCompactionMinTokens: 50_000,
			});
			// Only small token message
			const ctx = fakeCtx([[rawMessage("raw-1", "short message"), validObsEntry]]);

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();
		});

		it("does not schedule idle compaction if foldLedger has no observations or reflections", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 1800,
				idleCompactionMinTokens: 1,
			});
			// No observationsRecordedEntry in branch
			const ctx = fakeCtx([[rawMessage("raw-1", "message without memory projection")]]);

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();
		});

		it("does not schedule idle compaction if no new source entries exist after previous compaction", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 1_800,
				idleCompactionMinTokens: 1,
			});
			// Compaction entry is the last entry — no new source messages
			const branch = [
				rawMessage("raw-1", "hello"),
				validObsEntry,
				compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			];
			const ctx = fakeCtx([branch]);

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();
		});

		it("schedules idle compaction when token threshold, source entries, and projection requirements are met", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = [rawMessage("raw-1", "hello"), validObsEntry];
			const ctx = fakeCtx([branch]);

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();
		});

		it("cancels idle compaction timer when interaction events fire", async () => {
			const { handler, handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = [rawMessage("raw-1", "hello"), validObsEntry];
			const ctx = fakeCtx([branch]);

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();

			// User interaction begins
			const beforeAgentStart = handlers.get("before_agent_start");
			expect(beforeAgentStart).toBeDefined();
			beforeAgentStart?.({}, ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();
			const agentStart = handlers.get("agent_start");
			agentStart?.({}, ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();
			const turnStart = handlers.get("turn_start");
			turnStart?.({}, ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();
		});

		it("executes idle compaction when timer fires and session is idle", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = [rawMessage("raw-1", "hello"), validObsEntry];
			const ctx = fakeCtx([branch]);

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();

			// Fast-forward 60s
			await vi.advanceTimersByTimeAsync(60_000);

			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(runtime.compactInFlight).toBe(true);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("idle timeout reached"),
				"info",
			);
		});

		it("skips idle compaction if agent becomes busy when timer fires", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = [rawMessage("raw-1", "hello"), validObsEntry];
			const ctx = fakeCtx([branch], { isIdle: vi.fn(() => false) });

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();

			await vi.advanceTimersByTimeAsync(60_000);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("handles cold resume in scheduleColdResumeCompaction", async () => {
			const { runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const now = Date.now();
			const branch = [
				{
					id: "raw-1",
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "old message" }] },
					timestamp: new Date(now - 120_000).toISOString(), // 2 minutes ago (> 60s TTL)
				},
				validObsEntry,
			];
			const ctx = fakeCtx([branch]);

			scheduleColdResumeCompaction(ctx, runtime);

			// Should be scheduled with 5s startup debounce
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();

			await vi.advanceTimersByTimeAsync(5_000);

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("awaits in-flight consolidation before running idle compaction and re-reads branch", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branchBefore = [rawMessage("raw-1", "hello"), validObsEntry];
			const branchAfter = [
				rawMessage("raw-1", "hello"),
				validObsEntry,
				rawMessage("raw-2", "world"),
			];
			const ctx = fakeCtx([branchBefore, branchAfter]);

			let resolveConsolidation: () => void = () => {};
			runtime.consolidationInFlight = true;
			runtime.consolidationPromise = new Promise<void>((resolve) => {
				resolveConsolidation = resolve;
			});

			handler(agentSettled(), ctx);
			expect(runtime.pendingIdleCompactionTimer).toBeDefined();

			// Advance past idle TTL (60s)
			await vi.advanceTimersByTimeAsync(60_000);

			// Should not have compacted yet because consolidation is in-flight
			expect(ctx.compact).not.toHaveBeenCalled();

			// Resolve consolidation
			runtime.consolidationInFlight = false;
			resolveConsolidation();
			await Promise.resolve();

			// Now idle compaction proceeds with the updated branch and calls ctx.compact
			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("aborts agent_settled if session generation changed during ensureConfig", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 1,
			});
			runtime.configLoaded = false;
			let resolveConfig: () => void = () => {};
			runtime.ensureConfig = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveConfig = resolve;
					}),
			);

			const ctx = fakeCtx([[rawMessage("raw-1", "hello")]]);

			// Trigger agent_settled
			const promise = handler(agentSettled(), ctx);

			// While ensureConfig is awaiting, session changes
			runtime.sessionGeneration = 999;
			runtime.configLoaded = true;
			resolveConfig();
			await promise;

			// Should not have scheduled compaction or set compactInFlight for generation 999
			expect(runtime.compactInFlight).toBe(false);
			expect(runtime.pendingCompactionTimer).toBeUndefined();
			expect(runtime.pendingIdleCompactionTimer).toBeUndefined();
		});

		it("does not mutate new session flags when old compaction callback completes after session replacement", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = [rawMessage("raw-1", "hello"), validObsEntry];
			let capturedCallbacks: {
				onComplete?: () => void;
				onError?: (err: { message: string }) => void;
			} = {};
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts: typeof capturedCallbacks) => {
					capturedCallbacks = opts;
				}),
			});

			handler(agentSettled(), ctx);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(runtime.compactInFlight).toBe(true);
			expect(runtime.idleCompactInFlight).toBe(true);

			// New session begins: new session resets flags and starts its own state
			runtime.sessionGeneration = 1;
			runtime.compactInFlight = true;
			runtime.idleCompactInFlight = true;

			// Old compaction completes after session replacement
			capturedCallbacks.onComplete?.();

			// Flags must NOT be cleared by the old callback because generation is now 1
			expect(runtime.compactInFlight).toBe(true);
			expect(runtime.idleCompactInFlight).toBe(true);
		});
	});
});
