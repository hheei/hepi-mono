import { debugLog } from "../debug-log.js";
import type { HindsightGateway, HindsightRetainReceipt } from "./client.js";
import { fingerprintTurns, type HindsightTurn } from "./transcript.js";

/**
 * Most recent turns sent in one retain call.
 *
 * `agent_end` delivers one run's messages, so this only bounds a pathological single run.
 * Anything dropped is reported by `status()` and never affects the session itself.
 */
export const MAX_RETAINED_TURNS = 200;

/** Grace period granted to an in-flight retain before the caller aborts it. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/** Backlog cap: further turns are dropped rather than queued without bound. */
export const MAX_PENDING_BATCHES = 8;

export interface HindsightRetainStatus {
	readonly retainedTurns: number;
	readonly inFlight: boolean;
	readonly pendingBatches: number;
	readonly lastError?: string | undefined;
}

/**
 * Serializes session writeback to Hindsight.
 *
 * One retain runs at a time, in enqueue order, so turns reach the server in transcript
 * order. A repeat of the same turn batch is dropped locally and a retry of a partially
 * delivered batch folds server-side, because the operation id is derived from the batch
 * content: delivery is at-most-once from the client's point of view, and idempotent on the
 * server's.
 *
 * Failures are recorded and swallowed. Memory writeback must never surface as a turn
 * failure or block the user's session.
 */
export class HindsightRetainQueue {
	readonly #gateway: HindsightGateway;
	readonly #maxTurns: number;
	#pending: HindsightTurn[][] = [];
	#sessionId: string | undefined;
	#inFlight: Promise<void> | undefined;
	/** Set while draining: stops accepting work, but keeps flushing what is queued. */
	#closed = false;
	/** Set when the drain grace period expires: stop flushing and cancel in flight. */
	#stopped = false;
	#retainedTurns = 0;
	#lastFingerprint: string | undefined;
	#lastError: string | undefined;
	#controller: AbortController | undefined;

	constructor(gateway: HindsightGateway, maxTurns: number = MAX_RETAINED_TURNS) {
		this.#gateway = gateway;
		this.#maxTurns = Math.max(1, maxTurns);
	}

	/**
	 * Records one run's turns for writeback.
	 *
	 * Returns `false` when there is nothing to retain, so callers can skip scheduling.
	 */
	enqueue(sessionId: string, turns: readonly HindsightTurn[], signal?: AbortSignal): boolean {
		if (this.#closed || turns.length === 0 || signal?.aborted === true) return false;
		const batch = turns.length <= this.#maxTurns ? [...turns] : turns.slice(-this.#maxTurns);
		const fingerprint = fingerprintTurns(batch);
		if (fingerprint === this.#lastFingerprint) return false;
		if (this.#pending.length >= MAX_PENDING_BATCHES) {
			debugLog("hindsight.retain_backlog_dropped", { pending: this.#pending.length });
			return false;
		}
		this.#sessionId = sessionId;
		this.#pending.push(batch);
		this.#schedule(signal);
		return true;
	}

	#schedule(signal?: AbortSignal): void {
		if (this.#inFlight !== undefined) return;
		this.#inFlight = this.#run(signal).finally(() => {
			this.#inFlight = undefined;
			this.#controller = undefined;
		});
	}

	async #run(signal?: AbortSignal): Promise<void> {
		while (this.#pending.length > 0 && !this.#stopped) {
			const batch = this.#pending.shift();
			const sessionId = this.#sessionId;
			if (batch === undefined || sessionId === undefined) continue;
			this.#controller = new AbortController();
			const requestSignal =
				signal === undefined
					? this.#controller.signal
					: AbortSignal.any([signal, this.#controller.signal]);
			try {
				const receipt: HindsightRetainReceipt = await this.#gateway.retainTurns(
					{ sessionId, turns: batch },
					requestSignal,
				);
				this.#retainedTurns += batch.length;
				this.#lastFingerprint = fingerprintTurns(batch);
				this.#lastError = undefined;
				debugLog("hindsight.retain", {
					operationId: receipt.operationId,
					documentId: receipt.documentId,
					turns: receipt.turns,
				});
			} catch (error) {
				// A caller-initiated abort is a deliberate stop, not a memory failure.
				if (signal?.aborted === true) return;
				const message = error instanceof Error ? error.message : String(error);
				this.#lastError = message;
				debugLog("hindsight.retain_failed", { sessionId, turns: batch.length, error: message });
			}
		}
	}

	/**
	 * Stops accepting work, flushes what is queued, then cancels anything still running.
	 *
	 * Called on session teardown so a pending writeback is not silently lost. The flush is
	 * bounded: once the grace period expires, the in-flight request is aborted and the rest
	 * of the backlog is discarded rather than outliving the session. Returns whether the
	 * queue drained within the grace period.
	 */
	async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<boolean> {
		this.#closed = true;
		const running = this.#inFlight;
		if (running === undefined) return true;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			this.#stopped = true;
			this.#controller?.abort();
		}, timeoutMs);
		try {
			await running;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
		return !timedOut;
	}

	status(): HindsightRetainStatus {
		return {
			retainedTurns: this.#retainedTurns,
			inFlight: this.#inFlight !== undefined,
			pendingBatches: this.#pending.length,
			...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
		};
	}
}
