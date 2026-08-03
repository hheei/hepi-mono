import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import type { MctxStore } from "../src/store.js";

const model = { api: "test", provider: "anthropic", id: "claude-haiku" } as Model<Api>;

function configuration(failClosedBlocking = true): MctxConfiguration {
	return {
		global: {},
		project: {},
		merged: {},
		sourceOf: () => undefined,
		pipeline: {
			kind: "enabled",
			settings: {
				historianModel: "anthropic/claude-haiku",
				failClosedBlocking,
				executeThresholdPercentage: { defaultValue: 65, byModel: {} },
				protectedTags: 20,
			},
		},
		warnings: [],
	};
}

function lifecycleFixture(): {
	readonly context: ExtensionLifecycleContext;
	readonly cleanups: Array<() => void | Promise<void>>;
	readonly notifications: Array<{ readonly message: string; readonly level: string | undefined }>;
} {
	const cleanups: Array<() => void | Promise<void>> = [];
	const notifications: Array<{ readonly message: string; readonly level: string | undefined }> = [];
	const context = {
		pi: { events: {} } as ExtensionAPI,
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: {
				find: () => model,
				hasConfiguredAuth: () => true,
			},
			ui: {
				notify: (message: string, level?: string) => notifications.push({ message, level }),
			},
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: {
			add: (_id: string, cleanup: () => void | Promise<void>): void => {
				cleanups.push(cleanup);
			},
			cleanup: async () => [],
		},
	} as unknown as ExtensionLifecycleContext;
	return { context, cleanups, notifications };
}

function store(): MctxStore {
	return {
		path: "/store",
		getOrCreatePartition: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		findPartition: () => undefined,
		isHandoffInstalled: () => false,
		reserveHandoffInstallation: () => undefined,
		recoverHandoffInstallation: () => false,
		markHandoffInstalled: () => undefined,
		clearHandoffInstallation: () => undefined,
		initializeForkPartition: () => ({
			kind: "copied",
			partition: { projectIdentity: "git:project", sessionId: "session-1", revision: 0 },
		}),
		advancePartitionRevision: () => undefined,
		acquireHistorianLease: () => undefined,
		renewHistorianLease: () => undefined,
		releaseHistorianLease: () => undefined,
		listCompartments: () => [],
		readStatusMetrics: () => ({
			compartments: { total: 0, m0: 0, m1: 0 },
			tags: { total: 0, active: 0, pending: 0, dropped: 0 },
		}),
		discardCompartmentsFrom: () => undefined,
		publishCompartment: () => undefined,
		syncHistoryTags: (partition) => ({ partition, tags: [] }),
		queueHistoryTagDrops: () => undefined,
		markHistoryTagsDropped: () => undefined,
		writeMemory: () => {
			throw new Error("not used");
		},
		getMemories: () => [],
		listActiveMemories: () => [],
		updateMemory: () => undefined,
		archiveMemory: () => undefined,
		writeMemoryEmbedding: () => false,
		listMemoryEmbeddingCoverage: () => new Map(),

		writeNote: () => {
			throw new Error("not used");
		},
		readNotes: () => [],
		listActiveNotes: () => [],
		listRetainedHistoryTags: () => [],
		purgeRetainedHistory: () => 0,
		updateNote: () => undefined,
		dismissNote: () => undefined,
		close: () => undefined,
	};
}

function turnContext(
	usage: { readonly tokens: number; readonly contextWindow: number } | undefined,
	sessionId = "session-1",
): ExtensionContext {
	return {
		model,
		getContextUsage: () => usage,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
}

test("status reports inactive before start and active read-only snapshot", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async () => ({ kind: "ineligible", reason: "protected-tail" }),
	});
	expect(feature.status(turnContext(undefined))).toEqual({
		kind: "inactive",
		reason: "not-started",
	});
	await feature.start(fixture.context);
	const snapshot = feature.status(turnContext({ tokens: 10, contextWindow: 100 }));
	expect(snapshot).toMatchObject({
		kind: "active",
		projectIdentity: "git:project",
		sessionId: "session-1",
		partitionRevision: 0,
		usage: { tokens: 10, contextWindow: 100, percentage: 10 },
		historian: { phase: "idle" },
		pendingAugmentation: false,
	});
	expect(feature.status(turnContext(undefined, "other-session"))).toEqual({ kind: "stale" });
});

