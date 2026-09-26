import type { HindsightClient } from "@vectorize-io/hindsight-client";
import { describe, expect, it, vi } from "vitest";
import {
	createHindsightGateway,
	KnowledgePagesUnavailableError,
} from "../../src/hindsight/client.js";
import { fakeResolved } from "./fixtures.js";

/** A status-carrying failure shaped like the SDK's own `HindsightError`. */
function sdkError(message: string, statusCode: number): Error {
	return Object.assign(new Error(message), { statusCode });
}

/**
 * Structural double for the SDK client.
 *
 * The adapter takes the client as a parameter precisely so its request/response mapping can
 * be tested without a server; the cast is the unavoidable interop gap between a class type
 * and a partial double.
 */
function sdkClient(overrides: Record<string, unknown> = {}): HindsightClient {
	const base = {
		getKnowledgeBaseTree: vi.fn(async () => ({ roots: [] })),
		getKnowledgePage: vi.fn(async (_bankId: string, pageId: string) => ({
			id: pageId,
			name: "Conventions",
			markdown: "# Conventions",
		})),
		searchKnowledgeBase: vi.fn(async () => ({ results: [], total: 0 })),
		reflect: vi.fn(async () => ({ text: "because reasons" })),
		createKnowledgeFolder: vi.fn(async () => ({ id: "folder-1" })),
		createKnowledgePage: vi.fn(async () => ({ page_id: "kp-new", mental_model_id: "mm-1" })),
		retain: vi.fn(async () => ({ success: true, bank_id: "hheei", items_count: 1, async: true })),
		getVersion: vi.fn(async () => ({ api_version: "0.9.2", features: {} })),
		listDocuments: vi.fn(async () => ({ items: [], total: 7, limit: 1, offset: 0 })),
	};
	return { ...base, ...overrides } as unknown as HindsightClient;
}

