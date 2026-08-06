import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
	type SubagentId,
	type TaskSubagentHandle,
	type TaskTerminalResult,
} from "@hheei/pi-ext-core";
import type { EmbeddingProviderLease } from "@hheei/pi-ext-embed";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import { type MctxSearchCandidate, mctxSearchContentHash } from "../src/search.js";
import { createMctxSourceSnapshot } from "../src/source-snapshot.js";
import { emptyMctxStatusAccounting } from "../src/status-metrics.js";
import type {
	MctxCompartment,
	MctxHistoryTag,
	MctxMemory,
	MctxMemoryEmbeddingWrite,
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

function subagentId(value: string): SubagentId {
	return value as SubagentId;
}

function configuration(
	failClosedBlocking = true,
	smartDrops = false,
	protectedTags = 20,
): MctxConfiguration {
	return {
		global: {},
		project: {},
		merged: {},
		sourceOf: () => undefined,
		warnings: [],
		pipeline: {
			kind: "enabled",
			settings: {
				historian: { kind: "enabled", model: "anthropic/claude-haiku" },
				failClosedBlocking,
				smartDrops,
				executeThresholdPercentage: { defaultValue: 65, byModel: {} },
				protectedTags,
				clearReasoningAge: 3,
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

function store(overrides: Partial<MctxStore> = {}): MctxStore {
	const historyTags: MctxHistoryTag[] = [];
	const notes: MctxNote[] = [];
	const handoffDestinations = new Set<string>();
	const base: MctxStore = {
		path: "/store",
		getOrCreatePartition: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		replaceHistoryTagSources: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		advanceHistoryTagCavemanDepths: () => ({
			projectIdentity: "git:project",
			sessionId: "session-1",
			revision: 0,
		}),
		readStatusAccounting: () => emptyMctxStatusAccounting(),
		writeStatusAccounting: () => undefined,
		readReasoningWatermark: () => 0,
		advanceReasoningWatermark: (_partition, tagNumber) => tagNumber,
		findPartition: () => undefined,
		isHandoffInstalled: (_parent, destinationSessionId) =>
			handoffDestinations.has(destinationSessionId),
		reserveHandoffInstallation: (_parent, destinationSessionId) => {
			if (handoffDestinations.has(destinationSessionId)) return undefined;
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
		listHistoryTags: () => historyTags,
		advancePartitionRevision: () => undefined,
		acquireHistorianLease: () => undefined,
		renewHistorianLease: () => undefined,
		releaseHistorianLease: () => undefined,
		listCompartments: () => [compartment()],
		readStatusMetrics: () => ({
			compartments: { total: 1, m0: 1, m1: 0 },
			tags: { total: historyTags.length, active: historyTags.length, pending: 0, dropped: 0 },
		}),
		publishCompartment: () => undefined,
		replaceCompartmentsFrom: () => undefined,
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
		writeMemoryEmbedding: () => {
			throw new Error("not used");
		},
		listMemoryEmbeddingCoverage: () => new Map(),
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
	return { ...base, ...overrides };
}

test("active MCTX prepares a verified same-session compaction result", async (): Promise<void> => {
	const notifications: Array<{ readonly message: string; readonly level?: string }> = [];
	const branch = [...entries, entry("tail", "user", "keep this live")];
	const partition = { projectIdentity: "git:project", sessionId: "session-1", revision: 0 };
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () =>
			store({
				findPartition: () => partition,
				listCompartments: () => [compartment()],
			}),
		resolveProjectIdentity: async () => "git:project",
	});
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: {
				notify: (message: string, level?: string) =>
					notifications.push({ message, ...(level === undefined ? {} : { level }) }),
			},
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	};
	await feature.start(lifecycle as unknown as ExtensionLifecycleContext);
	const context = {
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;

	expect(
		await feature.compact(branch, 1_000, context, false, new AbortController().signal),
	).toEqual({
		kind: "compaction",
		compaction: {
			summary: "[MCTX m0]: summary",
			firstKeptEntryId: "tail",
			tokensBefore: 1_000,
			details: { source: "pi-mctx" },
		},
	});
});

test("smart drops queue an old visible tool result and project its recovery marker", async (): Promise<void> => {
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text: "I inspected the command output." },
			{ type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "rg" } },
		],
		timestamp: 1,
	};
	const result = {
		role: "toolResult" as const,
		toolCallId: "call-1",
		content: [{ type: "text" as const, text: "x".repeat(400) }],
		timestamp: 2,
	};
	const branch = [
		entry("user", "user", "Inspect this."),
		{
			id: "assistant",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			type: "message",
			message: assistant,
		} as SessionEntry,
		{
			id: "result",
			parentId: null,
			timestamp: "2026-01-01T00:00:02.000Z",
			type: "message",
			message: result,
		} as SessionEntry,
		{
			id: "assistant-followup",
			parentId: null,
			timestamp: "2026-01-01T00:00:03.000Z",
			type: "message",
			message: {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "The output has been handled." }],
				timestamp: 3,
			},
		} as SessionEntry,
	];
	const historyTags: MctxHistoryTag[] = [];
	let firstDropCommit = true;
	const notifications: Array<{ readonly message: string; readonly level?: string }> = [];
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: {
				notify: (message: string, level?: string) =>
					notifications.push({ message, ...(level === undefined ? {} : { level }) }),
			},
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(true, true, 1),
		openStore: () =>
			store({
				listCompartments: () => [],
				findPartition: () => ({
					projectIdentity: "git:project",
					sessionId: "session-1",
					revision: 1,
				}),
				syncHistoryTags: (partition, inputs) => {
					for (const input of inputs) {
						const exists = historyTags.some(
							(tag) =>
								tag.kind === input.kind &&
								tag.entryId === input.entryId &&
								tag.toolCallId === input.toolCallId,
						);
						if (exists) continue;
						historyTags.push({ ...input, tagNumber: historyTags.length + 1, status: "active" });
					}
					return { partition, tags: historyTags };
				},
				queueHistoryTagDrops: (partition, tagNumbers) => {
					for (const [index, tag] of historyTags.entries()) {
						if (tagNumbers.includes(tag.tagNumber) && tag.status === "active")
							historyTags[index] = { ...tag, status: "pending" };
					}
					return {
						partition: { ...partition, revision: partition.revision + 1 },
						queued: tagNumbers,
						rejected: [],
					};
				},
				markHistoryTagsDropped: (partition, tagNumbers) => {
					if (firstDropCommit) {
						firstDropCommit = false;
						return undefined;
					}
					for (const [index, tag] of historyTags.entries()) {
						if (tagNumbers.includes(tag.tagNumber) && tag.status === "pending")
							historyTags[index] = { ...tag, status: "dropped" };
					}
					return { ...partition, revision: partition.revision + 1 };
				},
			}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	// Pi emits a deep copy for context hooks; this catches accidental session-object
	// identity checks in smart-drop candidate selection.
	const raw = structuredClone(branch.flatMap(sessionEntryToContextMessages));
	let activeBranch = branch.slice(0, 2);
	const context = {
		model,
		getContextUsage: () => ({ tokens: 65, contextWindow: 100 }),
		sessionManager: { getSessionId: () => "session-1", getBranch: () => activeBranch },
	} as unknown as ExtensionContext;
	// A high-usage pass with no result must not consume smart-drop cooldown.
	await feature.onContext(activeBranch.flatMap(sessionEntryToContextMessages), context);
	activeBranch = branch;
	const projected = await feature.onContext(raw, context);
	expect(
		projected?.messages.some((message) => JSON.stringify(message).includes("[dropped §3§]")),
	).toBeFalse();
	expect(historyTags.find((tag) => tag.kind === "tool")?.status).toBe("pending");
	expect(notifications).toContainEqual({
		message: "pi-mctx automatic history drop failed during commit; keeping raw context",
		level: "error",
	});

	const committed = await feature.onContext(raw, context);
	expect(
		committed?.messages.some((message) => JSON.stringify(message).includes("[dropped §3§]")),
	).toBe(true);
	expect(historyTags.find((tag) => tag.kind === "tool")?.status).toBe("dropped");
	expect(firstDropCommit).toBeFalse();
});

