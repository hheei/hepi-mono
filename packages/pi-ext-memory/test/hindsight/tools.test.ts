import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { KnowledgePagesUnavailableError } from "../../src/hindsight/client.js";
import { HindsightRetainQueue } from "../../src/hindsight/queue.js";
import {
	declareHindsightTools,
	HINDSIGHT_DISABLED_TEXT,
	HINDSIGHT_TOOL_NAMES,
	type HindsightDiagnoseDetails,
	type HindsightToolContext,
	type HindsightToolDetails,
	KNOWLEDGE_PAGES_UNAVAILABLE_TEXT,
} from "../../src/hindsight/tools.js";
import { fakeGateway, fakePi, fakeResolved } from "./fixtures.js";

type CallableTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<AgentToolResult<HindsightToolDetails>>;
};

function toolContext(overrides: Partial<HindsightToolContext> = {}): HindsightToolContext {
	const gateway = fakeGateway();
	return {
		gateway,
		resolved: fakeResolved(),
		retainQueue: new HindsightRetainQueue(gateway),
		...overrides,
	};
}

function setup(context: HindsightToolContext | undefined) {
	const { pi, registered, active } = fakePi();
	declareHindsightTools(pi, () => context, "deferred");
	const tool = (name: string): CallableTool => registered.get(name) as CallableTool;
	return { pi, registered, active, tool };
}

function exposures(registered: Map<string, unknown>): string[] {
	return [...registered.values()].map(
		(tool) => (tool as { exposure?: string }).exposure ?? "direct",
	);
}

async function call(
	tool: CallableTool,
	params: unknown = {},
): Promise<AgentToolResult<HindsightToolDetails>> {
	return tool.execute("call-1", params, undefined, undefined, undefined);
}

describe("hindsight tool registration", () => {
	it("registers exactly the eight prefixed tools and no alias", () => {
		const { registered } = setup(toolContext());
		expect([...registered.keys()].sort()).toEqual([...HINDSIGHT_TOOL_NAMES].sort());
		expect([...registered.keys()].every((name) => name.startsWith("hindsight_"))).toBe(true);
		// No unprefixed alias exists under any spelling.
		expect(registered.has("reflect")).toBe(false);
		expect(registered.has("search_knowledge_pages")).toBe(false);
	});

	it("reports a disabled session instead of reaching for a gateway", async () => {
		const { registered, tool } = setup(undefined);
		expect(registered.size).toBe(8);
		for (const name of HINDSIGHT_TOOL_NAMES) {
			const result = await call(tool(name));
			expect(result.details.status).toBe("disabled");
			expect(result.content[0]?.type).toBe("text");
			if (result.content[0]?.type === "text") {
				expect(result.content[0].text).toBe(HINDSIGHT_DISABLED_TEXT);
			}
		}
	});

	it("registers every tool as deferred, activating none of them", () => {
		const { registered, active } = setup(toolContext());
		expect(exposures(registered)).toEqual(HINDSIGHT_TOOL_NAMES.map(() => "deferred"));
		// Activation belongs to tool_search: a Hindsight tool is declared only after a load.
		expect(active).toEqual([]);
	});

	it("withdraws a previous session's tools when this session cannot use Hindsight", () => {
		const { pi, registered } = setup(toolContext());
		declareHindsightTools(pi, () => undefined, "hidden");
		expect(registered.size).toBe(8);
		expect(exposures(registered)).toEqual(HINDSIGHT_TOOL_NAMES.map(() => "hidden"));
	});

	it("restores the deferred declaration when a later session can use Hindsight again", () => {
		const { pi, registered } = setup(toolContext());
		declareHindsightTools(pi, () => undefined, "hidden");
		declareHindsightTools(pi, () => toolContext(), "deferred");
		expect(exposures(registered)).toEqual(HINDSIGHT_TOOL_NAMES.map(() => "deferred"));
	});

	it("registers nothing for a session that was never able to use Hindsight", () => {
		const { pi, registered } = fakePi();
		declareHindsightTools(pi, () => undefined, "hidden");
		expect(registered.size).toBe(0);
	});
});

describe("hindsight knowledge page tools", () => {
	it("searches, lists, and reads pages", async () => {
		const context = toolContext({
			gateway: fakeGateway({
				searchPages: vi.fn(async () => [
					{ page: "Conventions", pageId: "kp-1", snippet: "use pnpm", score: 0.75 },
				]),
				listPages: vi.fn(async () => ({
					pages: [{ id: "kp-1", title: "Conventions", description: "repo-wide rules" }],
					pagesAvailable: true,
				})),
				readPage: vi.fn(async () => ({ id: "kp-1", title: "Conventions", markdown: "# Rules" })),
			}),
		});
		const { tool } = setup(context);

		const search = await call(tool("hindsight_search_knowledge_pages"), { query: "pnpm" });
		expect(search.details.status).toBe("ok");
		expect(text(search)).toContain("- **Conventions** (`id: kp-1`, score: 0.75):");
		expect(context.gateway.searchPages).toHaveBeenCalledWith("pnpm", 3, undefined);

		const list = await call(tool("hindsight_list_knowledge_pages"));
		expect(text(list)).toBe("- **Conventions** (`id: kp-1`): repo-wide rules");

		const read = await call(tool("hindsight_read_knowledge_page"), { page_id: "kp-1" });
		expect(text(read)).toContain('---\npage: "Conventions"\nid: kp-1\n---');
		expect(text(read)).toContain("# Rules");
	});

	it("reports the documented degradation when pages are unsupported", async () => {
		const context = toolContext({
			gateway: fakeGateway({
				searchPages: vi.fn(async () => {
					throw new KnowledgePagesUnavailableError();
				}),
				readPage: vi.fn(async () => {
					throw new KnowledgePagesUnavailableError();
				}),
				listPages: vi.fn(async () => ({ pages: [], pagesAvailable: false })),
			}),
		});
		const { tool } = setup(context);
		for (const name of [
			"hindsight_search_knowledge_pages",
			"hindsight_read_knowledge_page",
			"hindsight_list_knowledge_pages",
		]) {
			const result = await call(tool(name), { query: "q", page_id: "kp-1" });
			expect(result.details.status).toBe("unavailable");
			expect(text(result)).toBe(KNOWLEDGE_PAGES_UNAVAILABLE_TEXT);
		}
	});

	it("surfaces transport failures with the tool name and the server message", async () => {
		const context = toolContext({
			gateway: fakeGateway({
				searchPages: vi.fn(async () => {
					throw new Error("ECONNREFUSED");
				}),
			}),
		});
		const { tool } = setup(context);
		const result = await call(tool("hindsight_search_knowledge_pages"), { query: "q" });
		expect(result.details.status).toBe("error");
		expect(text(result)).toBe("hindsight_search_knowledge_pages failed: ECONNREFUSED");
	});
});

