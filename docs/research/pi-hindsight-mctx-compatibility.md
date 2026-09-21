# @luxusai/pi-hindsight 与 Magic Context 严格兼容性审查

> 审查对象：`@luxusai/pi-hindsight` 0.13.0（Pi package 页面显示于 2026-09-16 发布）
>
> 上游：<https://github.com/luxus/pi-hindsight>
>
> 审查日期：2026-09-21
>
> 结论性质：研究报告，不代表已经批准 fork 或迁移。

## 1. 明确结论

**Verdict：部分吻合，但目前不能与当前 `pi-mctx` / Magic Context 直接并装使用；需要先 fork 并重构 integration boundary。**

它与 Magic Context 的 durable-memory 方向高度吻合：

- 使用官方 `@vectorize-io/hindsight-client`；
- 自动 recall 通过 Pi `context` hook 注入，而且注入内容不写入 Pi transcript；
- 自动 retain 通过 `agent_end` hook，使用本地持久队列；
- 有 append/retry/dedupe、取消、secret redaction、project/user bank、read-only/ignored/next-opt-out 等成熟机制；
- Hindsight 的 extraction/ranking/observation/consolidation 仍由 Hindsight 拥有。

但它**不是当前 Magic Context 的 drop-in backend**，原因不是 API 小差异，而是生命周期所有权冲突：

1. `pi-hindsight` 自己注册 `context` 和 `agent_end`；`pi-mctx` 也拥有完整的 context transform 与 durable-memory capture/projection。
2. 两者都会自动 recall，且两者都会自动 retain；直接并装会产生重复请求、重复注入、重复 retain 或不一致的 cursor/outbox。
3. `pi-hindsight` 的 canonical 工具名是 `hindsight_recall`、`hindsight_retain`、`hindsight_reflect`，不是目前项目希望的 `recall` / `retain`。
4. `pi-hindsight` 的 recall 是一个独立的 ephemeral user message patch；Magic Context 有自己的 m[0]/m[1]、compartment、tag、epoch、branch、taint、already-visible 和 projection ledger。两套注入协议没有共同 admission contract。
5. `pi-hindsight` 把 project/user memory policy、bank scope、session mode 放在自己的 `.pi/hindsight/*` 文件和 hub 中；当前 pi-mctx 仍有自己的 `agentmemory*` 配置、Pi session identity、outbox、projection ledger。双重配置会产生 silent divergence。
6. 当前仓库的 Pi peer 范围是 `>=0.85.1`，候选包开发依赖和测试版本为 `0.84.1`；必须实测 API/event ordering，不能仅凭版本号判断兼容。

**推荐方向：fork 它作为 `pi-hindsight` durable-memory owner，但第一步必须禁用或抽离它对 `context` / `agent_end` 的自动宿主行为，使它先提供一个可被 pi-mctx 消费的 Hindsight port；之后再决定是否由 pi-hindsight 独立拥有自动 recall/retain。**

## 2. 证据范围

本审查使用：

- Pi package 页面与 README：<https://pi.dev/packages/@luxusai/pi-hindsight?name=hindsight>
- 上游 package manifest：<https://raw.githubusercontent.com/luxus/pi-hindsight/main/package.json>
- 上游 extension entry：<https://raw.githubusercontent.com/luxus/pi-hindsight/main/extensions/index.ts>
- 上游 lifecycle：<https://raw.githubusercontent.com/luxus/pi-hindsight/main/extensions/lifecycle/memory-lifecycle.ts>
- 上游 recall policy：<https://raw.githubusercontent.com/luxus/pi-hindsight/main/extensions/lifecycle/memory-lifecycle-recall.ts>
- 上游 retain policy：<https://raw.githubusercontent.com/luxus/pi-hindsight/main/extensions/lifecycle/memory-lifecycle-retain.ts>
- 上游 operation catalog：<https://raw.githubusercontent.com/luxus/pi-hindsight/main/extensions/operations/operation-catalog.ts>
- 上游工具/契约 reference：<https://raw.githubusercontent.com/luxus/pi-hindsight/main/docs/surface-reference.md>
- 上游 memory behavior：<https://luxus.github.io/pi-hindsight/concepts/memory-behavior/>
- 上游 session modes：<https://luxus.github.io/pi-hindsight/concepts/session-memory-modes/>
- 当前仓库：`docs/mctx/spec.md`、`packages/pi-mctx/package.json`、`packages/pi-mctx/src/context-handler.ts`、`packages/pi-mctx/src/agentmemory/client.ts`、相关 `agentmemory/` 与 `tools/` 实现。