test("ctx_reduce rejects tags already covered by a verified compartment", async (): Promise<void> => {
	const tail = entry("tail", "user", "current request");
	const branch = [...entries, tail];
	const historyTags: MctxHistoryTag[] = [];
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
		loadConfiguration: async () => configuration(true, false, 1),
		openStore: () =>
			store({
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
				queueHistoryTagDrops: (partition, tagNumbers, activeTagNumbers) => ({
					partition,
					queued: tagNumbers.filter((tagNumber) => activeTagNumbers.includes(tagNumber)),
					rejected: tagNumbers.filter((tagNumber) => !activeTagNumbers.includes(tagNumber)),
				}),
			}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => branch },
	} as unknown as ExtensionContext;
	expect(feature.reduce([1], context)).toEqual({ kind: "queued", queued: [], rejected: [1] });
});

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
		resources: {
			add: (_id: string, _cleanup: () => void | Promise<void>) => undefined,
			cleanup: async () => [],
		} as never,
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

test("tool-result guidance does not append an inline ceiling message", async (): Promise<void> => {
	const toolBranch = [
		entry("request", "user", "inspect files"),
		{
			type: "message",
			id: "tool-call-1",
			parentId: "request",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }],
				timestamp: 1,
			},
		} as SessionEntry,
		{
			type: "message",
			id: "tool-result-1",
			parentId: "tool-call-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text" as const, text: "old result" }],
				isError: false,
				timestamp: 2,
			},
		} as SessionEntry,
		{
			type: "message",
			id: "tool-call-2",
			parentId: "tool-result-1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "call-2", name: "read", arguments: {} }],
				timestamp: 3,
			},
		} as SessionEntry,
		{
			type: "message",
			id: "tool-result-2",
			parentId: "tool-call-2",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: {
				role: "toolResult" as const,
				toolCallId: "call-2",
				toolName: "read",
				content: [{ type: "text" as const, text: "protected result" }],
				isError: false,
				timestamp: 4,
			},
		} as SessionEntry,
	];
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(true, false, 1),
		openStore: () => store({ listCompartments: () => [] }),
		resolveProjectIdentity: async () => "git:project",
	});
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
	await feature.start(lifecycle);
	const context = {
		model,
		getContextUsage: () => ({ tokens: 64, contextWindow: 100 }),
		sessionManager: { getSessionId: () => "session-1", getBranch: () => toolBranch },
	} as unknown as ExtensionContext;
	await feature.onContext(toolBranch.flatMap(sessionEntryToContextMessages), context);
	expect(feature.onToolResult("read", [{ type: "text", text: "more output" }], context)).toBe(
		"<system-reminder>Context pressure is rising. Review completed tool outputs and silently call ctx_reduce for obsolete tool tags: 2. Keep user and assistant text. Reclaim after this result if it is no longer needed.</system-reminder>",
	);
	await feature.onContext(toolBranch.flatMap(sessionEntryToContextMessages), context);
});

