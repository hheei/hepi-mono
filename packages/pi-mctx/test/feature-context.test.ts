import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	MCTX_MEMORY_EXCLUSION_SERVICE,
	provideService,
} from "@hheei/pi-ext-core";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import type { MctxSearchCandidate } from "../src/search.js";
import { createMctxSourceSnapshot } from "../src/source-snapshot.js";
import type {
	MctxCompartment,
	MctxHistoryTag,
	MctxMemory,
	MctxNote,
	MctxRetainedHistoryTag,
	MctxStore,
} from "../src/store.js";

const model = { api: "test", provider: "anthropic", id: "claude-haiku" } as Model<Api>;

function entry(id: string, role: "user" | "assistant", content: string): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role, content, timestamp: 1 },
	} as SessionEntry;
}

const entries = [
	entry("user", "user", "old request"),
	entry("assistant", "assistant", "old response"),
];

function configuration(): MctxConfiguration {
	return {
		global: {},
		project: {},
		merged: {},
		sourceOf: () => undefined,
		warnings: [],
		pipeline: {
			kind: "enabled",
			settings: {
				historianModel: "anthropic/claude-haiku",
				failClosedBlocking: true,
				executeThresholdPercentage: { defaultValue: 65, byModel: {} },
				protectedTags: 20,
			},
		},
	};
}

function compartment(): MctxCompartment {
	const snapshot = createMctxSourceSnapshot(entries);
	if (snapshot.kind !== "valid") throw new Error("Expected valid source snapshot");
	return {
		tier: "m0",
		sequence: 0,
		sourceStartEntryId: "user",
		sourceEndEntryId: "assistant",
		sourceFingerprint: snapshot.snapshot.fingerprint,
		renderedPayload: "summary",
		publishedRevision: 1,
	};
}

function store(): MctxStore {
	const historyTags: MctxHistoryTag[] = [];
	const notes: MctxNote[] = [];
	const handoffDestinations = new Set<string>();
	return {
		path: "/store",
		getOrCreatePartition: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		findPartition: () => undefined,
		isHandoffInstalled: (_parent, destinationSessionId) =>
			handoffDestinations.has(destinationSessionId),
		reserveHandoffInstallation: (_parent, destinationSessionId) => {
			if (handoffDestinations.has(destinationSessionId)) return false;
			handoffDestinations.add(destinationSessionId);
			return {
				bindingId: `test-${destinationSessionId}`,
				ownerToken: `owner-${destinationSessionId}`,
			};
		},
		recoverHandoffInstallation: () => true,
		markHandoffInstalled: () => undefined,
		clearHandoffInstallation: (reservation) => {
			handoffDestinations.delete(reservation.bindingId.slice(5));
		},
		initializeForkPartition: () => ({
			kind: "copied",
			partition: { projectIdentity: "git:project", sessionId: "session-1", revision: 0 },
		}),
		advancePartitionRevision: () => undefined,
		acquireHistorianLease: () => undefined,
		renewHistorianLease: () => undefined,
		releaseHistorianLease: () => undefined,
		listCompartments: () => [compartment()],
		discardCompartmentsFrom: () => undefined,
		publishCompartment: () => undefined,
		syncHistoryTags: (partition, inputs) => {
			for (const input of inputs) {
				if (
					historyTags.some(
						(tag) =>
							tag.kind === input.kind &&
							tag.entryId === input.entryId &&
							tag.toolCallId === input.toolCallId,
					)
				)
					continue;
				historyTags.push({ ...input, tagNumber: historyTags.length + 1, status: "active" });
			}
			return { partition, tags: historyTags };
		},
		queueHistoryTagDrops: () => undefined,
		markHistoryTagsDropped: () => undefined,
		writeMemory: () => {
			throw new Error("not used");
		},
		getMemories: () => [],
		listActiveMemories: () => [],
		updateMemory: () => undefined,
		archiveMemory: () => undefined,
		writeNote: (input) => {
			const note: MctxNote = {
				projectIdentity: input.projectIdentity,
				sessionId: input.sessionId,
				noteId: notes.length + 1,
				content: input.content,
				status: "active",
				...(input.anchor === undefined ? {} : { anchor: input.anchor }),
				...(input.smartCondition === undefined ? {} : { smartCondition: input.smartCondition }),
				revision: 1,
				createdSessionId: input.sessionId,
				updatedSessionId: input.sessionId,
				createdAtMs: 0,
				updatedAtMs: 0,
			};
			notes.push(note);
			return note;
		},
		readNotes: (_projectIdentity, sessionId, status = "active") =>
			notes.filter((note) => note.sessionId === sessionId && note.status === status),
		listActiveNotes: (_projectIdentity, sessionId) =>
			notes.filter((note) => note.sessionId === sessionId && note.status === "active"),
		listRetainedHistoryTags: (input) =>
			historyTags
				.filter(() =>
					input.sessionId !== undefined
						? input.sessionId !== input.activeSessionId && input.sessionId === "session-1"
						: input.activeSessionId !== "session-1",
				)
				.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit)
				.map((tag) => ({ ...tag, projectIdentity: "git:project", sessionId: "session-1" })),
		purgeRetainedHistory: (input) => {
			if (input.sessionId === input.activeSessionId) throw new Error("active history");
			return historyTags.length;
		},
		updateNote: (input) => {
			const index = notes.findIndex(
				(note) =>
					note.sessionId === input.sessionId &&
					note.noteId === input.noteId &&
					note.status === "active" &&
					note.revision === input.expectedRevision,
			);
			const current = notes[index];
			if (current === undefined) return undefined;
			const updated: MctxNote = {
				...current,
				content: input.content,
				...(input.anchor === undefined
					? {}
					: input.anchor === null
						? {}
						: { anchor: input.anchor }),
				...(input.smartCondition === undefined
					? {}
					: input.smartCondition === null
						? {}
						: { smartCondition: input.smartCondition }),
				revision: current.revision + 1,
				updatedSessionId: input.sessionId,
			};
			notes[index] = updated;
			return updated;
		},
		dismissNote: (input) => {
			const index = notes.findIndex(
				(note) =>
					note.sessionId === input.sessionId &&
					note.noteId === input.noteId &&
					note.status === "active" &&
					note.revision === input.expectedRevision,
			);
			const current = notes[index];
			if (current === undefined) return undefined;
			const dismissed: MctxNote = {
				...current,
				status: "dismissed",
				revision: current.revision + 1,
			};
			notes[index] = dismissed;
			return dismissed;
		},
		close: () => undefined,
	};
}

