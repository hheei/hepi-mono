import { describe, expect, it } from "vitest";
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

	it("shows unknown after compaction instead of a prefix floor", () => {
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
				...fakeContext("ses-status-line-compacted"),
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
			expect(statuses.at(-1)).toBe("mc: -- (--) · idle");
		} finally {
			closeQuietly(db);
		}
	});
});
