import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
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

		it("formats idle duration correctly", () => {
			expect(formatIdleDuration(0)).toBe("0s");
			expect(formatIdleDuration(45)).toBe("45s");
			expect(formatIdleDuration(60)).toBe("1m");
			expect(formatIdleDuration(95)).toBe("1m 35s");
			expect(formatIdleDuration(1800)).toBe("30m");
			expect(formatIdleDuration(3600)).toBe("1h");
			expect(formatIdleDuration(3665)).toBe("1h 1m");
			expect(formatIdleDuration(7200)).toBe("2h");
			expect(formatIdleDuration(86400)).toBe("1d");
			expect(formatIdleDuration(90000)).toBe("1d 1h");
		});

		it("notifies user directly once idle timeout expires without running compaction", async () => {
			const { handler, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "some text for token estimation", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "some text for token estimation" }],
					},
					timestamp: new Date(nowSec * 1000).toISOString(),
				}),
				validObsEntry,
			];
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

		it("does not repeat notice in before_agent_start when already notified at timeout", async () => {
			const { handler, handlers, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "some text for token estimation", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "some text for token estimation" }],
					},
					timestamp: new Date(nowSec * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			handler(agentSettled(), ctx);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(runtime.idleNoticeEmitted).toBe(true);

			// User starts the next turn
			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			// Compaction runs before the turn
			expect(ctx.compact).toHaveBeenCalledTimes(1);
			// Notification was ONE-OFF: appendEntry is not called again
			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		});

		it("checks cold context in before_agent_start and compacts before starting turn if idle threshold exceeded", async () => {
			const { handlers, runtime, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
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
			];
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			const beforeAgentStart = handlers.get("before_agent_start");
			expect(beforeAgentStart).toBeDefined();

			await beforeAgentStart?.({}, ctx);

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
			const branch = [
				rawMessage("raw-1", "some text for token estimation", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "some text for token estimation" }],
					},
					timestamp: new Date((nowSec - 40) * 1000).toISOString(),
				}),
				validObsEntry,
			];
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

		it("emits notice immediately on resume or fork when already past idle TTL", async () => {
			const { handlers, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			// Settled 120s ago (already > 60s TTL)
			const branch = [
				rawMessage("raw-1", "some text for token estimation", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "some text for token estimation" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const ctx = fakeCtx([branch]);

			const sessionStart = handlers.get("session_start");
			await sessionStart?.({ reason: "fork" }, ctx);

			// Immediately emitted on start/fork without waiting
			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				OM_IDLE_NOTICE,
				expect.objectContaining({
					text: expect.stringMatching(
						/The conversation has idled for 2m. Next turn will compact context./,
					),
				}),
			);
		});

		it("does not duplicate notice on resume if notice was already persisted in branch", async () => {
			const { handlers, pi } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
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
				{
					type: "custom",
					id: "notice-1",
					parentId: null,
					customType: OM_IDLE_NOTICE,
					data: { text: "already notified" },
					timestamp: new Date((nowSec - 60) * 1000).toISOString(),
				},
			];
			const ctx = fakeCtx([branch]);

			const sessionStart = handlers.get("session_start");
			await sessionStart?.({ reason: "resume" }, ctx);

			// Notice already persisted: zero new appendEntry calls
			expect(pi.appendEntry).not.toHaveBeenCalled();
		});

		it("skips compaction in before_agent_start if idle threshold has not been exceeded", async () => {
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
					timestamp: new Date((nowSec - 10) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const ctx = fakeCtx([branch]);

			const beforeAgentStart = handlers.get("before_agent_start");
			expect(beforeAgentStart).toBeDefined();

			await beforeAgentStart?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("skips compaction in before_agent_start if idleCompactionTtlSeconds is undefined", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: undefined,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "some text", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "some text" }],
					},
					timestamp: new Date((nowSec - 3600) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const ctx = fakeCtx([branch]);

			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("skips idle compaction for short conversations below compaction cap", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "short message", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "short message" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			// Below default keepRecentTokens (20_000), compaction must not be called
			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("silently handles Nothing to compact without notifying UI error", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branch = [
				rawMessage("raw-1", "some text", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "some text" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) =>
					opts?.onError?.({ message: "Compaction failed: Nothing to compact (session too small)" }),
				),
			});

			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
				expect.stringContaining("Nothing to compact"),
				"error",
			);
			expect(runtime.compactInFlight).toBe(false);
			expect(runtime.idleCompactInFlight).toBe(false);
		});

		it("skips compaction in before_agent_start if foldLedger has no observations or reflections", async () => {
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

			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("skips compaction in before_agent_start if no new source entries exist after previous compaction", async () => {
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

			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("skips compaction in before_agent_start while session gate is off", async () => {
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

			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("counts wait_jobs duration towards idle lifespan in before_agent_start", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			// Only 10s elapsed since last settle, but wait_jobs waited 70s -> total 80s > 60s TTL
			const branch = [
				rawMessage("raw-1", "hello", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
					timestamp: new Date((nowSec - 10) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			const toolStart = handlers.get("tool_execution_start");
			const toolEnd = handlers.get("tool_execution_end");
			expect(toolStart).toBeDefined();
			expect(toolEnd).toBeDefined();

			const startMs = 10000;
			toolStart?.({ toolName: "wait_jobs" }, ctx);
			runtime.currentWaitJobsStartMs = startMs;
			runtime.recordWaitJobsEnd(startMs + 70_000); // 70s wait

			const beforeAgentStart = handlers.get("before_agent_start");
			await beforeAgentStart?.({}, ctx);

			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(runtime.compactInFlight).toBe(false);
		});

		it("awaits in-flight consolidation in before_agent_start before compacting and re-reads branch", async () => {
			const { handlers, runtime } = captureHandler({
				compactAfterTokens: 100_000,
				idleCompactionTtlSeconds: 60,
				idleCompactionMinTokens: 1,
			});
			const nowSec = Math.floor(Date.now() / 1000);
			const branchBefore = [
				rawMessage("raw-1", "hello", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			const branchAfter = [...branchBefore, rawMessage("raw-2", "world")];
			const ctx = fakeCtx([branchBefore, branchAfter], {
				compact: vi.fn((opts) => opts?.onComplete?.()),
			});

			let resolveConsolidation: () => void = () => {};
			runtime.consolidationInFlight = true;
			runtime.consolidationPromise = new Promise<void>((resolve) => {
				resolveConsolidation = resolve;
			});

			const beforeAgentStart = handlers.get("before_agent_start");
			const promise = beforeAgentStart?.({}, ctx);

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
			const branch = [
				rawMessage("raw-1", "hello", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
					timestamp: new Date((nowSec - 120) * 1000).toISOString(),
				}),
				validObsEntry,
			];
			let capturedCallbacks: {
				onComplete?: () => void;
				onError?: (err: { message: string }) => void;
			} = {};
			const ctx = fakeCtx([branch], {
				compact: vi.fn((opts: typeof capturedCallbacks) => {
					capturedCallbacks = opts;
				}),
			});

			const beforeAgentStart = handlers.get("before_agent_start");
			const promise = beforeAgentStart?.({}, ctx);

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
	});
});