test("context injects a ceiling nudge in the request that first crosses the delivery threshold", async (): Promise<void> => {
	const toolBranch = [
		entry("request", "user", "inspect files"),
		{
			type: "message",
			id: "tool-call",
			parentId: "request",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }],
				timestamp: 1,
			},
		} as SessionEntry,
		{
			type: "message",
			id: "tool-result",
			parentId: "tool-call",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text" as const, text: "x".repeat(1_000) }],
				isError: false,
				timestamp: 2,
			},
		} as SessionEntry,
		entry("current", "user", "continue"),
	];
	const historyTags: MctxHistoryTag[] = [];
	let nudgeState: "pending" | "claimed" | "delivered" | undefined;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(true, false, 1),
		openStore: () =>
			store({
				listCompartments: () => [],
				syncHistoryTags: (partition, inputs) => {
					for (const input of inputs) {
						const alreadyTracked = historyTags.some(
							(tag) =>
								tag.kind === input.kind &&
								tag.entryId === input.entryId &&
								tag.toolCallId === input.toolCallId,
						);
						if (alreadyTracked) continue;
						historyTags.push({ ...input, tagNumber: historyTags.length + 1, status: "active" });
					}
					return { partition, tags: historyTags };
				},
				armNudgeDelivery: () => {
					nudgeState = "pending";
				},
				claimNudgeDelivery: (partition) => {
					if (nudgeState !== "pending") return undefined;
					nudgeState = "claimed";
					return { partition, ownerToken: "nudge" };
				},
				markNudgeDelivered: () => {
					if (nudgeState !== "claimed") return false;
					nudgeState = "delivered";
					return true;
				},
			}),
		resolveProjectIdentity: async () => "git:project",
	});
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
	await feature.start(lifecycle);
	const context = {
		model,
		getContextUsage: () => ({ tokens: 64, contextWindow: 100 }),
		sessionManager: { getSessionId: () => "session-1", getBranch: () => toolBranch },
	} as unknown as ExtensionContext;

	const projected = await feature.onContext(
		structuredClone(toolBranch.flatMap(sessionEntryToContextMessages)),
		context,
	);
	expect(projected?.messages).toContainEqual(
		expect.objectContaining({
			role: "custom",
			customType: "pi-mctx:ceiling-nudge",
			content: expect.stringContaining("Context pressure is rising"),
		}),
	);
	expect(nudgeState).toBe("delivered");
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

