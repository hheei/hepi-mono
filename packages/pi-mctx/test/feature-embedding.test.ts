import { expect, test } from "bun:test";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import type { EmbeddingProvider, EmbeddingProviderLease } from "@hheei/pi-ext-embed";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import type { MctxStore } from "../src/store.js";

function configuration(embedding?: Readonly<Record<string, unknown>>): MctxConfiguration {
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
		...(embedding === undefined ? {} : { embedding }),
		warnings: [],
	};
}

function store(): MctxStore {
	return {
		getOrCreatePartition: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		close: () => undefined,
	} as unknown as MctxStore;
}

function lifecycle(cleanup: Array<() => void | Promise<void>>): ExtensionLifecycleContext {
	return {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: {
				find: () => ({ api: "test", provider: "anthropic", id: "claude-haiku" }),
				hasConfiguredAuth: () => true,
			},
			ui: { notify: () => undefined },
		},
		signal: new AbortController().signal,
		resources: { add: (_name, dispose) => cleanup.push(dispose), cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
}

test("acquires configured embedding once and releases it during MCTX cleanup", async (): Promise<void> => {
	const cleanup: Array<() => void | Promise<void>> = [];
	let acquires = 0;
	let releases = 0;
	const provider: EmbeddingProvider = {
		snapshot: () => ({ provider: "local", modelIdentity: "test", generation: 1 }),
		embed: async () => undefined,
		embedBatch: async () => undefined,
	};
	const lease: EmbeddingProviderLease = {
		provider,
		release: async () => {
			releases += 1;
		},
	};
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration({ provider: "local" }),
		openStore: store,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async (config) => {
			acquires += 1;
			expect(config).toEqual({ provider: "local" });
			return lease;
		},
	});
	await feature.start(lifecycle(cleanup));
	expect(acquires).toBe(1);
	expect(feature.active()?.embedding).toBe(provider);
	for (const dispose of [...cleanup].reverse()) await dispose();
	expect(releases).toBe(1);
});

test("does not load embedding runtime without explicit user configuration", async (): Promise<void> => {
	let acquires = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: store,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => {
			acquires += 1;
			return undefined;
		},
	});
	await feature.start(lifecycle([]));
	expect(acquires).toBe(0);
});
