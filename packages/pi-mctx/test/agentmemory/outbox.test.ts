import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "#core/shared/sqlite";
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
	let db: Database;
	beforeEach(() => {
		db = createTestDb();
	});
	afterEach(() => {
		vi.useRealTimers();
		closeQuietly(db);
	});

	it("commits before delivery and deduplicates repeated saves", async () => {
		let release: (() => void) | undefined;
		const remember = vi.fn(
			() =>
				new Promise<{ success: true; memory: { id: string } }>((resolve) => {
					release = () => resolve({ success: true, memory: { id: "mem-1" } });
				}),
		);
		const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
		const input = { content: "Use pnpm.", project: "hepi-mono" };
		const first = outbox.queue(input);
		const second = outbox.queue(input);
		expect(second.id).toBe(first.id);
		expect(outbox.statusCounts()).toEqual({ pending: 1, leased: 0, failed: 0 });
		const draining = outbox.drain();
		await vi.waitFor(() => expect(remember).toHaveBeenCalledTimes(1));
		expect(outbox.statusCounts()).toEqual({ pending: 0, leased: 1, failed: 0 });
		release?.();
		await draining;
		expect(outbox.queue(input)).toMatchObject({ id: first.id, status: "delivered" });
		expect(outbox.statusCounts()).toEqual({ pending: 0, leased: 0, failed: 0 });
	});

	it("retries expired leases after restart without duplicating a delivered row", async () => {
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "mem-2" } }));
		const first = new AgentMemoryOutbox(db, client(remember), "crashed-worker");
		const queued = first.queue({ content: "Crash-safe save", project: "hepi-mono" });
		db.prepare(
			"UPDATE agentmemory_outbox SET state = 'leased', lease_owner = 'crashed-worker', lease_until = 0 WHERE id = ?",
		).run(queued.id);
		const restarted = new AgentMemoryOutbox(db, client(remember), "new-worker");
		await restarted.drain();
		await restarted.drain();
		expect(remember).toHaveBeenCalledTimes(1);
		expect(restarted.statusCounts()).toEqual({ pending: 0, leased: 0, failed: 0 });
	});

	it("resumes an unexpired leased record after its lease expires", async () => {
		vi.useFakeTimers();
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "mem-leased" } }));
		const first = new AgentMemoryOutbox(db, client(remember), "crashed-worker");
		const queued = first.queue({ content: "leased save", project: "hepi-mono" });
		db.prepare(
			"UPDATE agentmemory_outbox SET state = 'leased', lease_owner = 'crashed-worker', lease_until = ? WHERE id = ?",
		).run(Date.now() + 2_000, queued.id);
		await first.close(0);
		const restarted = new AgentMemoryOutbox(db, client(remember), "new-worker");
		restarted.resume();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2_001);
		expect(remember).toHaveBeenCalledTimes(1);
		expect(restarted.statusCounts()).toEqual({ pending: 0, leased: 0, failed: 0 });
		await restarted.close(0);
	});

	it("reconciles an ambiguous crashed delivery before retrying remember", async () => {
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "duplicate" } }));
		const search = vi.fn(async () => ({
			results: [
				{ memory: { id: "mem-existing", content: "already remote", project: "hepi-mono" } },
			],
		}));
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
		expect(restarted.statusCounts()).toEqual({ pending: 0, leased: 0, failed: 0 });
	});

	it("reconciles an ambiguous timeout after restart without a duplicate durable save", async () => {
		const remember = vi.fn(async () => Promise.reject(new Error("remember timed out")));
		const first = new AgentMemoryOutbox(db, client(remember), "timed-out-worker");
		const queued = first.queue({ content: "timeout-safe fact", project: "hepi-mono" });
		await first.drain();
		db.prepare("UPDATE agentmemory_outbox SET next_attempt_at = 0 WHERE id = ?").run(queued.id);
		await first.close(0);

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
		restarted.resume();
		await vi.waitFor(() => expect(restartedClient.search).toHaveBeenCalledTimes(1));
		expect(remember).toHaveBeenCalledTimes(1);
		expect(restarted.statusCounts()).toEqual({ pending: 0, leased: 0, failed: 0 });
	});

	it("bounds each drain to the requested number of deliveries", async () => {
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "mem" } }));
		const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
		outbox.queue({ content: "one", project: "hepi-mono" });
		outbox.queue({ content: "two", project: "hepi-mono" });
		outbox.queue({ content: "three", project: "hepi-mono" });
		await outbox.drain(2);
		expect(remember).toHaveBeenCalledTimes(2);
		expect(outbox.statusCounts()).toEqual({ pending: 1, leased: 0, failed: 0 });
	});

	it("closes after a bounded final drain and rejects later writes", async () => {
		const remember = vi.fn(async () => ({ success: true as const, memory: { id: "mem" } }));
		const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
		outbox.queue({ content: "one", project: "hepi-mono" });
		outbox.queue({ content: "two", project: "hepi-mono" });
		await outbox.close(1);
		expect(remember).toHaveBeenCalledTimes(1);
		expect(outbox.statusCounts()).toEqual({ pending: 1, leased: 0, failed: 0 });
		expect(() => outbox.queue({ content: "late", project: "hepi-mono" })).toThrow(
			/outbox is closed/,
		);
	});

	it("coalesces concurrent close calls into one final drain", async () => {
		let release: (() => void) | undefined;
		const remember = vi.fn(
			() =>
				new Promise<{ success: true; memory: { id: string } }>((resolve) => {
					release = () => resolve({ success: true, memory: { id: "mem" } });
				}),
		);
		const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
		outbox.queue({ content: "one", project: "hepi-mono" });
		const first = outbox.close();
		const second = outbox.close();
		await vi.waitFor(() => expect(remember).toHaveBeenCalledTimes(1));
		release?.();
		await Promise.all([first, second]);
		expect(remember).toHaveBeenCalledTimes(1);
	});

	it("retries pending delivery at its scheduled backoff without another enqueue", async () => {
		vi.useFakeTimers();
		const remember = vi
			.fn<AgentMemoryClientPort["remember"]>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ success: true, memory: { id: "mem-retried" } });
		const retriedClient = client(remember);
		retriedClient.search = vi.fn(async () => ({ results: [] }));
		const outbox = new AgentMemoryOutbox(db, retriedClient, "worker-1");
		outbox.queue({ content: "retry me", project: "hepi-mono" });
		await outbox.drain();
		expect(outbox.statusCounts()).toEqual({ pending: 1, leased: 0, failed: 0 });
		const row = db.prepare("SELECT attempts, last_error FROM agentmemory_outbox").get() as {
			attempts: number;
			last_error: string;
		};
		expect(row).toEqual({ attempts: 1, last_error: "offline" });
		await vi.advanceTimersByTimeAsync(2_001);
		expect(remember).toHaveBeenCalledTimes(2);
		expect(outbox.statusCounts()).toEqual({ pending: 0, leased: 0, failed: 0 });
		await outbox.close(0);
	});

	it("cancels a scheduled retry when closed", async () => {
		vi.useFakeTimers();
		const remember = vi.fn(async () => Promise.reject(new Error("offline")));
		const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
		outbox.queue({ content: "close me", project: "hepi-mono" });
		await outbox.drain();
		await outbox.close(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(remember).toHaveBeenCalledTimes(1);
	});

	it("clears an obsolete retry timer when no pending or leased row remains", async () => {
		vi.useFakeTimers();
		const remember = vi.fn(async () => Promise.reject(new Error("offline")));
		const outbox = new AgentMemoryOutbox(db, client(remember), "worker-1");
		outbox.queue({ content: "removed retry", project: "hepi-mono" });
		await outbox.drain();
		db.prepare("DELETE FROM agentmemory_outbox").run();
		await outbox.drain();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(remember).toHaveBeenCalledTimes(1);
		await outbox.close(0);
	});
});