## 3. 能力逐项对照

### 3.1 Hindsight backend 与 durable-memory ownership：基本吻合

候选包只把 Hindsight client 作为依赖，Hindsight server 负责 bank、extraction、ranking、observations 和 consolidation。这与当前 Magic Context 规格中“Hindsight 是唯一外部 durable-memory owner”的方向一致。

候选 package manifest 使用 `@vectorize-io/hindsight-client` `^0.9.0`，当前 pi-mctx 使用 `^0.8.6`。fork 时必须统一 SDK contract，并针对 Hindsight server 版本做 capability matrix；不能把 SDK 类型直接泄漏到 mctx public API。

**判断：通过，但要统一 client/version boundary。**

### 3.2 自动 recall：语义吻合，管线不吻合

候选 extension entry 在 `session_start` 初始化，在 `context` hook 调用 lifecycle recall，在 recall 成功后返回 `ContextPatch`。recall policy：

- 根据最近 transcript 构造 query；
- 以 bank IDs + 最后一个 user message content 建 cache key；
- 支持 60 秒 TTL；
- 将结果渲染为 ephemeral `AgentMessage`；
- 默认把 recall message 插到最后一个 user message 前；
- abort 时不注入，也不报 extension error；
- 可以做 blank/duplicate/contamination 过滤、score floor、source fact 控制。

这些行为本身与 Magic Context 的目标一致：recall 不污染 transcript、可取消、失败不阻断主流程。

但当前 pi-mctx 的 `context-handler.ts` 是一个大型 transform pipeline，负责：

- tags 与 `§N§` accounting；
- pending drops 与 persisted tag status；
- m[0]/m[1] history injection；
- compartment boundary 和 raw tail；
- historian/compaction/nudge；
- local auto-search；
- LKG、epoch、branch/replay、taint、already-visible admission；
- provider-visible projection。

候选包的独立 `context` patch 没有消费这些状态，也没有接入 mctx 的 projection ledger。若两个 extension 同时返回 context patch，最终结果取决于 Pi host 的 handler 合并/覆盖顺序；即使 Pi 当前会依次合并，也没有证据保证两套 transform 对同一 message array 的顺序在未来稳定。

**风险等级：阻断级。**

推荐只有一个 owner 注册自动 `context` hook：

```text
Pi context event
  -> pi-mctx orchestrator
      -> local context transform
      -> optional Hindsight recall port
      -> admission / epoch / taint / visible filtering
      -> one final provider-visible patch
```

fork 后应把候选包的 recall policy 拆成纯函数/port：输入 query、scope、signal，输出 durable results；不要让它直接注册第二个 context injector。

### 3.3 自动 retain：能力吻合，但会与 mctx 重复写入

候选 retain policy 在 `agent_end`：

- 从 session cursor 找出尚未 retain 的 message；
- 将消息投影为结构化 JSON；
- 使用稳定 live-session document ID；
- 以 append 模式更新 Hindsight document；
- JSONL queue-first；
- 有 lock directory、stale lock、malformed quarantine、dead-letter；
- shutdown、periodic flush 和 explicit retain 都支持；
- 默认过滤 recursive Hindsight output 以及 noisy read/search result；
- 支持 project bank，global bank automatic retain 默认关闭。

这比当前 pi-mctx 的简单 Hindsight bridge 更完整，值得 fork 重用。

但是当前 pi-mctx 已经拥有：

- Pi-owned transactional outbox；
- capture/retain admission；
- Hindsight retain queue；
- session/branch/turn/projection identity；
- retries/dedupe contract；
- Hindsight capture 的 focused tests。

两者并装会出现至少四种重复：

