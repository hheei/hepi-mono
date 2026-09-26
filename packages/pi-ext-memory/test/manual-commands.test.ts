import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockForced = vi.hoisted(() => ({ runForcedConsolidation: vi.fn() }));

vi.mock("../src/hooks/consolidation-trigger.js", () => ({
	runForcedConsolidation: mockForced.runForcedConsolidation,
}));

import { registerCompactCommand } from "../src/commands/compact.js";
import { registerConsolidateCommand } from "../src/commands/consolidate.js";
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
	register: (pi: ExtensionAPI, runtime: Runtime) => void;
	name: string;
	entries: TestEntry[];
	runtime?: Record<string, unknown>;
	consolidationPromise?: Promise<void>;
}) {
	let handler: ((args: unknown, ctx: CmdCtx) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe(args.name);
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
	args.register(pi as unknown as ExtensionAPI, runtime as unknown as Runtime);
	if (!handler) throw new Error(`${args.name} handler not registered`);

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
			await handler!(undefined, ctx);
			return notify.mock.calls.map((call) => call[0] as string);
		},
		lastMessage: () => notify.mock.calls.at(-1)?.[0] as string,
	};
}

describe("/om:consolidate", () => {
	it("runs a forced consolidation when there is uncovered conversation", async () => {
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
		});

		await cmd.run();

		expect(mockForced.runForcedConsolidation).toHaveBeenCalledOnce();
	});

	it("refuses to run while a consolidation is already in flight", async () => {
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			runtime: { consolidationInFlight: true },
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("already in progress");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("refuses to run while a compaction is in progress", async () => {
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			runtime: { compactInFlight: true },
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("compaction is in progress");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("declines when there is nothing to consolidate", async () => {
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
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
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries,
		});

		await cmd.run();

		expect(mockForced.runForcedConsolidation).toHaveBeenCalledOnce();
	});

	it("refuses when the session gate is off", async () => {
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa"), gateEntry("gate-1", false)],
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("is off for this session");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("re-checks the in-flight lock after awaiting configuration", async () => {
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
		});
		// The automatic trigger claims the lock while the command is awaiting config.
		cmd.runtime.ensureConfig.mockImplementation(async () => {
			cmd.runtime.consolidationInFlight = true;
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("already in progress");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("re-checks the gate after awaiting configuration", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries,
		});
		// The operator runs `/om off` while the command is awaiting config.
		cmd.runtime.ensureConfig.mockImplementation(async () => {
			entries.push(gateEntry("gate-2", false));
		});

		await cmd.run();

		expect(cmd.lastMessage()).toContain("is off for this session");
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});

	it("stays silent when the session was replaced while awaiting configuration", async () => {
		const cmd = setup({
			register: registerConsolidateCommand,
			name: "om:consolidate",
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			runtime: { isSessionCurrent: vi.fn(() => false) },
		});

		const messages = await cmd.run();

		expect(messages).toEqual([]);
		expect(mockForced.runForcedConsolidation).not.toHaveBeenCalled();
	});
});

describe("/om:compact", () => {
	const readyEntries = [
		textCustomMessage("raw-1", "aaaaaaaa"),
		observationsRecordedEntry("om-obs", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		}),
	];

	it("starts a compaction and reports completion through the host callbacks", async () => {
		const cmd = setup({
			register: registerCompactCommand,
			name: "om:compact",
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
			register: registerCompactCommand,
			name: "om:compact",
			entries: readyEntries,
		});

		await cmd.run();
		cmd.compactCalls[0]?.options?.onError?.({ message: "compaction exploded" });

		expect(cmd.runtime.compactInFlight).toBe(false);
		expect(cmd.lastMessage()).toContain("compaction exploded");
	});

	it("refuses to compact an empty memory pool instead of falling back to the native summarizer", async () => {
		const cmd = setup({
			register: registerCompactCommand,
			name: "om:compact",
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
		const cmd = setup({ register: registerCompactCommand, name: "om:compact", entries });

		await cmd.run();

		expect(cmd.lastMessage()).toContain("nothing new to compact");
		expect(cmd.compactCalls).toHaveLength(0);
	});

	it("waits for an in-flight consolidation before compacting", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cmd = setup({
			register: registerCompactCommand,
			name: "om:compact",
			entries: readyEntries,
			runtime: { consolidationInFlight: true },
			consolidationPromise: pending,
		});

		const run = cmd.run();
		await Promise.resolve();
		expect(cmd.compactCalls).toHaveLength(0);

		release?.();
		await run;
		expect(cmd.compactCalls).toHaveLength(1);
		expect(cmd.runtime.compactInFlight).toBe(true);
	});

	it("refuses when a compaction is already running and when the gate is off", async () => {
		const busy = setup({
			register: registerCompactCommand,
			name: "om:compact",
			entries: readyEntries,
			runtime: { compactInFlight: true },
		});
		await busy.run();
		expect(busy.lastMessage()).toContain("already in progress");
		expect(busy.compactCalls).toHaveLength(0);

		const gated = setup({
			register: registerCompactCommand,
			name: "om:compact",
			entries: [...readyEntries, gateEntry("gate-1", false)],
		});
		await gated.run();
		expect(gated.lastMessage()).toContain("is off for this session");
		expect(gated.compactCalls).toHaveLength(0);
	});

	it("re-checks the gate after waiting for an in-flight consolidation", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entries = [...readyEntries];
		const cmd = setup({
			register: registerCompactCommand,
			name: "om:compact",
			entries,
			runtime: { consolidationInFlight: true },
			consolidationPromise: pending,
		});

		const run = cmd.run();
		await Promise.resolve();
		// The operator runs `/om off` while the command waits for the consolidation.
		entries.push(gateEntry("gate-2", false));
		release?.();
		await run;

		expect(cmd.lastMessage()).toContain("is off for this session");
		expect(cmd.compactCalls).toHaveLength(0);
		expect(cmd.runtime.compactInFlight).toBe(false);
	});

	it("re-checks for a competing compaction after waiting for an in-flight consolidation", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cmd = setup({
			register: registerCompactCommand,
			name: "om:compact",
			entries: readyEntries,
			runtime: { consolidationInFlight: true },
			consolidationPromise: pending,
		});

		const run = cmd.run();
		await Promise.resolve();
		// A trigger path claims the compaction while the command is waiting.
		cmd.runtime.compactInFlight = true;
		release?.();
		await run;

		expect(cmd.lastMessage()).toContain("already in progress");
		expect(cmd.compactCalls).toHaveLength(0);
	});

	it("stays silent when the session was replaced while waiting", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cmd = setup({
			register: registerCompactCommand,
			name: "om:compact",
			entries: readyEntries,
			runtime: { consolidationInFlight: true, isSessionCurrent: vi.fn(() => false) },
			consolidationPromise: pending,
		});

		const run = cmd.run();
		await Promise.resolve();
		release?.();
		const messages = await run;

		// The wait notice is the only message: the replaced session reports nothing further.
		expect(messages).toEqual([
			"Observational memory: waiting for the running consolidation first…",
		]);
		expect(cmd.compactCalls).toHaveLength(0);
	});
});
