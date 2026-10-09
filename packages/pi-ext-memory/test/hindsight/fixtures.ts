import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { HindsightGateway } from "../../src/hindsight/client.js";
import { buildBankMcpUrl, type ResolvedHindsight } from "../../src/hindsight/config.js";
import { HindsightRetainQueue } from "../../src/hindsight/queue.js";

/** Resolved configuration with a shared bank, so scope tags are exercised by default. */
export function fakeResolved(overrides: Partial<ResolvedHindsight> = {}): ResolvedHindsight {
	const config = {
		apiUrl: "http://hindsight.test:38888",
		mcpUrl: "http://hindsight.test:38888/mcp",
		autoRecall: true,
		retainSessions: true,
		readTimeoutMs: 15_000,
		maxMemoryChars: 8_000,
		configPath: "/tmp/hindsight.json",
	};
	const bankId = overrides.bankId ?? "hheei";
	const mcpUrl = overrides.config?.mcpUrl ?? config.mcpUrl;
	return {
		config,
		bankId,
		bankSource: "fallback",
		bankMcpUrl: buildBankMcpUrl(mcpUrl, bankId),
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
		retainTurns: vi.fn(async () => ({ operationId: "op", documentId: "doc", turns: 0 })),
	};
	return { ...base, ...overrides } as FakeGateway;
}

export interface FakePi {
	readonly pi: ExtensionAPI;
	readonly registered: Map<string, unknown>;
	readonly active: string[];
	readonly mcpServers: Map<string, unknown>;
	readonly toolRenderers: unknown[];
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
	const mcpServers = new Map<string, unknown>();
	const toolRenderers: unknown[] = [];
	const pi = {
		registerTool: (tool: { name: string; exposure?: string; defaultActive?: boolean }) => {
			registered.set(tool.name, tool);
			const declarable =
				tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only";
			if (declarable && tool.defaultActive !== false && !active.includes(tool.name)) {
				active.push(tool.name);
			}
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.length = 0;
			active.push(...names);
		},
		registerMcpServer: (name: string, config: unknown) => {
			mcpServers.set(name, config);
		},
		unregisterMcpServer: (name: string) => {
			mcpServers.delete(name);
		},
		getMcpServers: () =>
			[...mcpServers.entries()].map(([name, config]) => ({
				name,
				config,
				extensionPath: "fake",
			})),
		registerToolRenderer: (resolver: unknown) => {
			toolRenderers.push(resolver);
		},
		on: () => () => {},
	} as unknown as ExtensionAPI;
	return { pi, registered, active, mcpServers, toolRenderers };
}

/** Queue plus the gateway it writes through, so tests can assert both sides. */
export function fakeQueue(overrides: Partial<HindsightGateway> = {}): {
	queue: HindsightRetainQueue;
	gateway: FakeGateway;
} {
	const gateway = fakeGateway(overrides);
	return { queue: new HindsightRetainQueue(gateway), gateway };
}