1. 同一 `agent_end` 同时生成两套 retain payload；
2. 一个保留原始结构化 transcript，另一个保留 mctx projection/compacted context；
3. 两套 cursor 分别认为自己已处理到不同 transcript index；
4. Hindsight append document 的时序和 retry 结果无法由另一套 ledger 解释。

**风险等级：阻断级。**

必须二选一：

- **推荐：pi-hindsight 拥有唯一 Hindsight queue/cursor；pi-mctx 只调用它的 retain port，并把 mctx 明确过滤后的 durable candidate 交给它。**
- 或者：pi-mctx 完全拥有 capture/outbox，fork 后关闭候选包的 agent_end auto-retain，仅保留 client/tools/queue library。

不能让两个 extension 各自“尽量去重”；去重必须有一个 owner。

### 3.4 工具 surface：不吻合，需要命名与职责决策

候选包的稳定工具是：

- `hindsight_recall`
- `hindsight_retain`
- `hindsight_retain_global`
- `hindsight_reflect`
- `hindsight_status`
- `hindsight_seed_git`
- `hindsight_scope`
- `hindsight_config`
- `hindsight_bank`
- `hindsight_mental_model`
- `hindsight_knowledge`
- `hindsight_scope_migrate`

当前项目先前决定面向模型的名称为 `recall` / `retain`，而本仓库当前还有 native `mctx_memory` 等本地维护 surface。

直接并装会导致：

- `recall` 与 `hindsight_recall` 语义重复；
- `retain` 与 `hindsight_retain` 语义重复；
- 自动 recall 可能被调用两次；
- system prompt 需要同时解释两套工具；
- pi-subagents 的 tool allowlist 需要知道两套名称；
- Hindsight-specific admin tools 可能被不应拥有 memory 的 child 暴露。

**建议：** fork 后将 `hindsight_recall` / `hindsight_retain` 保留为 backend/admin namespace，是否提供 `recall` / `retain` alias 必须由唯一 integration owner 决定。对于最终三包设计，更干净的是：

- pi-hindsight canonical public tools：`retain`、`recall`、`reflect`；
- `hindsight_*` 作为诊断/管理工具，或只在明确启用 advanced surface 时注册；
- pi-mctx 不重复注册 `recall`，只消费 durable port 并把结果纳入自己的 context projection；
- `mctx_memory` 只保留给 local memory maintenance，不表示 Hindsight retain。

### 3.5 Scope、bank、identity：方向吻合，身份模型尚未完全对齐

候选包有成熟的 project/user bank 设计：

- project bank 默认使用稳定 `project:<id>` tag；
- global/user bank 需要显式开启；
- user memory 自动 retain 默认关闭；
- recall scope 使用 strict tag groups；
- `read-only` 允许 recall、禁止自动 retain；
- `ignored` 同时关闭 recall/retain；
- `next-opt-out` 只跳过下一次自动 retain。

这些安全默认值与 Magic Context 的“project memory 与 user memory 分离、敏感工作可关闭、失败不污染 session”高度吻合。

但当前 pi-mctx 的 project identity 来自自己的 session/project identity 与 SQLite registry；候选包有自己的 project bank derivation、repo key、bank config 和 `.pi/hindsight` 状态。若两者并装，必须保证：

```text
mctx project identity == hindsight project bank identity == subagent inherited project identity
```

否则会出现 local search 命中 project A、Hindsight recall 命中 project B，或 child 与 parent 进入不同 bank 的问题。

**风险等级：高。**

fork 时应把 identity derivation 提取成一个明确 contract：输入 canonical project identity，输出 bank ID 和 scope tags。不要让 pi-hindsight 再次根据 cwd/basename/remote 自己猜测一次。建议优先使用 repo canonical identity，basename 只能作为显式 fallback，并在 status 中显示 derivation。

### 3.6 Memory modes 与 Magic Context policy：基本兼容，但需要合并 policy

候选包提供 normal/read-only/ignored/next-turn opt-out，覆盖了 Magic Context 需要的主要安全控制。

不过当前 mctx 还有自己的：

- `memory.enabled` / Hindsight bridge enabled；
- compaction/window 开关；
- local memory tool policy；
- projection/admission policy；
- dreamer action gate；
- sidekick/dreamer tool allowlist。

