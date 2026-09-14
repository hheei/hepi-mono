# pi-mctx AgentMemory 与 Context Projection 迁移规格

## 1. 用户目标

让 `@hheei/pi-mctx` 在保持 Pi host、Node、pnpm 和现有 Window 行为不变的前提下，逐步达到 `omp-mctx` 当前 AgentMemory 集成能力：

- AgentMemory 是可选的外部 HTTP durable-memory 服务；
- Window 在 AgentMemory 关闭、不可达或失败时继续工作；
- `memory_search` 同时提供当前 session lane 与跨 session durable lane；
- `memory_save` 通过本地 transactional outbox 可靠投递；
- 自动 recall 以可审计、cache-stable 的 Context Projection 进入 provider context；
- `/ctx-status` 能显示 Window、AgentMemory、recall、outbox 和后台任务的真实状态。

本迁移不是把 OMP 目录整体复制到 Pi 包。`omp-mctx` 的 host、handoff、OMP 类型和 manifest 不属于本包；只迁移与上述用户目标直接相关的领域逻辑，并接入现有 Pi adapter。

## 2. 当前边界

```text
Pi host
  -> pi-mctx adapter: hooks / commands / tools / TUI / session lifecycle
  -> Window core: context transform / compaction / local session storage
  -> AgentMemory bridge: HTTP client / capture / search / save / status
  -> Context Projection: recall ledger / epochs / admission / replay
  -> external AgentMemory service
```

### 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| Pi host | session、provider conversion、native compaction、UI 生命周期 | AgentMemory schema 与 ranking |
| `pi-mctx` Window | 本地 context window、compartment、tag、LKG、projection、recall admission | 远程 durable-memory 数据库 |
| AgentMemory 服务 | 跨 session facts、ranking、graph、consolidation、REST | Pi Window、projection、TUI |
| `pi-ext-core` | 通用 surface、widget、cleanup、lifecycle primitives | AgentMemory-specific state、recall policy |

### 关键原则

1. `agentmemory.enabled` 独立于 `compactionEnabled` 和 Window `enabled`，默认关闭。
2. 外部请求、capture、recall、outbox 失败不得静默破坏或阻断 Window。
3. 不在本地复制 AgentMemory backend schema，也不 dual-write 旧本地 memory 表与远端。
4. 不直接引入 OMP 的 `src/host`、`@oh-my-pi/omptype`、handoff 或 OMP-specific shim。
5. 所有新持久化表必须 additive、可重入、可识别版本；已有 legacy rows 不删除、不伪造迁移结果。
6. recall 内容不得写入 session JSONL，不得伪装成 tool call；provider-visible recall 必须属于 projection。
7. 所有异步 continuation 必须绑定 session、branch、generation、AbortSignal 和清理生命周期。
8. AgentMemory project identity 默认按 `environment -> git root -> cwd` 推导；不再新增全局显式 project namespace 设置。

## 3. 目标运行流

### 3.1 Capture 与工具流

```text
session_start
  -> 建立/复用一个 AgentMemory session binding
turn/tool/assistant events
  -> redact + exclude memory tools
  -> fire-and-forget observe
memory_save
  -> validate -> local outbox -> lease/retry/dedupe -> AgentMemory remember
session_shutdown
  -> best-effort end every unended remote session
```

Capture 是旁路能力：HTTP 失败只记录 observed failure，不影响 provider turn。

### 3.2 Automatic recall 与 projection

```text
provider context transform
  -> rebuild local Window / LKG
  -> declare current projection epoch
  -> identify substantive user entry
  -> reuse same anchor+epoch recall, or search AgentMemory
  -> Scope Gate + stale generation filter
  -> admit one Recall Event
  -> splice after user entry, before assistant reply
  -> present TUI widget when interactive
  -> publish projection atomically
```

发布分类只有：

- `unchanged`：body 与 contract 均未变；
- `append`：旧 body 是新 body 的 byte prefix，保留 cache；
- `transition`：compaction、branch、model/system/tool contract、privacy withdrawal 或前缀改写，建立新 epoch；
- `lkg`：本次 transform 失败时仅回放未撤销的 last-known-good。

## 4. 最小公共契约

### 配置

保留并扩展现有 `agentmemory` 配置：