test("search passes lifecycle cancellation to external candidates", async (): Promise<void> => {
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
	let externalSignal: AbortSignal | undefined;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
		collectExternalSearchCandidates: async (input) => {
			externalSignal = input.signal;
			await new Promise<void>((resolve) =>
				input.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return [];
		},
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const search = feature.search(
		{ query: "target", limit: 10, sources: ["git"] },
		context,
		new AbortController().signal,
	);
	lifecycleController.abort();
	expect(await search).toEqual({ kind: "stale" });
	expect(externalSignal?.aborted).toBe(true);
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
	expect(await feature.onContext(raw, context)).toEqual({
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
		await feature.onContext(raw, {
			...context,
			sessionManager: { ...context.sessionManager, getSessionId: () => "other" },
		}),
	).toBeUndefined();
});

test("context hook rethrows store read failures when blocking is enabled", async (): Promise<void> => {
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
			syncHistoryTags: () => {
				throw new Error("database is unavailable");
			},
		}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const raw: AgentMessage[] = entries.flatMap((value) => sessionEntryToContextMessages(value));
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	await expect(feature.onContext(raw, context)).rejects.toThrow("database is unavailable");
});

test("context hook passes Pi-native messages through and warns per failure epoch when disabled", async (): Promise<void> => {
	const notifications: Array<{ readonly message: string; readonly level: string | undefined }> = [];
	const failureState = { value: true };
	const shouldFail = (): boolean => failureState.value;
	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: {
				notify: (message: string, level?: string) => notifications.push({ message, level }),
			},
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(false),
		openStore: () => ({
			...store(),
			syncHistoryTags: () => {
				if (shouldFail()) throw new Error("database is unavailable");
				return {
					partition: { projectIdentity: "git:project", sessionId: "session-1", revision: 0 },
					tags: [],
				};
			},
		}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const raw: AgentMessage[] = entries.flatMap((value) => sessionEntryToContextMessages(value));
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	expect(await feature.onContext(raw, context)).toBeUndefined();
	// Consecutive failures within one epoch warn once, not per model invocation.
	expect(await feature.onContext(raw, context)).toBeUndefined();
	expect(notifications).toEqual([
		{
			message:
				"pi-mctx context store read failed; continuing with Pi native context: database is unavailable",
			level: "error",
		},
	]);
	// A successful projection re-arms the next failure epoch.
	failureState.value = false;
	expect(await feature.onContext(raw, context)).toBeDefined();
	failureState.value = true;
	expect(await feature.onContext(raw, context)).toBeUndefined();
	expect(notifications).toHaveLength(2);
});

test("parent projection exposes verified compartments and only the live tail", async (): Promise<void> => {
	const branch = [...entries, entry("tail", "user", "live tail")];
	const installedDestinations = new Set<string>();
	const reservationState = { failed: false };
	const shouldFailReservation = (): boolean => reservationState.failed;
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
				if (shouldFailReservation()) throw new Error("database unavailable");
				if (installedDestinations.has(destination)) return undefined;
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
			appendCustomMessageEntry: <T = unknown>(
				_type: string,
				content: string | T[],
				_display: boolean,
			): string => {
				injected.push(typeof content === "string" ? content : JSON.stringify(content));
				return "";
			},
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
		await handoff.install(
			context.sessionManager as unknown as Parameters<typeof handoff.install>[0],
			new AbortController().signal,
		);
		await handoff.install(
			{
				getSessionId: () => "replacement-session",
				getBranch: () => [],
				appendCustomMessageEntry: (_type: string, content: string): string => {
					injected.push(content);
					return "";
				},
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
				appendCustomMessageEntry: (_type: string, content: string): string => {
					injected.push(content);
					return "";
				},
			},
			new AbortController().signal,
		);

	reservationState.failed = true;
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
					appendCustomMessageEntry: (_type: string, content: string): string => {
						injected.push(content);
						return "";
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow("database unavailable");
	expect(injected).toHaveLength(2);

	reservationState.failed = false;
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
					appendCustomMessageEntry: (_type: string, content: string): string => {
						injected.push(content);
						return "";
					},
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
	let historianCalls = 0;
	let rebuildRequest:
		| { readonly rebuild?: true; readonly baseCompartments?: readonly MctxCompartment[] }
		| undefined;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => ({
			...store(),
			listCompartments: () => [{ ...compartment(), sourceFingerprint: "stale" }],
			replaceCompartmentsFrom: () => undefined,
		}),
		resolveProjectIdentity: async () => "git:project",
		runHistorianForBranch: async (request) => {
			historianCalls++;
			rebuildRequest = request;
			return { kind: "cancelled" };
		},
	});
	await feature.start(lifecycle);
	const raw: AgentMessage[] = entries.flatMap((value) => sessionEntryToContextMessages(value));
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	expect(await feature.onContext(raw, context)).toBeUndefined();
	expect(historianCalls).toBe(1);
	expect(rebuildRequest).toMatchObject({ rebuild: true, baseCompartments: [] });
	const active = feature.active();
	if (active === undefined) throw new Error("Expected active runtime");
	expect(active.partition.revision).toBe(0);
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
			listHistoryTags: () => [
				{
					kind: "message",
					entryId: "user",
					source: "old request",
					tagNumber: 1,
					status: "dropped",
					cavemanDepth: 2,
				},
				{
					kind: "message",
					entryId: "outside-child-branch",
					source: "must not copy",
					tagNumber: 2,
					status: "active",
				},
			],
			initializeForkPartition: (source, destination, compartments, historyTags) => {
				initialized = true;
				expect(source).toEqual({
					projectIdentity: parentProject,
					sessionId: "parent-session",
					revision: 1,
				});
				expect(destination).toEqual({ projectIdentity: childProject, sessionId: "child-session" });
				expect(compartments).toEqual([compartment()]);
				expect(historyTags).toEqual([
					{
						kind: "message",
						entryId: "user",
						source: "old request",
						tagNumber: 1,
						status: "dropped",
						cavemanDepth: 2,
					},
				]);
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

function embeddingConfiguration(): MctxConfiguration {
	return { ...configuration(), embedding: { config: { provider: "local" } } };
}

function embeddingLease(
	options: {
		readonly embed?: (
			text: string,
			purpose: "query" | "passage",
			signal: AbortSignal,
		) => Promise<Float32Array | undefined>;
		readonly embedBatch?: (
			items: ReadonlyArray<{
				readonly id: string;
				readonly text: string;
				readonly contentHash: string;
			}>,
			purpose: "query" | "passage",
			signal: AbortSignal,
		) => Promise<ReadonlyMap<string, Float32Array> | undefined>;
	} = {},
): {
	readonly lease: EmbeddingProviderLease;
	readonly released: () => boolean;
} {
	let releasedFlag = false;
	return {
		lease: {
			provider: {
				snapshot: () => ({
					provider: "local",
					modelIdentity: "local/model-a",
					generation: 1,
				}),
				embed: options.embed ?? (async () => new Float32Array([0.5, 0.25])),
				embedBatch: options.embedBatch ?? (async () => undefined),
			},
			release: async () => {
				releasedFlag = true;
			},
		},
		released: () => releasedFlag,
	};
}

function embeddingHarness(): {
	readonly store: MctxStore;
	readonly writes: MctxMemoryEmbeddingWrite[];
	readonly closed: () => boolean;
} {
	const writes: MctxMemoryEmbeddingWrite[] = [];
	const memories: MctxMemory[] = [];
	let nextId = 1;
	let closedFlag = false;
	return {
		store: store({
			writeMemory: (input) => {
				const memory: MctxMemory = {
					projectIdentity: input.projectIdentity,
					memoryId: nextId++,
					category: input.category,
					content: input.content,
					status: "active",
					revision: 1,
					createdSessionId: input.sessionId,
					updatedSessionId: input.sessionId,
					createdAtMs: input.nowMs ?? 0,
					updatedAtMs: input.nowMs ?? 0,
				};
				memories.push(memory);
				return memory;
			},
			updateMemory: (input) => {
				const index = memories.findIndex(
					(memory) =>
						memory.memoryId === input.memoryId &&
						memory.revision === input.expectedRevision &&
						memory.status === "active",
				);
				const current = memories[index];
				if (current === undefined) return undefined;
				const updated: MctxMemory = {
					...current,
					content: input.content,
					revision: current.revision + 1,
					updatedSessionId: input.sessionId,
				};
				memories[index] = updated;
				return updated;
			},
			archiveMemory: (input) => {
				const index = memories.findIndex(
					(memory) =>
						memory.memoryId === input.memoryId &&
						memory.revision === input.expectedRevision &&
						memory.status === "active",
				);
				const current = memories[index];
				if (current === undefined) return undefined;
				const archived: MctxMemory = {
					...current,
					status: "archived",
					revision: current.revision + 1,
				};
				memories[index] = archived;
				return archived;
			},
			writeMemoryEmbedding: (input) => {
				writes.push(input);
				return true;
			},
			close: () => {
				closedFlag = true;
			},
		}),
		writes,
		closed: () => closedFlag,
	};
}

function embeddingLifecycle(options: { readonly notifications?: string[] } = {}): {
	readonly lifecycle: ExtensionLifecycleContext;
	readonly cleanups: Map<string, () => void | Promise<void>>;
} {
	const cleanups = new Map<string, () => void | Promise<void>>();
	const notifications = options.notifications ?? [];
	return {
		cleanups,
		lifecycle: {
			pi: { events: {} },
			extension: {
				cwd: "/project",
				sessionManager: { getSessionId: () => "session-1" },
				modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
				ui: {
					notify: (message: string) => {
						notifications.push(message);
					},
				},
			} as unknown as ExtensionContext,
			signal: new AbortController().signal,
			resources: {
				add: (id: string, cleanup: () => void | Promise<void>) => {
					cleanups.set(id, cleanup);
				},
				cleanup: async () => [],
			} as never,
		} as unknown as ExtensionLifecycleContext,
	};
}

/** Deterministic embed result the test resolves itself. The fence chain after
 * `embed` settles contains no awaits, so awaiting the embed promise observes
 * the ledger write (or its skip) without any wall-clock timing. */
function deferredVector(): {
	readonly promise: Promise<Float32Array | undefined>;
	readonly resolve: (vector: Float32Array) => void;
} {
	let resolveVector!: (vector: Float32Array) => void;
	const promise = new Promise<Float32Array | undefined>((resolvePromise) => {
		resolveVector = resolvePromise;
	});
	return { promise, resolve: resolveVector };
}

const memoryContext = {
	sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
} as unknown as ExtensionContext;

test("ctx_memory write schedules one fenced detached embedding", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	const embed = deferredVector();
	const { lease } = embeddingLease({ embed: () => embed.promise });
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	const result = feature.memory(
		{ action: "write", category: "ARCHITECTURE", content: "Use WAL." },
		memoryContext,
	);
	expect(result).toMatchObject({
		kind: "memory",
		memories: [{ memoryId: 1, content: "Use WAL.", revision: 1 }],
	});
	embed.resolve(new Float32Array([0.5, 0.25]));
	await embed.promise;
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		projectIdentity: "git:project",
		memoryId: 1,
		modelIdentity: "local/model-a",
		providerGeneration: 1,
		sourceMemoryRevision: 1,
		dimensions: 2,
	});
	expect(writes[0]?.sourceContentHash).toBe(mctxSearchContentHash("Use WAL."));
});

test("ctx_memory update embeds only the updated record revision", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	const first = deferredVector();
	const second = deferredVector();
	const results = [first.promise, second.promise];
	let calls = 0;
	const { lease } = embeddingLease({
		embed: () => results[calls++]!,
	});
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	feature.memory({ action: "write", category: "ARCHITECTURE", content: "First." }, memoryContext);
	first.resolve(new Float32Array([1, 2]));
	await first.promise;
	// Drain the fixed runMemoryEmbedding -> catch -> finally chain so the
	// settled job is fully cleared before the update starts its own embed.
	await Promise.resolve();
	await Promise.resolve();
	expect(
		feature.memory(
			{
				action: "update",
				memoryId: 1,
				expectedRevision: 1,
				content: "Second.",
			},
			memoryContext,
		),
	).toMatchObject({ kind: "memory", memories: [{ revision: 2 }] });
	expect(calls).toBe(2);
	second.resolve(new Float32Array([1, 2]));
	await second.promise;
	expect(writes).toHaveLength(2);
	expect(writes[1]).toMatchObject({ sourceMemoryRevision: 2 });
	expect(writes[1]?.sourceContentHash).toBe(mctxSearchContentHash("Second."));
});

