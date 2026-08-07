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
	HINDSIGHT_KNOWLEDGE_PROVIDER,
	HINDSIGHT_PAGE_SECTION_SERVICE,
	type HindsightKnowledgeProvider,
	type KnowledgeProjectionIdentity,
	type KnowledgeSection,
	provideService,
} from "@hheei/pi-ext-core";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";
import { createMctxSourceSnapshot } from "../src/source-snapshot.js";
import { emptyMctxStatusAccounting } from "../src/status-metrics.js";
import type {
	MctxCompartment,
	MctxHistoryTag,
	MctxKnowledgeSnapshot,
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

function configuration(
	failClosedBlocking = true,
	smartDrops = false,
	protectedTags = 20,
	knowledgePersistence: "persistent" | "ephemeral" | "disabled" = "persistent",
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
				knowledgePersistence,
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

const knowledgeIdentity: KnowledgeProjectionIdentity = {
	projectIdentity: "git:project",
	bankIds: ["project-bank"],
	scopeTags: ["project:project"],
	memoryProfile: "project-only",
	capabilityRevision: "hindsight-client:test",
	policyVersion: "policy-1",
	epoch: "persistent",
};

const knowledgeSources = [
	{
		id: "mental-model:architecture",
		kind: "mental-model" as const,
		title: "Architecture",
		text: "Keep seams explicit.",
		sourceVersion: "version-1",
		provenance: ["bank:project-bank"],
		scopeTags: ["project:project"],
	},
];

function knowledgeSnapshot(
	freshness: MctxKnowledgeSnapshot["freshness"] = "fresh",
	identity: KnowledgeProjectionIdentity = knowledgeIdentity,
): MctxKnowledgeSnapshot {
	return {
		revision: 1,
		freshness,
		identity,
		sources: knowledgeSources,
		renderedPayload: "<hindsight-knowledge>Keep seams explicit.</hindsight-knowledge>",
		sourceFingerprint: "knowledge-fingerprint",
		updatedAtMs: 1,
	};
}

function store(overrides: Partial<MctxStore> = {}): MctxStore {
	const historyTags: MctxHistoryTag[] = [];
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
		readKnowledgeSnapshot: () => undefined,
		replaceKnowledgeSnapshot: () => undefined,
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

test("knowledge persistence policy prevents disabled provider use and ephemeral SQLite writes", async (): Promise<void> => {
	let identityCalls = 0;
	let projectCalls = 0;
	const notifications: Array<{ readonly message: string; readonly level?: string }> = [];
	const provider: HindsightKnowledgeProvider = {
		identity: async () => {
			identityCalls++;
			return {
				kind: "allowed",
				identity: {
					projectIdentity: "git:project",
					bankIds: ["project-bank"],
					scopeTags: ["project:project"],
					memoryProfile: "project-only",
					capabilityRevision: "hindsight-client:test",
					policyVersion: "policy-1",
					epoch: "persistent",
				},
			};
		},
		project: async () => {
			projectCalls++;
			return {
				identity: {
					projectIdentity: "git:project",
					bankIds: ["project-bank"],
					scopeTags: ["project:project"],
					memoryProfile: "project-only",
					capabilityRevision: "hindsight-client:test",
					policyVersion: "policy-1",
					epoch: "persistent",
				},
				freshness: "fresh",
				sources: [
					{
						id: "mental-model:architecture",
						kind: "mental-model",
						title: "Architecture",
						text: "Keep seams explicit.",
						sourceVersion: "version-1",
						provenance: ["bank:project-bank"],
						scopeTags: ["project:project"],
					},
				],
			};
		},
	};

	const lifecycle = {
		pi: { events: {} },
		extension: {
			cwd: "/project",
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
			ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
		} as unknown as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => undefined, cleanup: async () => [] },
	} as unknown as ExtensionLifecycleContext;
	provideService(lifecycle, HINDSIGHT_KNOWLEDGE_PROVIDER, provider);
	const pageSection: KnowledgeSection = {
		id: "knowledge-page:page-1:section:0",
		pageId: "page-1",
		pageName: "Session guidance",
		heading: "Old request",
		text: "Keep page context bounded.",
		sourceVersion: "page-version-1",
		provenance: ["bank:project-bank", "knowledge-page:page-1"],
		scopeTags: ["project:project"],
	};
	provideService(lifecycle, HINDSIGHT_PAGE_SECTION_SERVICE, {
		getPageSections: async () => ({
			kind: "sections",
			version: "page-version-1",
			sections: [pageSection],
		}),
	});

	const disabledFeature = createMctxFeature({
		loadConfiguration: async () => configuration(true, false, 20, "disabled"),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await disabledFeature.start(lifecycle);
	const disabledContext = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	await disabledFeature.onContext(entries.flatMap(sessionEntryToContextMessages), disabledContext);
	expect(identityCalls).toBe(0);
	expect(projectCalls).toBe(0);

	const ephemeralFeature = createMctxFeature({
		loadConfiguration: async () => configuration(true, false, 20, "ephemeral"),
		openStore: () =>
			store({
				readKnowledgeSnapshot: () => {
					throw new Error("ephemeral must not read SQLite snapshot");
				},
				replaceKnowledgeSnapshot: () => {
					throw new Error("ephemeral must not write SQLite snapshot");
				},
			}),
		resolveProjectIdentity: async () => "git:project",
	});
	await ephemeralFeature.start(lifecycle);
	const projected = await ephemeralFeature.onContext(
		entries.flatMap(sessionEntryToContextMessages),
		{ ...disabledContext },
	);
	expect(identityCalls).toBeGreaterThan(0);
	expect(projectCalls).toBeGreaterThan(0);
	expect(projected?.messages[0]).toMatchObject({ customType: "pi-injected-knowledge" });
	expect(projected?.messages[1]).toMatchObject({
		customType: "pi-injected-knowledge",
		display: true,
		details: { sourceIds: [pageSection.id], retain: false },
	});
	expect(notifications.filter(({ message }) => message.includes("MCTX Hindsight"))).toEqual([
		expect.objectContaining({ message: expect.stringContaining("<hindsight-knowledge>") }),
		expect.objectContaining({ message: expect.stringContaining("<hindsight-page-sections>") }),
	]);
});

test("concurrent context passes wait for one materialization and replay its result", async (): Promise<void> => {
	let projectCalls = 0;
	let releaseProject: (() => void) | undefined;
	let projectStarted: (() => void) | undefined;
	const projectGate = new Promise<void>((resolve) => {
		releaseProject = resolve;
	});
	const started = new Promise<void>((resolve) => {
		projectStarted = resolve;
	});
	const provider: HindsightKnowledgeProvider = {
		identity: async () => ({ kind: "allowed", identity: knowledgeIdentity }),
		project: async () => {
			projectCalls++;
			projectStarted?.();
			await projectGate;
			return { identity: knowledgeIdentity, freshness: "fresh", sources: knowledgeSources };
		},
	};
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
	provideService(lifecycle, HINDSIGHT_KNOWLEDGE_PROVIDER, provider);
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(true, false, 20, "ephemeral"),
		openStore: () => store(),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const raw = entries.flatMap(sessionEntryToContextMessages);
	const first = feature.onContext(raw, context);
	await started;
	const second = feature.onContext(raw, context);
	expect(projectCalls).toBe(1);
	releaseProject?.();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	expect(firstResult?.messages[0]).toMatchObject({ customType: "pi-injected-knowledge" });
	expect(secondResult?.messages[0]).toMatchObject({ customType: "pi-injected-knowledge" });
	expect(projectCalls).toBe(1);
});

test("rejects a raced snapshot with a different identity after CAS loss", async (): Promise<void> => {
	const raced = knowledgeSnapshot("fresh", { ...knowledgeIdentity, projectIdentity: "git:other" });
	let reads = 0;
	const provider: HindsightKnowledgeProvider = {
		identity: async () => ({ kind: "allowed", identity: knowledgeIdentity }),
		project: async () => ({
			identity: knowledgeIdentity,
			freshness: "fresh",
			sources: knowledgeSources,
		}),
	};
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
	provideService(lifecycle, HINDSIGHT_KNOWLEDGE_PROVIDER, provider);
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () =>
			store({
				readKnowledgeSnapshot: () => {
					reads++;
					return reads === 1 ? undefined : raced;
				},
				replaceKnowledgeSnapshot: () => undefined,
			}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const projected = await feature.onContext(
		entries.flatMap(sessionEntryToContextMessages),
		context,
	);
	expect(
		projected?.messages.some(
			(message) => "customType" in message && message.customType === "pi-injected-knowledge",
		),
	).toBe(false);
	expect(reads).toBe(2);
});

test("keeps stale fallback when stale CAS publication loses", async (): Promise<void> => {
	const previous = knowledgeSnapshot("stale");
	let reads = 0;
	const provider: HindsightKnowledgeProvider = {
		identity: async () => ({ kind: "allowed", identity: knowledgeIdentity }),
		project: async () => {
			throw new Error("reflect unavailable");
		},
	};
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
	provideService(lifecycle, HINDSIGHT_KNOWLEDGE_PROVIDER, provider);
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () =>
			store({
				readKnowledgeSnapshot: () => {
					reads++;
					return previous;
				},
				replaceKnowledgeSnapshot: () => undefined,
			}),
		resolveProjectIdentity: async () => "git:project",
	});
	await feature.start(lifecycle);
	const context = {
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const projected = await feature.onContext(
		entries.flatMap(sessionEntryToContextMessages),
		context,
	);
	const knowledge = projected?.messages.find((message) => message.role === "custom");
	expect(knowledge).toMatchObject({ customType: "pi-injected-knowledge" });
	expect(knowledge?.content).toContain("stale");
	expect(reads).toBe(2);
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