test("status returns failed when store metrics read throws", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			readStatusMetrics: () => {
				throw new Error("read failed");
			},
		}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(fixture.context);
	expect(feature.status(turnContext(undefined))).toEqual({ kind: "failed", reason: "read failed" });
	expect(fixture.notifications).toEqual([]);
});

test("status preserves disabled and disposed inactive reasons", async (): Promise<void> => {
	const disabled = lifecycleFixture();
	const disabledFeature = createMctxFeature({
		loadConfiguration: async () => ({ ...configuration(), pipeline: { kind: "disabled" } }),
	});
	await disabledFeature.start(disabled.context);
	expect(disabledFeature.status(turnContext(undefined))).toEqual({
		kind: "inactive",
		reason: "disabled",
	});
	const active = lifecycleFixture();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(active.context);
	await active.cleanups[0]?.();
	expect(feature.status(turnContext(undefined))).toEqual({ kind: "inactive", reason: "disposed" });
});

test("status exposes running/cooling phases and omits invalid usage", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const historianGate = Promise.withResolvers<{
		readonly kind: "ineligible";
		readonly reason: "protected-tail";
	}>();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async () => historianGate.promise,
	});
	await feature.start(fixture.context);
	feature.onTurnEnd(turnContext({ tokens: 65_000, contextWindow: 100_000 }));
	expect(feature.status(turnContext({ tokens: 0, contextWindow: 0 }))).toMatchObject({
		kind: "active",
		historian: { phase: "running" },
	});
	historianGate.resolve({ kind: "ineligible", reason: "protected-tail" });
	await Bun.sleep(0);
	expect(feature.status(turnContext({ tokens: 1, contextWindow: 100_000 }))).toMatchObject({
		kind: "active",
		historian: { phase: "cooling" },
	});
});

test("turn_end starts one background historian and cleanup aborts it", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	let calls = 0;
	let signal: AbortSignal | undefined;
	let resolveRun: (() => void) | undefined;
	let storeClosed = false;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({ ...store(), close: () => (storeClosed = true) }),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async (request) => {
			calls++;
			signal = request.signal;
			await new Promise<void>((resolve) => {
				resolveRun = resolve;
				request.signal.addEventListener("abort", () => resolve());
			});
			if (storeClosed) throw new Error("store closed before historian settled");
			return { kind: "cancelled" };
		},
	});
	await feature.start(fixture.context);

	feature.onTurnEnd(turnContext({ tokens: 65_000, contextWindow: 100_000 }));
	expect(calls).toBe(1);
	feature.onTurnEnd(turnContext({ tokens: 65_000, contextWindow: 100_000 }));
	expect(calls).toBe(1);

	const historianCleanup = fixture.cleanups[1];
	if (historianCleanup === undefined) throw new Error("Expected historian cleanup");
	await historianCleanup();
	expect(signal?.aborted).toBe(true);
	resolveRun?.();
	const storeCleanup = fixture.cleanups[0];
	if (storeCleanup === undefined) throw new Error("Expected store cleanup");
	await storeCleanup();
	expect(storeClosed).toBe(true);
});

test("storage open failure blocks activation by default", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: async () => {
			throw new Error("database is unavailable");
		},
	});

	await expect(feature.start(fixture.context)).rejects.toThrow("database is unavailable");
	expect(feature.active()).toBeUndefined();
	expect(fixture.notifications).toEqual([
		{
			message: "pi-mctx context store unavailable: database is unavailable",
			level: "error",
		},
	]);
});

test("storage open failure keeps Pi-native behavior when blocking is disabled", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(false),
		openStore: async () => {
			throw new Error("database is unavailable");
		},
	});

	await feature.start(fixture.context);
	expect(feature.active()).toBeUndefined();
	expect(fixture.notifications).toEqual([
		{
			message:
				"pi-mctx context store unavailable; continuing with Pi native behavior: database is unavailable",
			level: "warning",
		},
	]);
});

test("partition failure follows disabled blocking policy after closing the store", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	let closed = false;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(false),
		openStore: () => ({
			...store(),
			getOrCreatePartition: () => {
				throw new Error("partition is unavailable");
			},
			close: () => {
				closed = true;
			},
		}),
		resolveProjectIdentity: async () => "git:project",
	});

	await feature.start(fixture.context);
	expect(closed).toBe(true);
	expect(feature.active()).toBeUndefined();
	expect(fixture.notifications).toEqual([
		{
			message:
				"pi-mctx context partition unavailable; continuing with Pi native behavior: partition is unavailable",
			level: "warning",
		},
	]);
});

