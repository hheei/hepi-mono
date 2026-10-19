import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HindsightRetainQueue,
	MAX_PENDING_BATCHES,
	MAX_RETAINED_TURNS,
} from "../../src/hindsight/queue.js";
import type { HindsightTurn } from "../../src/hindsight/transcript.js";
import { fakeGateway } from "./fixtures.js";

function turn(text: string): HindsightTurn {
	return { role: "user", text };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("hindsight retain queue", () => {
	it("retains batches in enqueue order, one at a time", async () => {
		const blocked = deferred();
		const started: string[] = [];
		let concurrent = 0;
		let maxConcurrent = 0;
		const gateway = fakeGateway({
			retainTurns: vi.fn(async ({ turns }: { turns: readonly HindsightTurn[] }) => {
				concurrent += 1;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				started.push(turns.map((item) => item.text).join(","));
				await blocked.promise;
				concurrent -= 1;
				return { operationId: "op", documentId: "doc", turns: turns.length };
			}),
		});
		const queue = new HindsightRetainQueue(gateway);

		expect(queue.enqueue("s1", [turn("first")])).toBe(true);
		expect(queue.enqueue("s1", [turn("second")])).toBe(true);
		expect(started).toEqual(["first"]);
		blocked.resolve();
		await queue.drain();
		expect(started).toEqual(["first", "second"]);
		expect(maxConcurrent).toBe(1);
	});

	it("drops an immediate repeat of the same batch while still accepting new ones", async () => {
		const gateway = fakeGateway();
		const queue = new HindsightRetainQueue(gateway);
		const turns = [turn("same")];
		expect(queue.enqueue("s1", turns)).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.status().retainedTurns).toBe(1);

		// A retried agent_end handing back identical content is not new memory. The queue
		// is still live here, so this is the duplicate guard and not a closed queue.
		expect(queue.enqueue("s1", turns)).toBe(false);
		expect(queue.enqueue("s1", [turn("different")])).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(gateway.retainTurns).toHaveBeenCalledTimes(2);
		expect(queue.status().retainedTurns).toBe(2);
	});

	it("refuses work with nothing to retain or no live session", async () => {
		const gateway = fakeGateway();
		const queue = new HindsightRetainQueue(gateway);
		expect(queue.enqueue("s1", [])).toBe(false);
		const controller = new AbortController();
		controller.abort();
		expect(queue.enqueue("s1", [turn("after abort")], controller.signal)).toBe(false);
		expect(gateway.retainTurns).not.toHaveBeenCalled();
	});

	it("records a failure, keeps the session usable, and reports it", async () => {
		const gateway = fakeGateway({
			retainTurns: vi
				.fn()
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValue({ operationId: "op", documentId: "doc", turns: 1 }),
		});
		const queue = new HindsightRetainQueue(gateway);
		queue.enqueue("s1", [turn("first")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.status().lastError).toBe("connection refused");
		expect(queue.status().retainedTurns).toBe(0);

		// The queue stays usable: the next batch still goes out and clears the error.
		queue.enqueue("s1", [turn("second")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.status().retainedTurns).toBe(1);
		expect(gateway.retainTurns).toHaveBeenCalledTimes(2);
		expect(queue.status().lastError).toBeUndefined();
		await queue.drain();
	});

	it("bounds the backlog instead of queuing without limit", async () => {
		const blocked = deferred();
		const gateway = fakeGateway({
			retainTurns: vi.fn(async ({ turns }: { turns: readonly HindsightTurn[] }) => {
				await blocked.promise;
				return { operationId: "op", documentId: "doc", turns: turns.length };
			}),
		});
		const queue = new HindsightRetainQueue(gateway);

		expect(queue.enqueue("s1", [turn("in flight")])).toBe(true);
		for (let index = 0; index < MAX_PENDING_BATCHES; index += 1) {
			expect(queue.enqueue("s1", [turn(`pending ${index}`)])).toBe(true);
		}
		expect(queue.enqueue("s1", [turn("overflow")])).toBe(false);
		expect(queue.status().pendingBatches).toBe(MAX_PENDING_BATCHES);
		blocked.resolve();
		await queue.drain();
		expect(queue.status().pendingBatches).toBe(0);
	});

	it("caps one batch at the turn limit, keeping the newest turns", async () => {
		const seen: string[][] = [];
		const gateway = fakeGateway({
			retainTurns: vi.fn(async ({ turns }: { turns: readonly HindsightTurn[] }) => {
				seen.push(turns.map((item) => item.text));
				return { operationId: "op", documentId: "doc", turns: turns.length };
			}),
		});
		expect(MAX_RETAINED_TURNS).toBeGreaterThan(3);
		const queue = new HindsightRetainQueue(gateway, 3);
		queue.enqueue(
			"s1",
			[1, 2, 3, 4, 5].map((index) => turn(String(index))),
		);
		await queue.drain();
		expect(seen).toEqual([["3", "4", "5"]]);
	});

	it("aborts an in-flight retain when the drain grace period expires", async () => {
		const observed = { aborted: false };
		const gateway = fakeGateway({
			retainTurns: vi.fn(
				(_input: unknown, signal?: AbortSignal) =>
					new Promise<never>((_resolve, reject) => {
						signal?.addEventListener("abort", () => {
							observed.aborted = true;
							reject(new Error("aborted"));
						});
					}),
			),
		});
		const queue = new HindsightRetainQueue(gateway);
		queue.enqueue("s1", [turn("hangs")]);
		expect(queue.status().inFlight).toBe(true);
		const drained = queue.drain(5);
		await vi.advanceTimersByTimeAsync(4);
		expect(observed.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await drained).toBe(false);
		expect(observed.aborted).toBe(true);
		// Once closed, later turns are ignored rather than revived.
		expect(queue.enqueue("s1", [turn("after teardown")])).toBe(false);
	});

	it("returns immediately when nothing is in flight", async () => {
		const queue = new HindsightRetainQueue(fakeGateway());
		expect(await queue.drain(5)).toBe(true);
		expect(queue.status()).toEqual({
			retainedTurns: 0,
			inFlight: false,
			pendingBatches: 0,
		});
	});
});
