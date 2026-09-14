import { describe, expect, it, vi } from "vitest";
import { MagicContextConfigSchema } from "#core/config/schema/magic-context";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import type { AgentMemoryClientPort } from "../../src/agentmemory/client";
import { AgentMemoryOutbox } from "../../src/agentmemory/outbox";
import { AgentMemoryStatusTracker, formatAgentMemoryStatus } from "../../src/agentmemory/status";
import { createTestDb } from "../test-utils.test";

function client(): AgentMemoryClientPort {
	return {
		health: vi.fn(),
		startSession: vi.fn(),
		observe: vi.fn(),
		search: vi.fn(),
		remember: vi.fn(),
		endSession: vi.fn(),
	};
}

const enabled = {
	...MagicContextConfigSchema.parse({}).agentmemory,
	enabled: true,
};

describe("AgentMemory observed status", () => {
	it("reads observed state and local outbox counts without network access", () => {
		const db = createTestDb();
		const remote = client();
		try {
			const outbox = new AgentMemoryOutbox(db, remote, "status-worker");
			outbox.queue({ content: "pending fact", project: "hepi-mono" });
			db.prepare(
				"INSERT INTO agentmemory_outbox (id, dedupe_key, project, content, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)",
			).run("failed", "failed-key", "hepi-mono", "failed fact", 1, 2);
			const tracker = new AgentMemoryStatusTracker();
			tracker.recordSuccess("capture");
			tracker.recordFailure("search", new Error("offline"));

			const rowsBefore = db.prepare("SELECT * FROM agentmemory_outbox ORDER BY id").all();
			const snapshot = tracker.snapshot(enabled, outbox);
			expect(snapshot).toMatchObject({
				enabled: true,
				health: "unknown",
				capture: "healthy",
				search: "degraded",
				inject: "idle",
				memory: "idle",
				outbox: { pending: 1, leased: 0, failed: 1 },
				lastError: "offline",
			});
			expect(formatAgentMemoryStatus(snapshot).join("\n")).toContain("search=degraded");
			expect(remote.health).not.toHaveBeenCalled();
			expect(remote.search).not.toHaveBeenCalled();
			expect(db.prepare("SELECT * FROM agentmemory_outbox ORDER BY id").all()).toEqual(rowsBefore);
		} finally {
			closeQuietly(db);
		}
	});

	it("reports every gate disabled when the bridge is disabled", () => {
		const tracker = new AgentMemoryStatusTracker();
		const snapshot = tracker.snapshot({ ...enabled, enabled: false }, undefined);
		expect(snapshot).toMatchObject({
			enabled: false,
			capture: "disabled",
			search: "disabled",
			inject: "disabled",
			memory: "disabled",
		});
		expect(formatAgentMemoryStatus(snapshot)).toEqual(["AgentMemory: disabled"]);
	});
});