test("expand reads only current-branch retained tags and reports gaps", async (): Promise<void> => {
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	expect(feature.expand([1, 2, 99], context)).toMatchObject({
		kind: "expanded",
		tags: [
			{ tagNumber: 1, status: "active", source: "old request" },
			{ tagNumber: 2, status: "active" },
		],
		rejected: [99],
	});
	expect(
		feature.expand([1], {
			...context,
			sessionManager: { ...context.sessionManager, getBranch: () => [entries[0]!] },
		}),
	).toMatchObject({ kind: "expanded", tags: [{ tagNumber: 1 }], rejected: [] });
});

test("notes persist resolved current-branch tag identity and stay session-local", async (): Promise<void> => {
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const written = feature.note(
		{ action: "write", content: "Check migration.", anchorTag: 2, smartCondition: "When v7 opens" },
		context,
	);
	expect(written).toMatchObject({
		kind: "notes",
		notes: [
			{
				noteId: 1,
				anchor: { entryId: "assistant", kind: "message" },
				smartCondition: "When v7 opens",
			},
		],
	});
	expect(feature.note({ action: "read" }, context)).toMatchObject({
		kind: "notes",
		notes: [{ noteId: 1 }],
	});
	expect(feature.note({ action: "write", content: "bad", anchorTag: 99 }, context)).toEqual({
		kind: "invalid-anchor",
	});
	expect(
		feature.note(
			{ action: "read" },
			{
				...context,
				sessionManager: { ...context.sessionManager, getSessionId: () => "other-session" },
			},
		),
	).toEqual({ kind: "inactive" });
});

test("history lists and purges only non-active retained sessions", async (): Promise<void> => {
	const retained: MctxRetainedHistoryTag[] = [
		{
			projectIdentity: "git:project",
			sessionId: "old-session",
			tagNumber: 1,
			kind: "message",
			entryId: "old-entry",
			source: "old retained source",
			status: "active",
		},
	];
	let purgedSession: string | undefined;
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			listRetainedHistoryTags: (input) =>
				input.sessionId === "session-1" ? [] : retained.slice(input.offset ?? 0, input.limit),
			purgeRetainedHistory: (input) => {
				if (input.sessionId === input.activeSessionId) throw new Error("active history");
				purgedSession = input.sessionId;
				return 1;
			},
		}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	expect(feature.history({ action: "list", limit: 10 }, context)).toMatchObject({
		kind: "history",
		tags: [{ sessionId: "old-session", source: "old retained source" }],
	});
	expect(feature.history({ action: "list", sessionId: "session-1", limit: 10 }, context)).toEqual({
		kind: "history",
		tags: [],
	});
	expect(feature.history({ action: "purge", sessionId: "session-1" }, context)).toEqual({
		kind: "active-session",
	});
	expect(feature.history({ action: "purge", sessionId: "old-session" }, context)).toEqual({
		kind: "purged",
		deleted: 1,
	});
	expect(purgedSession).toBe("old-session");
});

