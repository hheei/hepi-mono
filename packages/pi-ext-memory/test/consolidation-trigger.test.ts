import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/dropper/agent.js")>()),
	runDropper: mockAgents.runDropper,
}));

import { ObserverStreamError } from "../src/agents/observer/agent.js";
import { DEFAULTS } from "../src/config.js";
import {
	registerConsolidationTrigger,
	runForcedConsolidation,
} from "../src/hooks/consolidation-trigger.js";
import type { ResolveResult, Runtime } from "../src/runtime.js";
import { fmtLocal } from "../src/serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
	summaryOverheadTokens,
} from "../src/session-ledger/index.js";
import { observationLineTokenCount, reflectionLineTokenCount } from "../src/tokens.js";
import { testModel } from "./fixtures/model.js";
import {
	gateEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	type TestEntry,
	textCustomMessage,
} from "./fixtures/session.js";

/** Console Go's endpoint: the base URL the x-opencode-session header rule keys off. */
const ZEN_BASE_URL = "https://opencode.ai/zen/go/v1";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runReflector.mockReset();
	mockAgents.runDropper.mockReset();
	mockAgents.runObserver.mockResolvedValue(undefined);
	mockAgents.runReflector.mockResolvedValue(undefined);
	mockAgents.runDropper.mockResolvedValue(undefined);
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	observerChunkMaxTokens?: number;
	observationsPoolMaxTokens?: number;
	observationsPoolTargetTokens?: number;
	memoryMaxTokens?: number;
	showWorkerNotifications?: boolean;
	passive?: boolean;
	consolidationInFlight?: boolean;
	appendEntryReturnsId?: boolean;
	sessionId?: string;
}) {
	let entries = [...args.entries];
	let sessionId = args.sessionId ?? "session-1";
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [
				...entries,
				{
					type: "custom",
					id,
					parentId: entries.at(-1)?.id ?? null,
					timestamp: "2026-05-02T10:00:00.000Z",
					customType,
					data,
				},
			];
			return args.appendEntryReturnsId === false ? undefined : id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	const runtime = {
		configLoaded: true,
		config: {
			...DEFAULTS,
			showWorkerNotifications: args.showWorkerNotifications ?? true,
			passive: args.passive ?? false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			reflectAfterTokens: args.reflectAfterTokens ?? 1,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 100,
			observationsPoolTargetTokens:
				args.observationsPoolTargetTokens ??
				Math.floor((args.observationsPoolMaxTokens ?? 100) / 2),
			memoryMaxTokens: args.memoryMaxTokens,
			agentMaxTurns: 9,
			agentMaxTokens: 32000,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
		},
		consolidationInFlight: args.consolidationInFlight ?? false,
		consolidationPhase: undefined as "observer" | "reflector" | "dropper" | "enforcer" | undefined,
		workerCost: { totalUsd: 0, runs: { observer: 0, reflector: 0, dropper: 0 } },
		resolveFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		lastDropperError: undefined as string | undefined,
		lastEnforcerError: undefined as string | undefined,
		lifecycleSignal: undefined as AbortSignal | undefined,
		observerEmptyBackoff: undefined as Runtime["observerEmptyBackoff"],
		ensureConfig: vi.fn(),
		isSessionCurrent: vi.fn(() => true),
		resolveModel: vi.fn<() => Promise<ResolveResult>>(async () => ({
			ok: true,
			model: testModel({ provider: "anthropic", id: "memory", reasoning: true }),
			apiKey: "key",
			headers: { h: "v" },
		})),
		launchConsolidationTask: vi.fn((_ctx, work) => {
			runtime.consolidationInFlight = true;
			launchedWork = work;
			return Promise.resolve();
		}),
		recordWorkerRun: vi.fn((stage: "observer" | "reflector" | "dropper") => {
			runtime.workerCost.runs[stage] += 1;
		}),
		recordWorkerCost: vi.fn((costUsd: number) => {
			if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
			runtime.workerCost.totalUsd += costUsd;
			return costUsd;
		}),
		recordConsolidationStageError: vi.fn(
			(ctx, phase: "observer" | "reflector" | "dropper" | "enforcer", error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (phase === "observer") runtime.lastObserverError = message;
				if (phase === "reflector") runtime.lastReflectorError = message;
				if (phase === "dropper") runtime.lastDropperError = message;
				if (phase === "enforcer") runtime.lastEnforcerError = message;
				ctx.ui?.notify(`om: ${phase} failed: ${message}`, "warning");
				return message;
			},
		),
	};
	registerConsolidationTrigger(pi as any, runtime as any);
	if (!handlers.agent_start) throw new Error("agent_start consolidation handler not registered");
	if (!handlers.turn_end) throw new Error("turn_end consolidation handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: testModel({ provider: "session", id: "session" }),
		modelRegistry: {
			streamSimple: () => {
				throw new Error("this harness never streams a worker call");
			},
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => sessionId,
		},
	};
	return {
		pi,
		runtime,
		ctx,
		fire: (eventName = "turn_end") => handlers[eventName]!(undefined, ctx),
		fireAgentStart: () => handlers.agent_start!(undefined, ctx),
		fireTurnEnd: () => handlers.turn_end!(undefined, ctx),
		runLaunchedWork: async () => launchedWork?.(),
		addEntries: (...more: TestEntry[]) => {
			entries = [...entries, ...more];
		},
		setSessionId: (next: string) => {
			sessionId = next;
		},
		getEntries: () => entries,
	};
}