不能出现两个独立的“总开关”而没有优先级。建议定义单一 policy matrix：

| Mode | local mctx/window | durable recall | durable auto-retain | explicit retain | projection |
| --- | --- | --- | --- | --- | --- |
| normal | on | on | on | on | on |
| read-only | on | on | off | 可由显式 policy 决定 | on |
| ignored | on | off | off | off | local-only |
| mctx-off | off | 可独立 | 可独立 | 可独立 | off |
| child-read | 由 child profile | on/allowlist | 默认 off | 默认 off | 不写 parent ledger |

这里的关键不是照搬候选包的 mode，而是让 mode 明确声明谁拥有 recall、retain 和 projection。

### 3.7 Reflect、mental model、knowledge：不能自动塞入 Magic Context 主循环

候选包提供：

- `hindsight_reflect`；
- mental model CRUD/refresh；
- knowledge page tree/search/get/export；
- bank mission 管理；
- git seed。

这些能力有价值，但与 Magic Context 的自动 recall/compaction 主循环不是同一层：

- `reflect` 是 synthesis，应保持显式调用，不能作为每轮 context hook 的隐式步骤；
- mental model refresh 会改变长期注入内容，必须有独立 cache/epoch/invalidation 语义；
- knowledge pages 是外部持久知识面，不应自动混入 `<session-history>` 或 mctx transcript；
- git seed 可能和 pi-mctx 现有 git commit indexing 重复，必须明确只保留一个 git ingestion owner。

**判断：** 这些功能可以 fork 保留，但第一阶段不要接到 mctx automatic transform；先作为 Hindsight 独立 advanced surface。

### 3.8 Hindsight 结果质量与 mctx admission：部分吻合，需要二次防线

候选包有 recall quality pass：blank-memory、duplicate-memory、recall-contamination、score floors、source facts budget。

Magic Context 需要的 admission 更广：

- session / branch / generation；
- projection epoch；
- scope；
- taint；
- already-visible memory；
- provider token budget；
- current live tail / compartment boundary；
- no duplicate with m[0]/m[1] or local recall lane。

因此候选包的 quality pass 不能替代 mctx admission。推荐把它视为 Hindsight-side candidate hygiene，mctx 仍要做最终 provider-visible admission。

## 4. fork 时应直接重用什么

### 可以直接重用或小改

1. Hindsight SDK client wrapper 与 capability error handling。
2. `context` recall policy 中的 cache key、TTL、abort 语义。
3. retain cursor：stable document ID、append cursor、hash chain、bounded tail。
4. queue-first durable queue：lock、stale lock、malformed quarantine、dead-letter、bounded flush。
5. project/user bank scope 与 strict tag groups。
6. secret redaction、reserved provenance metadata、防止 caller 覆盖 provenance。
7. read-only、ignored、next-opt-out 的 session policy 思路。
8. explicit `reflect`、bank、scope、status 的管理 surface。
9. release verification、pack smoke、surface reference 与 docs freshness checks。

### 不应原样复制

1. 直接注册自己的 `context` hook，与 pi-mctx 并行注入。
2. 直接注册自己的 `agent_end` 自动 retain，与 mctx outbox/capture 并行写入。
3. 自己重新推导 project identity，而不消费仓库 canonical identity。
4. 把 `hindsight_recall` 结果直接当作 mctx projection；它没有 mctx epoch/taint/branch admission。
5. 把 Hindsight knowledge/mental models 自动注入 Magic Context transcript。
6. 把 `hindsight_*` advanced admin tools 默认暴露给所有 pi-subagents child。
7. 保留 legacy mission/config migration 后又让 mctx 继续读取第二份同义配置。
8. 把 post-retain reflect 或 Hindsight observation 变成 historian event；当前设计明确 reflect 不进入 historian/每轮 provider transform。

## 5. 推荐 fork 结构

建议 fork 后先形成三个层次，而不是立刻把所有功能塞进 `pi-hindsight` extension：