test("ctx_memory without an embedding config never acquires or embeds", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	let acquired = 0;
	const { lease } = embeddingLease();
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => {
			acquired += 1;
			return lease;
		},
	});
	await feature.start(lifecycle);
	expect(
		feature.memory(
			{ action: "write", category: "ARCHITECTURE", content: "No vectors." },
			memoryContext,
		),
	).toMatchObject({ kind: "memory" });
	expect(acquired).toBe(0);
	expect(writes).toHaveLength(0);
});

test("provider acquisition failure warns and keeps the pipeline active", async (): Promise<void> => {
	const notifications: string[] = [];
	const { store: memStore, writes } = embeddingHarness();
	const { lifecycle } = embeddingLifecycle({ notifications });
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => {
			throw new Error("provider rejected");
		},
	});
	await feature.start(lifecycle);
	expect(notifications.some((message) => message.includes("embedding provider unavailable"))).toBe(
		true,
	);
	expect(
		feature.memory(
			{ action: "write", category: "ARCHITECTURE", content: "Still works." },
			memoryContext,
		),
	).toMatchObject({ kind: "memory" });
	expect(writes).toHaveLength(0);
});

test("embedding failure never fails the memory write or reaches the ledger", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	const { lease } = embeddingLease({
		embed: async () => {
			throw new Error("model crashed");
		},
	});
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	expect(
		feature.memory(
			{ action: "write", category: "ARCHITECTURE", content: "Survives." },
			memoryContext,
		),
	).toMatchObject({ kind: "memory", memories: [{ content: "Survives." }] });
	await Promise.resolve();
	await Promise.resolve();
	expect(writes).toHaveLength(0);
});

