import { describe, expect, it, vi } from "vitest";
import { resolveProjectIdentity } from "#core/features/memory/project-identity";
import type { UnifiedSearchResult } from "#core/features/search";
import * as searchModule from "#core/features/search";

import { closeQuietly } from "#core/shared/sqlite-helpers";
import { createCtxSearchTool } from "../../src/tools/ctx-search";
import { asToolResult, createTestDb, fakeContext } from "../test-utils.test";

describe("createCtxSearchTool", () => {
	it("prints mctx_expand ranges and footer for message search hits", async () => {
		const db = createTestDb();
		const spy = vi.spyOn(searchModule, "unifiedSearch").mockImplementation(async () => [
			{
				source: "message",
				content: "prior conversation detail",
				score: 0.87,
				messageOrdinal: 12,
				messageId: "m-12",
				role: "user",
			} satisfies UnifiedSearchResult,
		]);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = asToolResult(
				await tool.execute(
					"call-1",
					{ query: "prior detail", sources: ["message"] },
					new AbortController().signal,
					undefined,
					fakeContext("ses-search") as never,
				),
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("ordinal=12 range=9-15 role=user");
			expect(text).toContain(
				"Use mctx_expand(start, end) with the range from any message result above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("accepts note sources and renders note anchors", async () => {
		const db = createTestDb();
		const spy = vi
			.spyOn(searchModule, "unifiedSearch")
			.mockImplementation(async (_db, _sessionId, _project, _query, options) => {
				expect(options?.sources).toEqual(["note"]);
				return [
					{
						source: "note",
						content: "Decision: keep the compatibility shim for one more release.",
						score: 0.91,
						noteId: 5,
						status: "ready",
						createdAt: Date.now() - 24 * 60 * 60 * 1000,
						anchorOrdinal: 21,
						sourceSessionId: "ses-search",
					},
				] as UnifiedSearchResult[];
			});
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = asToolResult(
				await tool.execute(
					"call-2",
					{ query: "compatibility shim", sources: ["note"] },
					new AbortController().signal,
					undefined,
					fakeContext("ses-search") as never,
				),
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#5 status=ready");
			expect(text).toContain("@msg 21");
			expect(text).toContain(
				"Use mctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("omits note anchors and footer hints for foreign-session smart notes", async () => {
		const db = createTestDb();
		const spy = vi.spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "note",
						content: "Foreign session note should not expose an expandable anchor.",
						score: 0.72,
						noteId: 6,
						status: "ready",
						createdAt: Date.now(),
						anchorOrdinal: 22,
						sourceSessionId: "ses-other",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = asToolResult(
				await tool.execute(
					"call-3",
					{ query: "foreign anchor", sources: ["note"] },
					new AbortController().signal,
					undefined,
					fakeContext("ses-search") as never,
				),
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#6 status=ready");
			expect(text).not.toContain("@msg 22");
			expect(text).not.toContain(
				"Use mctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("resolves a `#1234` query directly without calling unifiedSearch (Pi parity)", async () => {
		const db = createTestDb();
		// Dynamically import `insertMemory` to seed a memory for this test,
		// then verify that an ID-shaped query uses `resolveMemoriesByIdsForSearch`
		// instead of `unifiedSearch`.
		const { insertMemory } = await import("#core/features/memory/index");
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const memory = insertMemory(db, {
			projectPath: projectIdentity,
			category: "USER_DIRECTIVES",
			content: "Direct id hit for the short-circuit.",
		});
		const spy = vi.spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
			throw new Error("unifiedSearch must not run for ID-shaped queries");
		});
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = asToolResult(
				await tool.execute(
					"call-id",
					{ query: `#${memory.id}` },
					new AbortController().signal,
					undefined,
					fakeContext("ses-search", process.cwd()) as never,
				),
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("[1] [memory]");
			expect(text).toContain(`id=${memory.id}`);
			expect(text).toContain("Direct id hit for the short-circuit.");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});

it("keeps local and durable lanes separate and excludes the active remote session", async () => {
	const db = createTestDb();
	const spy = vi.spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
	const remoteSearch = vi.fn(async () => ({
		results: [
			{
				sessionId: "remote-active",
				observation: { id: "active", narrative: "current capture", project: "hepi-mono" },
			},
			{
				sessionId: "remote-prior",
				observation: {
					id: "prior",
					narrative: "prior durable fact",
					project: "hepi-mono",
					agentId: "agent-1",
				},
			},
		],
	}));
	try {
		const tool = createCtxSearchTool({
			db,
			memoryEnabled: false,
			embeddingEnabled: false,
			gitCommitsEnabled: false,
			remoteSearch: {
				client: {
					health: vi.fn(),
					startSession: vi.fn(),
					observe: vi.fn(),
					search: remoteSearch,
					remember: vi.fn(),
					endSession: vi.fn(),
				},
				identity: () => ({ project: "hepi-mono", agentId: "agent-1" }),
				remoteSessionId: () => "remote-active",
			},
		});
		const result = asToolResult(
			await tool.execute(
				"call-remote",
				{ query: "durable fact" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			),
		);
		const text = result.content[0]?.text ?? "";
		expect(tool.name).toBe("mctx_search");
		expect(text).toContain("Current session/local lane");
		expect(text).toContain("Durable AgentMemory lane");
		expect(text).toContain("prior durable fact");
		expect(text).toContain("project=hepi-mono session=remote-prior agent=agent-1");
		expect(text).not.toContain("current capture");
	} finally {
		spy.mockRestore();
		closeQuietly(db);
	}
});

it("reports a partial durable lane while preserving local results", async () => {
	const db = createTestDb();
	const spy = vi.spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
	try {
		const tool = createCtxSearchTool({
			db,
			remoteSearch: {
				client: {
					health: vi.fn(),
					startSession: vi.fn(),
					observe: vi.fn(),
					search: vi.fn(async () => Promise.reject(new Error("offline"))),
					remember: vi.fn(),
					endSession: vi.fn(),
				},
				identity: () => ({ project: "hepi-mono" }),
			},
		});
		const result = asToolResult(
			await tool.execute(
				"call-partial",
				{ query: "anything" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			),
		);
		expect(result.content[0]?.text).toContain("Current session/local lane");
		expect(result.content[0]?.text).toContain("partial/unavailable (offline)");
	} finally {
		spy.mockRestore();
		closeQuietly(db);
	}
});

it("fails closed for durable results without matching scope identity", async () => {
	const db = createTestDb();
	const spy = vi.spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
	try {
		const tool = createCtxSearchTool({
			db,
			remoteSearch: {
				client: {
					health: vi.fn(),
					startSession: vi.fn(),
					observe: vi.fn(),
					search: vi.fn(async () => ({
						results: [
							{ memory: { id: "no-project", content: "missing scope" } },
							{
								memory: {
									id: "wrong-agent",
									content: "wrong agent",
									project: "hepi-mono",
									agentId: "agent-2",
								},
							},
						],
					})),
					remember: vi.fn(),
					endSession: vi.fn(),
				},
				identity: () => ({ project: "hepi-mono", agentId: "agent-1" }),
			},
		});
		const result = asToolResult(
			await tool.execute(
				"call-scope",
				{ query: "scope" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			),
		);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("No durable results.");
		expect(text).not.toContain("missing scope");
		expect(text).not.toContain("wrong agent");
	} finally {
		spy.mockRestore();
		closeQuietly(db);
	}
});
