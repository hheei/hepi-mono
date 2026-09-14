import type { Database } from "#core/shared/sqlite";
import { ensureAgentMemoryOutboxSchema } from "./outbox";
import { ensureAgentMemoryTurnTaintSchema } from "./taint";

/** Additive, idempotent bridge-local schema initialization. */
export function ensureAgentMemorySchema(db: Database): void {
	ensureAgentMemoryOutboxSchema(db);
	ensureAgentMemoryTurnTaintSchema(db);
}
