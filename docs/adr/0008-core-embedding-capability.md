# Core Embedding Capability

`EmbeddingService` 是经用户明确授权的 single-consumer exception。`pi-ext-embed` 需要先发布一个
runtime-scoped、provider-neutral embedding capability，才能让 MCTX semantic search 与 Dreamer 后续使用同一
model identity、generation 和 cancellation contract。

core 只导出 stable ServiceKey、input/output types。它不加载 model、保存 credential/vector、管理 provider pool、
执行 batch/backfill，也不决定 lexical fallback。provider lifecycle 属于 `pi-ext-embed`；consumer 在 service
absent 或返回 `undefined` 时继续自身的 no-semantic path。跨进程 sharing 由 provider implementation 与
consumer-owned SQLite content/model fences 处理，不在 core global state 中伪造。

这是 bounded exception，不授权 generic ML/model registry、vector store、scheduler 或 provider configuration。
后续第二 consumer 出现后，只可凭实际重复需求扩展此 contract。
