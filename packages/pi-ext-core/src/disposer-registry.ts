/** A cleanup callback owned by one lifecycle scope. It may be asynchronous. */
export type Cleanup = () => void | Promise<void>;

/** One cleanup failure retained so teardown can attempt every registered resource. */
export interface CleanupFailure {
	readonly id: string;
	readonly error: unknown;
}

/** Session-scoped cleanup owner. Registered cleanup runs in reverse order. */
export interface DisposerRegistry {
	/** Adds a unique resource owner; registration after cleanup is a programming error. */
	add(id: string, cleanup: Cleanup): void;
	/** Runs all callbacks once in reverse registration order and returns every failure. */
	cleanup(): Promise<readonly CleanupFailure[]>;
}

/** Creates the cleanup owner used by one lifecycle context. */
export function createDisposerRegistry(): DisposerRegistry {
	const entries = new Map<string, Cleanup>();
	let cleaned = false;

	return {
		add(id: string, cleanup: Cleanup): void {
			if (cleaned) throw new Error("Cannot register cleanup after lifecycle shutdown");
			if (!id.trim()) throw new Error("Cleanup id must not be empty");
			if (entries.has(id)) throw new Error(`Cleanup id already registered: ${id}`);
			entries.set(id, cleanup);
		},
		async cleanup(): Promise<readonly CleanupFailure[]> {
			if (cleaned) return [];
			cleaned = true;
			const failures: CleanupFailure[] = [];
			const reverseEntries = [...entries.entries()].reverse();
			entries.clear();
			// Teardown is best effort: one failed resource must not prevent later
			// resources from closing, and the caller receives the complete failure list.
			for (const [id, cleanup] of reverseEntries) {
				try {
					await cleanup();
				} catch (error) {
					failures.push({ id, error });
				}
			}
			return failures;
		},
	};
}