describe("V3 consolidation trigger", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("registers agent_start and turn_end consolidation entrypoints", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { pi } = setup({ entries });

		expect(pi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("does not launch below all thresholds from either entrypoint", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "raw-1",
			}),
		];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({
			entries,
			observeAfterTokens: 10,
			reflectAfterTokens: 10,
		});

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint in passive mode", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const passive = setup({ entries, passive: true });

		passive.fireAgentStart();
		passive.fireTurnEnd();

		expect(passive.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint while consolidation is already in flight", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const locked = setup({ entries, consolidationInFlight: true });

		locked.fireAgentStart();
		locked.fireTurnEnd();

		expect(locked.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("launches from agent_start when work is due", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, runtime } = setup({ entries });

		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when agent_start fires before turn_end", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when turn_end fires before agent_start", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireTurnEnd();
		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("runs observer first and appends source-addressed observations", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalled();
		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedSourceEntryIds: ["raw-1"],
				maxTurns: 9,
				thinkingLevel: "minimal",
			}),
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, {
			observations: [obs],
			coversUpToId: "raw-1",
		});
	});

	it("forwards OAuth-shaped auth (headers, no apiKey) to the observer agent", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: testModel({ provider: "kimi-coding", id: "kimi-for-coding" }),
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: undefined,
				headers: { Authorization: "Bearer oauth-token" },
			}),
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, {
			observations: [obs],
			coversUpToId: "raw-1",
		});
	});

	it("adds x-opencode-session headers for opencode-go worker models", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({
			entries,
			reflectAfterTokens: 999,
			sessionId: "session-abc",
		});
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: testModel({
				provider: "opencode-go",
				id: "zen",
				baseUrl: ZEN_BASE_URL,
				reasoning: true,
			}),
			apiKey: "go-key",
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "go-key",
				headers: { "x-opencode-session": "session-abc", "x-opencode-client": "pi" },
			}),
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, {
			observations: [obs],
			coversUpToId: "raw-1",
		});
	});

	it("merges x-opencode-session with existing auth headers and preserves them", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, runtime } = setup({
			entries,
			reflectAfterTokens: 999,
			sessionId: "session-1",
		});
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: testModel({ provider: "opencode-go", id: "zen", baseUrl: ZEN_BASE_URL }),
			apiKey: "go-key",
			headers: { Authorization: "Bearer go-key" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: {
					Authorization: "Bearer go-key",
					"x-opencode-session": "session-1",
					"x-opencode-client": "pi",
				},
			}),
		);
	});

	it("detects opencode hosts by baseUrl even when provider is generic", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, runtime } = setup({
			entries,
			reflectAfterTokens: 999,
			sessionId: "session-1",
		});
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: testModel({ provider: "custom", id: "zen", baseUrl: ZEN_BASE_URL }),
			apiKey: "go-key",
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: { "x-opencode-session": "session-1", "x-opencode-client": "pi" },
			}),
		);
	});

	it("leaves headers untouched for non-opencode worker models", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, runtime } = setup({
			entries,
			reflectAfterTokens: 999,
			sessionId: "session-1",
		});
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: testModel({
				provider: "anthropic",
				id: "claude",
				baseUrl: "https://api.anthropic.com",
			}),
			apiKey: "k",
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "k",
				headers: undefined,
			}),
		);
	});

	it("uses existing observation coverage and retries larger ranges after no-output", async () => {
		const prior = observation("cccccccccccc", { sourceEntryIds: ["raw-1"] });
		const newObs = observation("dddddddddddd", { sourceEntryIds: ["raw-2"] });
		mockAgents.runObserver.mockResolvedValueOnce([newObs]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-prior", { observations: [prior], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccc"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({ allowedSourceEntryIds: ["raw-2", "raw-3"] }),
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, {
			observations: [newObs],
			coversUpToId: "raw-3",
		});
	});

	it("observer no-output appends nothing and does not fake observation coverage", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("shows routine worker notifications by default", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^om: observer running on [\w.]+ tokens chunk$/), "info"],
			[expect.stringMatching(/^om: reflector running \([\w.]+ tokens\)$/), "info"],
			[
				expect.stringMatching(
					/^om: dropper running after reflection — active observation pool [\w.]+ \/ [\w.]+ target tokens \(\d+%\)$/,
				),
				"info",
			],
			["om: consolidation complete (+1 obs, +1 refl, -1 dropped)", "info"],
		]);
	});

	it("suppresses routine worker notifications without hiding warnings", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const quiet = setup({
			entries,
			observationsPoolTargetTokens: 5,
			showWorkerNotifications: false,
		});

		quiet.fire();
		await quiet.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
		expect(mockAgents.runDropper).toHaveBeenCalledOnce();
		expect(quiet.ctx.ui.notify).not.toHaveBeenCalled();

		// Deliberate empty is routine info: also hidden when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValueOnce(undefined);
		const noOutput = setup({ entries, reflectAfterTokens: 999, showWorkerNotifications: false });

		noOutput.fire();
		await noOutput.runLaunchedWork();

		expect(noOutput.ctx.ui.notify).not.toHaveBeenCalled();

		// Real failures still surface as warnings when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockRejectedValueOnce(
			new ObserverStreamError("error", "prompt is too long"),
		);
		const failed = setup({ entries, reflectAfterTokens: 999, showWorkerNotifications: false });

		failed.fire();
		await failed.runLaunchedWork();

		expect(failed.ctx.ui.notify).toHaveBeenCalledOnce();
		expect(failed.ctx.ui.notify.mock.calls[0]?.[1]).toBe("warning");
		expect(failed.ctx.ui.notify.mock.calls[0]?.[0]).toContain("observer failed");
	});

	it("reports deliberate empty as info, not a warning", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^om: observer running on [\w.]+ tokens chunk$/), "info"],
			[
				"om: observer found nothing new in this chunk (coverage unchanged; will retry later)",
				"info",
			],
		]);
	});

	it("backs off observer re-fires after a deliberate empty until enough new tokens arrive", async () => {
		const entries = [textCustomMessage("raw-1", "a".repeat(40))]; // 10 tokens
		const { fire, runLaunchedWork, addEntries, runtime } = setup({
			entries,
			observeAfterTokens: 10,
			reflectAfterTokens: 999,
		});

		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(runtime.observerEmptyBackoff).toEqual({
			sessionIdentity: "session-1",
			coverageId: undefined,
			tokensAtEmpty: 10,
		});

		// Same span, only 5 new tokens (< observeAfterTokens more): no re-fire.
		addEntries(textCustomMessage("raw-2", "b".repeat(20)));
		runtime.consolidationInFlight = false;
		fire();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(2);
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		// 10 more new tokens: backoff satisfied, observer re-fires over the grown span.
		addEntries(textCustomMessage("raw-3", "c".repeat(40)));
		runtime.consolidationInFlight = false;
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(runtime.observerEmptyBackoff).toBeUndefined();
	});

	it("does not apply deliberate-empty backoff to another session", async () => {
		const entries = [textCustomMessage("raw-1", "a".repeat(40))];
		const { fire, runLaunchedWork, runtime, setSessionId } = setup({
			entries,
			observeAfterTokens: 10,
			reflectAfterTokens: 999,
		});

		fire();
		await runLaunchedWork();
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		runtime.consolidationInFlight = false;
		setSessionId("session-2");
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
	});

	it("surfaces API stream errors as observer failure, never as empty", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(
			new ObserverStreamError("error", "prompt is too long: 5198507 tokens > 1000000 maximum"),
		);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(runtime.lastObserverError).toContain("prompt is too long");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'om: observer failed: observer stream ended with stopReason "error": prompt is too long: 5198507 tokens > 1000000 maximum',
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("no observations"),
			expect.anything(),
		);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.observerEmptyBackoff).toBeUndefined();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});

	it("model resolution failure skips appending and notifies once", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
		runtime.resolveModel.mockResolvedValueOnce({ ok: false, reason: "no model" });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("om: observer skipped — no model", "warning");
	});

	it("re-reads branch so observer append can unblock reflector in the same consolidation run", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(mockAgents.runReflector).toHaveBeenCalledWith(
			expect.objectContaining({ observations: [obsA] }),
		);
		expect(mockAgents.runObserver.mock.invocationCallOrder[0]!).toBeLessThan(
			mockAgents.runReflector.mock.invocationCallOrder[0]!,
		);
		expect(pi.appendEntry.mock.calls[0]).toEqual([
			OM_OBSERVATIONS_RECORDED,
			{ observations: [obsA], coversUpToId: "raw-1" },
		]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([
			OM_REFLECTIONS_RECORDED,
			{ reflections: [newRef], coversUpToId: "raw-1" },
		]);
	});

	it("runs reflector-only and appends non-empty reflections", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsDroppedEntry("om-drop", {
				observationIds: ["bbbbbbbbbbbb"],
				coversUpToId: "raw-2",
			}),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(
			expect.objectContaining({ observations: [obsA], maxTurns: 9, thinkingLevel: "minimal" }),
		);
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, {
			reflections: [newRef],
			coversUpToId: "raw-1",
		});
	});

	it("derives observation times from the chunk's own source entries", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa", { timestamp: "2026-05-02T01:00:00.000Z" }),
			textCustomMessage("raw-2", "bbbbbbbb", { timestamp: "2026-05-02T05:30:00.000Z" }),
		];
		const { fire, runLaunchedWork } = setup({ entries });

		fire();
		await runLaunchedWork();

		const args = mockAgents.runObserver.mock.calls[0]?.[0] as {
			resolveTimestamp: (ids: readonly string[]) => string;
		};
		// Earliest of the cited entries, in local time, to the minute.
		expect(args.resolveTimestamp(["raw-1", "raw-2"])).toBe(
			fmtLocal(new Date("2026-05-02T01:00:00.000Z")),
		);
		expect(args.resolveTimestamp(["raw-2"])).toBe(fmtLocal(new Date("2026-05-02T05:30:00.000Z")));
		// Earliest, not merely the first one listed.
		expect(args.resolveTimestamp(["raw-2", "raw-1"])).toBe(
			fmtLocal(new Date("2026-05-02T01:00:00.000Z")),
		);
		// No usable citation: the chunk's own last source entry stands in.
		expect(args.resolveTimestamp([])).toBe(fmtLocal(new Date("2026-05-02T05:30:00.000Z")));
	});

	it("falls back to the recorded time when the chunk reports no usable entry time", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa", { timestamp: "" }),
			textCustomMessage("raw-2", "bbbbbbbb", { timestamp: "not-a-time" }),
		];
		const { fire, runLaunchedWork } = setup({ entries });

		fire();
		await runLaunchedWork();

		const args = mockAgents.runObserver.mock.calls[0]?.[0] as {
			resolveTimestamp: (ids: readonly string[]) => string;
		};
		expect(args.resolveTimestamp(["raw-1", "raw-2"])).toMatch(
			/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$/,
		);
	});

	it("sizes the fallback from the entries that were sent, not from the whole backlog", async () => {
		// The chunk cap drops the second entry, so nothing may inherit its (later) time.
		const entries = [
			textCustomMessage("raw-1", "a".repeat(4000), { timestamp: "2026-05-02T01:00:00.000Z" }),
			textCustomMessage("raw-2", "b".repeat(4000), { timestamp: "2026-05-02T09:00:00.000Z" }),
		];
		const { fire, runLaunchedWork } = setup({ entries, observerChunkMaxTokens: 600 });

		fire();
		await runLaunchedWork();

		const args = mockAgents.runObserver.mock.calls[0]?.[0] as {
			allowedSourceEntryIds: string[];
			resolveTimestamp: (ids: readonly string[]) => string;
		};
		expect(args.allowedSourceEntryIds).toEqual(["raw-1"]);
		expect(args.resolveTimestamp([])).toBe(fmtLocal(new Date("2026-05-02T01:00:00.000Z")));
	});

	it("sizes the workers' memory view from the session model, not the worker's own window", async () => {
		const many = Array.from({ length: 40 }, (_value, index) =>
			observation(`a${index.toString(16).padStart(11, "0")}`, {
				content: "x".repeat(800),
				sourceEntryIds: ["raw-1"],
			}),
		);
		const test = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: many, coversUpToId: "raw-1" }),
				textCustomMessage("raw-2", "bbbbbbbb"),
			],
			observationsPoolMaxTokens: 100_000,
		});
		// The worker model's own window is small; the session model is the room memory has.
		test.runtime.resolveModel.mockResolvedValue({
			ok: true,
			model: testModel({ provider: "anthropic", id: "memory", contextWindow: 5_000 }),
			apiKey: "key",
			headers: {},
		});
		test.ctx.model = testModel({ provider: "session", id: "session", contextWindow: 200_000 });

		test.fire();
		await test.runLaunchedWork();

		const args = mockAgents.runReflector.mock.calls[0]?.[0] as { observations: unknown[] };
		// A 5,000-token worker window would cap visible memory at 4,000 tokens and trim these.
		expect(args.observations).toHaveLength(40);
	});

	it("weighs reflections in the pool by their rendered line", async () => {
		// 100 short reflections: content-only counting stays under the watermark while the
		// lines the summary would actually render push it over.
		const reflections = Array.from({ length: 100 }, (_value, index) =>
			reflection(`e${index.toString(16).padStart(11, "0")}`, ["dddddddddddd"], {
				content: "y".repeat(40),
				tokenCount: 10,
			}),
		);
		const heavy = observation("bbbbbbbbbbbb", { content: "d".repeat(1200), tokenCount: 10 });
		const test = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: [heavy], coversUpToId: "raw-1" }),
				reflectionsRecordedEntry("om-ref", { reflections, coversUpToId: "raw-1" }),
				textCustomMessage("raw-2", "bbbbbbbb"),
			],
			memoryMaxTokens: 1_000,
			observationsPoolTargetTokens: 100,
		});

		test.fire();
		await test.runLaunchedWork();

		const drops = test.pi.appendEntry.mock.calls.filter(
			([type]) => type === OM_OBSERVATIONS_DROPPED,
		);
		expect(drops).toHaveLength(1);
		expect(drops[0]?.[1]).toMatchObject({ observationIds: ["bbbbbbbbbbbb"] });
	});

	it("retires superseded reflections with a tombstone and keeps the ledger", async () => {
		const existing = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const merged = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [merged],
			supersededReflectionIds: ["eeeeeeeeeeee"],
		});
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [existing], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, {
			reflections: [merged],
			coversUpToId: "raw-1",
		});
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_DROPPED, {
			reflectionIds: ["eeeeeeeeeeee"],
			coversUpToId: "raw-1",
		});
	});

	it("writes only the tombstone when a merge produces no new reflection", async () => {
		const existing = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [],
			supersededReflectionIds: ["eeeeeeeeeeee"],
		});
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [existing], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi, ctx } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls).toEqual([
			[OM_REFLECTIONS_DROPPED, { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-1" }],
		]);
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		// The run delta reports the merge, not a new line.
		expect(ctx.ui.notify.mock.calls.some((call) => String(call[0]).includes("-1 superseded"))).toBe(
			true,
		);
	});

	it("hands the reflector the reflections that are permanently retired", async () => {
		// Only the reflector knows which proposal asked for which merge, so it decides what may be
		// retired; the stage's job is to tell it which ids are gone for good.
		const retired = reflection("aaaaaaaaaaaa", ["dddddddddddd"]);
		const current = reflection("eeeeeeeeeeee", ["dddddddddddd"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [],
			supersededReflectionIds: [],
		});
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", {
				reflections: [retired, current],
				coversUpToId: "raw-1",
			}),
			reflectionsDroppedEntry("om-retire", {
				reflectionIds: ["aaaaaaaaaaaa"],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledTimes(1);
		expect(mockAgents.runReflector.mock.calls[0]?.[0]).toMatchObject({
			droppedReflectionIds: new Set(["aaaaaaaaaaaa"]),
		});
	});

	it("gives the reflector the reflection share of the memory budget", async () => {
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [], supersededReflectionIds: [] });
		// A pool far over its target inside a small render budget, so the observations
		// take their share and the rest is what reflections may use.
		const observations = Array.from({ length: 20 }, (_value, index) =>
			observation(`a${index}`.padStart(12, "0"), { content: "x".repeat(200) }),
		);
		// Rendered lines, not the tokenCount field, decide the render budget.
		const existingReflections = Array.from({ length: 20 }, (_value, index) =>
			reflection(`e${index.toString(16).padStart(11, "0")}`, ["0000000000a0"], {
				content: "y".repeat(200),
			}),
		);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations, coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", {
				reflections: existingReflections,
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			memoryMaxTokens: 1_000,
		});

		fire();
		await runLaunchedWork();

		const args = mockAgents.runReflector.mock.calls[0]?.[0] as {
			reflectionBudgetTokens?: number;
			reflectionPool?: { count: number; tokens: number };
		};
		// The share is inside the render budget and non-zero, and the pool it is measured
		// against is the whole active pool, not the trimmed view.
		expect(args.reflectionBudgetTokens).toBeGreaterThan(0);
		expect(args.reflectionBudgetTokens).toBeLessThanOrEqual(1_000 - summaryOverheadTokens());
		// Pool weight is the rendered line, ids and newlines included.
		expect(args.reflectionPool).toEqual({
			count: 20,
			tokens: existingReflections.reduce((sum, r) => sum + reflectionLineTokenCount(r), 0),
		});
	});

	it("runs dropper after same-run non-empty reflector output and appends non-empty drops", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalledWith(
			expect.objectContaining({ reflections: [newRef], observations: [obsA] }),
		);
		expect(pi.appendEntry.mock.calls[0]).toEqual([
			OM_REFLECTIONS_RECORDED,
			{ reflections: [newRef], coversUpToId: "raw-1" },
		]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([
			OM_OBSERVATIONS_DROPPED,
			{ observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" },
		]);
	});

	it("does not launch dropper-only work when active pool is over target", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
		];
		const { fire, runtime } = setup({
			entries,
			observeAfterTokens: 999,
			reflectAfterTokens: 999,
			observationsPoolTargetTokens: 5,
		});

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("waits for successful reflection even when active observation pool is over target", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, runtime } = setup({
			entries,
			observeAfterTokens: 999,
			reflectAfterTokens: 1,
			observationsPoolTargetTokens: 5,
		});

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("does not launch dropper-only work when dropped tombstones reduce active pool below budget", () => {
		const heavy = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 100 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [heavy], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", {
				observationIds: ["cccccccccccc"],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-2" }),
		];
		const { fire, runtime } = setup({
			entries,
			observeAfterTokens: 999,
			reflectAfterTokens: 1,
			observationsPoolMaxTokens: 100,
		});

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("uses same-run reflection coverage for drop coverage", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolMaxTokens: 10,
		});

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[0]).toEqual([
			OM_REFLECTIONS_RECORDED,
			{ reflections: [newRef], coversUpToId: "raw-2" },
		]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([
			OM_OBSERVATIONS_DROPPED,
			{ observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" },
		]);
	});

	it("does not bootstrap dropper without same-run reflection output", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolMaxTokens: 10,
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not append reflect/drop entries without observation coverage", async () => {
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [reflection("ffffffffffff", ["aaaaaaaaaaaa"])],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("runs reflector before dropper and covers drops through same-run reflection coverage", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolMaxTokens: 10,
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).toHaveBeenCalledWith(
			expect.objectContaining({ reflections: [newRef] }),
		);
		expect(pi.appendEntry.mock.calls[0]).toEqual([
			OM_REFLECTIONS_RECORDED,
			{ reflections: [newRef], coversUpToId: "raw-2" },
		]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([
			OM_OBSERVATIONS_DROPPED,
			{ observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" },
		]);
	});

	it("does not use appended reflection entry id for drop coverage when appendEntry returns no id", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({
			entries,
			observeAfterTokens: 999,
			appendEntryReturnsId: false,
			observationsPoolMaxTokens: 10,
		});

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[1]).toEqual([
			OM_OBSERVATIONS_DROPPED,
			{ observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" },
		]);
	});

	it("appends no empty reflection or drop entries", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const { fire, runLaunchedWork, pi, ctx } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("dropper running"),
			"info",
		);
	});

	it("preserves stage failure boundaries", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("observe failed"));
		const observerFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		observerFailure.fire();
		await observerFailure.runLaunchedWork();
		expect(observerFailure.runtime.lastObserverError).toBe("observe failed");
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();

		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValue(undefined);
		mockAgents.runReflector.mockReset();
		mockAgents.runReflector.mockRejectedValueOnce(new Error("reflect failed"));
		const reflectorFailure = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			],
			observeAfterTokens: 999,
		});
		reflectorFailure.fire();
		await reflectorFailure.runLaunchedWork();
		expect(reflectorFailure.runtime.lastReflectorError).toBe("reflect failed");
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(reflectorFailure.pi.appendEntry).not.toHaveBeenCalled();

		mockAgents.runReflector.mockReset();
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce({
			reflections: [newRef],
			supersededReflectionIds: [],
		});
		mockAgents.runDropper.mockReset();
		mockAgents.runDropper.mockRejectedValueOnce(new Error("drop failed"));
		const dropperFailure = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			],
			observeAfterTokens: 999,
			observationsPoolMaxTokens: 10,
		});
		dropperFailure.fire();
		await dropperFailure.runLaunchedWork();
		expect(dropperFailure.runtime.lastDropperError).toBe("drop failed");
		expect(dropperFailure.pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(dropperFailure.pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, {
			reflections: [newRef],
			coversUpToId: "raw-1",
		});
	});
});

