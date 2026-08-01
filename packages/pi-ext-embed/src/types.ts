export type EmbeddingPurpose = "query" | "passage";

export interface EmbeddingSnapshot {
	readonly provider: "local" | "openai-compatible" | "synapse" | "off";
	readonly modelIdentity: string;
	readonly generation: number;
	readonly dimensions?: number;
	readonly maxInputTokens?: number;
}

export interface EmbeddingProvider {
	snapshot(): EmbeddingSnapshot | undefined;
	embed(
		text: string,
		purpose: EmbeddingPurpose,
		signal: AbortSignal,
	): Promise<Float32Array | undefined>;
	embedBatch(
		items: ReadonlyArray<{
			readonly id: string;
			readonly text: string;
			readonly contentHash: string;
		}>,
		purpose: EmbeddingPurpose,
		signal: AbortSignal,
	): Promise<ReadonlyMap<string, Float32Array> | undefined>;
}

export interface EmbeddingProviderLease {
	readonly provider: EmbeddingProvider;
	release(): Promise<void>;
}

export interface LocalEmbeddingProviderConfig {
	readonly provider?: "local";
	readonly model?: string;
	/** Host-owned shared model cache. The runtime serializes load/download setup with a file lock. */
	readonly cacheDir?: string;
}

export interface OffEmbeddingProviderConfig {
	readonly provider: "off";
}

export interface SynapseEmbeddingProviderConfig {
	readonly provider: "synapse";
	readonly connectionFile: string;
	readonly model: string;
	readonly projectRoot: string;
	readonly session: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** Rejected until credential and network policy are deliberately specified. */
export interface OpenAICompatibleEmbeddingProviderConfig {
	readonly provider: "openai-compatible";
	readonly [key: string]: unknown;
}

export type EmbeddingProviderConfig =
	| LocalEmbeddingProviderConfig
	| OffEmbeddingProviderConfig
	| SynapseEmbeddingProviderConfig
	| OpenAICompatibleEmbeddingProviderConfig;