```text
pi-hindsight/
├── core/
│   ├── HindsightClientPort
│   ├── bank/scope identity
│   ├── recall/retain request + result types
│   ├── queue/cursor/dedupe
│   └── redaction / capability errors
├── extension/
│   ├── explicit tools
│   ├── status/config/bank commands
│   └── optional standalone context/agent_end lifecycle
└── integration/
    ├── mctx adapter: query/result/admission handoff
    └── subagents adapter: child policy/config propagation
```

关键点：`core` 不依赖 pi-mctx 或 pi-subagents；standalone extension 的自动 hooks 必须可配置关闭；mctx integration 只能由一个 orchestrator 决定是否启用自动 recall/retain。

建议的第一版 public port：

```ts
interface HindsightMemoryPort {
  recall(input: {
    readonly query: string;
    readonly bankIds: readonly string[];
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly HindsightRecallResult[]>;

  enqueueRetain(input: {
    readonly documentId: string;
    readonly bankId: string;
    readonly content: string;
    readonly context: string;
    readonly updateMode?: "append" | "replace";
    readonly signal?: AbortSignal;
  }): Promise<{ readonly queued: boolean; readonly id: string }>;

  health(input?: { readonly signal?: AbortSignal }): Promise<{
    readonly status: "ok" | "unavailable";
    readonly version?: string;
  }>;
}
```

这是架构建议，不是当前仓库 API。port 必须隐藏 Hindsight SDK 类型、Pi UI 类型、Pi session manager 和 SQLite connection。

## 6. pi-subagents 组合时的特殊考量

候选包是 Pi extension + skills package，不代表 child process 会自动安全继承它。需要显式决定：

- child 是否安装/加载 pi-hindsight；
- child 使用 parent project bank、独立 child bank，还是只允许 recall；
- child retain 是否写入同一 append document；
- child 的 session identity 是否进入 tags/metadata；
- child 是否拥有 `hindsight_retain_global`；建议默认禁止；
- child 断线/重连是否会重复 retain；必须由 stable document ID + cursor 保证；
- child 的 Hindsight secret 是否从自身环境读取；不得写入 subagents registry/RPC payload；
- parent 的 projection ledger 是否允许 child recall 结果直接进入 parent provider context；建议必须由 parent admission 重新验证。

最小安全默认：child 可以被显式授予 recall，但默认没有 automatic retain、global retain、reflect、mental-model mutation、knowledge mutation。

## 7. Fork 迁移顺序

### Phase 0：建立兼容性基线

固定上游 commit/tag，不以 npm `latest` 为开发基线；记录：

- Pi host/API 版本；
- Hindsight SDK 版本和服务器版本；
- package manifest extension/skill discovery；
- 当前工具 surface；
- 当前 `.pi/hindsight` 配置格式与迁移行为；
- queue/cursor 文件格式。

### Phase 1：只 fork 运行，不安装到 mctx

验证候选包单独使用：

- setup gate；
- project-only / user-only / recall-only；
- recall cancellation；
- retain queue down/restart/retry/dead-letter；
- session mode；
- secret redaction；
- bank isolation。

### Phase 2：关闭候选包自动 hooks

保留 client、queue、cursor、tools 和 admin surface；将自动 `context` / `agent_end` lifecycle 变为显式选项，并验证关闭后没有残留 side effect。

### Phase 3：接入 pi-mctx port

- mctx 成为唯一 context transform owner；
- mctx 成为最终 recall admission/projection owner；
- pi-hindsight 只返回 durable candidates；
- mctx 成为唯一决定 retain candidate 的 owner，或者明确移交给 pi-hindsight，但不能双写；
- 删除 pi-mctx 自己的 Hindsight client/outbox 后再切换 package dependency。

### Phase 4：接入 pi-subagents

增加 child policy：

- `none`；
- `recall-only`；
- `project-retain`；
- `full-memory-admin`（不建议默认开放）。

所有跨进程能力通过显式 launch config/RPC，不依赖 process-local service。

### Phase 5：最终清理

确认所有 caller、配置、resume/fork、docs、package files、release script 和 tests 已迁移后，删除旧 `agentmemory*` compatibility residue 与重复 Hindsight integration。

## 8. 必须通过的 focused validation matrix

