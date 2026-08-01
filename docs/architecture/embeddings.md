# Embedding Capability Proposal

## 目的

Embedding 是可选 semantic retrieval capability，供 `pi-mctx` 的 composite search、Dreamer 与后续已确认 consumer
复用。它不改变 historian/context transform，也不能使 MCTX activation 因 provider unavailable 而失败。没有 service
时，consumer 必须走自己的 lexical/no-semantic fallback；不得等待 provider load。

`pi-mctx` 不拥有 provider、credential、model process pool 或通用 vector API。`@hheei/pi-embeddings` 是独立的
publishable runtime package，而非 Pi extension：它不注册 lifecycle、handler、tool、command、UI 或 scheduler。
它公开 `acquireEmbeddingProvider(config)` 与 releaseable lease，拥有 provider policy、process-local pool、model cache
lock 和 in-flight drain，且不导入 concrete consumer。Pi consumer 自己在 lifecycle 中 acquire/release，并将取得的
provider 注册到 core ServiceKey。未安装或未 acquire 时，不应加载 Transformers/native runtime、创建模型缓存或启动资源。

这是继 `pi-ext-core` 后的受限 foundation-package exception：它只提供 embedding runtime，不能成为 generic extension
framework、vector store、scheduler 或 Pi adapter。

## Public Contract

用户已明确授权此 bounded single-consumer exception；下列 interface 由 `pi-ext-core` export。provider runtime
仍不进入 core，第二 consumer 出现前不得扩大接口：

```ts
export type EmbeddingPurpose = "query" | "passage";

export interface EmbeddingSnapshot {
  readonly provider: "local" | "openai-compatible" | "synapse" | "off";
  readonly modelIdentity: string;
  readonly generation: number;
  readonly dimensions?: number;
  readonly maxInputTokens?: number;
}

export interface EmbeddingService {
  snapshot(): EmbeddingSnapshot | undefined;
  embed(text: string, purpose: EmbeddingPurpose, signal: AbortSignal): Promise<Float32Array | undefined>;
  embedBatch(
    items: ReadonlyArray<{ readonly id: string; readonly text: string; readonly contentHash: string }>,
    purpose: EmbeddingPurpose,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, Float32Array> | undefined>;
}
```

`undefined` means disabled/unavailable/stale registration; it is not a thrown provider error. Invalid input, duplicate item IDs,
or an invalid capability registration are caller/programmer errors and reject before provider I/O. `Float32Array` ownership transfers
to caller; callers must not mutate it. Service never exposes API keys, raw response envelopes, connection paths or provider clients.

The runtime-scoped `ServiceKey<EmbeddingService>` is an explicit bounded exception recorded in
[`ADR 0008`](../adr/0008-core-embedding-capability.md). Its absence fallback, cancellation, provider cleanup and concurrency
semantics must be documented beside each consumer. Provider implementation remains private to `pi-embeddings`; no extension may
deep-import it.

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
