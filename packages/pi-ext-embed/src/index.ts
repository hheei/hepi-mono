export type {
	EmbeddingProvider,
	EmbeddingProviderConfig,
	EmbeddingProviderLease,
	EmbeddingPurpose,
	EmbeddingSnapshot,
	LocalEmbeddingProviderConfig,
	OffEmbeddingProviderConfig,
	OpenAICompatibleEmbeddingProviderConfig,
	SynapseEmbeddingProviderConfig,
} from "./types.js";

import { EmbeddingRuntime } from "./runtime.js";

const runtime = new EmbeddingRuntime();

/** Acquires a process-local provider lease. Unavailable or disabled providers resolve to undefined. */
export function acquireEmbeddingProvider(
	config: unknown,
): Promise<EmbeddingProviderLease | undefined> {
	return runtime.acquire(config);
}