test("search admits bounded five-source snapshots without current-session history", async (): Promise<void> => {
	const memory: MctxMemory = {
		projectIdentity: "git:project",
		memoryId: 1,
		category: "ARCHITECTURE",
		content: "target memory",
		status: "active",
		revision: 1,
		createdSessionId: "session-1",
		updatedSessionId: "session-1",
		createdAtMs: 0,
		updatedAtMs: 0,
	};
	const note: MctxNote = {
		projectIdentity: "git:project",
		sessionId: "session-1",
		noteId: 1,
		content: "target note",
		status: "active",
		anchor: { entryId: "assistant", kind: "message" },
		revision: 1,
		createdSessionId: "session-1",
		updatedSessionId: "session-1",
		createdAtMs: 0,
		updatedAtMs: 0,
	};
	const history: MctxRetainedHistoryTag = {
		projectIdentity: "git:project",
		sessionId: "old-session",
		tagNumber: 1,
		kind: "message",
		entryId: "old-entry",
		source: "target retained history",
		status: "dropped",
	};
	let externalInput:
		| {
				readonly sources: readonly string[];
				readonly signal: AbortSignal;
		  }
		| undefined;
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			listActiveMemories: () => [memory],
			listActiveNotes: () => [note],
			listRetainedHistoryTags: (input) => {
				expect(input.activeSessionId).toBe("session-1");
				return [history];
			},
		}),
		resolveProjectIdentity: async () => "git:project",
		collectExternalSearchCandidates: async (input): Promise<readonly MctxSearchCandidate[]> => {
			externalInput = input;
			return [
				{ source: "git", id: "git:1", title: "Git", text: "target commit" },
				{ source: "primer", id: "primer:1", title: "Primer", text: "target primer" },
			];
		},
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const result = await feature.search(
		{ query: "target", limit: 10 },
		context,
		new AbortController().signal,
	);
	expect(result).toMatchObject({
		kind: "hits",
		hits: [
			{ source: "memory" },
			{ source: "note" },
			{ source: "history", title: "History old-session §1§ (message)" },
			{ source: "git" },
			{ source: "primer" },
		],
	});
	expect(externalInput?.sources).toEqual(["memory", "note", "history", "git", "primer"]);
});

test("search excludes runtime-injected active memory IDs", async (): Promise<void> => {
	const memory: MctxMemory = {
		projectIdentity: "git:project",
		memoryId: 1,
		category: "ARCHITECTURE",
		content: "target memory",
		status: "active",
		revision: 1,
		createdSessionId: "session-1",
		updatedSessionId: "session-1",
		createdAtMs: 0,
		updatedAtMs: 0,
	};
	let excludedIds: readonly number[] = [1];
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	expect(
		provideService(lifecycle, MCTX_MEMORY_EXCLUSION_SERVICE, {
			excludeMemoryIds: (input) => {
				expect(input).toMatchObject({ projectIdentity: "git:project", sessionId: "session-1" });
				return excludedIds;
			},
		}),
	).toBeTrue();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({ ...store(), listActiveMemories: () => [memory] }),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	expect(
		await feature.search({ query: "target", limit: 10 }, context, new AbortController().signal),
	).toEqual({ kind: "hits", hits: [] });
	excludedIds = [0];
	expect(
		await feature.search({ query: "target", limit: 10 }, context, new AbortController().signal),
	).toEqual({ kind: "invalid-exclusions" });
});

