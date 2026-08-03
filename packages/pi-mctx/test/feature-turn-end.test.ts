import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import type { MctxStore } from "../src/store.js";

const model = { api: "test", provider: "anthropic", id: "claude-haiku" } as Model<Api>;

function configuration(): MctxConfiguration {
	return {
		global: {},
		project: {},
		merged: {},
		sourceOf: () => undefined,
		pipeline: {
			kind: "enabled",
			settings: {
				historianModel: "anthropic/claude-haiku",
				failClosedBlocking: true,
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
			add: (_id: string, cleanup: () => void | Promise<void>) => cleanups.push(cleanup),
			cleanup: async () => [],
		},
	} as ExtensionLifecycleContext;
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
		initializeForkPartition: () => ({
			kind: "copied",
			partition: { projectIdentity: "git:project", sessionId: "session-1", revision: 0 },
		}),
		advancePartitionRevision: () => undefined,
		acquireHistorianLease: () => undefined,
		renewHistorianLease: () => undefined,
		releaseHistorianLease: () => undefined,
		listCompartments: () => [],
		discardCompartmentsFrom: () => undefined,
		publishCompartment: () => undefined,
		syncHistoryTags: (partition) => ({ partition, tags: [] }),
		queueHistoryTagDrops: () => undefined,
		markHistoryTagsDropped: () => undefined,
		writeMemory: () => {
			throw new Error("not used");
		},
		getMemories: () => [],
		updateMemory: () => undefined,
		archiveMemory: () => undefined,

		writeNote: () => {
			throw new Error("not used");
		},
		readNotes: () => [],
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

test("turn_end starts one background historian and cleanup aborts it", async (): Promise<void> => {
	const fixture = lifecycleFixture();
	let calls = 0;
	let signal: AbortSignal | undefined;
	let resolveRun: (() => void) | undefined;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async (request) => {
			calls++;
			signal = request.signal;
			await new Promise<void>((resolve) => {
				resolveRun = resolve;
			});
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
