import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockForced = vi.hoisted(() => ({ runForcedConsolidation: vi.fn() }));

vi.mock("../src/hooks/consolidation-trigger.js", () => ({
	runForcedConsolidation: mockForced.runForcedConsolidation,
}));

import { registerOmCommand } from "../src/commands/om.js";
import type { Runtime } from "../src/runtime.js";
import {
	compactionEntry,
	gateEntry,
	memoryDetails,
	observation,
	observationsRecordedEntry,
	type TestEntry,
	textCustomMessage,
} from "./fixtures/session.js";

beforeEach(() => {
	mockForced.runForcedConsolidation.mockReset();
	mockForced.runForcedConsolidation.mockResolvedValue(undefined);
});

type NotifyLevel = "info" | "warning" | "error";

type CmdCtx = {
	cwd: string;
	ui: { notify: (message: string, level?: NotifyLevel) => void };
	sessionManager: { getBranch: () => unknown };
	compact: (options?: {
		onComplete?: () => void;
		onError?: (error: { message: string }) => void;
	}) => void;
};

function setup(args: {
	verb: "consolidate" | "compact";
	entries: TestEntry[];
	runtime?: Record<string, unknown>;
	consolidationPromise?: Promise<void>;
}) {
	let handler: ((args: unknown, ctx: CmdCtx) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om");
			handler = command.handler;
		}),
		appendEntry: vi.fn(),
	};
	const compactCalls: {
		options?: {
			onComplete?: () => void;
			onError?: (error: { message: string }) => void;
		};
	}[] = [];
	const runtime = {
		configLoaded: true,
		config: { passive: false },
		consolidationInFlight: false,
		consolidationPromise: args.consolidationPromise ?? null,
		compactInFlight: false,
		compactHookInFlight: false,
		sessionGeneration: 1,
		lifecycleSignal: undefined,
		ensureConfig: vi.fn(async () => {}),
		isSessionCurrent: vi.fn(() => true),
		...args.runtime,
	};
	registerOmCommand(pi as unknown as ExtensionAPI, runtime as unknown as Runtime);
	if (!handler) throw new Error(`/om ${args.verb} handler not registered`);

	const notify = vi.fn();
	const ctx: CmdCtx = {
		cwd: "/tmp/project",
		ui: { notify },
		sessionManager: { getBranch: () => args.entries },
		compact: (options) => {
			compactCalls.push({ ...(options ? { options } : {}) });
		},
	};
	return {
		pi,
		runtime,
		ctx,
		compactCalls,
		run: async () => {
			await handler!(args.verb, ctx);
			return notify.mock.calls.map((call) => call[0] as string);
		},
		lastMessage: () => notify.mock.calls.at(-1)?.[0] as string,
	};
}

/** A consolidation the command can be left waiting on, plus the release for it. */
function pendingConsolidation(): { readonly promise: Promise<void>; readonly release: () => void } {
	let release: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release: () => release?.() };
}