describe("observer chunk cap", () => {
	it("caps an oversized backlog and drains it incrementally across runs", async () => {
		const first = observation("111111111111", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		const second = observation("222222222222", { sourceEntryIds: ["raw-2"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
			textCustomMessage("raw-3", "c".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({
			entries,
			observerChunkMaxTokens: 256,
			reflectAfterTokens: 999,
		});

		fire();
		await runLaunchedWork();

		// Only the oldest entry fits under the cap; coverage advances to it, not to the backlog tail.
		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }),
		);
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, {
			observations: [first],
			coversUpToId: "raw-1",
		});

		// The next run continues from the advanced coverage.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ allowedSourceEntryIds: ["raw-2"] }),
		);
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, {
			observations: [second],
			coversUpToId: "raw-2",
		});
	});

	it("bounds one oversized tool result, preserves provenance, and continues on the next run", async () => {
		const first = observation("333333333333", { sourceEntryIds: ["raw-huge"], tokenCount: 4 });
		const second = observation("555555555555", { sourceEntryIds: ["raw-next"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const hugeText = `HEAD:${"m".repeat(2_000)}:TAIL`;
		const entries: TestEntry[] = [
			{
				type: "message",
				id: "raw-huge",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "bash",
					content: [{ type: "text", text: hugeText }],
					isError: false,
					timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
				},
			},
			textCustomMessage("raw-next", "later"),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({
			entries,
			observerChunkMaxTokens: 100,
			reflectAfterTokens: 999,
		});

		fire();
		await runLaunchedWork();

		const firstCall = mockAgents.runObserver.mock.calls[0]![0];
		expect(firstCall.allowedSourceEntryIds).toEqual(["raw-huge"]);
		expect(firstCall.chunk).toContain("HEAD:");
		expect(firstCall.chunk).toContain(":TAIL");
		expect(firstCall.chunk).toContain("middle omitted: source exceeds observer input budget");
		expect(firstCall.chunk).not.toContain("raw-next");
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, {
			observations: [first],
			coversUpToId: "raw-huge",
		});

		// The source id still points at the full ledger entry; the next run starts
		// after it instead of retrying the oversized input forever.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ allowedSourceEntryIds: ["raw-next"] }),
		);
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, {
			observations: [second],
			coversUpToId: "raw-next",
		});
	});

	it("derives the cap from the resolved model's context window when not configured", async () => {
		const obs = observation("444444444444", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });
		// contextWindow 1,280 -> cap = floor(1,280 * 0.2) = 256, so only raw-1 fits.
		runtime.resolveModel.mockResolvedValue({
			ok: true,
			model: testModel({
				provider: "anthropic",
				id: "memory",
				reasoning: true,
				contextWindow: 1_280,
			}),
			apiKey: "key",
			headers: { h: "v" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(
			expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }),
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_RECORDED,
			expect.objectContaining({ coversUpToId: "raw-1" }),
		);
	});

	describe("lifecycle signal propagation", () => {
		it("passes runtime.lifecycleSignal down to runObserver, runReflector, and runDropper", async () => {
			const controller = new AbortController();
			const localObs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
			const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
			mockAgents.runObserver.mockResolvedValueOnce([localObs]);
			mockAgents.runReflector.mockResolvedValueOnce({
				reflections: [newRef],
				supersededReflectionIds: [],
			});
			mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);

			const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
			const { fire, runLaunchedWork, runtime } = setup({
				entries,
				observationsPoolTargetTokens: 5,
				showWorkerNotifications: false,
			});
			runtime.lifecycleSignal = controller.signal;

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalledWith(
				expect.objectContaining({ signal: controller.signal }),
			);
			expect(mockAgents.runReflector).toHaveBeenCalledWith(
				expect.objectContaining({ signal: controller.signal }),
			);
			expect(mockAgents.runDropper).toHaveBeenCalledWith(
				expect.objectContaining({ signal: controller.signal }),
			);
		});

		it("aborts cleanly when signal is already aborted without appending entries or notifying errors", async () => {
			const controller = new AbortController();
			controller.abort();

			const entries = [textCustomMessage("raw-1", "a".repeat(800))];
			const { fire, runLaunchedWork, pi, runtime, ctx } = setup({
				entries,
				showWorkerNotifications: false,
			});
			runtime.lifecycleSignal = controller.signal;

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).not.toHaveBeenCalled();
			expect(mockAgents.runReflector).not.toHaveBeenCalled();
			expect(mockAgents.runDropper).not.toHaveBeenCalled();
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(ctx.ui.notify).not.toHaveBeenCalled();
		});

		it("aborts immediately if signal is aborted during observer stage without error warnings", async () => {
			const controller = new AbortController();
			mockAgents.runObserver.mockImplementationOnce(
				async ({ signal }: { signal?: AbortSignal }) => {
					controller.abort();
					expect(signal?.aborted).toBe(true);
					return undefined;
				},
			);

			const entries = [textCustomMessage("raw-1", "a".repeat(800))];
			const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
			runtime.lifecycleSignal = controller.signal;

			fire();
			await runLaunchedWork();

			expect(mockAgents.runObserver).toHaveBeenCalled();
			expect(mockAgents.runReflector).not.toHaveBeenCalled();
			expect(mockAgents.runDropper).not.toHaveBeenCalled();
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("failed"), "warning");
		});

		it("silently aborts when appendEntry throws a stale context error", async () => {
			mockAgents.runObserver.mockResolvedValueOnce([
				{
					id: "obs_000000000001",
					text: "Observation text",
					tokenCount: 10,
					sourceTokenCount: 100,
				},
			]);

			const entries = [textCustomMessage("raw-1", "a".repeat(800))];
			const { fire, runLaunchedWork, pi, ctx } = setup({ entries });
			pi.appendEntry.mockImplementationOnce(() => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			});

			fire();
			await expect(runLaunchedWork()).resolves.toBeUndefined();

			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("failed"), "warning");
		});
	});
});