| 场景 | 必须证明 |
| --- | --- |
| 仅 pi-hindsight | retain/recall/queue/health 可用，不需要 mctx |
| 仅 pi-mctx | Window/local lane/native compaction 可用，Hindsight 缺失不阻断 |
| 两者同时安装 | 只有一个 context injector、一个 retain owner、无重复工具 |
| context hook 顺序 | mctx 最终 patch 包含 local + admitted durable，非双重 user message |
| retain | 同一 agent_end 不重复写入；restart/resume 不重复 append |
| Hindsight down | local mctx 正常，durable 状态 degraded，queue 保留 |
| Esc/cancel | recall 不注入、不写 sidecar、不改变 epoch |
| branch/replay | stale generation 的 recall 不进入当前 branch |
| project isolation | 不同 repo、worktree、remote、basename collision 不串 bank |
| user/global | project automatic retain 不写 global；global explicit tool 有独立权限 |
| child no-memory | subagent 正常启动，不暴露 memory tools |
| child recall-only | 可 recall，不能 automatic retain/global/admin mutation |
| child reconnect | queue/cursor/document ID 不重复写入 |
| Pi versions | current Pi `>=0.85.1` 与 upstream tested `0.84.1` 的 event/tool/context contract |
| package install | npm packed artifact 的 extension、skills、docs、LICENSE、runtime deps 完整 |

## 9. 最终建议

这个 fork 值得做，且候选包有不少能力明显优于当前 pi-mctx 内的 Hindsight bridge，特别是：

- queue-first durability；
- stable append cursor；
- project/user scope；
- session modes；
- recall quality filters；
- explicit Hindsight management surface；
- release and package verification discipline。

但它不能直接作为当前 Magic Context 的“记忆模块替换”。正确的 fork 目标应是：

> **保留它作为 Hindsight durable-memory owner 的成熟实现，删除/关闭它对 Pi context 与 agent_end 的独占假设，把 recall candidate、retain queue、identity、policy 和 mctx projection 之间的边界重新设计清楚。**

在没有完成“单一 context owner、单一 retain owner、统一 project identity、统一 policy、明确 child capability”之前，不建议把 `@luxusai/pi-hindsight` 与当前 `@hheei/pi-mctx` 同时启用，更不建议直接在 pi-mctx 里再加载它的完整 extension entry。

## 10. 根据当前决策收缩方案

本次讨论后，采用比前述通用 integration 方案更简单的边界：

```text
Pi host
├── pi-mctx      只负责 context window / compaction / local session context
└── pi-hindsight 负责全部长期记忆与 Hindsight 生命周期

pi-subagents 暂不接入任何记忆能力
```

具体决策：

1. 直接 clone/fork `luxus/pi-hindsight`，优先复用其已经工作的 client、bank/scope、queue、cursor、redaction、recall quality、session mode 和诊断界面。
2. 从 fork 中删除当前目标不需要的功能，而不是先设计新的抽象层：child integration、复杂跨 extension service contract、与 pi-mctx 的双向 adapter、未确认需求的 provider routing。
3. 将 pi-mctx 的长期记忆实现整体迁移到 pi-hindsight：包括自动 recall、自动 retain、Hindsight queue/cursor、project/user bank、reflect/admin memory surface。
4. pi-mctx 不再拥有长期记忆、Hindsight client、durable-memory outbox、memory recall ledger 或 durable memory tools。
5. pi-mctx 仍可拥有短期 session context、compaction、Window、local transcript/context bookkeeping；这些不是跨 session 的长期记忆，不应继续沿用 AgentMemory/Hindsight 命名。
6. 初期只保留一个实际自动 memory lifecycle owner：fork 后由 pi-hindsight 注册 `context` / `agent_end` memory hooks；pi-mctx 的原长期记忆 hooks、tools、配置、tests 和 backend 全部删除或迁移，不能双写。
7. pi-subagents 本阶段完全不做 memory 相关改动：child 不继承、不注入、不 retain、不 recall，也不新增 memory policy 或 RPC 字段。

### 10.1 这样收缩后的关键风险

收缩方案减少了大量抽象，但仍有三个必须直接验证的硬边界：

