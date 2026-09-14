import { createHash, randomUUID } from "node:crypto";
import type { Database } from "#core/shared/sqlite";
import {
	type AgentMemoryClientPort,
	decodeAgentMemorySearchResults,
	type RememberInput,
} from "./client";

const OUTBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agentmemory_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  agent_id TEXT,
  content TEXT NOT NULL,
  type TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  remote_memory_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agentmemory_outbox_ready_idx
  ON agentmemory_outbox (state, next_attempt_at, lease_until);
`;

export type AgentMemoryOutboxStatus = "queued" | "delivered" | "failed";
export type AgentMemoryOutboxRow = {
	readonly id: string;
	readonly dedupeKey: string;
	readonly input: RememberInput;
	readonly state: "pending" | "leased" | "delivered" | "failed";
	readonly attempts: number;
	readonly lastError?: string | undefined;
};

export function ensureAgentMemoryOutboxSchema(db: Database): void {
	db.exec(OUTBOX_SCHEMA_SQL);
}

function dedupeKey(input: RememberInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify([input.project, input.agentId ?? null, input.type ?? null, input.content]),
		)
		.digest("hex");
}

function rowToOutbox(row: Record<string, unknown>): AgentMemoryOutboxRow {
	const input: RememberInput = {
		content: String(row.content),
		project: String(row.project),
		...(typeof row.agent_id === "string" ? { agentId: row.agent_id } : {}),
		...(typeof row.type === "string" ? { type: row.type } : {}),
	};
	return {
		id: String(row.id),
		dedupeKey: String(row.dedupe_key),
		input,
		state: row.state as AgentMemoryOutboxRow["state"],
		attempts: Number(row.attempts),
		...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
	};
}

export class AgentMemoryOutbox {
	readonly #db: Database;
	readonly #client: AgentMemoryClientPort;
	readonly #owner: string;
	#draining: Promise<void> | undefined;

	constructor(db: Database, client: AgentMemoryClientPort, owner = `pi-${randomUUID()}`) {
		this.#db = db;
		this.#client = client;
		this.#owner = owner;
		ensureAgentMemoryOutboxSchema(db);
	}

	queue(input: RememberInput): { status: AgentMemoryOutboxStatus; id: string; dedupeKey: string } {
		const key = dedupeKey(input);
		const now = Date.now();
		const id = randomUUID();
		this.#db
			.prepare(
				`INSERT INTO agentmemory_outbox
				(id, dedupe_key, project, agent_id, content, type, state, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
				ON CONFLICT(dedupe_key) DO NOTHING`,
			)
			.run(
				id,
				key,
				input.project,
				input.agentId ?? null,
				input.content,
				input.type ?? null,
				now,
				now,
			);
		const stored = this.#db
			.prepare("SELECT id, state FROM agentmemory_outbox WHERE dedupe_key = ?")
			.get(key) as { id: string; state: AgentMemoryOutboxRow["state"] };
		return {
			status:
				stored.state === "delivered"
					? "delivered"
					: stored.state === "failed"
						? "failed"
						: "queued",
			id: stored.id,
			dedupeKey: key,
		};
	}

	async enqueueAndDrain(
		input: RememberInput,
	): Promise<{ status: AgentMemoryOutboxStatus; id: string }> {
		const queued = this.queue(input);
		if (queued.status === "queued") void this.drain(1);
		return { status: queued.status, id: queued.id };
	}

	async drain(limit = 16): Promise<void> {
		if (this.#draining !== undefined) return this.#draining;
		this.#draining = this.#drain(limit).finally(() => {
			this.#draining = undefined;
		});
		return this.#draining;
	}

	pendingCount(): number {
		const row = this.#db
			.prepare(
				"SELECT count(*) AS count FROM agentmemory_outbox WHERE state IN ('pending', 'leased')",
			)
			.get() as { count: number };
		return Number(row.count);
	}

	failedCount(): number {
		const row = this.#db
			.prepare("SELECT count(*) AS count FROM agentmemory_outbox WHERE state = 'failed'")
			.get() as { count: number };
		return Number(row.count);
	}

	async #drain(limit: number): Promise<void> {
		const now = Date.now();
		this.#db
			.prepare(
				`UPDATE agentmemory_outbox SET state = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
				 WHERE state = 'leased' AND (lease_until IS NULL OR lease_until < ?)`,
			)
			.run(now, now);
		for (let index = 0; index < limit; index += 1) {
			const row = this.#db
				.prepare(
					`UPDATE agentmemory_outbox SET state = 'leased', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
					 WHERE id = (SELECT id FROM agentmemory_outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 1)
					 RETURNING *`,
				)
				.get(this.#owner, Date.now() + 30_000, Date.now(), Date.now()) as
				| Record<string, unknown>
				| undefined;
			if (!row) return;
			const item = rowToOutbox(row);
			if (item.attempts > 1) {
				try {
					const existing = decodeAgentMemorySearchResults(
						await this.#client.search({
							query: item.input.content,
							limit: 20,
							project: item.input.project,
							...(item.input.agentId ? { agentId: item.input.agentId } : {}),
						}),
					).find(
						(result) =>
							result.content === item.input.content &&
							(result.project === undefined || result.project === item.input.project) &&
							(result.agentId === undefined || result.agentId === item.input.agentId),
					);
					if (existing) {
						this.#markDelivered(item.id, existing.id);
						continue;
					}
				} catch (error) {
					this.#retry(item, error);
					continue;
				}
			}
			try {
				const result = await this.#client.remember(item.input);
				this.#markDelivered(item.id, result.memory.id);
			} catch (error) {
				this.#retry(item, error);
			}
		}
	}

	#markDelivered(id: string, remoteMemoryId: string): void {
		this.#db
			.prepare(
				"UPDATE agentmemory_outbox SET state = 'delivered', remote_memory_id = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?",
			)
			.run(remoteMemoryId, Date.now(), id, this.#owner);
	}

	#retry(item: AgentMemoryOutboxRow, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const attempts = item.attempts;
		this.#db
			.prepare(
				"UPDATE agentmemory_outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?",
			)
			.run(
				attempts >= 5 ? "failed" : "pending",
				attempts,
				Date.now() + Math.min(60_000, 2 ** attempts * 1_000),
				message,
				Date.now(),
				item.id,
				this.#owner,
			);
	}
}
