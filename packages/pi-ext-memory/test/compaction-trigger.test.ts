import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
	canPiCompact,
	formatIdleDuration,
	type IdleCompactionContext,
	OM_IDLE_NOTICE,
	registerCompactionTrigger,
} from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
	compactionEntry,
	gateEntry,
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
		compactAfterTokensRatio?: number;
		idleCompactionTtlSeconds?: number | undefined;
		idleCompactionMinTokens?: number | undefined;
		keepRecentTokens?: number;
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
		appendEntry: vi.fn(),
		registerEntryRenderer: vi.fn(),
		getSettings: () =>
			args.keepRecentTokens === undefined
				? {}
				: { compaction: { keepRecentTokens: args.keepRecentTokens } },
	};
	const runtime = new Runtime();
	runtime.config = {
		...runtime.config,
		compactAfterTokens: args.compactAfterTokens ?? 3,
		compactAfterTokensMode: args.compactAfterTokensMode ?? "calibrated",
		compactAfterTokensRatio: args.compactAfterTokensRatio ?? 0.68,
		passive: args.passive ?? false,
	};
	runtime.config.idleCompactionTtlSeconds = args.idleCompactionTtlSeconds;
	if (args.idleCompactionMinTokens !== undefined) {
		runtime.config.idleCompactionMinTokens = args.idleCompactionMinTokens;
	}
	runtime.configLoaded = true;
	runtime.deferSessionIdleCheck = false;
	runtime.ensureConfig = vi.fn();
	runtime.compactInFlight = args.compactInFlight ?? false;
	registerCompactionTrigger(pi as unknown as ExtensionAPI, runtime);
	if (!handler) throw new Error("agent_settled handler was not registered");
	return { handler, handlers, runtime, pi };
}

function agentSettled() {
	return { type: "agent_settled" };
}

/**
 * Test double for the handler ctx. Pi's ExtensionContext also carries `model`
 * and `getContextUsage`, and assertions need a concrete `ui`.
 */
