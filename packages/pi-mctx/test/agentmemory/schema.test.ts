import { describe, expect, it } from "vitest";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { ensureAgentMemorySchema } from "../../src/agentmemory/schema";

function schemaObjects(db: Database): string[] {
	return (
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND (name LIKE 'agentmemory_%' OR name LIKE 'mctx_projection_%' OR name LIKE 'mctx_context_projection_%' OR name LIKE 'mctx_recall_%' OR name = 'mctx_branch_lineage') ORDER BY name",
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name);
}

describe("AgentMemory additive schema", () => {
	it("initializes a fresh database idempotently", () => {
		const db = new Database(":memory:");
		try {
			ensureAgentMemorySchema(db);
			const first = schemaObjects(db);
			ensureAgentMemorySchema(db);
			expect(schemaObjects(db)).toEqual(first);
			expect(first).toEqual([
				"agentmemory_outbox",
				"agentmemory_outbox_ready_idx",
				"agentmemory_turn_taint",
				"agentmemory_turn_taint_host_idx",
				"mctx_branch_lineage",
				"mctx_context_projection_heads",
				"mctx_projection_epoch_reachability",
				"mctx_projection_epochs",
				"mctx_projection_epochs_active_idx",
				"mctx_projection_epochs_session_idx",
				"mctx_projection_heads",
				"mctx_recall_dependencies",
				"mctx_recall_events",
				"mctx_recall_events_anchor_idx",
				"mctx_recall_presentation_claims",
				"mctx_recall_presentation_receipts",
				"mctx_recall_recovery_refs",
				"mctx_recall_sources",
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("adds bridge tables without changing legacy rows", () => {
		const db = new Database(":memory:");
		try {
			db.exec("CREATE TABLE legacy_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
			db.prepare("INSERT INTO legacy_state (id, value) VALUES (?, ?)").run("keep", "unchanged");
			ensureAgentMemorySchema(db);
			expect(db.prepare("SELECT id, value FROM legacy_state").get()).toEqual({
				id: "keep",
				value: "unchanged",
			});
			expect(schemaObjects(db)).toContain("agentmemory_outbox");
		} finally {
			closeQuietly(db);
		}
	});
});
