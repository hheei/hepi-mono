import { describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { testModel } from "./fixtures/model.js";
import {
	compactionEntry,
	gateEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	type TestEntry,
	textCustomMessage,
} from "./fixtures/session.js";

interface CompactionHookTestResult {
	cancel?: boolean;
	compaction?: {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		details: {
			type: string;
			version: number;
			fullFold: boolean;
			observations: Array<{ id: string }>;
			reflections: Array<{ id: string }>;
			budget?: {
				maxTokens: number;
				renderedTokens: number;
				tailTokens: number;
				softLimit: number;
				trimmedObservations: number;
				trimmedReflections: number;
			};
		};
	};
}

function setup(args: {
	entries: TestEntry[];
	observationsPoolMaxTokens?: number;
	observationsPoolTargetTokens?: number;
	memoryMaxTokens?: number;
	contextWindow?: number;
	compactHookInFlight?: boolean;
	idleCompactInFlight?: boolean;
	lifecycleSignal?: AbortSignal;
	reason?: "manual" | "threshold" | "overflow";
}) {
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: typeof handler) => {
			expect(eventName).toBe("session_before_compact");
			handler = cb;
		}),
		appendEntry: vi.fn(),
	};
	const runtime = {
		config: {
			...DEFAULTS,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 20_000,
			...(args.observationsPoolTargetTokens !== undefined
				? { observationsPoolTargetTokens: args.observationsPoolTargetTokens }
				: {}),
			...(args.memoryMaxTokens !== undefined ? { memoryMaxTokens: args.memoryMaxTokens } : {}),
		},
		compactHookInFlight: args.compactHookInFlight ?? false,
		idleCompactInFlight: args.idleCompactInFlight ?? false,
		sessionGeneration: 1,
		lifecycleSignal: args.lifecycleSignal,
		isSessionCurrent: vi.fn((generation: number) => generation === 1),
		resolveModel: vi.fn(() => {
			throw new Error("resolveModel must not be called");
		}),
		ensureConfig: vi.fn(),
	};
	registerCompactionHook(
		pi as unknown as Parameters<typeof registerCompactionHook>[0],
		runtime as unknown as Parameters<typeof registerCompactionHook>[1],
	);
	if (!handler) throw new Error("compaction handler was not registered");
	const appendContextEdit = vi.fn();
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		sessionManager: {
			getBranch: vi.fn(() => args.entries),
			appendContextEdit,
		},
		model: testModel({
			provider: "session",
			id: "session",
			contextWindow: args.contextWindow ?? 200_000,
		}),
		getSystemPrompt: () => "You are a coding assistant.",
	};
	const run = (firstKeptEntryId = args.entries.at(-1)?.id ?? "missing") =>
		handler!(
			{
				preparation: {
					firstKeptEntryId,
					tokensBefore: 123,
					settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
				},
				branchEntries: args.entries,
				reason: args.reason ?? "threshold",
				signal: undefined,
			},
			ctx,
		);
	return { pi, runtime, ctx, run, appendContextEdit };
}

