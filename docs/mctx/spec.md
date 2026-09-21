# pi-mctx Hindsight durable-memory backend 迁移规格

## 1. 用户目标

移除仓库自有的 AgentMemory backend 与 `/agentmemory/*` 协议，改用官方 Hindsight HTTP API
作为 `@hheei/pi-mctx` 的 durable-memory backend，同时保持 Pi host、Window、Context Projection
以及 `mctx_search` / `mctx_memory` 合同稳定。

Hindsight 是唯一的外部 durable-memory owner；pi-mctx 不复制 Hindsight 的 schema、fact extraction、
ranking 或 consolidation。Pi 继续拥有本地 outbox、recall admission、projection epoch、LKG 和 TUI。

## 2. 数据流与所有权

```text
Pi host
  -> pi-mctx adapter: hooks / commands / tools / TUI / session lifecycle
  -> Window core: context transform / compaction / local session storage
  -> Hindsight port: retain / recall / /version
  -> Hindsight: bank / extraction / ranking / consolidation
  -> Context Projection: admission / replay / provider-visible splice
```

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| Pi host | session、provider conversion、native compaction、UI 生命周期 | Hindsight schema 与 ranking |
| `pi-mctx` | Window、projection、outbox、recall ledger、Pi lifecycle | durable-memory database |
| Hindsight | bank、retain、recall、reflect、fact extraction、graph、consolidation | Pi Window、projection、TUI |
| `pi-ext-core` | 通用 surface、widget、cleanup、lifecycle primitives | Hindsight-specific state |

## 3. Backend 合同

- capture 与显式 `mctx_memory` → Hindsight `retain`。
- automatic search 与 Context Projection recall → Hindsight `recall`。
- explicit synthesis → Hindsight `reflect`；不进入 historian 或每轮 provider transform。
- health → Hindsight `/version`。
- project identity → Hindsight bank id。
- Pi session/turn/branch/projection identity → Pi-owned ledger；必要的 metadata/tags 传给 Hindsight。
- 旧远程 `session/start`、`session/end`、`observe`、`search`、`remember` 不再存在。
- `agentmemory*` 设置键仅暂时保留为已有用户配置的兼容命名，底层语义全部是 Hindsight。

`mctx_memory` 先写 Pi-owned SQLite transactional outbox，再由有界 retry worker 调用 Hindsight retain；
未得到 Hindsight 成功响应前不得报告 delivered。重复 retain 必须使用稳定的 document/operation identity，
避免重试制造重复 durable memory。

## 4. Projection 与失败语义

Recall 结果必须经过 session、branch、generation、epoch、scope、taint 和 already-visible 检查；
通过 admission 后才可作为 provider-visible projection。recall 不写 Pi JSONL，也不伪装成 tool call。

Hindsight down、timeout、invalid response 或 cancellation：

- Window、native compaction、LKG 和 local session lane 继续工作；
- remote lane 报告 degraded/partial；
- 不提交空 recall event，不发布半成品 projection；
- `/ctx-status` 只读本地 observed state，不探测网络；
- `/agentmemory-health` 命令名保留，但只执行显式 Hindsight `/version` probe。

## 5. 不在范围内

- 不嵌入 Hindsight server、PostgreSQL 或本地 Hindsight database。
- 不保留旧 AgentMemory HTTP backend 作为 fallback 或 dual-write 路径。
- 不把 Hindsight `reflect` 隐式加入 historian。
- 不把 Hindsight-specific capability 放入 `pi-ext-core`。

## 6. 完成定义

1. runtime 不请求任何 `/agentmemory/*` endpoint。
2. 官方 Hindsight TypeScript client 已接入 retain、recall、version，并有 focused tests。
3. outbox retry/dedupe、recall admission、branch/reload/replay 行为有 focused coverage。
4. backend 关闭或不可达时 Window 和 local lane 不回归。
5. README、architecture、ADR、tickets 与实际配置和运行行为一致。

官方来源：

- [Hindsight TypeScript client](https://hindsight.vectorize.io/sdks/nodejs)
- [Retain](https://hindsight.vectorize.io/developer/api/retain)
- [Recall](https://hindsight.vectorize.io/developer/api/recall)
- [Installation](https://hindsight.vectorize.io/developer/installation)
