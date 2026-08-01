# Embedding Capability Proposal

## 目的

Embedding 是可选 semantic retrieval capability，供 `pi-mctx` 的 composite search、Dreamer 与后续已确认 consumer
复用。它不改变 historian/context transform，也不能使 MCTX activation 因 provider unavailable 而失败。没有 provider
时，consumer 必须走自己的 lexical/no-semantic fallback；不得等待 model load。

`pi-mctx` 不拥有 provider、credential、model process pool 或通用 vector API。`@hheei/pi-ext-embed` 是独立的
publishable runtime package，而非 Pi extension：它不注册 lifecycle、handler、tool、command、UI 或 scheduler。
它公开 `acquireEmbeddingProvider(config)` 与 releaseable lease，拥有 provider policy、process-local pool、model cache
lock 和 in-flight drain，且不导入 concrete consumer。Pi consumer 自己在 lifecycle 中 acquire/release。未安装或未
acquire 时，不应加载 Transformers/native runtime、创建模型缓存或启动资源。

这是继 `pi-ext-core` 后的受限 foundation-package exception：它只提供 embedding runtime，不能成为 generic extension
framework、vector store、scheduler 或 Pi adapter。

## Public Contract

下列 interface 由 `@hheei/pi-ext-embed` export。它是普通 package API，不是 Pi runtime service；provider runtime
不进入 `pi-ext-core`，第二 consumer 出现前不得扩大接口：

```ts
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
  embed(text: string, purpose: EmbeddingPurpose, signal: AbortSignal): Promise<Float32Array | undefined>;
  embedBatch(
    items: ReadonlyArray<{ readonly id: string; readonly text: string; readonly contentHash: string }>,
    purpose: EmbeddingPurpose,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, Float32Array> | undefined>;
}

export interface EmbeddingProviderLease {
  readonly provider: EmbeddingProvider;
  release(): Promise<void>;
}

export function acquireEmbeddingProvider(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingProviderLease | undefined>;
```

`undefined` means disabled/unavailable/stale provider; it is not a thrown provider error. Invalid input, duplicate item IDs, or an
invalid configuration are caller/programmer errors and reject before provider I/O. `Float32Array` ownership transfers to caller;
callers must not mutate it. The package never exposes raw model clients or provider internals. Each consumer documents its own
provider lifetime, cancellation and fallback behavior.

## Provider And Process Ownership

Supported provider shapes follow fixed Magic Context evidence:

- `local`: default provider. It uses `@huggingface/transformers` feature-extraction with mean pooling and normalization,
  in a process-local model runtime pooled by normalized provider/model fingerprint and reference-counted. Its shared model-cache
  directory uses a cross-process file lock plus heartbeat only to serialize downloads/load initialization; it does not claim to
  share an in-memory pipeline between Pi processes.
- `openai-compatible`: HTTP provider; credentials live in user-level configuration, never project configuration or SQLite.
- `synapse`: external local/shared service; a process shares one client per connection identity, while distinct Pi processes connect
  independently to the same service.
- `off`: no service and no background work.

Provider selection is user-level and defaults to `local`. `synapse` and `openai-compatible` are explicit opt-in; no `auto`
selection is part of the first implementation, so project content never silently leaves the local process. `synapse` is the
fixed-baseline route for an externally shared model runtime when an installation later needs cross-process inference sharing.
A provider registration owns a monotonic generation and normalized model identity. Configuration reload retires its pool reference
only after current calls settle or abort; late result from an old generation is discarded.

## Cross-Process Safety

`globalThis` pooling is process-local only. Persistent embedding rows must include project identity, item identity, content hash,
model identity and generation-compatible provider fingerprint. Writers re-read the row inside one SQLite transaction and write only
when the source content hash and active model identity still match. A provider call completing after content/config changes is dropped.

Backfill is project-scoped and uses a SQLite lease with renewal. Remote batch providers receive deterministic idempotency keys derived
from model identity, provider fingerprint, item IDs and content hashes; a persisted batch ledger records complete/partial/failed
outcomes. Local provider work may duplicate across processes after a lease failure, but stale-vector publication remains impossible.

Stale model rows remain readable only to their matching identity and are garbage-collected under a bounded grace/batch policy. Retention
must be configured before any automatic cleanup is enabled.

## First Implementation Gate

Provider implementation needs credential/config schemas and focused tests for cancellation, pool ref-count cleanup,
config-generation discard, two-process SQLite write race, provider-off fallback and remote idempotency ledger. `/ctx-embed`,
automatic backfill, vector-store schema, semantic `ctx_search`, and Dreamer evaluation are later slices, not part of registering
the capability.