test("search reports stale when either exclusion-provider cancellation scope aborts", async (): Promise<void> => {
	const controller = new AbortController();
	const lifecycleController = new AbortController();
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: lifecycleController.signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	expect(
		provideService(lifecycle, MCTX_MEMORY_EXCLUSION_SERVICE, {
			excludeMemoryIds: async (input) => {
				await new Promise<void>((_resolve, reject) => {
					input.signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
				return [];
			},
		}),
	).toBeTrue();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const search = feature.search({ query: "target", limit: 10 }, context, controller.signal);
	controller.abort();
	expect(await search).toEqual({ kind: "stale" });
	const lifecycleSearch = feature.search(
		{ query: "target", limit: 10 },
		context,
		new AbortController().signal,
	);
	lifecycleController.abort();
	expect(await lifecycleSearch).toEqual({ kind: "stale" });
});

test("context hook renders only the active session's verified graph", async (): Promise<void> => {
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const raw: AgentMessage[] = entries.flatMap((value) => sessionEntryToContextMessages(value));
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	expect(feature.onContext(raw, context)).toEqual({
		messages: [
			{
				role: "custom",
				customType: "pi-mctx:m0",
				content: "summary",
				display: false,
				timestamp: 0,
			},
		],
	});
	expect(
		feature.onContext(raw, {
			...context,
			sessionManager: { ...context.sessionManager, getSessionId: () => "other" },
		}),
	).toBeUndefined();
});

test("parent projection exposes verified compartments and only the live tail", async (): Promise<void> => {
	const branch = [...entries, entry("tail", "user", "live tail")];
	const installedDestinations = new Set<string>();
	let reserveFailure = false;
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1", getBranch: () => branch },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			isHandoffInstalled: (_parent, destination) => installedDestinations.has(destination),
			reserveHandoffInstallation: (_parent, destination) => {
				if (reserveFailure) throw new Error("database unavailable");
				if (installedDestinations.has(destination)) return false;
				installedDestinations.add(destination);
				return { bindingId: `test-${destination}`, ownerToken: `owner-${destination}` };
			},
			recoverHandoffInstallation: () => true,
			markHandoffInstalled: () => undefined,
			clearHandoffInstallation: (reservation) => {
				installedDestinations.delete(reservation.bindingId.slice(5));
			},
			findPartition: () => ({
				projectIdentity: "git:project",
				sessionId: "session-1",
				revision: 0,
			}),
		}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const injected: string[] = [];
	const context = {
		sessionManager: {
			getSessionId: () => "replacement-session",
			getBranch: () => branch,
			appendCustomMessageEntry: (_type: string, content: string, _display: boolean) =>
				injected.push(content),
		},
	} as unknown as ExtensionContext;
	const projection = await feature.prepare({
		purpose: "inheritance",
		signal: new AbortController().signal,
	});
	expect(projection).toMatchObject({ kind: "result", purpose: "inheritance" });
	if (projection.kind === "result" && projection.purpose === "inheritance") {
		expect(projection.payload).toContain("[MCTX m0]: summary");
		expect(projection.payload).toContain("[User]: live tail");
		expect(projection.payload).not.toContain("old request");
	}
	const handoff = await feature.prepare({
		purpose: "handoff",
		signal: new AbortController().signal,
	});
	expect(handoff.kind).toBe("result");
	expect(
		await feature.prepare({ purpose: "handoff", signal: new AbortController().signal }),
	).toEqual({ kind: "stale" });
	if (handoff.kind === "result" && handoff.purpose === "handoff") {
		await handoff.install(context.sessionManager, new AbortController().signal);
		await handoff.install(
			{
				getSessionId: () => "replacement-session",
				getBranch: () => [],
				appendCustomMessageEntry: (_type: string, content: string) => injected.push(content),
			},
			new AbortController().signal,
		);
	}
	expect(injected).toHaveLength(1);

	// Pi may cancel `newSession()` before it invokes the selected plan's setup.
	// Aborting prepare's operation must release the in-memory preparation guard.
	const cancelledPreparation = new AbortController();
	const cancelledHandoff = await feature.prepare({
		purpose: "handoff",
		signal: cancelledPreparation.signal,
	});
	expect(cancelledHandoff).toMatchObject({ kind: "result", purpose: "handoff" });
	cancelledPreparation.abort();
	const retriedHandoff = await feature.prepare({
		purpose: "handoff",
		signal: new AbortController().signal,
	});
	expect(retriedHandoff).toMatchObject({ kind: "result", purpose: "handoff" });
	if (retriedHandoff.kind === "result" && retriedHandoff.purpose === "handoff")
		await retriedHandoff.install(
			{
				getSessionId: () => "cancelled-then-retried",
				getBranch: () => [],
				appendCustomMessageEntry: (_type: string, content: string) => injected.push(content),
			},
			new AbortController().signal,
		);

	reserveFailure = true;
	const markFailure = await feature.prepare({
		purpose: "handoff",
		signal: new AbortController().signal,
	});
	if (markFailure.kind === "result" && markFailure.purpose === "handoff")
		await expect(
			markFailure.install(
				{
					getSessionId: () => "mark-failure",
					getBranch: () => [],
					appendCustomMessageEntry: (_type: string, content: string) => injected.push(content),
				},
				new AbortController().signal,
			),
		).rejects.toThrow("database unavailable");
	expect(injected).toHaveLength(2);

	reserveFailure = false;
	const appendFailure = await feature.prepare({
		purpose: "handoff",
		signal: new AbortController().signal,
	});
	if (appendFailure.kind === "result" && appendFailure.purpose === "handoff")
		await expect(
			appendFailure.install(
				{
					getSessionId: () => "append-failure",
					getBranch: () => [],
					appendCustomMessageEntry: () => {
						throw new Error("host append failed");
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow("host append failed");
	expect(installedDestinations.has("append-failure")).toBeFalse();

	const abortedPrepare = new AbortController();
	abortedPrepare.abort();
	expect(await feature.prepare({ purpose: "inheritance", signal: abortedPrepare.signal })).toEqual({
		kind: "stale",
	});

	const abortedInstall = await feature.prepare({
		purpose: "handoff",
		signal: new AbortController().signal,
	});
	const abortedInstallSignal = new AbortController();
	abortedInstallSignal.abort();
	if (abortedInstall.kind === "result" && abortedInstall.purpose === "handoff")
		await expect(
			abortedInstall.install(
				{
					getSessionId: () => "aborted-install",
					getBranch: () => [],
					appendCustomMessageEntry: (_type: string, content: string) => injected.push(content),
				},
				abortedInstallSignal.signal,
			),
		).rejects.toThrow("MCTX handoff aborted");
	expect(installedDestinations.has("aborted-install")).toBeFalse();
});

test("context hook atomically drops a recoverable divergent tail and leaves that pass raw", async (): Promise<void> => {
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	let discardedRevision: number | undefined;
	let historianCalls = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			listCompartments: () => [{ ...compartment(), sourceFingerprint: "stale" }],
			discardCompartmentsFrom: (_partition, revision) => {
				discardedRevision = revision;
				return { projectIdentity: "git:project", sessionId: "session-1", revision: 1 };
			},
		}),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async () => {
			historianCalls++;
			return { kind: "cancelled" };
		},
	});
	await feature.start(lifecycle);
	const raw: AgentMessage[] = entries.flatMap((value) => sessionEntryToContextMessages(value));
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	expect(feature.onContext(raw, context)).toBeUndefined();
	expect(discardedRevision).toBe(1);
	expect(historianCalls).toBe(1);
	const active = feature.active();
	if (active === undefined) throw new Error("Expected active runtime");
	expect(active.partition.revision).toBe(1);
});

test("fork activation copies cross-project ancestors only after child-branch proof", async (): Promise<void> => {
	const parentProject = `git:${"a".repeat(40)}`;
	const childProject = `git:${"b".repeat(40)}`;
	let initialized = false;
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/child-project",
			sessionManager: {
				getSessionId: () => "child-session",
				getHeader: () => ({ parentSession: "/parent-session.jsonl" }),
				getBranch: () => entries,
			},
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			findPartition: () => ({
				projectIdentity: parentProject,
				sessionId: "parent-session",
				revision: 1,
			}),
			initializeForkPartition: (source, destination, compartments) => {
				initialized = true;
				expect(source).toEqual({
					projectIdentity: parentProject,
					sessionId: "parent-session",
					revision: 1,
				});
				expect(destination).toEqual({ projectIdentity: childProject, sessionId: "child-session" });
				expect(compartments).toEqual([compartment()]);
				return {
					kind: "copied",
					partition: { ...destination, revision: compartments.length },
				};
			},
		}),
		resolveProjectIdentity: async (cwd) =>
			cwd === "/parent-project" ? parentProject : childProject,
		readForkSource: () => ({ cwd: "/parent-project", sessionId: "parent-session" }),
	});
	await feature.start(lifecycle);
	expect(initialized).toBeTrue();
	expect(feature.active()?.partition).toEqual({
		projectIdentity: childProject,
		sessionId: "child-session",
		revision: 1,
	});
});

test("fork activation leaves invalid parent graph unmaterialized", async (): Promise<void> => {
	let initialized = false;
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/child-project",
			sessionManager: {
				getSessionId: () => "child-session",
				getHeader: () => ({ parentSession: "/parent-session.jsonl" }),
				getBranch: () => entries,
			},
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			findPartition: () => ({
				projectIdentity: "git:parent",
				sessionId: "parent-session",
				revision: 1,
			}),
			listCompartments: () => [{ ...compartment(), sourceFingerprint: "not-child-proof" }],
			initializeForkPartition: () => {
				initialized = true;
				throw new Error("Invalid graph must not copy");
			},
		}),
		resolveProjectIdentity: async () => "git:child",
		readForkSource: () => ({ cwd: "/parent-project", sessionId: "parent-session" }),
	});
	await feature.start(lifecycle);
	expect(initialized).toBeFalse();
	expect(feature.active()?.partition).toEqual({
		projectIdentity: "git:project",
		sessionId: "session-1",
		revision: 0,
	});
});