type FakeCtx = Omit<IdleCompactionContext, "ui" | "sessionManager" | "isIdle" | "compact"> & {
	ui: { notify: Mock<(message: string, level?: "info" | "warning" | "error") => void> };
	sessionManager: { getBranch: Mock };
	isIdle: Mock;
	compact: Mock;
	model?: { contextWindow?: number } | undefined;
	getContextUsage?: Mock | undefined;
};

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}): FakeCtx {
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
			expect.stringMatching(
				/^om: compaction threshold reached \([\w.]+ estimated source tokens\); triggering compaction$/,
			),
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

	it("skips the threshold path while the session gate is off", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([[...dueBranch, gateEntry("gate-1", false)]]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.pendingCompactionTimer).toBeUndefined();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips compaction while the session gate is off", async () => {
		const { handler } = captureHandler({
			compactAfterTokens: 1_000,
			idleCompactionTtlSeconds: 60,
		});
		const entries = [
			...dueBranch,
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbb"),
			gateEntry("gate-1", false),
		];
		const ctx = fakeCtx([entries]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

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
			"om: compaction deferred — agent became busy before compaction",
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
			"om: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("re-checks the session gate after the deferral", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, [...dueBranch, gateEntry("gate-2", false)]]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
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
		const { handler, runtime } = captureHandler({ compactAfterTokens: 1300 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "baseline" }),
			rawMessage("baseline", "baseline", {
				message: {
					role: "assistant",
					content: "baseline",
					stopReason: "end_turn",
					usage: { totalTokens: 50 },
				},
			}),
			textCustomMessage("raw-1", "a".repeat(3_022)), // 756 tokens plus the 2-token baseline message
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 1356, contextWindow: 2000 })),
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
			expect(ctx.ui.notify).not.toHaveBeenCalledWith("om: compaction complete", "info");
			expect(ctx.ui.notify).not.toHaveBeenCalledWith("om: late compaction failure", "error");
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

		const makeIdleBranch = (nowSec: number, elapsedSec = 0, text = "x".repeat(90_000)) => [
			rawMessage("user-0", "initial prompt", {
				timestamp: new Date((nowSec - elapsedSec) * 1000).toISOString(),
			}),
			rawMessage("raw-1", text, {
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
				},
				timestamp: new Date((nowSec - elapsedSec) * 1000).toISOString(),
			}),
			validObsEntry,
		];

		it.each([
			[0, "0s"],
			[45, "45s"],
			[60, "1m"],
			[95, "1m 35s"],
			[1800, "30m"],
			[3600, "1h"],
			[3665, "1h 1m"],
			[7200, "2h"],
			[86400, "1d"],
			[90000, "1d 1h"],
		] as const)("formats %s idle seconds as %s", (seconds, label) => {
			expect(formatIdleDuration(seconds)).toBe(label);
		});

		it("notifies user directly once idle timeout expires without running compaction", async () => {
			const { handler, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec);
			const ctx = fakeCtx([branch]);

			handler(agentSettled(), ctx);
			expect(pi.appendEntry).not.toHaveBeenCalled();

			// Advance timers to trigger the idle notification timer
			await vi.advanceTimersByTimeAsync(60_000);

			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(
						/The conversation has idled for 1m. Next turn will compact context./,
					),
				}),
			);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringMatching(/The conversation has idled for 1m. Next turn will compact context./),
				"info",
			);
			// Crucial: compaction itself is NOT executed on the timer
			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
			expect(runtime.idleNoticeEmitted).toBe(true);
		});

		it("does not repeat notice on input when already notified at timeout", async () => {
			const { handler, handlers, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec);
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			handler(agentSettled(), ctx);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(runtime.idleNoticeEmitted).toBe(true);

			// User starts the next turn
			const inputHandler = handlers.get("input");
			await inputHandler?.({}, ctx);

			// Compaction runs before the turn
			expect(ctx.compact).toHaveBeenCalledTimes(1);
			// Notification was ONE-OFF: appendEntry is not called again
			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		});

		it("checks cold context on input and compacts before starting turn if idle threshold exceeded", async () => {
			const { handlers, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 120);
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			const inputHandler = handlers.get("input");
			expect(inputHandler).toBeDefined();

			await inputHandler?.({}, ctx);

			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(runtime.compactInFlight).toBe(false);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(
						/The conversation has idled for 2m. Compacting context before the next turn./,
					),
				}),
			);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringMatching(
					/The conversation has idled for 2m. Compacting context before the next turn./,
				),
				"info",
			);
		});

		it("schedules remaining idle delay on session resume and notifies at exact timeout", async () => {
			const { handlers, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			// Settled 40s ago; with 60s TTL, remaining delay is 20s
			const branch = makeIdleBranch(nowSec, 40);
			const ctx = fakeCtx([branch]);

			const sessionStart = handlers.get("session_start");
			expect(sessionStart).toBeDefined();

			await sessionStart?.({ reason: "resume" }, ctx);

			// At 10s into resume (total 50s): notice should NOT be emitted yet
			await vi.advanceTimersByTimeAsync(10_000);
			expect(pi.appendEntry).not.toHaveBeenCalled();

			// At 20s into resume (total 60s): notice emitted directly!
			await vi.advanceTimersByTimeAsync(10_000);
			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(
						/The conversation has idled for 1m. Next turn will compact context./,
					),
				}),
			);
		});

		it("notifies on resume or fork when already past idle TTL and waits for the next message", async () => {
			const { handlers, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 120);
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});

			const sessionStart = handlers.get("session_start");
			await sessionStart?.({ reason: "fork" }, ctx);

			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(
						/The conversation has idled for 2m. Next turn will compact context./,
					),
				}),
			);
			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("does not duplicate notice on resume if notice was already persisted in branch", async () => {
			const { handlers, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				...makeIdleBranch(nowSec, 120),
				{
					type: "custom",
					id: "notice-1",
					parentId: null,
					customType: OM_IDLE_NOTICE,
					data: { text: "already notified" },
					timestamp: new Date((nowSec - 60) * 1000).toISOString(),
				},
			];
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});

			const sessionStart = handlers.get("session_start");
			await sessionStart?.({ reason: "resume" }, ctx);

			// Notice already persisted: resume does not append, notify, or compact.
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(ctx.compact).not.toHaveBeenCalled();
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringMatching(/Compacting context/),
				"info",
			);
		});

		it("waits for the next turn after an idle model switch", async () => {
			const { handlers, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 0);
			const setStatus = vi.fn();
			const ctx = fakeCtx([branch], {
				ui: { notify: vi.fn(), setStatus },
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});
			await handlers.get("model_select")?.(
				{
					type: "model_select",
					source: "set",
					model: { provider: "b", id: "b" },
					previousModel: { provider: "a", id: "a" },
				},
				ctx,
			);
			await vi.advanceTimersByTimeAsync(5000);
			expect(setStatus).toHaveBeenCalledWith(
				"om-model-switch",
				"Switched model. Next turn will compact context.",
			);
			expect(ctx.compact).not.toHaveBeenCalled();
			expect(pi.appendEntry).not.toHaveBeenCalled();

			await handlers.get("input")?.({ type: "input" }, ctx);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({ text: "Switched model. Compacting context." }),
			);
			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(setStatus).toHaveBeenCalledWith("om-model-switch", undefined);
		});

		it("does not arm model-switch compaction while a turn is running", async () => {
			const { handlers } = captureHandler({
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 0);
			const setStatus = vi.fn();
			const ctx = fakeCtx([branch], {
				ui: { notify: vi.fn(), setStatus },
				isIdle: vi.fn(() => false),
			});
			await handlers.get("model_select")?.(
				{
					type: "model_select",
					source: "set",
					model: { provider: "b", id: "b" },
					previousModel: { provider: "a", id: "a" },
				},
				ctx,
			);
			expect(setStatus).not.toHaveBeenCalled();
		});

		it("cancels a pending model-switch compaction when switching back", async () => {
			const { handlers, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 0);
			const setStatus = vi.fn();
			const ctx = fakeCtx([branch], {
				ui: { notify: vi.fn(), setStatus },
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});
			const modelSelect = handlers.get("model_select");
			const base = { type: "model_select", source: "cycle" as const };
			await modelSelect?.(
				{ ...base, model: { provider: "b", id: "b" }, previousModel: { provider: "a", id: "a" } },
				ctx,
			);
			await modelSelect?.(
				{ ...base, model: { provider: "a", id: "a" }, previousModel: { provider: "b", id: "b" } },
				ctx,
			);
			await handlers.get("input")?.({ type: "input" }, ctx);
			expect(setStatus).toHaveBeenLastCalledWith("om-model-switch", undefined);
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("ignores model restore", async () => {
			const { handlers } = captureHandler({
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 0);
			const setStatus = vi.fn();
			const ctx = fakeCtx([branch], { ui: { notify: vi.fn(), setStatus } });
			await handlers.get("model_select")?.(
				{
					type: "model_select",
					source: "restore",
					model: { provider: "b", id: "b" },
					previousModel: { provider: "a", id: "a" },
				},
				ctx,
			);
			expect(setStatus).not.toHaveBeenCalled();
		});

		it("skips compaction on input if idle threshold has not been exceeded", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 10);
			const ctx = fakeCtx([branch]);

			const inputHandler = handlers.get("input");
			expect(inputHandler).toBeDefined();

			await inputHandler?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("skips compaction on input if idleCompactionTtlSeconds is undefined", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: undefined,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 3600, "some text");
			const ctx = fakeCtx([branch]);

			const inputHandler = handlers.get("input");
			await inputHandler?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("does not compact a short conversation on the next message", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 120, "short message");
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			const inputHandler = handlers.get("input");
			await inputHandler?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("follows Pi keepRecentTokens when it is above 20_000", async () => {
			const nowSec = Math.floor(Date.now() / 1000);
			const { handlers } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				keepRecentTokens: 40_000,
			});
			const below = fakeCtx([makeIdleBranch(nowSec, 120)], {
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});
			await handlers.get("input")?.({}, below);
			expect(below.compact).not.toHaveBeenCalled();

			const above = fakeCtx([makeIdleBranch(nowSec, 120, "x".repeat(200_000))], {
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});
			await handlers.get("input")?.({}, above);
			expect(above.compact).toHaveBeenCalledTimes(1);
		});

		it("does not arm model-switch compaction when idle TTL is disabled", async () => {
			const { handlers } = captureHandler({ idleCompactionTtlSeconds: undefined });
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 0);
			const setStatus = vi.fn();
			const ctx = fakeCtx([branch], { ui: { notify: vi.fn(), setStatus } });
			await handlers.get("model_select")?.(
				{
					type: "model_select",
					source: "set",
					model: { provider: "b", id: "b" },
					previousModel: { provider: "a", id: "a" },
				},
				ctx,
			);
			expect(setStatus).not.toHaveBeenCalled();
		});

		it("silently handles Nothing to compact without notifying UI error", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 120);
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) =>
					opts?.onError?.({ message: "Compaction failed: Nothing to compact (session too small)" }),
				),
			});

			const inputHandler = handlers.get("input");
			await inputHandler?.({}, ctx);

			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringContaining("Nothing to compact"),
				"error",
			);
			expect(runtime.compactInFlight).toBe(false);
			expect(runtime.idleCompactInFlight).toBe(false);
		});

		it("skips compaction on input if foldLedger has no observations or reflections", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "message without memory projection", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "message without memory projection" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
			];
			const ctx = fakeCtx([branch]);

			const inputHandler = handlers.get("input");
			await inputHandler?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("skips compaction on input if no new source entries exist after previous compaction", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "hello", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
				validObsEntry,
				compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			];
			const ctx = fakeCtx([branch]);

			const inputHandler = handlers.get("input");
			await inputHandler?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("skips compaction on input while session gate is off", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "some text for token estimation", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "some text for token estimation" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
				validObsEntry,
				gateEntry("gate-1", false),
			];
			const ctx = fakeCtx([branch]);

			const inputHandler = handlers.get("input");
			await inputHandler?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("awaits in-flight consolidation on input before compacting and re-reads branch", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branchBefore = makeIdleBranch(nowSec, 120);
			const branchAfter = [...branchBefore, rawMessage("raw-2", "world")];
			const ctx = fakeCtx([branchBefore, branchAfter], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			let resolveConsolidation: () => void = () => {};
			runtime.consolidationInFlight = true;
			runtime.consolidationPromise = new Promise<void>((resolve) => {
				resolveConsolidation = resolve;
			});

			const inputHandler = handlers.get("input");
			const promise = inputHandler?.({}, ctx);

			// Consolidation in-flight: compact not called yet
			expect(ctx.compact).not.toHaveBeenCalled();

			// Resolve consolidation
			runtime.consolidationInFlight = false;
			resolveConsolidation();
			await promise;

			// Now idle compaction proceeds with the updated branch and calls ctx.compact
			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not mutate new session flags when old compaction callback completes after session replacement", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 120);
			let capturedCallbacks: {
				onComplete?: () => void;
				onError?: (err: { message: string }) => void;
			} = {};
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts: typeof capturedCallbacks) => {
					capturedCallbacks = opts;
				}),
			});

			const inputHandler = handlers.get("input");
			const promise = inputHandler?.({}, ctx);

			expect(runtime.compactInFlight).toBe(true);
			expect(runtime.idleCompactInFlight).toBe(true);

			// New session begins: new session resets flags and starts its own state
			runtime.sessionGeneration = 1;
			runtime.compactInFlight = true;
			runtime.idleCompactInFlight = true;

			// Old compaction completes after session replacement
			capturedCallbacks.onComplete?.();
			await promise;

			// Flags must NOT be cleared by the old callback because generation is now 1
			expect(runtime.compactInFlight).toBe(true);
			expect(runtime.idleCompactInFlight).toBe(true);
		});

		it("rearms the idle timer after compaction is cancelled", async () => {
			const { handlers, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 120);
			const ctx = fakeCtx([branch]);
			runtime.compactInFlight = true;
			runtime.idleCompactInFlight = true;
			await handlers.get("session_compact_failed")?.(
				{
					type: "session_compact_failed",
					reason: "manual",
					aborted: true,
					willRetry: false,
					fromExtension: false,
				},
				ctx,
			);
			runtime.compactInFlight = false;
			runtime.idleCompactInFlight = false;
			await vi.advanceTimersByTimeAsync(0);

			expect(runtime.pendingIdleNoticeTimer).toBeDefined();
			expect(pi.appendEntry).not.toHaveBeenCalled();
			await handlers.get("before_agent_start")?.({}, ctx);
			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.pendingIdleNoticeTimer).toBeUndefined();

			const settled = handlers.get("agent_settled");
			await settled?.({ type: "agent_settled" }, ctx);
			expect(runtime.pendingIdleNoticeTimer).toBeDefined();
			await vi.advanceTimersByTimeAsync(59_000);
			expect(pi.appendEntry).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(/Next turn will compact context/),
				}),
			);
		});

		it("does not start the idle countdown below 20_000 tokens", async () => {
			const { handler, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = makeIdleBranch(nowSec, 0, "short");
			const ctx = fakeCtx([branch]);

			handler(agentSettled(), ctx);

			expect(runtime.pendingIdleNoticeTimer).toBeUndefined();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(pi.appendEntry).not.toHaveBeenCalled();
		});

		it("canPiCompact matches the 20_000 floor and a higher keep window", () => {
			const short = [rawMessage("user-1", "hi"), rawMessage("asst-1", "hello")];
			expect(canPiCompact(short)).toBe(false);
			const mid = [
				rawMessage("user-1", "x".repeat(90_000)),
				rawMessage("asst-1", "y".repeat(90_000), {
					message: { role: "assistant", content: [{ type: "text", text: "y".repeat(90_000) }] },
				}),
			];
			expect(canPiCompact(mid)).toBe(true);
			expect(canPiCompact(mid, 80_000)).toBe(false);
		});

		it("keeps the idle clock after an aborted turn", async () => {
			const { handlers, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				...makeIdleBranch(nowSec, 40),
				rawMessage("user-abort", "stop", {
					timestamp: new Date(nowSec * 1000).toISOString(),
				}),
				rawMessage("asst-abort", "partial", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "partial" }],
						stopReason: "aborted",
					},
					timestamp: new Date(nowSec * 1000).toISOString(),
				}),
			];
			const ctx = fakeCtx([branch]);

			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

			expect(runtime.pendingIdleNoticeTimer).toBeDefined();
			await vi.advanceTimersByTimeAsync(19_000);
			expect(pi.appendEntry).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(/Next turn will compact context/),
				}),
			);
		});

		it("does not compact from before_agent_start once the run is active", async () => {
			const { handlers } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 120);
			const ctx = fakeCtx([branch], {
				isIdle: vi.fn(() => false),
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});
			await handlers.get("before_agent_start")?.({}, ctx);
			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("does not compact from input while a turn is already running", async () => {
			const { handlers } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 120);
			const ctx = fakeCtx([branch], {
				isIdle: vi.fn(() => false),
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});
			await handlers.get("input")?.({}, ctx);
			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("does not restart the idle clock when a non-idle compaction is cancelled", async () => {
			const { handlers, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const branch = makeIdleBranch(Math.floor(Date.now() / 1000), 120);
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts: { onComplete?: () => void }) => opts?.onComplete?.()),
			});
			runtime.compactInFlight = true;
			await handlers.get("session_compact_failed")?.(
				{
					type: "session_compact_failed",
					reason: "threshold",
					aborted: true,
					willRetry: false,
					fromExtension: false,
				},
				ctx,
			);
			runtime.compactInFlight = false;
			await vi.advanceTimersByTimeAsync(0);

			expect(runtime.idleClockResetSec).toBeUndefined();
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(/Next turn will compact context/),
				}),
			);
			await handlers.get("input")?.({}, ctx);
			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});
	});
});