- **Pi context hook 共存：** pi-mctx 仍然会注册自己的 context transform，但它不再做 durable recall；必须验证 Pi 对两个 context handler 的 patch 合并顺序，以及 Hindsight 注入不会被 mctx transform 丢失、重复处理或写入长期记忆。
- **短期 local context 与长期 Hindsight memory：** 删除 mctx durable memory 后，local SQLite 中哪些表/feature 仍属于窗口运行所需，哪些是已退役 memory store，必须按 caller、resume/fork 和 persistence contract 逐项切开，不能简单保留“看起来像 memory”的残留。
- **工具 surface：** 初期应直接采用 fork 的 `hindsight_*` 工具命名，避免同时引入 `recall`/`retain` alias 和迁移期重复工具；待独立运行稳定后，再基于实际使用重新决定是否改名。工具改名不是本次拆分的必要前置条件。

### 10.2 收缩后的迁移顺序

1. clone/fork 并固定 upstream commit；先跑 fork 自己的 checks/smoke。
2. 在 fork 中删除 child/subagent 相关设想和非目标功能，但保留独立安装所需的完整 Hindsight lifecycle。
3. 将 pi-mctx 当前 Hindsight/AgentMemory 数据和配置迁移到 fork 的 bank、scope、queue/cursor 格式；提供一次性迁移，不做双写长期兼容层。
4. 在 pi-mctx 中关闭并删除 durable-memory capture、remote recall、memory tools、memory config 和对应 tests；只保留 context-window 功能。
5. 组合运行 Pi：验证一个 session 只有一套自动 recall 和 retain，且 mctx compaction 不会把 Hindsight ephemeral recall 写入 Pi transcript 或再次 retain。
6. 做一次实际 fork/reload/resume/queue-retry smoke；确认旧 AgentMemory endpoint、旧 queue 和旧工具没有残留调用。
7. 最后再更新 package catalogue、README、ADR/spec、发布文件和版本说明。

这意味着最终不是 `pi-mctx <-> pi-hindsight <-> pi-subagents` 三方抽象，而是当前阶段的两个独立包：`pi-mctx` 负责窗口，`pi-hindsight` 负责长期记忆；`pi-subagents` 保持原样。

## 11. 明确保留 historian

用户已确认：`historian` 属于 pi-mctx 的 context managing，不属于长期记忆 backend，迁移时必须保留。

因此“删除 pi-mctx 长期记忆”不包括：

- historian / compartment trigger；
- transcript compaction 与历史分段；
- m[0]/m[1] history injection；
- context transform 中为窗口压力、摘要、compartment 和 live-tail 管理服务的状态；
- Pi session transcript 的读取、重放、branch/reload continuity。

需要删除的是 historian 对 durable-memory backend 的耦合，例如把 Hindsight recall/retain 当作 historian event、远程 memory search 当作 context history source，或把长期记忆 ledger 混入 historian persistence。迁移前必须逐个检查 historian caller 和 persistence contract，避免按 `memory`、`history` 或 `agentmemory` 名称进行粗暴删除。

### 11.1 迁移边界

`historian` 本身继续由 pi-mctx 拥有并运行。它负责把原始 Pi transcript 转换为可管理的 context history，包括 compartment、历史分段、压缩前边界、摘要/事实生成、drop 队列、重放和 recomp；这些都是 context managing，不因长期记忆迁移而删除。

后续实现只能在 historian 的输出边界处理长期记忆迁移：需要迁移的是 durable memory 的存储、recall/retain 生命周期和 Hindsight backend；不能删除 historian runner、compartment trigger、compartment storage、context injection 或 historian 的 session continuity。若某个 historian 输出同时被 context window 和长期记忆使用，应先拆开两个 consumer，再迁移长期记忆 consumer，不能删除 producer。

简化后的原则是：

```text
raw Pi transcript
  -> pi-mctx historian / compartment manager
      -> context-window history (pi-mctx, 保留)
      -> durable long-term memory (pi-hindsight, 迁移)
```

因此后续清理不得依据 `memory`、`history`、`agentmemory` 或 `historian` 文件名做整目录删除；必须按实际职责和 caller 检查。
