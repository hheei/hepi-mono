import { describe, expect, it, vi } from "vitest";
import {
	admitHistorianCandidate,
	admitHistorianCandidateFromRawMessages,
} from "../../src/agentmemory/historian";
import {
	captureAssistantEnd,
	captureToolResult,
	createAgentMemoryRuntime,
	redactCaptureText,
	redactCaptureValue,
} from "../../src/agentmemory/runtime";
import { SqliteTurnTaintStore } from "../../src/agentmemory/taint";
import { MagicContextConfigSchema } from "../../src/core/config/schema/magic-context";
import { closeQuietly } from "../../src/core/shared/sqlite-helpers";
import { createTestDb } from "../test-utils.test";

const defaults = MagicContextConfigSchema.parse({}).agentmemory;

function client(observe = vi.fn(async () => ({ observationId: "obs-1" }))) {
	return {
		async health() {
			return { status: "ok" };
		},
		async startSession(input: { sessionId: string }) {
			return { sessionId: input.sessionId };
		},
		observe,
		async search() {
			return { results: [] };
		},
		async remember() {
			return { success: true as const, memory: { id: "mem-1" } };
		},
		async endSession() {},
	};
}

describe("AgentMemory capture security", () => {
	it("redacts configured, shaped, header, nested, and key-named credentials", () => {
		const configured = "configured-secret";
		expect(
			redactCaptureText(
				`Authorization: Bearer abc123 password=hunter2 api_key: xyz sk-abcdefghijklmnop ${configured}`,
				[configured],
			),
		).toBe(
			"Authorization: Bearer [REDACTED] password=[REDACTED] api_key: [REDACTED] [REDACTED] [REDACTED]",
		);
		expect(
			redactCaptureValue({ nested: { accessToken: "raw-token", value: "secret=visible" } }),
		).toEqual({ nested: { accessToken: "[REDACTED]", value: "secret=[REDACTED]" } });
	});

	it("excludes memory output and propagates taint to user, tool, synthetic fold, and assistant", async () => {
		const db = createTestDb();
		const observe = vi.fn(async () => ({ observationId: "obs-1" }));
		const runtime = createAgentMemoryRuntime({ ...defaults, enabled: true }, client(observe), {
			db,
		});
		const branch: unknown[] = [
			{ type: "message", id: "user-1", message: { role: "user", content: "find prior work" } },
		];
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: { getSessionId: () => "session-1", getBranch: () => branch },
		};
		try {
			captureToolResult(runtime, ctx, {
				toolName: "mctx_search",
				toolCallId: "call-1",
				content: [{ type: "text", text: "recalled secret" }],
			});
			expect(observe).not.toHaveBeenCalled();
			branch.push({
				type: "message",
				id: "tool-1",
				message: { role: "toolResult", toolCallId: "call-1", toolName: "mctx_search" },
			});
			branch.push({
				type: "message",
				id: "assistant-1",
				message: { role: "assistant", content: [{ type: "text", text: "recalled secret" }] },
			});
			captureAssistantEnd(runtime, ctx, [
				{ role: "assistant", content: [{ type: "text", text: "recalled secret" }] },
			]);
			await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
			const store = runtime.taint;
			expect(store?.isHostEntryTainted("session-1", "user-1")).toBe(true);
			expect(store?.isHostEntryTainted("session-1", "tool-1")).toBe(true);
			expect(store?.isHostEntryTainted("session-1", "synth-user-tool-1")).toBe(true);
			expect(store?.isHostEntryTainted("session-1", "assistant-1")).toBe(true);
		} finally {
			await runtime.shutdown();
			closeQuietly(db);
		}
	});

	it("keeps capture failure detached from the host result", async () => {
		const runtime = createAgentMemoryRuntime(
			{ ...defaults, enabled: true },
			client(vi.fn(async () => Promise.reject(new Error("bridge down")))),
		);
		const ctx = { cwd: "/tmp/project", sessionManager: { getSessionId: () => "session-1" } };
		expect(() =>
			captureToolResult(runtime, ctx, { toolName: "read", content: "ordinary output" }),
		).not.toThrow();
		await runtime.shutdown();
	});
});

describe("AgentMemory Historian provenance", () => {
	it("rejects recall, memory tools, assistant restatements, and tainted evidence", () => {
		for (const evidence of [
			{ kind: "retrieval" as const, content: "fact", hostEntryId: "r1" },
			{ kind: "tool" as const, toolName: "mctx_search", content: "fact", hostEntryId: "t1" },
			{ kind: "assistant" as const, content: "fact", hostEntryId: "a1" },
			{ kind: "user" as const, content: "fact", hostEntryId: "u1", tainted: true },
		]) {
			expect(admitHistorianCandidate({ content: "fact", evidence: [evidence] }).accepted).toBe(
				false,
			);
		}
	});

	it("requires an exact untainted raw user or non-memory tool source", () => {
		const db = createTestDb();
		try {
			const taint = new SqliteTurnTaintStore(db);
			const messages = [
				{ ordinal: 1, id: "u1", role: "user", parts: [{ type: "text", text: "use pnpm" }] },
				{
					ordinal: 2,
					id: "t1",
					role: "user",
					parts: [
						{ type: "tool", tool: "read", callID: "c1", state: { output: "workspace exists" } },
					],
				},
			];
			expect(
				admitHistorianCandidateFromRawMessages({
					content: "workspace exists",
					sessionId: "s1",
					messages,
					taint,
				}).accepted,
			).toBe(true);
			taint.mark({ sessionId: "s1", turnId: "u1", hostEntryIds: ["t1"], reason: "recall" });
			expect(
				admitHistorianCandidateFromRawMessages({
					content: "workspace exists",
					sessionId: "s1",
					messages,
					taint,
				}).accepted,
			).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});
});