describe("hindsight write and status tools", () => {
	it("records initiatives, ingests documents, and reports status", async () => {
		const capture = vi.fn(async () => ({ pageId: "kp-9" }));
		const ingest = vi.fn(async () => ({ documentId: "correction-topic" }));
		const context = toolContext({
			gateway: fakeGateway({
				captureInitiative: capture,
				ingestDocument: ingest,
				syncStatus: vi.fn(async () => ({
					apiVersion: "0.9.2",
					pagesAvailable: true,
					pageCount: 5,
					documentTotal: 12,
				})),
			}),
		});
		const { tool } = setup(context);

		const initiative = await call(tool("hindsight_capture_initiative"), {
			title: "Hindsight integration",
			summary: "Add opt-in long-term memory.",
		});
		expect(text(initiative)).toBe("Initiative recorded on knowledge page kp-9.");
		expect(capture).toHaveBeenCalledWith(
			{ title: "Hindsight integration", summary: "Add opt-in long-term memory." },
			undefined,
		);

		const update = await call(tool("hindsight_capture_initiative"), {
			title: "Hindsight integration",
			summary: "Scope narrowed.",
			relates_to_page_id: "kp-9",
		});
		expect(text(update)).toContain("kp-9");
		expect(capture).toHaveBeenCalledWith(
			{
				title: "Hindsight integration",
				summary: "Scope narrowed.",
				relatesToPageId: "kp-9",
			},
			undefined,
		);

		const document = await call(tool("hindsight_ingest_document"), {
			title: "Correction: topic",
			content: "the truth",
		});
		expect(text(document)).toBe("Document stored as correction-topic.");
		expect(ingest).toHaveBeenCalledWith(
			{ title: "Correction: topic", content: "the truth" },
			undefined,
		);

		const status = await call(tool("hindsight_sync_status"));
		expect(text(status)).toContain("- **Server API version**: 0.9.2");
		expect(text(status)).toContain("- **Knowledge pages**: 5");
		expect(text(status)).toContain("- **Stored documents**: 12");
	});

	it("reflects over memory and handles an empty synthesis", async () => {
		const context = toolContext({
			gateway: fakeGateway({ reflect: vi.fn(async () => "   ") }),
		});
		const { tool } = setup(context);
		const result = await call(tool("hindsight_reflect"), { query: "why?" });
		expect(text(result)).toBe("No memory-based answer was produced.");
	});
});

describe("hindsight_diagnose", () => {
	it("reports the effective configuration without ever printing the token", async () => {
		const resolved = fakeResolved({
			config: { ...fakeResolved().config, apiToken: "super-secret-token" },
		});
		const gateway = fakeGateway({
			listPages: vi.fn(async () => ({
				pages: [{ id: "kp-1", title: "Conventions" }],
				pagesAvailable: true,
			})),
		});
		const queue = new HindsightRetainQueue(gateway);
		const { tool } = setup({ gateway, resolved, retainQueue: queue });

		const result = await call(tool("hindsight_diagnose"));
		const body = text(result);
		expect(body).not.toContain("super-secret-token");
		expect(body).toContain("- **Token configured**: yes");
		expect(body).toContain("- **Bank**: hheei (chosen by fallback)");
		expect(body).toContain("- **Isolation**: tagged-shared-bank (scope tags: repo:hepi-mono)");
		expect(body).toContain("- **Server reachable**: yes");
		expect(body).toContain("- **Writeback state**: 0 turns retained, 0 pending batches, idle");

		const details = result.details as HindsightDiagnoseDetails;
		expect(details.tokenConfigured).toBe(true);
		expect(details.scopeTags).toEqual(["repo:hepi-mono"]);
		expect(details.retainTags).toEqual(["repo:hepi-mono", "source:codex"]);
	});

	it("reports an unreachable server and a missing token", async () => {
		const context = toolContext({
			gateway: fakeGateway({
				listPages: vi.fn(async () => {
					throw new Error("ECONNREFUSED");
				}),
			}),
		});
		const { tool } = setup(context);
		const result = await call(tool("hindsight_diagnose"));
		expect(text(result)).toContain("- **Token configured**: no");
		expect(text(result)).toContain("- **Server reachable**: no");
		expect(result.details.status).toBe("error");
	});
});

function text(result: AgentToolResult<HindsightToolDetails>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
