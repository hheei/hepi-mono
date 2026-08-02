import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import type { EmbeddingProvider, EmbeddingProviderLease } from "@hheei/pi-ext-embed";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import type {
	MctxMemory,
	MctxMemoryArchive,
	MctxMemoryEmbeddingCandidate,
	MctxMemoryEmbeddingWrite,
	MctxMemoryUpdate,
	MctxMemoryWrite,
	MctxStore,
} from "../src/store.js";

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
		resources: {
			add: (_name: string, dispose: () => void | Promise<void>) => cleanup.push(dispose),
			cleanup: async () => [],
		},
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

test("embeds only successful memory writes and fences stale jobs during cleanup", async (): Promise<void> => {
	const cleanup: Array<() => void | Promise<void>> = [];
	let memory: MctxMemory | undefined;
	const persisted: MctxMemoryEmbeddingWrite[] = [];
	const contentHash = (content: string): string => (content === "first" ? "a" : "b").repeat(64);
	const candidate = (): MctxMemoryEmbeddingCandidate | undefined => {
		if (memory === undefined || memory.status !== "active") return undefined;
		return {
			projectIdentity: memory.projectIdentity,
			memoryId: memory.memoryId,
			content: memory.content,
			contentHash: contentHash(memory.content),
			revision: memory.revision,
		};
	};
	const fakeStore = {
		getOrCreatePartition: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		writeMemory: (input: MctxMemoryWrite): MctxMemory => {
			memory = {
				projectIdentity: input.projectIdentity,
				memoryId: 1,
				category: input.category,
				content: input.content,
				status: "active",
				revision: 1,
				createdSessionId: input.sessionId,
				updatedSessionId: input.sessionId,
				createdAtMs: 0,
				updatedAtMs: 0,
			};
			return memory;
		},
		updateMemory: (input: MctxMemoryUpdate): MctxMemory | undefined => {
			if (
				memory === undefined ||
				memory.status !== "active" ||
				memory.revision !== input.expectedRevision
			)
				return undefined;
			memory = { ...memory, content: input.content, revision: memory.revision + 1 };
			return memory;
		},
		archiveMemory: (input: MctxMemoryArchive): MctxMemory | undefined => {
			if (
				memory === undefined ||
				memory.status !== "active" ||
				memory.revision !== input.expectedRevision
			)
				return undefined;
			memory = { ...memory, status: "archived", revision: memory.revision + 1 };
			return memory;
		},
		loadMemoryEmbeddingCandidate: (): MctxMemoryEmbeddingCandidate | undefined => candidate(),
		persistMemoryEmbedding: (input: MctxMemoryEmbeddingWrite): boolean => {
			const current = candidate();
			if (
				current === undefined ||
				current.contentHash !== input.contentHash ||
				current.revision !== input.revision
			)
				return false;
			persisted.push(input);
			return true;
		},
		close: () => undefined,
	} as unknown as MctxStore;
	const pending: Array<{
		readonly id: string;
		readonly signal: AbortSignal;
		readonly resolve: (vectors: ReadonlyMap<string, Float32Array> | undefined) => void;
	}> = [];
	const provider: EmbeddingProvider = {
		snapshot: () => ({ provider: "local", modelIdentity: "test-model", generation: 3 }),
		embed: async () => undefined,
		embedBatch: async (items, _purpose, signal) => {
			const item = items[0];
			if (item === undefined) throw new Error("Expected one memory item");
			return new Promise<ReadonlyMap<string, Float32Array> | undefined>((resolve) => {
				pending.push({ id: item.id, signal, resolve });
			});
		},
	};
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration({ provider: "local" }),
		openStore: () => fakeStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => ({ provider, release: async () => undefined }),
	});
	await feature.start(lifecycle(cleanup));
	const context = {
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	const first = feature.memory(
		{ action: "write", category: "ARCHITECTURE", content: "first" },
		context,
	);
	expect(first.kind).toBe("memory");
	expect(pending).toHaveLength(1);
	const updated = feature.memory(
		{ action: "update", memoryId: 1, expectedRevision: 1, content: "second" },
		context,
	);
	expect(updated.kind).toBe("memory");
	expect(pending).toHaveLength(2);
	const firstPending = pending[0];
	const secondPending = pending[1];
	if (firstPending === undefined || secondPending === undefined)
		throw new Error("Expected embedding jobs");
	firstPending.resolve(new Map([[firstPending.id, new Float32Array([1])]]));
	await Promise.resolve();
	await Promise.resolve();
	expect(persisted).toHaveLength(0);
	secondPending.resolve(new Map([[secondPending.id, new Float32Array([2])]]));
	await Promise.resolve();
	await Promise.resolve();
	expect(persisted).toHaveLength(1);
	expect(persisted[0]?.revision).toBe(2);
	feature.memory({ action: "archive", memoryId: 1, expectedRevision: 2 }, context);
	expect(pending).toHaveLength(2);
	feature.memory({ action: "write", category: "ARCHITECTURE", content: "second" }, context);
	const cleanupPending = pending[2];
	if (cleanupPending === undefined) throw new Error("Expected cleanup embedding job");
	for (const dispose of [...cleanup].reverse()) await dispose();
	expect(cleanupPending.signal.aborted).toBe(true);
});
