export type Cleanup = () => void | Promise<void>;

export interface CleanupFailure {
	readonly id: string;
	readonly error: unknown;
}

/** Session-scoped cleanup owner. Registered cleanup runs in reverse order. */
export interface DisposerRegistry {
	add(id: string, cleanup: Cleanup): void;
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
