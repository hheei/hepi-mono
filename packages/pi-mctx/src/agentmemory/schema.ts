import type { Database } from "#core/shared/sqlite";
import { ensureContextProjectionSchema } from "./context-projection";
import { ensureAgentMemoryOutboxSchema } from "./outbox";
import { ensureRecallLedgerSchema } from "./recall";
import { ensureAgentMemoryTurnTaintSchema } from "./taint";
/** Additive, idempotent bridge-local schema initialization. */
export function ensureAgentMemorySchema(db: Database): void {
	ensureAgentMemoryOutboxSchema(db);
	ensureAgentMemoryTurnTaintSchema(db);
	ensureRecallLedgerSchema(db);
	ensureContextProjectionSchema(db);
}
