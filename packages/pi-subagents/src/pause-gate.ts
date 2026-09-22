/**
 * Child-side hold used by `turn_end`. Parent pause events arm the gate;
 * `cancel_pause` or process abort releases it. Returning from `turn_end`
 * is what lets Pi start the next provider request, so the hook must await
 * this while a matching generation is holding.
 */
export class PauseGate {
	#generation = 0;
	#holding = false;
	readonly #waiters = new Set<(error?: Error) => void>();

	public get generation(): number {
		return this.#generation;
	}

	public get holding(): boolean {
		return this.#holding;
	}

	public request(generation: number): void {
		if (!Number.isInteger(generation) || generation < this.#generation) return;
		this.#generation = generation;
		this.#holding = true;
	}

	public cancel(generation?: number): void {
		if (generation !== undefined && generation < this.#generation) return;
		if (generation !== undefined) this.#generation = generation;
		this.#holding = false;
		this.#release();
	}

	public wait(signal?: AbortSignal): Promise<void> {
		if (!this.#holding) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const finish = (error?: Error): void => {
				this.#waiters.delete(onRelease);
				signal?.removeEventListener("abort", onAbort);
				if (error !== undefined) reject(error);
				else resolve();
			};
			const onRelease = (error?: Error): void => {
				finish(error);
			};
			const onAbort = (): void => {
				this.#holding = false;
				this.#release();
			};
			this.#waiters.add(onRelease);
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	#release(error?: Error): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const waiter of waiters) waiter(error);
	}
}
