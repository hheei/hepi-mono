import { describe, expect, it, vi } from "vitest";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import type { AgentMemoryClientPort } from "../../src/agentmemory/client";
import { AgentMemoryOutbox } from "../../src/agentmemory/outbox";
import { createTestDb } from "../test-utils.test";

function client(remember: AgentMemoryClientPort["remember"]): AgentMemoryClientPort {
	return {
		health: vi.fn(),
		startSession: vi.fn(),
		observe: vi.fn(),
		search: vi.fn(),
		remember,
		endSession: vi.fn(),
	};
}

describe("AgentMemoryOutbox", () => {
	it("commits before delivery and deduplicates repeated saves", async () => {
		const db = createTestDb();
		let release: (() => void) | undefined;
		const remember = vi.fn(
			() =>
				new Promise<{ success: true; memory: { id: string } }>((resolve) => {
					release = () => resolve({ success: true, memory: { id: "mem-1" } });
				}),
		);
		try {
			const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
			const input = { content: "Use pnpm.", project: "hepi-mono" };
			const first = outbox.queue(input);
			const second = outbox.queue(input);
			expect(second.id).toBe(first.id);
			expect(outbox.pendingCount()).toBe(1);
			const draining = outbox.drain();
			await vi.waitFor(() => expect(remember).toHaveBeenCalledTimes(1));
			expect(outbox.pendingCount()).toBe(1);
			release?.();
			await draining;
			expect(outbox.queue(input)).toMatchObject({ id: first.id, status: "delivered" });
			expect(outbox.pendingCount()).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries expired leases after restart without duplicating a delivered row", async () => {
		const db = createTestDb();
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "mem-2" } }));
		try {
			const first = new AgentMemoryOutbox(db, client(remember), "crashed-worker");
			const queued = first.queue({ content: "Crash-safe save", project: "hepi-mono" });
			db.prepare(
				"UPDATE agentmemory_outbox SET state = 'leased', lease_owner = 'crashed-worker', lease_until = 0 WHERE id = ?",
			).run(queued.id);
			const restarted = new AgentMemoryOutbox(db, client(remember), "new-worker");
			await restarted.drain();
			await restarted.drain();
			expect(remember).toHaveBeenCalledTimes(1);
			expect(restarted.pendingCount()).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("reconciles an ambiguous crashed delivery before retrying remember", async () => {
		const db = createTestDb();
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "duplicate" } }));
		const search = vi.fn(async () => ({
			results: [
				{ memory: { id: "mem-existing", content: "already remote", project: "hepi-mono" } },
			],
		}));
		try {
			const crashed = new AgentMemoryOutbox(db, client(remember), "crashed-worker");
			const queued = crashed.queue({ content: "already remote", project: "hepi-mono" });
			db.prepare(
				"UPDATE agentmemory_outbox SET state = 'leased', attempts = 1, lease_owner = 'crashed-worker', lease_until = 0 WHERE id = ?",
			).run(queued.id);
			const restartedClient = client(remember);
			restartedClient.search = search;
			const restarted = new AgentMemoryOutbox(db, restartedClient, "new-worker");
			await restarted.drain();
			expect(search).toHaveBeenCalledTimes(1);
			expect(remember).not.toHaveBeenCalled();
			expect(restarted.pendingCount()).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("reconciles an ambiguous timeout after restart without a duplicate durable save", async () => {
		const db = createTestDb();
		const remember = vi.fn(async () => Promise.reject(new Error("remember timed out")));
		try {
			const first = new AgentMemoryOutbox(db, client(remember), "timed-out-worker");
			const queued = first.queue({ content: "timeout-safe fact", project: "hepi-mono" });
			await first.drain();
			db.prepare("UPDATE agentmemory_outbox SET next_attempt_at = 0 WHERE id = ?").run(queued.id);

			const restartedClient = client(remember);
			restartedClient.search = vi.fn(async () => ({
				results: [
					{
						memory: {
							id: "mem-timeout-committed",
							content: "timeout-safe fact",
							project: "hepi-mono",
						},
					},
				],
			}));
			const restarted = new AgentMemoryOutbox(db, restartedClient, "restarted-worker");
			await restarted.drain();
			expect(restartedClient.search).toHaveBeenCalledTimes(1);
			expect(remember).toHaveBeenCalledTimes(1);
			expect(restarted.pendingCount()).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("bounds each drain to the requested number of deliveries", async () => {
		const db = createTestDb();
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "mem" } }));
		try {
			const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
			outbox.queue({ content: "one", project: "hepi-mono" });
			outbox.queue({ content: "two", project: "hepi-mono" });
			outbox.queue({ content: "three", project: "hepi-mono" });
			await outbox.drain(2);
			expect(remember).toHaveBeenCalledTimes(2);
			expect(outbox.pendingCount()).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});
	it("records retry state when remote delivery fails", async () => {
		const db = createTestDb();
		try {
			const outbox = new AgentMemoryOutbox(
				db,
				client(vi.fn(async () => Promise.reject(new Error("offline")))),
				"worker-1",
			);
			outbox.queue({ content: "retry me", project: "hepi-mono" });
			await outbox.drain();
			expect(outbox.pendingCount()).toBe(1);
			expect(outbox.failedCount()).toBe(0);
			const row = db.prepare("SELECT attempts, last_error FROM agentmemory_outbox").get() as {
				attempts: number;
				last_error: string;
			};
			expect(row).toEqual({ attempts: 1, last_error: "offline" });
		} finally {
			closeQuietly(db);
		}
	});
});
