import { createServiceKey } from "./service.js";

/** Runtime scope supplied by a memory owner before MCTX searches its active records. */
export interface MemorySearchExclusionInput {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly signal: AbortSignal;
}

/**
 * Optional runtime capability for hiding memory records already visible elsewhere.
 * No provider means MCTX searches every active memory; a provider must return only
 * positive safe-integer memory IDs for the requested session scope.
 */
export interface MemorySearchExclusionService {
	excludeMemoryIds(
		input: MemorySearchExclusionInput,
	): readonly number[] | Promise<readonly number[]>;
}

export const MCTX_MEMORY_EXCLUSION_SERVICE = createServiceKey<MemorySearchExclusionService>(
	"@hheei/pi-ext-core/memory-search-exclusion@1",
);
