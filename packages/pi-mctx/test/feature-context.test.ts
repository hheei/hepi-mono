import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import { createMctxSourceSnapshot } from "../src/source-snapshot.js";
import type { MctxCompartment, MctxHistoryTag, MctxNote, MctxStore } from "../src/store.js";

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
		updateMemory: () => undefined,
		archiveMemory: () => undefined,
		loadMemoryEmbeddingCandidate: () => undefined,
		persistMemoryEmbedding: () => false,
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
