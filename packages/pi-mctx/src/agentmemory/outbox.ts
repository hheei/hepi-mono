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
type AgentMemoryOutboxRow = {
	readonly id: string;
	readonly input: RememberInput;
	readonly attempts: number;
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

export class AgentMemoryOutbox {
	readonly #db: Database;
	readonly #client: AgentMemoryClientPort;
	readonly #owner: string;
	#draining: Promise<void> | undefined;
	#accepting = true;
	#closing: Promise<void> | undefined;
	#retryTimer: NodeJS.Timeout | undefined;
	readonly #onFailure: ((error: unknown) => void) | undefined;

	constructor(
		db: Database,
		client: AgentMemoryClientPort,
		owner = `pi-${randomUUID()}`,
		onFailure?: (error: unknown) => void,
	) {
		this.#db = db;
		this.#client = client;
		this.#owner = owner;
		this.#onFailure = onFailure;
		ensureAgentMemoryOutboxSchema(db);
	}

	queue(input: RememberInput): { status: AgentMemoryOutboxStatus; id: string; dedupeKey: string } {
		if (!this.#accepting) throw new Error("AgentMemory outbox is closed");
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
			.get(key) as { id: string; state: "pending" | "leased" | "delivered" | "failed" };
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
		if (queued.status === "queued") this.#startBackgroundDrain(1);
		return { status: queued.status, id: queued.id };
	}

	resume(): void {
		if (!this.#accepting) return;
		this.#startBackgroundDrain(16);
	}

	async drain(limit = 16): Promise<void> {
		if (this.#draining !== undefined) return this.#draining;
		this.#draining = this.#drain(limit).finally(() => {
			this.#draining = undefined;
			this.#scheduleNextRetry();
		});
		return this.#draining;
	}

	close(limit = 16): Promise<void> {
		this.#accepting = false;
		this.#clearRetryTimer();
		this.#closing ??= this.#finishClose(limit);
		return this.#closing;
	}

	async #finishClose(limit: number): Promise<void> {
		const active = this.#draining;
		if (active !== undefined) await active;
		await this.drain(limit);
	}

	statusCounts(): { pending: number; leased: number; failed: number } {
		const rows = this.#db
			.prepare(
				"SELECT state, count(*) AS count FROM agentmemory_outbox WHERE state IN ('pending', 'leased', 'failed') GROUP BY state",
			)
			.all() as Array<{ state: "pending" | "leased" | "failed"; count: number }>;
		const counts = { pending: 0, leased: 0, failed: 0 };
		for (const row of rows) counts[row.state] = Number(row.count);
		return counts;
	}

	latestError(): { message: string; at: number } | null {
		const row = this.#db
			.prepare(
				"SELECT last_error, updated_at FROM agentmemory_outbox WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
			)
			.get() as { last_error: string; updated_at: number } | undefined;
		return row ? { message: row.last_error, at: Number(row.updated_at) } : null;
	}

	#startBackgroundDrain(limit: number): void {
		void this.drain(limit).catch((error: unknown) => {
			try {
				this.#onFailure?.(error);
			} catch {
				// Reporting cannot leave a rejected background task.
			}
		});
	}

	#clearRetryTimer(): void {
		if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
	}

	#scheduleNextRetry(): void {
		if (!this.#accepting) return;
		this.#clearRetryTimer();
		const row = this.#db
			.prepare(
				`SELECT min(CASE
					WHEN state = 'pending' THEN next_attempt_at
					WHEN lease_until IS NULL THEN 0
					ELSE lease_until + 1
				END) AS next_attempt_at
				FROM agentmemory_outbox
				WHERE state IN ('pending', 'leased')`,
			)
			.get() as { next_attempt_at: number | null };
		if (row.next_attempt_at === null) return;
		const delay = Math.max(0, Number(row.next_attempt_at) - Date.now());
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			this.#startBackgroundDrain(16);
		}, delay);
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
			const item: AgentMemoryOutboxRow = {
				id: String(row.id),
				input: {
					content: String(row.content),
					project: String(row.project),
					...(typeof row.agent_id === "string" ? { agentId: row.agent_id } : {}),
					...(typeof row.type === "string" ? { type: row.type } : {}),
				},
				attempts: Number(row.attempts),
			};
			try {
				if (item.attempts > 1) {
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
				}
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
		this.#scheduleNextRetry();
	}
}
