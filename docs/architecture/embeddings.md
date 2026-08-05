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
  config: unknown,
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

## MCTX Adapter

`pi-mctx` 是第一个 consumer。它仅在 user-level `pi-mctx.embedding` 是 object 时动态 import
`@hheei/pi-ext-embed`，调用 `acquireEmbeddingProvider()`，并把 lease 绑定到 parent MCTX lifecycle。字段缺省时不
import package、不 acquire provider；这使现有 MCTX-only startup 保持 Transformers-free。project settings 中的
`embedding` 一律忽略，因为它可能选择本地 cache 或外部 Synapse connection。

Package owns provider configuration's detailed runtime validation. Import/acquire failure is an optional-capability warning and
leaves the Context pipeline active with no semantic capability. Lifecycle shutdown/reload aborts outstanding embedding jobs,
awaits `lease.release()` before MCTX store cleanup. Provider availability 永不参与 `fail_closed_blocking` 决策。

## Durable Memory Ledger

The first actual MCTX embedding consumer is an explicit `ctx_memory` write or update. When its active parent runtime has a provider,
MCTX starts one detached, abortable passage embedding for that changed memory. This is not a historical backfill: it never scans
existing memories, retries a provider failure, creates a timer, or holds a project lease. A missing/failed provider leaves the
memory write successful and simply produces no vector. The embed job 与 memory write 结果解耦：`ctx_memory` tool 保持同步
返回，embedding 在后台完成。

The SQLite v8 ledger keeps active memory source content hash plus per-model vector rows. A vector write transaction rereads the
memory's active status and content hash; stale write/update/archive results are discarded. Archive immediately deletes that
memory's vectors, so an archived source cannot remain an active retrieval candidate. Rows include model identity, provider
generation, vector dimensions and a Float32 BLOB. Multiple model identities coexist; no automatic retention/GC is introduced.
Feature cleanup aborts outstanding explicit-memory jobs before releasing the provider lease and closing the store.

写路径完整 fence：embedding 开始时记录 provider snapshot（`modelIdentity`/`generation`）与内容 hash、memory revision；
完成时 provider snapshot 已切换则丢弃；store 写 ledger 的单事务内重读 memory 的 active status、content hash 与 revision，
任一不匹配则丢弃。同一 model/generation 的重写是幂等 upsert；不同 model identity 的行共存。

当前不做：historical backfill、timer、retry、`/ctx-embed` command、semantic `ctx_search` rerank、vector 读取方法
（retrieval consumer 出现前不暴露查询 API）。

## 当前实现

`@hheei/pi-ext-embed` 是纯运行时包，唯一公开入口为 `src/index.ts`。它不含 Pi extension entry，也不注册工具、命令、
lifecycle、scheduler 或任何持久化向量能力。

- `acquireEmbeddingProvider(config)` 默认请求本地 provider；`off`、运行时未安装或不可用时返回 `undefined`。
- 本地 provider 只在首次实际 acquire 时动态导入 Transformers，按标准化 provider/model 配置在单一进程内复用 pipeline。
  模型缓存锁只协调不同进程的下载和加载初始化，绝不表示跨进程共享内存模型。
- `synapse` 必须显式提供连接文件、项目根目录和 session。client 只按本进程内的连接标识复用；远端失败或调用取消返回
  `undefined`，不会泄漏 client 或凭据。
- 首版拒绝 `openai-compatible` 配置，避免在未定义的凭据、网络和数据外发策略下隐式启用远端服务。

调用方拥有 `AbortSignal` 与 lease 生命周期。release 后包会等待当前调用结束再释放本进程资源；输入、配置、batch ID 和
内容 hash 的不变量在任何 provider I/O 前校验。

`pi-mctx` 已实现 MCTX Adapter 与 Durable Memory Ledger consumer：activation 时 acquire lease，`ctx_memory`
write/update 后启动 detached embedding 并写入 per-model ledger，archive 删除 vector，cleanup 先 abort 再 release 再关
store。语义检索、backfill 与 `/ctx-embed` command 仍未实现，不得宣称 semantic search 已迁移。