- `enabled`
- `url`
- `secret`
- `agentId`
- `capture`
- `inject`
- `historianRetrieval`
- `memoryTools`
- `requireHttps`

删除/停止使用 `agentmemory.project` 与 `agentmemoryProject` 设置；保留 `AGENTMEMORY_PROJECT_NAME` 作为显式环境覆盖；其余由运行时自动解析。

### AgentMemory bridge

Bridge 至少提供：

- `health`
- `session/start`
- `session/end`
- `observe`
- `search`
- `remember`

client 必须区分 invalid URL、insecure transport、HTTP、network、timeout、cancelled、invalid response；响应必须运行时校验。

### Model-visible tools

首阶段只承诺：

- `memory_search`：当前 session 与 durable memory 两个 lane，分组展示，不合并不可比 score；
- `memory_save`：返回 queued/delivered/failed 的真实状态，不提前宣称远端已持久化。

不加入 `memory_health` model tool；健康检查保留为显式 `/agentmemory-health` 命令和 status snapshot。

### 持久化

Projection/recall 需要以下表族，初始化必须使用 additive DDL：

- `agentmemory_outbox`
- `agentmemory_turn_taint`
- `mctx_projection_epochs`
- `mctx_projection_epoch_reachability`
- `mctx_projection_heads`
- `mctx_branch_lineage`
- `mctx_recall_events`
- `mctx_recall_sources`
- `mctx_recall_dependencies`
- `mctx_recall_presentation_receipts`
- `mctx_recall_recovery_refs`
- `mctx_context_projection_states`
- `mctx_context_projection_heads`

## 5. 失败、取消与并发语义

| 情况 | Window | Recall/bridge | Projection |
| --- | --- | --- | --- |
| AgentMemory down | 继续 | 不产生新 recall；工具返回显式 partial/error | 不变 |
| capture 失败 | 继续 | 记录失败，不能阻断 turn | 不变 |
| admission 抛错 | 继续 | 记录失败 | 仍尝试发布本次 Window |
| transform 抛错 | 回放 LKG | 不发布新事件 | 不创建新 head |
| privacy withdrawal | 继续 | 可 GC 不可达事件 | 撤销 head，不得回放 withdrawn LKG |
| 新 generation/session/branch | 继续 | 旧请求标记 stale 并丢弃 | 只能提交当前 generation |
| SQLite open contention | fail closed 或重试 | 不建立半初始化 runtime | 不使用内存伪 DB |

## 6. 不在本规格范围

- 搬迁 OMP host adapter、`@oh-my-pi/omptype` 或 `src/host`。
- 搬迁 OMP handoff 实现。
- 把 AgentMemory backend、ranking 或 consolidation 嵌入 `pi-mctx`。
- 保留一个兼容旧 `ctx_*` durable-memory API 的 shim。
- 重新设计现有 Pi native compaction、Historian、Dreamer、embedding provider。
- 把 recall 写入普通 session transcript。

## 7. 完成定义

迁移完成必须满足：

1. bridge 关闭时 Window、现有 `mctx_*` 工具和 native compaction 行为不回归；
2. bridge 开启时 capture、search、save、recall、projection、status 形成可运行闭环；
3. 所有新网络/SQLite/异步路径有 focused tests，覆盖失败、取消、重试、重复 transform、branch/epoch 变化和 head withdrawal；
4. 通过受影响路径的 Biome、typecheck 和 focused Vitest；
5. package README、`docs/architecture/pi-mctx.md`、ADR 0020 与实际配置/运行行为一致；
6. 不存在 OMP-only import、静默 model/provider 路由或隐式启用 AgentMemory。

## 8. 实施顺序

```text
MCTX-01 基线与配置收敛
        |
MCTX-02 client/session/security
        |
MCTX-03 capture + taint + historian provenance
        |
MCTX-04 search + save + outbox
        |
MCTX-05 status + schema + runtime integration
        |
MCTX-06 recall ledger + admission
        |
MCTX-07 context projection + Pi transform
        |
MCTX-08 TUI presentation + end-to-end hardening
```

MCTX-06 与 MCTX-07 是唯一允许改变 provider-visible context contract 的阶段；在此之前，AgentMemory 只以 tool-first 方式工作。
