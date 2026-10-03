import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SubagentRecord } from "../src/domain.js";
import {
	forkSubagentSession,
	readSessionJsonlEntries,
	sanitizeForkEntry,
} from "../src/session-fork.js";

describe("session-fork", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pi-subagents-fork-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("sanitizeForkEntry strips thinking blocks and thinkingSignature", () => {
		const assistantEntry = {
			type: "message",
			message: {
				role: "assistant",
				thinkingSignature: "secret-sig-123",
				content: [
					{ type: "thinking", thinking: "internal thoughts", thinkingSignature: "sig" },
					{ type: "text", text: "Hello user!" },
				],
			},
		};

		const sanitized = sanitizeForkEntry(assistantEntry) as {
			type: string;
			message: {
				role: string;
				thinkingSignature?: string;
				content: Array<{ type: string; text?: string }>;
			};
		};

		expect(sanitized.message.thinkingSignature).toBeUndefined();
		expect(sanitized.message.content).toEqual([{ type: "text", text: "Hello user!" }]);
	});

	test("sanitizeForkEntry provides placeholder if assistant message was only thinking", () => {
		const assistantEntry = {
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "just thinking" }],
			},
		};

		const sanitized = sanitizeForkEntry(assistantEntry) as {
			message: { content: Array<{ type: string; text?: string }> };
		};

		expect(sanitized.message.content).toEqual([{ type: "text", text: "(previous response)" }]);
	});

	test("sanitizeForkEntry strips hindsight blocks from user and assistant text", () => {
		const userEntry = {
			type: "message",
			message: {
				role: "user",
				content:
					"Here is some text\n<hindsight-recall>\nsecret memory\n</hindsight-recall>\nand more text",
			},
		};

		const sanitized = sanitizeForkEntry(userEntry) as {
			message: { content: string };
		};

		expect(sanitized.message.content.trim()).toBe("Here is some text\nand more text");
	});

	test("forkSubagentSession forks from parent entries and writes valid JSONL", async () => {
		const targetSessionDir = join(testDir, "agents");
		const targetSessionId = "child-session-123";

		const parentEntries = [
			{
				type: "session",
				version: 1,
				id: "parent-session-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: testDir,
			},
			{
				type: "message",
				message: {
					role: "user",
					content: "Please build feature X",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					thinkingSignature: "bad-sig",
					content: [
						{ type: "thinking", thinking: "pondering..." },
						{ type: "text", text: "Sure, I will build feature X" },
					],
				},
			},
		];

		const sessionFile = await forkSubagentSession({
			targetSessionId,
			targetCwd: testDir,
			targetSessionDir,
			forkFrom: "parent",
			parentEntries,
		});

		const entries = await readSessionJsonlEntries(sessionFile);
		expect(entries.length).toBe(3); // 1 header + 2 sanitized messages

		const header = entries[0] as Record<string, unknown>;
		expect(header.type).toBe("session");
		expect(header.id).toBe(targetSessionId);
		expect(header.cwd).toBe(testDir);

		const assistantMsg = entries[2] as {
			message: { role: string; thinkingSignature?: string; content: unknown[] };
		};
		expect(assistantMsg.message.thinkingSignature).toBeUndefined();
		expect(assistantMsg.message.content).toEqual([
			{ type: "text", text: "Sure, I will build feature X" },
		]);
	});

	test("forkSubagentSession incorporates memory compaction draft if available", async () => {
		const targetSessionDir = join(testDir, "agents");
		const targetSessionId = "child-compact-456";

		const parentEntries = [
			{
				type: "session",
				version: 1,
				id: "parent-session-2",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: testDir,
			},
			{
				type: "message",
				message: { role: "user", content: "old message 1" },
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "old answer 1" }] },
			},
			{
				type: "message",
				message: { role: "user", content: "latest question" },
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
			},
		];

		const memoryCompactor = {
			createCompactionDraft: () => ({
				summary: "## Session Summary\nProject architecture was analyzed and task is underway.",
				firstKeptEntryId: null,
			}),
		};

		const sessionFile = await forkSubagentSession({
			targetSessionId,
			targetCwd: testDir,
			targetSessionDir,
			forkFrom: "parent",
			parentEntries,
			memoryCompactor,
		});

		const entries = await readSessionJsonlEntries(sessionFile);
		expect(entries.length).toBeGreaterThan(1);

		const compaction = entries[1] as Record<string, unknown>;
		expect(compaction.type).toBe("compaction");
		expect(compaction.summary).toContain("Session Summary");
	});

	test("forkSubagentSession forks from existing subagent session file", async () => {
		const priorSessionDir = join(testDir, "agents");
		await mkdir(priorSessionDir, { recursive: true });
		const priorSessionId = "prior-agent-session";
		const priorSessionFile = join(
			priorSessionDir,
			`2026-01-01T00-00-00-000Z_${priorSessionId}.jsonl`,
		);

		const priorEntries = [
			{
				type: "session",
				version: 1,
				id: priorSessionId,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: testDir,
			},
			{ type: "message", message: { role: "user", content: "Research auth" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "pondering auth" },
						{ type: "text", text: "Auth uses JWT tokens" },
					],
				},
			},
		];
		await writeFile(
			priorSessionFile,
			`${priorEntries.map((e) => JSON.stringify(e)).join("\n")}\n`,
			"utf8",
		);

		const mockRegistry = {
			get: async (id: string): Promise<SubagentRecord | undefined> => {
				if (id === "agent-1") {
					return {
						subagentId: "agent-1",
						sessionId: priorSessionId,
						sessionPath: priorSessionFile,
						launchConfig: { sessionDir: priorSessionDir, sessionId: priorSessionId },
					} as unknown as SubagentRecord;
				}
				return undefined;
			},
		};

		const targetSessionId = "child-from-agent-1";
		const sessionFile = await forkSubagentSession({
			targetSessionId,
			targetCwd: testDir,
			targetSessionDir: join(testDir, "child-agents"),
			forkFrom: "agent-1",
			registry: mockRegistry,
		});

		const entries = await readSessionJsonlEntries(sessionFile);
		expect(entries.length).toBe(3);

		const header = entries[0] as Record<string, unknown>;
		expect(header.id).toBe(targetSessionId);
		expect(header.parentSession).toBe(priorSessionFile);

		const assistant = entries[2] as { message: { content: unknown[] } };
		expect(assistant.message.content).toEqual([{ type: "text", text: "Auth uses JWT tokens" }]);
	});
});
