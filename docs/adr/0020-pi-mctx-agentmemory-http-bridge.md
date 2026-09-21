# pi-mctx 使用 Hindsight durable-memory backend

`@hheei/pi-mctx` 的 durable memory owner 是 Hindsight。pi-mctx 只拥有 Pi lifecycle、兼容端口、
本地 outbox、recall admission 和 Context Projection；不实现或复制 durable-memory backend。

## 决策

- 使用官方 `@vectorize-io/hindsight-client`，通过 Hindsight API 的 `retain`、`recall` 和 `/version` 操作。
- 删除旧的 `/agentmemory/*` HTTP 协议依赖：不再调用 `session/start`、`session/end`、`observe`、`search`、`remember`。
- capture 与 `mctx_memory` 映射到 Hindsight `retain`；自动检索映射到 `recall`；显式综合回答才使用 `reflect`。
- project identity 映射为 Hindsight bank id。Pi session、branch、turn 和 projection identity 保留在本地 ledger，必要的 session metadata 通过 Hindsight tags/metadata 传递。
- `agentmemory*` 设置键在本次 clean cutover 中暂时作为已有用户配置的兼容命名，但其 backend 语义已经是 Hindsight；新文档不得描述旧 AgentMemory 服务或旧 endpoint。
- Agent-facing 工具名固定为 `mctx_search` / `mctx_memory`，不增加旧 `memory_*` alias，也不 dual-write native memory 与 Hindsight。
- `mctx_memory` 仍先写 Pi-owned SQLite transactional outbox，再由 bounded retry worker 调用 Hindsight `retain`；工具只有在实际 retain 成功后才报告 delivered。
- `/ctx-status` 只读取本地 observed state，不探测网络；现有 `/agentmemory-health` 命令名保留以避免用户操作断裂，但实际执行 Hindsight `/version` probe。
- Hindsight 不可达、返回错误或取消时，Window、native compaction、LKG 和 local session lane 继续工作；provider-visible recall 只能由 admission/projection 合同发布。

## 不做

- 不在 `pi-mctx` 内嵌 Hindsight server、PostgreSQL、fact extraction、ranking 或 consolidation。
- 不保留旧 AgentMemory endpoint 作为第二 backend 或 fallback。
- 不把 Hindsight `reflect` 隐式加入 historian 或每轮 provider context transform。
- 不把 recall 内容写入 Pi JSONL 或伪装成 tool call。
- 不在 `pi-ext-core` 增加 Hindsight-specific capability。

## 验收

1. 仓库源码不存在对 `/agentmemory/*` endpoint 的运行时请求。
2. Hindsight client 的 retain、recall、health/version、timeout、取消和错误响应有 focused tests。
3. outbox 重试与 dedupe 不会破坏 Hindsight retain 语义；recall admission 在 branch/reload/replay 下幂等。
4. bridge/backend 关闭或不可达时，Window 和 local session lane 仍可用。
5. package README、architecture、spec 和本 ADR 一致，并链接 Hindsight 官方 API 文档：
   - [TypeScript client](https://hindsight.vectorize.io/sdks/nodejs)
   - [Retain](https://hindsight.vectorize.io/developer/api/retain)
   - [Recall](https://hindsight.vectorize.io/developer/api/recall)
   - [Installation](https://hindsight.vectorize.io/developer/installation)
