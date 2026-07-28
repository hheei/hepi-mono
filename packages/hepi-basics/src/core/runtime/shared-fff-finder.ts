type SharedFffFinderEntry = {
	readonly finder: unknown;
	readonly destroy: (finder: unknown) => void;
	leases: number;
};

declare global {
	var __hepiSharedFffFinders: Map<string, SharedFffFinderEntry> | undefined;
}

export type SharedFffFinderLease<T> = {
	readonly finder: T;
	release(): void;
};

function sharedFffFinders(): Map<string, SharedFffFinderEntry> {
	let finders = globalThis.__hepiSharedFffFinders;
	if (finders === undefined) {
		finders = new Map();
		globalThis.__hepiSharedFffFinders = finders;
	}
	return finders;
}

export function acquireSharedFffFinder<T>(
	key: string,
	create: () => T,
	destroy: (finder: T) => void,
): SharedFffFinderLease<T> {
	const finders = sharedFffFinders();
	let entry = finders.get(key);
	if (entry === undefined) {
		const finder = create();
		entry = { finder, destroy: (value) => destroy(value as T), leases: 0 };
		finders.set(key, entry);
	}

	entry.leases += 1;
	let released = false;
	return {
		finder: entry.finder as T,
		release: (): void => {
			if (released) return;
			released = true;
			entry.leases -= 1;
			if (entry.leases > 0) return;
			finders.delete(key);
			entry.destroy(entry.finder);
		},
	};
}
