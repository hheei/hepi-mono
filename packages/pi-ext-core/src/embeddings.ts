import { createServiceKey } from "./service.js";

/** The input role lets providers select model-specific query/passage behavior. */
export type EmbeddingPurpose = "query" | "passage";

export type EmbeddingProviderKind = "local" | "openai-compatible" | "synapse";

/** Immutable identity of the provider generation that produced a vector. */
export interface EmbeddingSnapshot {
	readonly provider: EmbeddingProviderKind;
	readonly modelIdentity: string;
	readonly generation: number;
	readonly dimensions?: number;
	readonly maxInputTokens?: number;
}

/** One caller-owned item in a batch. `contentHash` fences later persistence writes. */
export interface EmbeddingBatchItem {
	readonly id: string;
	readonly text: string;
	readonly contentHash: string;
}

/**
 * Runtime-scoped optional embedding capability. The provider owns model/client
 * lifetime; callers own cancellation and must treat an undefined result as an
 * unavailable or stale provider fallback. Returned vectors belong to callers
 * and must not be mutated after persistence or sharing.
 */
export interface EmbeddingService {
	snapshot(): EmbeddingSnapshot | undefined;
	embed(
		text: string,
		purpose: EmbeddingPurpose,
		signal: AbortSignal,
	): Promise<Float32Array | undefined>;
	embedBatch(
		items: ReadonlyArray<EmbeddingBatchItem>,
		purpose: EmbeddingPurpose,
		signal: AbortSignal,
	): Promise<ReadonlyMap<string, Float32Array> | undefined>;
}

/**
 * Explicit single-consumer exception: pi-ext-embed provides this stable
 * capability before MCTX Search and Dreamer are both implemented. Service
 * absence must remain a non-blocking semantic-retrieval fallback.
 */
export const embeddingService = createServiceKey<EmbeddingService>("@hheei/pi-ext-embed/service");