describe("/om consolidate", () => {
	it("runs a forced consolidation when there is uncovered conversation", async () => {
		const cmd = setup({
			verb: "consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
		});

		await cmd.run();

		expect(mockForced.runForcedConsolidation).toHaveBeenCalledOnce();
	});

	it("refuses to run while a consolidation is already in flight", async () => {
		const cmd = setup({
			verb: "consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			runtime: { consolidationInFlight: true },
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("already in progress");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("refuses to run while a compaction is in progress", async () => {
		const cmd = setup({
			verb: "consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			runtime: { compactInFlight: true },
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("compaction is in progress");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("declines when there is nothing to consolidate", async () => {
		const cmd = setup({
			verb: "consolidate",
			entries: [],
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("nothing to consolidate yet");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("runs when only existing memories remain (no uncovered conversation)", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
		];
		const cmd = setup({
			verb: "consolidate",
			entries,
		});

		await cmd.run();

		expect(mockForced.runForcedConsolidation).toHaveBeenCalledOnce();
	});

	it("refuses when the session gate is off", async () => {
		const cmd = setup({
			verb: "consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa"), gateEntry("gate-1", false)],
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("is off for this session");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("re-checks the lock, the gate, and the session after awaiting configuration", async () => {
		const locked = setup({
			verb: "consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
		});
		// The automatic trigger claims the lock while the command is awaiting config.
		locked.runtime.ensureConfig.mockImplementation(async () => {
			locked.runtime.consolidationInFlight = true;
		});
		await locked.run();
		expect(locked.lastMessage()).toContain("already in progress");

		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const gated = setup({ verb: "consolidate", entries });
		// The operator runs `/om off` while the command is awaiting config.
		gated.runtime.ensureConfig.mockImplementation(async () => {
			entries.push(gateEntry("gate-2", false));
		});
		await gated.run();
		expect(gated.lastMessage()).toContain("is off for this session");

		const replaced = setup({
			verb: "consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			runtime: { isSessionCurrent: vi.fn(() => false) },
		});
		expect(await replaced.run()).toEqual([]);

		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});
});

describe("/om compact", () => {
	const readyEntries = [
		textCustomMessage("raw-1", "aaaaaaaa"),
		observationsRecordedEntry("om-obs", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		}),
	];

	it("starts a compaction and reports completion through the host callbacks", async () => {
		const cmd = setup({
			verb: "compact",
			entries: readyEntries,
		});

		await cmd.run();

		expect(cmd.runtime.compactInFlight).toBe(true);
		expect(cmd.compactCalls).toHaveLength(1);
		cmd.compactCalls[0]?.options?.onComplete?.();
		expect(cmd.runtime.compactInFlight).toBe(false);
		expect(cmd.lastMessage()).toContain("compaction complete");
	});

	it("clears the in-flight flag and reports the error when compaction fails", async () => {
		const cmd = setup({
			verb: "compact",
			entries: readyEntries,
		});

		await cmd.run();
		cmd.compactCalls[0]?.options?.onError?.({ message: "compaction exploded" });

		expect(cmd.runtime.compactInFlight).toBe(false);
		expect(cmd.lastMessage()).toContain("compaction exploded");
	});

	it("refuses to compact an empty memory pool instead of falling back to the native summarizer", async () => {
		const cmd = setup({
			verb: "compact",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("no memories to compact");
		expect(cmd.compactCalls).toHaveLength(0);
		expect(cmd.runtime.compactInFlight).toBe(false);
	});

	it("refuses when nothing new arrived since the last compaction", async () => {
		const entries = [
			...readyEntries,
			compactionEntry("cmp-1", {
				firstKeptEntryId: "om-obs",
				details: memoryDetails({ observations: [observation("aaaaaaaaaaaa")] }),
			}),
		];
		const cmd = setup({ verb: "compact", entries });

		await cmd.run();

		expect(cmd.lastMessage()).toContain("nothing new to compact");
		expect(cmd.compactCalls).toHaveLength(0);
	});

	it("waits for an in-flight consolidation before compacting", async () => {
		const pending = pendingConsolidation();
		const cmd = setup({
			verb: "compact",
			entries: readyEntries,
			runtime: { consolidationInFlight: true },
			consolidationPromise: pending.promise,
		});

		const run = cmd.run();
		await Promise.resolve();
		expect(cmd.compactCalls).toHaveLength(0);

		pending.release();
		await run;
		expect(cmd.compactCalls).toHaveLength(1);
		expect(cmd.runtime.compactInFlight).toBe(true);
	});

	it("refuses when a compaction is already running and when the gate is off", async () => {
		const busy = setup({
			verb: "compact",
			entries: readyEntries,
			runtime: { compactInFlight: true },
		});
		await busy.run();
		expect(busy.lastMessage()).toContain("already in progress");
		expect(busy.compactCalls).toHaveLength(0);

		const gated = setup({
			verb: "compact",
			entries: [...readyEntries, gateEntry("gate-1", false)],
		});
		await gated.run();
		expect(gated.lastMessage()).toContain("is off for this session");
		expect(gated.compactCalls).toHaveLength(0);
	});

	it("re-checks the gate, a competing compaction, and the session after the wait", async () => {
		// The operator runs `/om off` while the command waits for the consolidation.
		const entries = [...readyEntries];
		const gateWait = pendingConsolidation();
		const gated = setup({
			verb: "compact",
			entries,
			runtime: { consolidationInFlight: true },
			consolidationPromise: gateWait.promise,
		});
		const gatedRun = gated.run();
		await Promise.resolve();
		entries.push(gateEntry("gate-2", false));
		gateWait.release();
		await gatedRun;
		expect(gated.lastMessage()).toContain("is off for this session");
		expect(gated.compactCalls).toHaveLength(0);
		expect(gated.runtime.compactInFlight).toBe(false);

		// A trigger path claims the compaction while the command is waiting.
		const busyWait = pendingConsolidation();
		const busy = setup({
			verb: "compact",
			entries: readyEntries,
			runtime: { consolidationInFlight: true },
			consolidationPromise: busyWait.promise,
		});
		const busyRun = busy.run();
		await Promise.resolve();
		busy.runtime.compactInFlight = true;
		busyWait.release();
		await busyRun;
		expect(busy.lastMessage()).toContain("already in progress");
		expect(busy.compactCalls).toHaveLength(0);

		// A replaced session reports nothing beyond the wait notice.
		const replacedWait = pendingConsolidation();
		const replaced = setup({
			verb: "compact",
			entries: readyEntries,
			runtime: { consolidationInFlight: true, isSessionCurrent: vi.fn(() => false) },
			consolidationPromise: replacedWait.promise,
		});
		const replacedRun = replaced.run();
		await Promise.resolve();
		replacedWait.release();
		expect(await replacedRun).toEqual([
			"Observational memory: waiting for the running consolidation first…",
		]);
		expect(replaced.compactCalls).toHaveLength(0);
	});
});