test("a provider config switch between start and completion drops the late vector", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	const embed = deferredVector();
	let snapshots = 0;
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => ({
			provider: {
				snapshot: () => {
					snapshots += 1;
					return snapshots === 1
						? { provider: "local", modelIdentity: "local/model-a", generation: 1 }
						: { provider: "local", modelIdentity: "local/model-b", generation: 2 };
				},
				embed: () => embed.promise,
				embedBatch: async () => undefined,
			},
			release: async () => undefined,
		}),
	});
	await feature.start(lifecycle);
	feature.memory({ action: "write", category: "ARCHITECTURE", content: "Switch." }, memoryContext);
	embed.resolve(new Float32Array([1, 2]));
	await embed.promise;
	expect(snapshots).toBe(2);
	expect(writes).toHaveLength(0);
});

test("a memory updated while embedding publishes with the stale source fence", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	const embed = deferredVector();
	const { lease } = embeddingLease({
		embed: () => {
			memStore.updateMemory({
				projectIdentity: "git:project",
				sessionId: "session-1",
				memoryId: 1,
				expectedRevision: 1,
				content: "newer content",
				nowMs: 1,
			});
			return embed.promise;
		},
	});
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	feature.memory(
		{ action: "write", category: "ARCHITECTURE", content: "Original." },
		memoryContext,
	);
	embed.resolve(new Float32Array([1, 2]));
	await embed.promise;
	expect(writes).toHaveLength(1);
	// The embed carries the source it started from; the store fence drops it.
	expect(writes[0]).toMatchObject({ sourceMemoryRevision: 1 });
	expect(writes[0]?.sourceContentHash).toBe(mctxSearchContentHash("Original."));
});

test("archive never schedules an embedding", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	const embed = deferredVector();
	const { lease } = embeddingLease({ embed: () => embed.promise });
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	feature.memory({ action: "write", category: "ARCHITECTURE", content: "Active." }, memoryContext);
	embed.resolve(new Float32Array([1, 2]));
	await embed.promise;
	feature.memory({ action: "archive", memoryId: 1, expectedRevision: 1 }, memoryContext);
	expect(writes).toHaveLength(1);
});

test("a newer memory write replaces the pending embedding job", async (): Promise<void> => {
	const { store: memStore, writes } = embeddingHarness();
	const first = deferredVector();
	const second = deferredVector();
	const results = [first.promise, second.promise];
	let calls = 0;
	const { lease } = embeddingLease({
		embed: () => results[calls++]!,
	});
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	feature.memory({ action: "write", category: "ARCHITECTURE", content: "First." }, memoryContext);
	feature.memory({ action: "write", category: "NAMING", content: "Second." }, memoryContext);
	expect(calls).toBe(1);
	first.resolve(new Float32Array([1, 2]));
	await first.promise;
	// The settled job's finally restarts the retained pending memory after
	// the fixed runMemoryEmbedding -> catch -> finally chain drains.
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toBe(2);
	second.resolve(new Float32Array([1, 2]));
	await second.promise;
	expect(writes).toHaveLength(2);
	expect(writes[1]?.sourceContentHash).toBe(mctxSearchContentHash("Second."));
});

test("lifecycle cleanup aborts in-flight embeddings before releasing lease and store", async (): Promise<void> => {
	const { store: memStore, writes, closed } = embeddingHarness();
	const { lease, released } = embeddingLease({
		embed: (_text, _purpose, signal) =>
			new Promise((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						resolve(undefined);
					},
					{ once: true },
				);
			}),
	});
	const { lifecycle, cleanups } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () => memStore,
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	feature.memory({ action: "write", category: "ARCHITECTURE", content: "Pending." }, memoryContext);
	expect(writes).toHaveLength(0);
	const cleanup = cleanups.get("mctx-runtime");
	expect(cleanup).toBeDefined();
	await cleanup!();
	expect(writes).toHaveLength(0);
	expect(released()).toBe(true);
	expect(closed()).toBe(true);
});

function taskHandle(result: TaskTerminalResult): TaskSubagentHandle {
	return {
		id: subagentId("task-1"),
		mode: "task",
		status: result.status,
		result: Promise.resolve(result),
		cancel: () => undefined,
		subscribe: () => ({ dispose: () => undefined }),
	};
}

function deferredTaskHandle(): {
	readonly handle: TaskSubagentHandle;
	readonly resolve: (result: TaskTerminalResult) => void;
	readonly cancelCalls: () => number;
} {
	let resolveResult!: (result: TaskTerminalResult) => void;
	let cancelCount = 0;
	const result = new Promise<TaskTerminalResult>((resolvePromise) => {
		resolveResult = resolvePromise;
	});
	return {
		handle: {
			id: subagentId("task-1"),
			mode: "task",
			status: "running",
			result,
			cancel: () => {
				cancelCount += 1;
				resolveResult({
					id: subagentId("task-1"),
					mode: "task",
					status: "cancelled",
					output: "",
					softLimitReached: false,
				});
			},
			subscribe: () => ({ dispose: () => undefined }),
		},
		resolve: resolveResult,
		cancelCalls: () => cancelCount,
	};
}

const sessionContext = {
	sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
} as unknown as ExtensionContext;

