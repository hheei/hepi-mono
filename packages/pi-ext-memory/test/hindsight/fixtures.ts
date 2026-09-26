import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { HindsightGateway } from "../../src/hindsight/client.js";
import type { ResolvedHindsight } from "../../src/hindsight/config.js";
import { HindsightRetainQueue } from "../../src/hindsight/queue.js";

/** Resolved configuration with a shared bank, so scope tags are exercised by default. */
export function fakeResolved(overrides: Partial<ResolvedHindsight> = {}): ResolvedHindsight {
	const config = {
		apiUrl: "http://hindsight.test:38888",
		autoRecall: true,
		retainSessions: true,
		reflectBudget: "high" as const,
		reflectTimeoutMs: 45_000,
		readTimeoutMs: 15_000,
		maxMemoryChars: 8_000,
		configPath: "/tmp/hindsight.json",
	};
	return {
		config,
		bankId: "hheei",
		bankSource: "fallback",
		repo: "hepi-mono",
		scopeTags: ["repo:hepi-mono"],
		retainTags: ["repo:hepi-mono", "source:codex"],
		retainMetadata: { project: "hepi-mono", cwd: "/work/hepi-mono" },
		isolationMode: "tagged-shared-bank",
		...overrides,
	};
}

export type FakeGateway = HindsightGateway & {
	readonly retainTurns: ReturnType<typeof vi.fn>;
};

/** Gateway double: every method resolves to an empty result unless overridden. */
export function fakeGateway(overrides: Partial<HindsightGateway> = {}): FakeGateway {
	const base: HindsightGateway = {
		bankId: "hheei",
		listPages: vi.fn(async () => ({ pages: [], pagesAvailable: true })),
		readPage: vi.fn(async (pageId: string) => ({ id: pageId, title: pageId, markdown: "" })),
		searchPages: vi.fn(async () => []),
		reflect: vi.fn(async () => "nothing remembered"),
		captureInitiative: vi.fn(async () => ({ pageId: "kp-new" })),
		ingestDocument: vi.fn(async () => ({ documentId: "doc" })),
		syncStatus: vi.fn(async () => ({ pagesAvailable: true, pageCount: 0, documentTotal: 0 })),
		retainTurns: vi.fn(async () => ({ operationId: "op", documentId: "doc", turns: 0 })),
	};
	return { ...base, ...overrides } as FakeGateway;
}

export interface FakePi {
	readonly pi: ExtensionAPI;
	readonly registered: Map<string, unknown>;
	readonly active: string[];
}

/**
 * Minimal ExtensionAPI double.
 *
 * `runtimeIdentity` treats an object without an `events` bus as its own runtime, so each
 * double carries its own core state — tests must create one per case, not share it.
 */
export function fakePi(): FakePi {
	const registered = new Map<string, unknown>();
	const active: string[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => {
			registered.set(tool.name, tool);
			if (!active.includes(tool.name)) active.push(tool.name);
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.length = 0;
			active.push(...names);
		},
		on: () => () => {},
	} as unknown as ExtensionAPI;
	return { pi, registered, active };
}

/** Queue plus the gateway it writes through, so tests can assert both sides. */
export function fakeQueue(overrides: Partial<HindsightGateway> = {}): {
	queue: HindsightRetainQueue;
	gateway: FakeGateway;
} {
	const gateway = fakeGateway(overrides);
	return { queue: new HindsightRetainQueue(gateway), gateway };
}