describe("V3 compaction hook", () => {
	it("delegates to native compaction when there is no V3 memory", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, pi } = setup({ entries });

		const result = await run("raw-1");

		expect(result).toBeUndefined();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("cancels compaction when projection is empty during idle compaction", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, pi } = setup({ entries, idleCompactInFlight: true });

		const result = await run("raw-1");

		expect(result).toEqual({ cancel: true });
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("cancels when the captured lifecycle signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, pi } = setup({ entries, lifecycleSignal: controller.signal });

		const result = await run("raw-1");

		expect(result).toEqual({ cancel: true });
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("hands compaction back to Pi when the session gate is off", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			gateEntry("gate-1", false),
		];
		const { run, runtime, pi } = setup({ entries });

		const result = await run("raw-1");

		// Declining ownership (rather than cancelling) lets Pi's own summarizer run.
		expect(result).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("takes compaction back over once the gate is on again", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			gateEntry("gate-1", false),
			gateEntry("gate-2", true),
		];
		const { run } = setup({ entries });

		const result = (await run("raw-1")) as CompactionHookTestResult;

		expect(result?.compaction?.summary).toContain("aaaaaaaaaaaa");
	});

	it("first normal compaction writes covered observations without orphan reflections", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = (await run("raw-1")) as CompactionHookTestResult;

		expect(result.compaction?.details.fullFold).toBe(false);
		expect(result.compaction?.details.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(result.compaction?.details.reflections).toEqual([]);
		expect(result.compaction?.summary).toContain("## Observations");
		expect(result.compaction?.summary).not.toContain("## Reflections");
	});

	it("writes a normal V3 projection without applying new reflections or drops", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", {
				firstKeptEntryId: "raw-1",
				details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }),
			}),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "raw-2",
			}),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = (await run("raw-2")) as CompactionHookTestResult;

		expect(result.compaction?.details).toMatchObject({
			type: "om.folded",
			version: 1,
			fullFold: false,
		});
		expect(result.compaction?.details.observations.map((obs) => obs.id)).toEqual([
			"aaaaaaaaaaaa",
			"bbbbbbbbbbbb",
		]);
		expect(result.compaction?.details.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.compaction?.summary).toContain("## Reflections\n[eeeeeeeeeeee]");
		expect(result.compaction?.summary).toContain("## Observations");
	});

	it("writes a full V3 projection when observation pool pressure reaches the threshold", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", {
				firstKeptEntryId: "raw-1",
				details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }),
			}),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "raw-2",
			}),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = (await run("raw-2")) as CompactionHookTestResult;

		expect(result.compaction?.details.fullFold).toBe(true);
		expect(result.compaction?.details.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.compaction?.details.reflections.map((ref) => ref.id)).toEqual([
			"eeeeeeeeeeee",
			"ffffffffffff",
		]);
	});

	it("delegates to native compaction when only old V2 memory exists", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];
		const { run } = setup({ entries });

		const result = await run("cmp-v2");

		expect(result).toBeUndefined();
	});

	it("cancels duplicate in-flight compaction and notifies the UI", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, ctx } = setup({ entries, compactHookInFlight: true });

		await expect(run("raw-1")).resolves.toEqual({ cancel: true });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"om: another compaction is already in progress; cancelling duplicate",
			"warning",
		);
	});

	// Deterministic sizes: the fixed summary preamble costs 240 tokens, an
	// observation line 38 and a reflection line 24, so a budget of 500 leaves
	// 260 tokens for memory and the split below is exact.
	function budgetedEntries() {
		const observations = Array.from({ length: 10 }, (_value, index) =>
			observation(`a${index}`.padStart(12, "0"), {
				content: `Observation number ${index} ${"x".repeat(80)}`,
			}),
		);
		const reflections = Array.from({ length: 2 }, (_value, index) =>
			reflection(`e${index}`.padEnd(12, "0"), ["0000000000a0"], { content: "y".repeat(80) }),
		);
		return [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations, coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections, coversUpToId: "raw-1" }),
			// Establishes the maintenance boundary reflections are folded against;
			// without a full fold the projection deliberately carries none.
			compactionEntry("cmp-full", {
				firstKeptEntryId: "raw-1",
				details: memoryDetails({ fullFold: true }),
			}),
		];
	}

	it("answers with the framing text when the budget cannot hold a memory line", async () => {
		const entries = budgetedEntries();
		const { run, ctx } = setup({ entries, memoryMaxTokens: 100 });

		const result = (await run("raw-1")) as CompactionHookTestResult;

		// Still ours: a memory-less render must not hand the compaction to Pi's own
		// summarizer, which respects no budget at all.
		expect(result?.compaction?.summary).toContain("These are condensed memories");
		expect(result?.compaction?.summary).not.toContain("## Observations");
		expect(result?.compaction?.summary).not.toContain("## Reflections");
		expect(result?.compaction?.details?.observations).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot hold a memory line"),
			"warning",
		);
	});

	it("trims rendered memory to its budget, records it, and says so", async () => {
		const entries = budgetedEntries();
		const { run, ctx } = setup({
			entries,
			memoryMaxTokens: 500,
			observationsPoolTargetTokens: 200,
		});

		const result = (await run("raw-1")) as CompactionHookTestResult;
		const details = result.compaction?.details;

		// Observation share 0.4 of 260 = 104, reflections need 48 of the rest;
		// the leftover 212 buys five 38-token observation lines.
		expect(details?.observations.map((entry) => entry.id)).toEqual([
			"0000000000a5",
			"0000000000a6",
			"0000000000a7",
			"0000000000a8",
			"0000000000a9",
		]);
		expect(details?.reflections.map((entry) => entry.id)).toEqual(["e00000000000", "e10000000000"]);
		expect(details?.budget).toMatchObject({
			maxTokens: 500,
			trimmedObservations: 5,
			trimmedReflections: 0,
			tailTokens: 1,
		});
		expect(details?.budget?.renderedTokens).toBeLessThanOrEqual(500);
		expect(result.compaction?.summary).not.toContain("0000000000a4");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("om: trimmed memory to its 500 token budget"),
			"info",
		);
	});

	it("keeps every line and stays quiet when memory fits the budget", async () => {
		const entries = budgetedEntries();
		const { run, ctx } = setup({
			entries,
			memoryMaxTokens: 5_000,
			observationsPoolTargetTokens: 2_000,
		});

		const result = (await run("raw-1")) as CompactionHookTestResult;

		expect(result.compaction?.details.observations).toHaveLength(10);
		expect(result.compaction?.details.reflections).toHaveLength(2);
		expect(result.compaction?.details.budget).toMatchObject({
			trimmedObservations: 0,
			trimmedReflections: 0,
		});
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("halves the render budget when Pi compacts after an overflow", async () => {
		const entries = budgetedEntries();
		const threshold = setup({
			entries,
			memoryMaxTokens: 800,
			observationsPoolTargetTokens: 400,
		});
		const overflow = setup({
			entries,
			memoryMaxTokens: 800,
			observationsPoolTargetTokens: 400,
			reason: "overflow",
		});

		const normal = (await threshold.run("raw-1")) as CompactionHookTestResult;
		const recovered = (await overflow.run("raw-1")) as CompactionHookTestResult;

		expect(normal.compaction?.details.budget?.maxTokens).toBe(800);
		expect(recovered.compaction?.details.budget?.maxTokens).toBe(400);
		expect(recovered.compaction?.details.observations.length).toBeLessThan(
			normal.compaction?.details.observations.length ?? 0,
		);
		expect(overflow.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("trimmed memory to its 400 token budget"),
			"warning",
		);
	});

	it("derives the cap from the model window and Pi's own reserve", async () => {
		const entries = budgetedEntries();
		const narrow = setup({ entries, contextWindow: 50_000 });
		const wide = setup({ entries, contextWindow: 200_000 });

		const narrowResult = (await narrow.run("raw-1")) as CompactionHookTestResult;
		const wideResult = (await wide.run("raw-1")) as CompactionHookTestResult;

		// 50,000 window with a 16,384 reserve leaves nothing above a tenth of the
		// window; 200,000 keeps the 81,000 trigger as the smaller bound.
		expect(narrowResult.compaction?.details.budget?.maxTokens).toBe(5_000);
		expect(narrowResult.compaction?.details.budget?.softLimit).toBe(33_616);
		expect(wideResult.compaction?.details.budget?.maxTokens).toBe(20_000);
		expect(wideResult.compaction?.details.budget?.softLimit).toBe(81_000);
	});

	it("sanitizes retained assistant messages and appends context_edit during compaction", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			{
				id: "raw-cut",
				parentId: "om-obs",
				timestamp: "2026-10-02T12:00:00.000Z",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Continue" }] },
			},
			{
				id: "raw-retained-assistant",
				parentId: "raw-cut",
				timestamp: "2026-10-02T12:00:01.000Z",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Deep thought",
							thinkingSignature: JSON.stringify({ encrypted_content: "xyz" }),
						},
						{
							type: "text",
							text: "Clear answer.",
						},
					],
				},
			},
		];
		const { run, appendContextEdit } = setup({ entries });

		const result = (await run("raw-cut")) as CompactionHookTestResult;

		expect(result.compaction).toBeDefined();
		expect(appendContextEdit).toHaveBeenCalledTimes(1);
		expect(appendContextEdit).toHaveBeenCalledWith("raw-retained-assistant", {
			content: [
				{ type: "thinking", thinking: "Deep thought" },
				{ type: "text", text: "Clear answer." },
			],
		});
	});
});