test("turn_end ignores absent usage and another session", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	let calls = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async () => {
			calls++;
			return { kind: "cancelled" };
		},
	});
	await feature.start(fixture.context);
	feature.onTurnEnd(turnContext(undefined));
	feature.onTurnEnd(turnContext({ tokens: 65_000, contextWindow: 100_000 }, "other-session"));
	expect(calls).toBe(0);
});

test("adopts a successful publication revision for the next historian run", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async () => ({
			kind: "published",
			repaired: false,
			publication: {
				partition: { projectIdentity: "git:project", sessionId: "session-1", revision: 1 },
				compartment: {
					tier: "m0",
					sequence: 0,
					sourceStartEntryId: "user-1",
					sourceEndEntryId: "assistant-1",
					sourceFingerprint: "fingerprint",
					renderedPayload: "summary",
					publishedRevision: 1,
				},
			},
		}),
	});
	await feature.start(fixture.context);
	feature.onTurnEnd(turnContext({ tokens: 65_000, contextWindow: 100_000 }));
	await Promise.resolve();
	await Promise.resolve();
	const active = feature.active();
	if (active === undefined) throw new Error("Expected active runtime");
	expect(active.partition.revision).toBe(1);
});

test("logs every historian failure but notifies once until publication rearms it", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const diagnostics: unknown[] = [];
	const outcomes = [
		{ kind: "failed", reason: "temporary outage", failureKind: "transient", attempt: 3 },
		{ kind: "failed", reason: "temporary outage", failureKind: "transient", attempt: 3 },
		{
			kind: "published",
			repaired: false,
			publication: {
				partition: { projectIdentity: "git:project", sessionId: "session-1", revision: 1 },
				compartment: {
					tier: "m0",
					sequence: 0,
					sourceStartEntryId: "user-1",
					sourceEndEntryId: "assistant-1",
					sourceFingerprint: "fingerprint",
					renderedPayload: "summary",
					publishedRevision: 1,
				},
			},
		},
		{ kind: "failed", reason: "temporary outage", failureKind: "transient", attempt: 1 },
	] as const;
	let outcomeIndex = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		logHistorianDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		runHistorianForBranch: async () => {
			const outcome = outcomes[outcomeIndex];
			outcomeIndex++;
			if (outcome === undefined) throw new Error("Expected historian outcome");
			return outcome;
		},
	});
	await feature.start(fixture.context);
	const highUsage = { tokens: 65_000, contextWindow: 100_000 };
	const lowUsage = { tokens: 50_000, contextWindow: 100_000 };
	for (let index = 0; index < outcomes.length; index++) {
		feature.onTurnEnd(turnContext(highUsage));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		if (index < outcomes.length - 1) feature.onTurnEnd(turnContext(lowUsage));
	}
	expect(diagnostics).toEqual([
		{
			event: "pi-mctx.historian_failure",
			partition: { projectIdentity: "git:project", sessionId: "session-1" },
			failureClass: "transient",
			attempt: 3,
			leaseOutcome: "released",
		},
		{
			event: "pi-mctx.historian_failure",
			partition: { projectIdentity: "git:project", sessionId: "session-1" },
			failureClass: "transient",
			attempt: 3,
			leaseOutcome: "released",
		},
		{
			event: "pi-mctx.historian_failure",
			partition: { projectIdentity: "git:project", sessionId: "session-1" },
			failureClass: "transient",
			attempt: 1,
			leaseOutcome: "released",
		},
	]);
	expect(fixture.notifications).toEqual([
		{ message: "pi-mctx historian failed (transient); keeping existing context", level: "warning" },
		{ message: "pi-mctx historian failed (transient); keeping existing context", level: "warning" },
	]);
});

test("runner throws as an opaque unknown diagnostic without exposing its message", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	const diagnostics: unknown[] = [];
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		logHistorianDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		runHistorianForBranch: async () => {
			throw new Error("provider error contains private data");
		},
	});
	await feature.start(fixture.context);
	feature.onTurnEnd(turnContext({ tokens: 65_000, contextWindow: 100_000 }));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(diagnostics).toEqual([
		{
			event: "pi-mctx.historian_failure",
			partition: { projectIdentity: "git:project", sessionId: "session-1" },
			failureClass: "unknown",
			attempt: 0,
			leaseOutcome: "released",
		},
	]);
	expect(fixture.notifications).toEqual([
		{ message: "pi-mctx historian failed (unknown); keeping existing context", level: "warning" },
	]);
});