function dreamerStore(notes: readonly MctxNote[]): MctxStore {
	return store({
		readNotes: () => notes,
	});
}

function dreamerContext(modelRegistry: {
	readonly find: () => unknown;
	readonly hasConfiguredAuth: () => boolean;
}): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
		modelRegistry,
	} as unknown as ExtensionContext;
}

const smartNote: MctxNote = {
	projectIdentity: "git:project",
	sessionId: "session-1",
	noteId: 1,
	content: "Keep the deploy green.",
	status: "active",
	smartCondition: "when the CI is red",
	revision: 1,
	createdSessionId: "session-1",
	updatedSessionId: "session-1",
	createdAtMs: 0,
	updatedAtMs: 0,
};

test("dreamer evaluates smart-condition notes and reports without mutating them", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	let capturedPrompt: string | undefined;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () =>
			dreamerStore([
				smartNote,
				{
					projectIdentity: smartNote.projectIdentity,
					sessionId: smartNote.sessionId,
					noteId: 2,
					content: "Plain note without a condition.",
					status: smartNote.status,
					revision: smartNote.revision,
					createdSessionId: smartNote.createdSessionId,
					updatedSessionId: smartNote.updatedSessionId,
					createdAtMs: smartNote.createdAtMs,
					updatedAtMs: smartNote.updatedAtMs,
				},
			]),
		resolveProjectIdentity: async () => "git:project",
		startDreamTask: (_context, spec) => {
			capturedPrompt = spec.prompt;
			return taskHandle({
				id: subagentId("task-1"),
				mode: "task",
				status: "completed",
				output: "#1 SATISFIED: CI is green on main",
				softLimitReached: false,
			});
		},
	});
	await feature.start(lifecycle);
	const result = await feature.dream(
		"",
		dreamerContext({ find: () => undefined, hasConfiguredAuth: () => false }),
	);
	expect(result).toEqual({
		kind: "reported",
		summary: "#1 SATISFIED: CI is green on main",
	});
	// Only the smart-condition note is compiled into the child prompt.
	expect(capturedPrompt).toContain("Keep the deploy green.");
	expect(capturedPrompt).toContain("when the CI is red");
	expect(capturedPrompt).not.toContain("Plain note without a condition.");
	// The evaluation never touches note state.
	const active = feature.active();
	if (active === undefined) throw new Error("Expected active MCTX feature");
	const notes = active.store.readNotes("git:project", "session-1", "active");
	expect(notes.some((note) => note.noteId === 1 && note.status === "active")).toBe(true);
});

test("dreamer returns empty without smart notes or a query and does not spawn", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	let spawned = false;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => dreamerStore([]),
		resolveProjectIdentity: async () => "git:project",
		startDreamTask: () => {
			spawned = true;
			return taskHandle({
				id: subagentId("task-1"),
				mode: "task",
				status: "completed",
				output: "x",
				softLimitReached: false,
			});
		},
	});
	await feature.start(lifecycle);
	expect(
		await feature.dream(
			"",
			dreamerContext({ find: () => undefined, hasConfiguredAuth: () => false }),
		),
	).toEqual({ kind: "empty" });
	expect(spawned).toBe(false);
});

test("dreamer appends a user query to the child prompt", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	let capturedPrompt: string | undefined;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => dreamerStore([smartNote]),
		resolveProjectIdentity: async () => "git:project",
		startDreamTask: (_context, spec) => {
			capturedPrompt = spec.prompt;
			return taskHandle({
				id: subagentId("task-1"),
				mode: "task",
				status: "completed",
				output: "report",
				softLimitReached: false,
			});
		},
	});
	await feature.start(lifecycle);
	expect(
		await feature.dream(
			"focus on the new API",
			dreamerContext({ find: () => undefined, hasConfiguredAuth: () => false }),
		),
	).toEqual({ kind: "reported", summary: "report" });
	expect(capturedPrompt).toContain("focus on the new API");
});

test("dreamer aborts cancel the child task", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const task = deferredTaskHandle();
	const controller = new AbortController();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => dreamerStore([smartNote]),
		resolveProjectIdentity: async () => "git:project",
		startDreamTask: () => task.handle,
	});
	await feature.start(lifecycle);
	const abortingContext = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
		signal: controller.signal,
	} as unknown as ExtensionContext;
	const pending = feature.dream("query", abortingContext);
	controller.abort();
	expect(await pending).toEqual({ kind: "cancelled" });
	expect(task.cancelCalls()).toBeGreaterThanOrEqual(1);
});

test("dreamer surfaces a synchronous admission rejection as a failure", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => dreamerStore([smartNote]),
		resolveProjectIdentity: async () => "git:project",
		startDreamTask: () => {
			throw new Error("Subagent pending queue is full");
		},
	});
	await feature.start(lifecycle);
	expect(
		await feature.dream(
			"query",
			dreamerContext({ find: () => undefined, hasConfiguredAuth: () => false }),
		),
	).toEqual({ kind: "failed", reason: "Subagent pending queue is full" });
});

test("dreamer fails loudly when an explicit model is unavailable", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	let spawned = false;
	const feature = createMctxFeature({
		loadConfiguration: async () => ({ ...configuration(), dreamer: { model: "provider/missing" } }),
		openStore: () => dreamerStore([smartNote]),
		resolveProjectIdentity: async () => "git:project",
		startDreamTask: () => {
			spawned = true;
			return taskHandle({
				id: subagentId("task-1"),
				mode: "task",
				status: "completed",
				output: "x",
				softLimitReached: false,
			});
		},
	});
	await feature.start(lifecycle);
	expect(
		await feature.dream(
			"query",
			dreamerContext({ find: () => undefined, hasConfiguredAuth: () => false }),
		),
	).toEqual({ kind: "failed", reason: "Dreamer model is unavailable: provider/missing" });
	expect(spawned).toBe(false);
});