describe("hindsight SDK adapter", () => {
	it("carries the bank scope tags into reflect but not into page search", async () => {
		const client = sdkClient();
		const gateway = createHindsightGateway(fakeResolved(), client);
		await gateway.reflect("why?");
		expect(client.reflect).toHaveBeenCalledWith(
			"hheei",
			"why?",
			expect.objectContaining({ budget: "high", tags: ["repo:hepi-mono"], tagsMatch: "any" }),
		);

		// Page search has no tag filter in the SDK: pages are bank-wide, and the adapter must
		// not pretend otherwise.
		await gateway.searchPages("q", 3);
		expect(client.searchKnowledgeBase).toHaveBeenCalledWith(
			"hheei",
			"q",
			expect.objectContaining({ limit: 3 }),
		);
	});

	it("omits the tag filter entirely for a dedicated bank", async () => {
		const client = sdkClient();
		const gateway = createHindsightGateway(
			fakeResolved({ scopeTags: [], isolationMode: "dedicated-bank" }),
			client,
		);
		await gateway.reflect("why?");
		const options = (client.reflect as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Record<
			string,
			unknown
		>;
		expect(options).not.toHaveProperty("tags");
		expect(options).not.toHaveProperty("tagsMatch");
	});

	it("writes turns back with scope tags, metadata, append mode, and a content-derived id", async () => {
		const client = sdkClient();
		const gateway = createHindsightGateway(fakeResolved(), client);
		const turns = [{ role: "user" as const, text: "remember this" }];
		const first = await gateway.retainTurns({ sessionId: "s1", turns });

		const options = (client.retain as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Record<
			string,
			unknown
		>;
		expect(client.retain).toHaveBeenCalledWith("hheei", "User: remember this", options);
		expect(options.updateMode).toBe("append");
		expect(options.async).toBe(true);
		expect(options.documentId).toBe("pi-session-s1");
		expect(options.tags).toEqual(["repo:hepi-mono", "source:codex"]);
		expect(options.metadata).toEqual({ project: "hepi-mono", cwd: "/work/hepi-mono" });
		expect(options.operationId).toBe(first.operationId);

		// Same content again -> same operation id, so a retry folds server-side.
		const again = await gateway.retainTurns({ sessionId: "s1", turns });
		expect(again.operationId).toBe(first.operationId);

		// New content -> a new operation id.
		const changed = await gateway.retainTurns({
			sessionId: "s1",
			turns: [...turns, { role: "assistant" as const, text: "noted" }],
		});
		expect(changed.operationId).not.toBe(first.operationId);
	});

	it("treats a missing tree or search endpoint as knowledge pages being unsupported", async () => {
		const client = sdkClient({
			getKnowledgeBaseTree: vi.fn(async () => {
				throw sdkError("not found", 404);
			}),
			searchKnowledgeBase: vi.fn(async () => {
				throw sdkError("method not allowed", 405);
			}),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);

		// A list cannot distinguish "no pages" from "no feature", so it reports unavailability.
		expect(await gateway.listPages()).toEqual({ pages: [], pagesAvailable: false });
		await expect(gateway.searchPages("q", 3)).rejects.toBeInstanceOf(
			KnowledgePagesUnavailableError,
		);
	});

	it("does not report an unknown page id as an unsupported deployment", async () => {
		const client = sdkClient({
			getKnowledgePage: vi.fn(async () => {
				throw sdkError("knowledge page not found: kp-404", 404);
			}),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);
		const failure = await gateway.readPage("kp-404").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(KnowledgePagesUnavailableError);
		expect((failure as Error).message).toContain("kp-404");
	});

	it("reports an unsupported page read as unavailable", async () => {
		const client = sdkClient({
			getKnowledgePage: vi.fn(async () => {
				throw sdkError("not implemented", 501);
			}),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);
		await expect(gateway.readPage("kp-1")).rejects.toBeInstanceOf(KnowledgePagesUnavailableError);
	});

	it("creates an initiative page under an existing Initiatives folder, then retains a marker", async () => {
		const client = sdkClient({
			getKnowledgeBaseTree: vi.fn(async () => ({
				roots: [{ id: "folder-9", kind: "folder", name: "initiatives" }],
			})),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);
		const created = await gateway.captureInitiative({ title: "New thing", summary: "why" });
		expect(created.pageId).toBe("kp-new");
		expect(client.createKnowledgePage).toHaveBeenCalledWith(
			"hheei",
			"New thing",
			expect.stringContaining('"New thing" initiative'),
			expect.objectContaining({ parentId: "folder-9", tags: ["knowledge:feature-work"] }),
		);
		expect(client.retain).toHaveBeenCalledWith(
			"hheei",
			"New initiative: New thing. why",
			expect.objectContaining({
				context: "initiative marker for [[page:kp-new]]",
				metadata: expect.objectContaining({ relatedPageId: "kp-new" }),
			}),
		);
	});

	it("updates an existing initiative page without minting a new one", async () => {
		const client = sdkClient();
		const gateway = createHindsightGateway(fakeResolved(), client);
		const created = await gateway.captureInitiative({
			title: "New thing",
			summary: "scope changed",
			relatesToPageId: "kp-existing",
		});
		expect(created.pageId).toBe("kp-existing");
		expect(client.createKnowledgePage).not.toHaveBeenCalled();
		expect(client.retain).toHaveBeenCalledWith(
			"hheei",
			"Update to an existing initiative: New thing. scope changed",
			expect.anything(),
		);
	});

	it("falls back to a root-level initiative page when folders are unavailable", async () => {
		const client = sdkClient({
			getKnowledgeBaseTree: vi.fn(async () => {
				throw sdkError("not found", 404);
			}),
			createKnowledgeFolder: vi.fn(async () => {
				throw sdkError("not found", 404);
			}),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);
		const created = await gateway.captureInitiative({ title: "New thing", summary: "why" });
		expect(created.pageId).toBe("kp-new");
		const options = (client.createKnowledgePage as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as
			| Record<string, unknown>
			| undefined;
		expect(options).not.toHaveProperty("parentId");
	});

	it("reports page availability, counts, and document total in sync status", async () => {
		const client = sdkClient({
			getKnowledgeBaseTree: vi.fn(async () => ({
				roots: [
					{ id: "kp-1", kind: "page", name: "Conventions" },
					{
						id: "folder-1",
						kind: "folder",
						name: "Nested",
						children: [{ id: "kp-2", kind: "page", name: "Components" }],
					},
				],
			})),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);
		expect(await gateway.syncStatus()).toEqual({
			apiVersion: "0.9.2",
			pagesAvailable: true,
			pageCount: 2,
			documentTotal: 7,
		});
	});

	it("keeps sync status useful when the version endpoint fails", async () => {
		const client = sdkClient({
			getVersion: vi.fn(async () => {
				throw sdkError("unauthorized", 401);
			}),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);
		const status = await gateway.syncStatus();
		expect(status.apiVersion).toBeUndefined();
		expect(status.documentTotal).toBe(7);
	});

	it("maps the page tree into page summaries, ignoring folders", async () => {
		const client = sdkClient({
			getKnowledgeBaseTree: vi.fn(async () => ({
				roots: [
					{ id: "folder-1", kind: "folder", name: "Root" },
					{
						id: "folder-2",
						kind: "folder",
						name: "Nested",
						children: [
							{ id: "kp-2", kind: "page", name: "Components", description: "module map" },
							{ id: "kp-3", kind: "page", name: "Decisions" },
						],
					},
				],
			})),
		});
		const gateway = createHindsightGateway(fakeResolved(), client);
		expect(await gateway.listPages()).toEqual({
			pagesAvailable: true,
			pages: [
				{ id: "kp-2", title: "Components", description: "module map" },
				{ id: "kp-3", title: "Decisions" },
			],
		});
	});

	it("ingests a document as a named document with upload provenance", async () => {
		const client = sdkClient();
		const gateway = createHindsightGateway(fakeResolved(), client);
		expect(await gateway.ingestDocument({ title: "Correction: topic", content: "truth" })).toEqual({
			documentId: "correction-topic",
		});
		expect(client.retain).toHaveBeenCalledWith(
			"hheei",
			"truth",
			expect.objectContaining({
				documentId: "correction-topic",
				context: "ingested document",
				tags: ["repo:hepi-mono", "source:codex", "source:upload"],
				updateMode: "replace",
			}),
		);
	});
});