describe("forced consolidation and worker accounting", () => {
	const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
	const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
	const highThresholds = { observeAfterTokens: 1_000_000, reflectAfterTokens: 1_000_000 };

	it("runs below the thresholds when forced", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		mockAgents.runReflector.mockResolvedValueOnce([ref]);
		const harness = setup({ entries, ...highThresholds });

		await runForcedConsolidation(
			harness.pi as never,
			harness.runtime as unknown as Runtime,
			harness.ctx,
		);
		await harness.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
	});

	it("leaves the same below-threshold work alone on the automatic path", async () => {
		const harness = setup({ entries, ...highThresholds });

		harness.fire();
		await harness.runLaunchedWork();

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
	});

	it("clears the deliberate-empty backoff when the operator forces a run", async () => {
		const harness = setup({ entries, ...highThresholds });
		harness.runtime.observerEmptyBackoff = {
			sessionIdentity: "session-1",
			coverageId: undefined,
			tokensAtEmpty: 1,
		};

		await runForcedConsolidation(
			harness.pi as never,
			harness.runtime as unknown as Runtime,
			harness.ctx,
		);
		await harness.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
	});

	it("does not launch when the session gate is off", async () => {
		const harness = setup({ entries: [...entries, gateEntry("gate-1", false)] });

		harness.fire();
		await harness.runLaunchedWork();

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
	});

	it("counts one run per stage and accumulates reported cost", async () => {
		mockAgents.runObserver.mockImplementationOnce(
			async (args: { onCost?: (usd: number) => void }) => {
				args.onCost?.(0.0025);
				return [obs];
			},
		);
		mockAgents.runReflector.mockImplementationOnce(
			async (args: { onCost?: (usd: number) => void }) => {
				args.onCost?.(0.001);
				return { reflections: [ref], supersededReflectionIds: [] };
			},
		);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const harness = setup({ entries, observationsPoolTargetTokens: 5 });

		harness.fire();
		await harness.runLaunchedWork();

		expect(harness.runtime.workerCost.runs).toEqual({ observer: 1, reflector: 1, dropper: 1 });
		expect(harness.runtime.workerCost.totalUsd).toBeCloseTo(0.0035, 10);
	});

	it("reports the run delta and the cost of that run", async () => {
		mockAgents.runObserver.mockImplementationOnce(
			async (args: { onCost?: (usd: number) => void }) => {
				args.onCost?.(0.0025);
				return [obs];
			},
		);
		const harness = setup({ entries });

		harness.fire();
		await harness.runLaunchedWork();

		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
			"om: consolidation complete (+1 obs) · $0.0025",
			"info",
		);
	});

	it("leaves the observer alone when a forced run has no new conversation", async () => {
		const harness = setup({
			entries: [
				...entries,
				observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			],
			...highThresholds,
		});

		await runForcedConsolidation(
			harness.pi as never,
			harness.runtime as unknown as Runtime,
			harness.ctx,
		);
		await harness.runLaunchedWork();

		// Nothing uncovered: an observer call could only answer "nothing".
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		// The reflector still re-reads the existing observations that force asked for.
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
	});

	it("does not bill a replaced session for a worker that outlives it", async () => {
		const harness = setup({ entries, ...highThresholds });
		mockAgents.runObserver.mockImplementationOnce(
			async (args: { onCost?: (usd: number) => void }) => {
				// The session is replaced while the worker's stream is still draining; the
				// provider still reports the usage of that final request.
				harness.runtime.isSessionCurrent.mockReturnValue(false);
				args.onCost?.(0.0025);
				return [obs];
			},
		);

		await runForcedConsolidation(
			harness.pi as never,
			harness.runtime as unknown as Runtime,
			harness.ctx,
		);
		await harness.runLaunchedWork();

		expect(harness.runtime.recordWorkerCost).not.toHaveBeenCalled();
		expect(harness.runtime.workerCost.totalUsd).toBe(0);
	});

	it("keeps the late cost of an earlier run out of the next run's summary", async () => {
		const harness = setup({ entries, ...highThresholds });
		let staleOnCost: ((usd: number) => void) | undefined;
		mockAgents.runObserver.mockImplementationOnce(
			async (args: { onCost?: (usd: number) => void }) => {
				// First run: the stream is still open when the pipeline gets awaited.
				staleOnCost = args.onCost;
				return [];
			},
		);

		const runOnce = () =>
			runForcedConsolidation(
				harness.pi as never,
				harness.runtime as unknown as Runtime,
				harness.ctx,
			);
		await runOnce();
		await harness.runLaunchedWork();

		mockAgents.runObserver.mockImplementationOnce(
			async (args: { onCost?: (usd: number) => void }) => {
				// The first run's worker reports its final usage event during the second run.
				staleOnCost?.(0.0025);
				args.onCost?.(0);
				return [obs];
			},
		);
		await runOnce();
		await harness.runLaunchedWork();

		// The money was spent in this session, so the session total does count it...
		expect(harness.runtime.workerCost.totalUsd).toBe(0.0025);
		// ...but the second run must not present it as its own.
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
			"om: consolidation complete (+1 obs)",
			"info",
		);
	});

	it("stays silent when a completed run changed nothing", async () => {
		const harness = setup({ entries });

		harness.fire();
		await harness.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(harness.ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("consolidation complete"),
			"info",
		);
	});
});