test("dreamer truncates an oversized report", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => dreamerStore([smartNote]),
		resolveProjectIdentity: async () => "git:project",
		startDreamTask: () =>
			taskHandle({
				id: subagentId("task-1"),
				mode: "task",
				status: "completed",
				output: "y".repeat(5_000),
				softLimitReached: false,
			}),
	});
	await feature.start(lifecycle);
	const result = await feature.dream(
		"query",
		dreamerContext({ find: () => undefined, hasConfiguredAuth: () => false }),
	);
	expect(result.kind).toBe("reported");
	if (result.kind !== "reported") return;
	expect(result.summary).toContain("dreamer report truncated");
	expect(result.summary.length).toBeLessThan(5_000);
});

test("embedBackfill skips covered memories and publishes the rest", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const { lease } = embeddingLease({
		embedBatch: async () =>
			new Map([
				["memory:2", new Float32Array([0.1, 0.2])],
				["memory:3", new Float32Array([0.3, 0.4])],
			]),
	});
	const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
	const memory = (memoryId: number, content: string): MctxMemory => ({
		projectIdentity: "git:project",
		memoryId,
		category: "ARCHITECTURE",
		content,
		status: "active",
		revision: 1,
		createdSessionId: "session-1",
		updatedSessionId: "session-1",
		createdAtMs: 0,
		updatedAtMs: 0,
	});
	const memories = [memory(1, "covered"), memory(2, "pending-a"), memory(3, "pending-b")];
	const writes: MctxMemoryEmbeddingWrite[] = [];
	let activeCalls = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () =>
			store({
				listActiveMemories: () => (activeCalls++ === 0 ? memories : []),
				listMemoryEmbeddingCoverage: () => new Map([[1, hash("covered")]]),
				writeMemoryEmbedding: (input) => {
					writes.push(input);
					return true;
				},
			}),
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	const result = await feature.embedBackfill(sessionContext);
	expect(result).toEqual({ kind: "done", embedded: 2, skipped: 1, failed: 0 });
	expect(writes.map((write) => write.memoryId).sort((a, b) => a - b)).toEqual([2, 3]);
});

test("embedBackfill without a provider lease fails", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	expect(await feature.embedBackfill(sessionContext)).toEqual({
		kind: "failed",
		reason: "no embedding provider is configured",
	});
});

test("embedBackfill rejects a concurrent run as busy", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const { lease } = embeddingLease({
		embedBatch: async () => new Map([["memory:1", new Float32Array([0.1])]]),
	});
	let activeCalls = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () =>
			store({
				listActiveMemories: () => (activeCalls++ === 0 ? [memoryFixture(1, "m")] : []),
				writeMemoryEmbedding: () => true,
			}),
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	const first = feature.embedBackfill(sessionContext);
	expect(await feature.embedBackfill(sessionContext)).toEqual({ kind: "busy" });
	await expect(first).resolves.toEqual({ kind: "done", embedded: 1, skipped: 0, failed: 0 });
});

test("embedBackfill aborts mid-run and keeps published vectors", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const controller = new AbortController();
	let releaseBatch!: (value: ReadonlyMap<string, Float32Array> | undefined) => void;
	const batch = new Promise<ReadonlyMap<string, Float32Array> | undefined>((resolve) => {
		releaseBatch = resolve;
	});
	const { lease } = embeddingLease({
		embedBatch: async (_items, _purpose, signal) => {
			signal.addEventListener("abort", () => releaseBatch(undefined), { once: true });
			return batch;
		},
	});
	const writes: MctxMemoryEmbeddingWrite[] = [];
	let activeCalls = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () =>
			store({
				listActiveMemories: () => (activeCalls++ === 0 ? [memoryFixture(1, "m")] : []),
				writeMemoryEmbedding: (input) => {
					writes.push(input);
					return true;
				},
			}),
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	const abortingContext = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
		signal: controller.signal,
	} as unknown as ExtensionContext;
	const pending = feature.embedBackfill(abortingContext);
	controller.abort();
	expect(await pending).toEqual({ kind: "cancelled" });
	expect(writes).toEqual([]);
});

test("embedBackfill counts provider-missing vectors as failed", async (): Promise<void> => {
	const { lifecycle } = embeddingLifecycle();
	const { lease } = embeddingLease({
		embedBatch: async () => new Map(),
	});
	let activeCalls = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => embeddingConfiguration(),
		openStore: () =>
			store({
				listActiveMemories: () => (activeCalls++ === 0 ? [memoryFixture(1, "m")] : []),
			}),
		resolveProjectIdentity: async () => "git:project",
		acquireEmbeddingProvider: async () => lease,
	});
	await feature.start(lifecycle);
	expect(await feature.embedBackfill(sessionContext)).toEqual({
		kind: "done",
		embedded: 0,
		skipped: 0,
		failed: 1,
	});
});

function memoryFixture(memoryId: number, content: string): MctxMemory {
	return {
		projectIdentity: "git:project",
		memoryId,
		category: "ARCHITECTURE",
		content,
		status: "active",
		revision: 1,
		createdSessionId: "session-1",
		updatedSessionId: "session-1",
		createdAtMs: 0,
		updatedAtMs: 0,
	};
}
