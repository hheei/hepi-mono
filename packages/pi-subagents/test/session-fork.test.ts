import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SubagentRecord } from "../src/domain.js";
import {
	formatSessionReferencePrompt,
	readSessionJsonlEntries,
	resolveForkSessionReference,
} from "../src/session-fork.js";

describe("session-fork (session reference)", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pi-subagents-fork-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("resolveForkSessionReference rejects 'current'", async () => {
		await expect(
			resolveForkSessionReference({
				forkFrom: "current",
				parentSessionPath: join(testDir, "parent.jsonl"),
			}),
		).rejects.toThrow(/cannot be 'current'/);
	});

	test("resolveForkSessionReference resolves 'parent'", async () => {
		const parentSessionPath = join(testDir, "parent.jsonl");
		await writeFile(parentSessionPath, '{"type":"session"}\n', "utf8");

		const resolved = await resolveForkSessionReference({
			forkFrom: "parent",
			parentSessionPath,
		});

		expect(resolved).toBe(parentSessionPath);
	});

	test("resolveForkSessionReference fails for 'parent' when no session path is available", async () => {
		await expect(
			resolveForkSessionReference({
				forkFrom: "parent",
			}),
		).rejects.toThrow(/Parent session has no associated session file/);
	});

	test("resolveForkSessionReference resolves subagent id from registry", async () => {
		const priorSessionDir = join(testDir, "agents");
		await mkdir(priorSessionDir, { recursive: true });
		const priorSessionId = "prior-agent-session";
		const priorSessionFile = join(
			priorSessionDir,
			`2026-01-01T00-00-00-000Z_${priorSessionId}.jsonl`,
		);
		await writeFile(priorSessionFile, '{"type":"session"}\n', "utf8");

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

		const resolved = await resolveForkSessionReference({
			forkFrom: "agent-1",
			registry: mockRegistry,
		});

		expect(resolved).toBe(priorSessionFile);
	});

	test("resolveForkSessionReference fails when subagent id is missing from registry", async () => {
		const mockRegistry = {
			get: async (): Promise<SubagentRecord | undefined> => undefined,
		};

		await expect(
			resolveForkSessionReference({
				forkFrom: "agent-99",
				registry: mockRegistry,
			}),
		).rejects.toThrow(/was not found in registry/);
	});

	test("resolveForkSessionReference resolves an explicit valid session file path", async () => {
		const explicitPath = join(testDir, "custom-session.jsonl");
		await writeFile(explicitPath, '{"type":"session"}\n', "utf8");

		const resolved = await resolveForkSessionReference({
			forkFrom: explicitPath,
		});

		expect(resolved).toBe(explicitPath);
	});

	test("resolveForkSessionReference fails when explicit session file does not exist", async () => {
		const nonexistent = join(testDir, "nonexistent.jsonl");
		await expect(
			resolveForkSessionReference({
				forkFrom: nonexistent,
			}),
		).rejects.toThrow(/Referenced session file not found/);
	});

	test("formatSessionReferencePrompt formats reference instructions for on-demand inspection", () => {
		const prompt = formatSessionReferencePrompt("/path/to/prior-session.jsonl");
		expect(prompt).toContain("## Referenced Session Context");
		expect(prompt).toContain("/path/to/prior-session.jsonl");
		expect(prompt).toContain("read or grep");
		expect(prompt).toContain("instead of loading the entire history");
	});

	test("readSessionJsonlEntries reads valid JSONL entries from disk", async () => {
		const filePath = join(testDir, "entries.jsonl");
		await writeFile(
			filePath,
			'{"type":"session","id":"123"}\n{"type":"message","text":"hello"}\n',
			"utf8",
		);

		const entries = await readSessionJsonlEntries(filePath);
		expect(entries).toEqual([
			{ type: "session", id: "123" },
			{ type: "message", text: "hello" },
		]);
	});
});