describe("deterministic pool enforcement", () => {
	/** Entries whose active observation pool sits where the enforcer looks at it. */
	function poolSetup(
		observations: ReturnType<typeof observation>[],
		args: { cap: number; target: number },
	) {
		return setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations, coversUpToId: "raw-1" }),
				textCustomMessage("raw-2", "bbbbbbbb"),
			],
			memoryMaxTokens: args.cap,
			observationsPoolTargetTokens: args.target,
		});
	}

	function droppedAppends(test: ReturnType<typeof setup>) {
		return test.pi.appendEntry.mock.calls.filter(
			([customType]) => customType === OM_OBSERVATIONS_DROPPED,
		);
	}

	function poolTokensOf(observations: ReturnType<typeof observation>[]): number {
		return observations.reduce((sum, entry) => sum + observationLineTokenCount(entry as never), 0);
	}

	it("reclaims an over-watermark pool, dropping progress before durable kinds", async () => {
		const progress = observation("aaaaaaaaaaaa", {
			kind: "progress",
			relevance: "high",
			content: "p".repeat(1200),
		});
		const decision = observation("bbbbbbbbbbbb", {
			kind: "decision",
			relevance: "high",
			content: "d".repeat(1200),
		});
		const poolTokens = poolTokensOf([progress, decision]);
		// A cap below the pool crosses the 1.5x watermark, and a target just under the
		// pool leaves room for exactly one drop — so the kind rank decides which line
		// goes, not the size of the pool.
		const test = poolSetup([progress, decision], {
			cap: Math.floor(poolTokens * 0.6),
			target: Math.floor(poolTokens * 0.55),
		});

		test.fire();
		await test.runLaunchedWork();

		const appends = droppedAppends(test);
		expect(appends).toHaveLength(1);
		expect(appends[0]?.[1]).toEqual({
			observationIds: ["aaaaaaaaaaaa"],
			coversUpToId: "raw-1",
		});
		// Deterministic: no dropper call, and the enforcer is not a worker, so the run
		// counts stay those of the model stages that did run.
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(test.runtime.workerCost.runs).toEqual({ observer: 1, reflector: 1, dropper: 0 });
		expect(test.runtime.recordWorkerRun).not.toHaveBeenCalledWith("enforcer");
		expect(test.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("enforced pool convergence"),
			"info",
		);
	});

	it("reports the reclaim even when routine worker notifications are off", async () => {
		const progress = observation("aaaaaaaaaaaa", { kind: "progress", content: "p".repeat(1200) });
		const durable = observation("bbbbbbbbbbbb", { kind: "decision", content: "d".repeat(1200) });
		const poolTokens = poolTokensOf([progress, durable]);
		const test = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", {
					observations: [progress, durable],
					coversUpToId: "raw-1",
				}),
				textCustomMessage("raw-2", "bbbbbbbb"),
			],
			memoryMaxTokens: Math.floor(poolTokens * 0.6),
			observationsPoolTargetTokens: Math.floor(poolTokens * 0.55),
			showWorkerNotifications: false,
		});

		test.fire();
		await test.runLaunchedWork();

		expect(droppedAppends(test)).toHaveLength(1);
		expect(
			test.ctx.ui.notify.mock.calls.some((call) =>
				String(call[0]).includes("enforced pool convergence"),
			),
		).toBe(true);
	});

	it("leaves a pool that is over its target but under the watermark alone", async () => {
		const observations = [observation("aaaaaaaaaaaa", { content: "z".repeat(1200) })];
		const poolTokens = poolTokensOf(observations);
		const test = poolSetup(observations, {
			cap: Math.floor(poolTokens / 1.2),
			target: Math.floor(poolTokens / 2),
		});

		test.fire();
		await test.runLaunchedWork();

		expect(droppedAppends(test)).toHaveLength(0);
	});

	it("never reclaims critical observations", async () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "critical", content: "z".repeat(1200) }),
			observation("bbbbbbbbbbbb", { relevance: "critical", content: "z".repeat(1200) }),
		];
		const poolTokens = poolTokensOf(observations);
		const test = poolSetup(observations, {
			cap: Math.floor(poolTokens / 2),
			target: Math.floor(poolTokens / 4),
		});

		test.fire();
		await test.runLaunchedWork();

		expect(droppedAppends(test)).toHaveLength(0);
		expect(test.ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("enforced pool convergence"),
			expect.anything(),
		);
	});

	it("keeps ranking until the pool reaches its target, not until an average batch is gone", async () => {
		const tiny = Array.from({ length: 100 }, (_value, index) =>
			observation((index + 0x1000).toString(16).padStart(12, "0"), {
				content: "p".repeat(80),
				kind: "progress",
			}),
		);
		const huge = observation("ffffffffffff", { content: "z".repeat(10_000), kind: "decision" });
		const observations = [...tiny, huge];
		const poolTokens = poolTokensOf(observations);
		const test = poolSetup(observations, {
			cap: Math.floor(poolTokens * 0.6),
			target: Math.floor(poolTokens * 0.15),
		});

		test.fire();
		await test.runLaunchedWork();

		const appends = droppedAppends(test);
		expect(appends).toHaveLength(1);
		// The 100 progress lines together are worth less than the excess, so a drop
		// count estimated from the average line size would stop short of the target.
		const dropped = (appends[0]?.[1] as { observationIds: string[] }).observationIds;
		expect(dropped).toContain("ffffffffffff");
		expect(dropped).toHaveLength(101);
	});

	it("is idempotent: once the pool is reclaimed the next run appends nothing", async () => {
		const observations = [
			observation("aaaaaaaaaaaa", { content: "z".repeat(1200) }),
			observation("bbbbbbbbbbbb", { content: "z".repeat(1200) }),
			observation("cccccccccccc", { content: "z".repeat(1200) }),
			observation("dddddddddddd", { content: "z".repeat(1200) }),
		];
		const poolTokens = poolTokensOf(observations);
		const test = poolSetup(observations, {
			cap: Math.floor(poolTokens / 2),
			target: Math.floor(poolTokens / 10),
		});

		test.fire();
		await test.runLaunchedWork();
		expect(droppedAppends(test)).toHaveLength(1);

		test.fire();
		await test.runLaunchedWork();
		expect(droppedAppends(test)).toHaveLength(1);
	});
});
