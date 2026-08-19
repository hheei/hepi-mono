import { describe, expect, test } from "bun:test";
import { initializeDatabase } from "../../src/core/features/storage-db";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { runHandoffCommand } from "../../src/handoff/command";
import { acquireHandoffLease } from "../../src/handoff/lease";

function createDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	initializeDatabase(db);
	return db;
}

function ctx(
	warnings: string[],
	overrides: Record<string, unknown> = {},
) {
	return {
		cwd: "/tmp/project",
		model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
		hasPendingMessages: () => false,
		waitForIdle: async () => undefined,
		ui: {
			notify(text: string) {
				warnings.push(text);
			},
		},
		sessionManager: {
			isPersisted: () => true,
			getSessionFile: () => "/tmp/project/source.jsonl",
			getSessionId: () => "sess-1",
			getBranch: () => [],
			getEntries: () => [],
		},
		...overrides,
	};
}

describe("handoff command", () => {
	test("rejects arguments before acquiring a lease", async () => {
		const db = createDb();
		const warnings: string[] = [];
		try {
			await runHandoffCommand(
				{} as never,
				{
					db,
					compactionOff: false,
					historianModel: "anthropic/claude",
				} as never,
				ctx(warnings),
				"please continue",
			);
			expect(warnings.join("\n")).toContain("does not accept arguments");
			expect(acquireHandoffLease(db, "sess-1", "probe", "req", "preparing")).not.toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	test("empty-session wrapup is already current then completion fails closed", async () => {
		const db = createDb();
		const warnings: string[] = [];
		const appended: unknown[] = [];
		try {
			await runHandoffCommand(
				{
					appendEntry(_type: string, data: unknown) {
						appended.push(data);
					},
					getAllTools: () => [],
				} as never,
				{
					db,
					compactionOff: false,
					historianModel: "anthropic/claude",
					runner: {
						run: async () => {
							throw new Error("runner must not start when wrapup is already current");
						},
					},
				} as never,
				{
					...ctx(warnings),
					getSystemPrompt: () => "system",
					thinkingLevel: "off",
				},
				"",
			);
			expect(warnings.join("\n")).toContain("The source session is still available.");
			expect(warnings.join("\n")).toContain("extension lifecycle is not started");
			expect(appended.some((entry) => JSON.stringify(entry).includes("failed"))).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	test("shows the current holder when the lease is already taken", async () => {
		const db = createDb();
		const warnings: string[] = [];
		try {
			expect(
				acquireHandoffLease(db, "sess-1", "other", "req-hold", "summarizing"),
			).not.toBeNull();
			await runHandoffCommand(
				{} as never,
				{
					db,
					compactionOff: false,
					historianModel: "anthropic/claude",
				} as never,
				ctx(warnings),
				"",
			);
			expect(warnings.join("\n")).toContain("req-hold");
			expect(warnings.join("\n")).toContain("summarizing");
		} finally {
			closeQuietly(db);
		}
	});
});
