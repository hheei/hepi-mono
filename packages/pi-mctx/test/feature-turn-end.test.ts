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
			},
		},
		warnings: [],
	};
}

function lifecycleFixture(): {
	readonly context: ExtensionLifecycleContext;
	readonly cleanups: Array<() => void | Promise<void>>;
} {
	const cleanups: Array<() => void | Promise<void>> = [];
	const context = {
		pi: { events: {} } as ExtensionAPI,
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: {
				find: () => model,
				hasConfiguredAuth: () => true,
			},
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: {
			add: (_id: string, cleanup: () => void | Promise<void>) => cleanups.push(cleanup),
			cleanup: async () => [],
		},
	} as ExtensionLifecycleContext;
	return { context, cleanups };
}

function store(): MctxStore {
	return {
		path: "/store",
		getOrCreatePartition: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		advancePartitionRevision: () => undefined,
		acquireHistorianLease: () => undefined,
		renewHistorianLease: () => undefined,
		releaseHistorianLease: () => undefined,
		listCompartments: () => [],
		publishCompartment: () => undefined,
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
