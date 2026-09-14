import { estimatePiPrefixTokens } from "@hheei/pi-ext-core";
import { describe, expect, it } from "vitest";
import { updateSessionMeta } from "#core/features/storage";
import { estimateTokens } from "#core/hooks/read-session-formatting";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { registerStatusLine, updateStatusLine } from "../src/status-line";
import { createTestDb, fakeContext } from "./test-utils.test";

describe("status line prefix", () => {
	it("shows system+tools instead of 0 on a new session", () => {
		const db = createTestDb();
		try {
			const statuses: Array<string | undefined> = [];
			registerStatusLine(
				{
					getAllTools: () => [
						{
							name: "read",
							description: "Read a file",
							parameters: { type: "object" },
						},
					],
					on() {
						return undefined;
					},
				} as never,
				{ db, projectIdentity: "proj" },
			);
			const ctx = {
				...fakeContext("ses-status-line-prefix"),
				getSystemPrompt: () =>
					"You are pi.\n<available_skills>\n  <skill><name>tdd</name></skill>\n</available_skills>",
				ui: {
					setStatus(_key: string, text: string | undefined) {
						statuses.push(text);
					},
				},
			};
			updateStatusLine(ctx as never, { db, projectIdentity: "proj" }, true);
			const text = statuses.at(-1);
			expect(text).toMatch(/^mc: \d/);
			expect(text).not.toMatch(/^mc: 0 \(/);
			expect(text).toContain("idle");
		} finally {
			closeQuietly(db);
		}
	});

	it("shows reserved-window percent instead of Pi's output-inclusive percent", () => {
		const db = createTestDb();
		try {
			const statuses: Array<string | undefined> = [];
			registerStatusLine(
				{
					getAllTools: () => [],
					on() {
						return undefined;
					},
				} as never,
				{ db, projectIdentity: "proj" },
			);
			const ctx = {
				...fakeContext("ses-status-line-reserved"),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 50_000,
					percent: 80,
					contextWindow: 100_000,
				}),
				ui: {
					setStatus(_key: string, text: string | undefined) {
						statuses.push(text);
					},
				},
			};
			updateStatusLine(ctx as never, { db, projectIdentity: "proj" }, true);
			expect(statuses.at(-1)).toBe("mc: 50K (63%) · idle");
		} finally {
			closeQuietly(db);
		}
	});

	it("estimates the next prompt after compaction instead of a prefix floor", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-line-compacted";
			updateSessionMeta(db, sessionId, {
				lastInputTokens: 90_000,
				conversationTokens: 2_000,
				toolCallTokens: 500,
			});
			db.prepare(
				"INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
			).run(
				sessionId,
				1,
				1,
				9,
				"m1",
				"m9",
				"Kept history",
				"archived compartment body",
				Date.now(),
			);
			const statuses: Array<string | undefined> = [];
			const tools = [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object" },
				},
			];
			registerStatusLine(
				{
					getAllTools: () => tools,
					on() {
						return undefined;
					},
				} as never,
				{ db, projectIdentity: "proj" },
			);
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getSystemPrompt: () => "You are pi.",
				getContextUsage: () => ({
					tokens: null,
					percent: null,
					contextWindow: 100_000,
				}),
				ui: {
					setStatus(_key: string, text: string | undefined) {
						statuses.push(text);
					},
				},
			};
			updateStatusLine(ctx as never, { db, projectIdentity: "proj" }, true);
			const text = statuses.at(-1) ?? "";
			const systemPrompt = "You are pi.";
			const prefix = estimatePiPrefixTokens({ systemPrompt, tools, estimateTokens }).tokens;
			const compartmentTokens = estimateTokens(
				"## 1-9 · Kept history\narchived compartment body\n",
			);
			const expected = prefix + compartmentTokens + 2_500;
			const shown =
				expected >= 1_000
					? `${(expected / 1_000).toFixed(1).replace(/\.0$/, "")}K`
					: String(Math.round(expected));
			expect(text).toBe(`mc: ${shown} (${Math.round((expected / 80_000) * 100)}%) · idle`);
		} finally {
			closeQuietly(db);
		}
	});
});
