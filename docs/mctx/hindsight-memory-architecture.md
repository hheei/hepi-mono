# MCTX 与 Hindsight 记忆架构

状态：设计提案，未进入实现。

参考：

- Hindsight upstream `vectorize-io/hindsight`，revision `d637008fbef54efef6e4fdfc8896dfa9994bc23c`
- `references/repos/cortexkit-magic-context/`
- `packages/pi-hindsight/docs/hindsight-core-functions.md`
- `packages/pi-hindsight/docs/adr/001-memory-lifecycle-and-scope.md`
- `packages/pi-hindsight/docs/adr/005-domain-banks-and-agent-first-surface.md`
- Hindsight upstream `docs/superpowers/specs/2026-07-27-reflect-pages-runtime.md` at the pinned revision

## 1. 核心直觉与目标

MCTX 与 Hindsight 不应各自维护一套完整的长期记忆系统。Hindsight 负责从 raw source
中提取、巩固和推理长期知识；MCTX 负责把已选知识编译成受 context budget、prefix cache、
session、fork 和 handoff 约束的稳定模型上下文。

```text
Pi session / project evidence
        |
        v
Hindsight retain
        |
        +--> world / experience facts
        +--> observations
        +--> reflect / mental models / knowledge pages
        |
        v
MCTX knowledge materializer
        |
        +--> stable knowledge baseline
        +--> bounded knowledge delta
        +--> local per-turn page-section selection
        |
        v
Pi model context
```

目标：

- 保留 MCTX 的 deterministic context projection、session compartment m0/m1、history tags、smart drop、
  historian、fork/handoff 和 compaction recovery。
- 使用 Hindsight 的 raw retain、semantic retrieval、facts、observations、reflect、mental models
  和 knowledge pages，不在 MCTX 重复实现这些知识能力。
- 让 Hindsight 的网络、异步 extraction、consolidation 和 refresh 不破坏 MCTX 的 prefix cache、
  CAS、取消和 context replay。
- 明确 remote knowledge freshness、MCTX snapshot freshness 和当前 turn relevance 的边界。
- 保持用户对两类记忆的心智模型清晰：MCTX 提供“本 session 的精确上下文恢复与压缩”，
  Hindsight 提供“跨 session 的长期知识”。

非目标：

- 不把 Hindsight knowledge 写入 MCTX compartment graph，也不复用 compartment m0/m1。
- 不让 MCTX 每个 turn 对 Hindsight 做远程 recall。
- 不把 Hindsight recall 结果直接当作最终答案。
- 不把 MCTX 的 session compartments、history tags 或 Pi transcript 迁移到 Hindsight。
- 不在第一阶段重写 `pi-hindsight` 的 lifecycle、queue、bank routing 或 client。

## 2. 边界映射

### Pi host

Pi host 拥有 session branch、当前 model context、context hook、native compaction、reload、
ExtensionContext 和 cancellation。Pi host 不解释 Hindsight facts，也不拥有 MCTX memory policy。

### ext-core

ext-core 只拥有跨 extension capability transport、lifecycle、abort、cleanup 和 revision guard。
它不拥有 memory record、bank、tag、page、fact、observation、rendered content 或 MCTX policy。

### pi-hindsight

pi-hindsight 是 Hindsight capability provider。它拥有：

- Hindsight client 和 server capability detection；
- coding/life/isolated bank routing；
- project/user scope tags；
- retain queue、retry、dead-letter 和 shutdown flush；
- recall、reflect、mental model、knowledge page 操作；
- Hindsight operation/status diagnostics。

pi-hindsight 不直接改 MCTX SQLite，不创建 MCTX compartment，不参与 MCTX CAS，不调用
`ctx_reduce`，不负责 Pi context prefix cache。

### pi-mctx

pi-mctx 是 context compiler。它拥有：

- Hindsight knowledge snapshot 的 materialization state；
- knowledge baseline/delta context placement、token budget 和 cache identity；
- page-section local index 和 score floor；
- snapshot invalidation、stale state、CAS publish、fork/handoff projection；
- MCTX context markers、history tags、smart drop 和 native compaction interception。

pi-mctx 不拥有 Hindsight bank、retain queue、observation extraction、embedding、semantic rank、
reflect prompt 或 mental-model content generation。

当前仓库仍有旧的 `pi-mctx` memory/embedding/search/note/Dreamer runtime。它不是目标架构，也不应继续
作为兼容路径。若用户数据有价值，先做一次显式 export/import 和验证；之后删除旧 implementation、schema、
tools、tests、embedding、Dreamer 和 revival 注释。不在 production 同时运行两套 backend；比较只能使用
exported fixtures、isolated evaluation banks 和 benchmark harness。

### Compartment 与 knowledge snapshot 的硬边界

MCTX 的 `m0`/`m1` 是 session compartment graph 的持久化 tier。每个 compartment 必须覆盖
Pi branch 的连续 entry range，并由 entry ID、source fingerprint、partition revision 和 CAS 验证。
Hindsight objects 不具备该 source contract，因此不得成为 compartment、不得占用 m0/m1 sequence，
也不得参与 compartment recovery、recomp 或 handoff graph。

Hindsight knowledge 使用独立 `knowledge snapshot` record，保存 source provenance、freshness、
render payload 与独立 revision。它和 compartment 按固定顺序共同渲染：

```text
stable Hindsight knowledge baseline
-> verified MCTX compartment m0
-> verified MCTX compartment m1
-> protected live tail
-> optional turn-local knowledge augmentation
```

knowledge snapshot replace 与 compartment publish 是独立 CAS。任一失败不得修改另一方。

### Hindsight knowledge snapshot

这是 MCTX 的投影缓存，不是 Hindsight 的第二份事实库。snapshot 保存：

- selected bank role 和 strict scope filter；
- source kind：reflect、mental model、knowledge page、observation；
- Hindsight object IDs 和 provenance；
- source version、updated timestamp 或 content fingerprint；
- rendered text、section metadata 和 token count；
- materialization status 与 last error。

snapshot 可以在 Hindsight refresh 前继续 replay。它必须标记 freshness，不能伪装成最新知识。

### Snapshot identity

每次 read、publish、handoff 和 status 都使用完整 `KnowledgeSnapshotIdentity`：

```text
project identity
resolved bank IDs and bank role
strict scope tags and memoryProfile
Hindsight server/client capability revision
projection policy version
source product versions/content fingerprints
knowledge epoch + reflect query fingerprint when applicable
page-section index version when applicable
```

任一字段变化都使旧 snapshot 不可作为 fresh 复用。它可以在相同 project/scope 下作为 stale fallback
replay；跨 project、profile、bank、privacy policy 或 capability revision 不得 replay。

## 3. 知识产品与上下文层级

Hindsight upstream 明确区分：

```text
Retain        = 保存 raw source
Recall        = 返回相关候选
Reflect       = 针对问题做深度分析
Observations  = 从重复证据中巩固的事实/信念
Mental Models = 面向重复问题的可复用综合答案
Knowledge Pages = 面向人和 agent 的组织化长期知识视图
```

MCTX 不把这些产品混成一个 `Memory[]`。目标 context tier：

### Knowledge baseline

适合跨 turn 重放、prefix cache 和 handoff 的稳定知识：

- project mental model；
- Hindsight knowledge page 中明确标为 project-stable 的 sections；
- 经过 materializer 固定的 project observations；

knowledge baseline 只使用已缓存 snapshot。普通 turn 不重新远程 recall 或 reflect。它的 fingerprint
包含 Hindsight source IDs、versions、scope、render policy 和 rendered payload；不进入 MCTX
compartment source fingerprint。

source selection 不由 MCTX 对 long-term knowledge 做第二次 semantic ranking。pi-hindsight provider 以
Hindsight product policy 返回已选 projection：默认优先 project-scoped mental models，再补 provenance
完整的 observations/pages。相同 provenance 或内容指纹只能出现一次。MCTX 验证 scope/provenance/budget
后编译，不重写知识优先级。Reflect 是当前 task/session epoch 的 synthesis，默认只进入该 epoch snapshot，
不是以后 session 的长期 baseline。

默认只使用 project/coding bank。只有 Hindsight `memoryProfile` 明确允许 global/user scope 时，provider
才返回 global mental model/page；MCTX 不因 context 压力或 project snapshot 为空而扩大到 user bank。

### Knowledge delta

适合当前 session 或近期变化、但尚未成为长期 baseline 的内容：

- 新的 Hindsight observations；
- 当前 project page refresh 后的增量 sections；
- hard materialization 后新增且通过 policy 的 stable knowledge。

knowledge delta 仍由 MCTX 固定 snapshot 后重放。它不是每个 turn 的动态远程结果，也不是 compartment m1。

### turn-local selection

Hindsight upstream 最新 Reflect + Pages runtime 的经验表明，raw recall-per-prompt 可能比无记忆更差。
因此 turn-local 路径不做默认远程 recall。第一阶段使用已缓存 knowledge pages 的本地 section index：

- 按 heading/body lexical overlap 评分；
- heading 命中权重更高；
- 选择 top 2-3 sections；
- 总预算约 700 tokens，但由当前 context budget 收紧；
- 低于 score floor 时不注入；
- 注入包含 page/section provenance 和读取完整 page 的指引。

Hindsight recall 使用三档策略：

```text
off       不自动 recall，仅允许显式 hindsight_recall
snapshot  hard materialization 时 bounded recall 一次，结果经过验证后进入 knowledge snapshot
adaptive  cached sections 无高分、snapshot stale、预算允许时，本轮最多 recall 一次
```

默认 `snapshot`。`adaptive` 还要求本 turn 未 adaptive recall、session mode 可读、lease current、provider
healthy、query 有足够有效文本且 deadline 尚有余量。结果只作为本 turn local block，不能 publish 到 stable
snapshot，也不能 retain。它必须经 benchmark 证明收益，不能退化成每轮无条件 remote recall。

## 4. 运行时流程

### 用户工作流与控制面

用户不应学习两套同义 memory command：

```text
/mctx        = 当前 session context、compartment、drop、historian、knowledge snapshot 状态
/hindsight   = bank、scope、retain queue、session memory mode、显式 recall/reflect、mental model 管理
ctx_expand   = 精确恢复被 MCTX drop 的历史 source
hindsight_*  = 查询或保存长期 Hindsight knowledge
```

`ctx_expand` 与 `hindsight_recall` 不能互相替代。前者按 MCTX tag 精确恢复本 session 的原始
tool/message source；后者返回跨 session 的语义知识候选。MCTX 不重新注册 `ctx_memory`、`ctx_note`、
`ctx_search` 或 Dreamer command。

`/mctx status` 与 `/hindsight status` 显示同一 injection coordination state：

```text
injectionOwner: unknown | mctx-owned | hindsight-owned | disabled
admissionReason
snapshotIdentity hash
freshness
last materialization outcome
retain mode
automatic recall policy
```

两边可添加各自 owner 的细节，但不得给出互相矛盾的当前 owner/freshness。

Hindsight session mode 是用户 authority：

```text
normal     = MCTX knowledge snapshot 可读；Hindsight retain 可写
read-only  = MCTX knowledge snapshot 可读；Hindsight automatic retain 不写
ignored    = 不读、不写、不注入 Hindsight knowledge；MCTX 仍可做纯 session compartment/context 工作
next-retain-off = 只影响下一次 Hindsight retain，不撤销已验证 knowledge snapshot
```

### 注入仲裁与生命周期顺序

pi-hindsight 当前 automatic context path 同时渲染 mental models 和 raw recall。MCTX knowledge mode
必须接管这整个 automatic path，不能只关闭 raw recall 而保留 mental-model auto injection。

```text
pi-hindsight active + session mode permits read
  -> publishes runtime injection-gate capability before bank initialization completes
pi-mctx active + knowledge integration enabled
  -> claims gate after both lifecycles are active
  -> pi-hindsight suppresses mental-model + recall auto injection
  -> pi-mctx renders only validated knowledge snapshot/local sections
claim release / MCTX cleanup
  -> injection owner returns to unknown
  -> next context revision must run admission before either side injects
```

Lifecycle ordering is not assumed. If MCTX starts before pi-hindsight, it retries admission at the first
eligible materialization boundary; it must not permanently decide from one absent service lookup. Hindsight
must not inject first and let MCTX take over later. The claim transition requires a context revision boundary:
never mix Hindsight direct injection and MCTX snapshot injection in one provider request.

### 注入 owner admission 状态机

automatic knowledge injection 只有一个 session-scoped owner。不能在 Hindsight 先启动时先注入一次，
再在 MCTX claim 后切换，因为首次 provider request 也必须稳定。

```text
unknown
  -> mctx-owned       MCTX enabled、Hindsight readable、claim 成功
  -> hindsight-owned  MCTX integration disabled 或用户明确选择 Hindsight direct runtime
  -> disabled         session mode ignored、capability denied 或双方均未启用

mctx-owned / hindsight-owned / disabled
  -> unknown          reload、extension unload、profile/bank/scope change、session replacement
```

`unknown` 时两边都不 automatic inject。admission 必须在下一次 context revision 前完成；超时/失败进入
`disabled` 并显示 reason，而不是临时回退另一方。owner 变更只发生在 context revision boundary，不能在
同一个 provider request 混合 Hindsight direct block 与 MCTX knowledge snapshot。

automatic retain 不受 injection owner 影响；它只服从 Hindsight session mode。

### Session start

```text
Pi host session_start
  -> ext-core starts pi-hindsight and pi-mctx lifecycles
  -> pi-hindsight resolves setup, banks and project scope
  -> MCTX knowledge mode claims automatic context injection ownership
  -> pi-hindsight disables its own automatic context recall for this lifecycle
  -> pi-mctx loads last valid knowledge snapshot
  -> if snapshot fresh: replay knowledge snapshot + compartment m0/m1
  -> if stale and policy permits: schedule one bounded materialization
  -> Pi context receives stable snapshots only
```

session start 不因 Hindsight network failure 阻塞 MCTX context。若没有 valid snapshot，MCTX
明确显示 unavailable/stale，而不是把旧内容伪装为 fresh，也不回退到另一套 memory backend。

### First real task

使用 Hindsight Reflect + Pages runtime 的 upstream 模式：

```text
first task message
  -> one reflect query over selected bank/scope
  -> obtain synthesized answer or explicit failure
  -> fetch/cache knowledge page roster and content if supported
  -> build local section index
  -> publish one MCTX knowledge snapshot
```

不在 session-open 对空 query 做 reflect。不在每个 prompt 做新的 reflect。

“first real task” 是 knowledge epoch，不等于 session file 创建。resume、handoff 或长 idle 后的第一条
substantive user request 可开始新 epoch；短连续 turns 复用同一 snapshot。Phase 0 必须定义可观察的
epoch boundary，不能把 MCTX 5-minute temporal marker 直接当作知识刷新事实。

### Each turn

```text
current prompt
  -> MCTX matches cached page sections locally
  -> score floor + token budget
  -> optional turn-local block
  -> replay unchanged knowledge snapshot + compartment graph
  -> provider request
```

local section selection 的结果不写 Pi transcript，不 retain 回 Hindsight，不改变 compartment 或
knowledge snapshot fingerprint。

### Agent end

```text
Pi host agent_end
  -> pi-hindsight retains raw structured session delta
  -> queue persists before network flush
  -> Hindsight extracts facts and updates observations/pages/models asynchronously
  -> pi-mctx records retain delivery state only
```

pi-mctx 不复制 pi-hindsight queue。retain 失败不能破坏已经可用的 MCTX snapshot；状态必须显示
queued/failed/dead-letter，而不是静默当作 durable。

所有 MCTX-rendered Hindsight knowledge 都使用 ext-core 定义的 shared injected-knowledge marker，
包含 provider、source IDs 与 `retain: false`。pi-hindsight retain projection 必须排除该 marker，
和排除自身 `<hindsight-memory>` block 使用同一规则。这样 reflect/page/model 内容不会作为新的
raw evidence 再次 retain。

Hindsight retain 的 source 必须是 Pi session branch/agent-end 的原始 message sequence，不能是 MCTX
`context` hook 的 rendered messages。MCTX drop marker、compartment、knowledge snapshot、recall block 和
provider-only custom message 都不得成为 retained evidence。实现前增加 host regression，证明 smart drop 后
Hindsight 仍 retain 原始 eligible source，而不会 retain MCTX projection。

这是主安全 invariant，不依赖 injected-knowledge marker：

```text
automatic retain input = canonical Pi session entries only
context-projection message = never retain input
```

marker 只作为显式 tool input、import 和未来 interop path 的 defence-in-depth filter。

retain 前由 pi-hindsight 做持久化安全过滤：secret redaction、credential/token pattern filtering、
tool/source allowlist、oversized output exclusion、custom/injected message exclusion 和 explicit user opt-out。
Hindsight returned text 也当作不可信数据渲染：固定 delimiter、provenance label、禁止它覆盖 system/tool
instruction 或扩大 bank/scope。source deletion/correction 必须通过 Hindsight document provenance 路径完成。

retain delivery 不等于知识刷新。MCTX status 必须区分：

```text
retain queued
-> retain delivered
-> Hindsight consolidation/page/model version observed
-> MCTX knowledge snapshot materialized
```

只有观察到可验证的 Hindsight source version/content fingerprint 改变，才将 knowledge snapshot 标为
`stale`。只有新 snapshot CAS publish 成功，才标为 `fresh`。当前 Hindsight server 无法提供该观察信号时，
snapshot 维持 `freshness: unknown`，不得在每次 agent end 盲目 reflect。

`unknown` 的可执行策略是：只允许 explicit refresh 或首次/新 epoch 的一次 bounded materialization，
并有最小 cooldown。它不因 agent end 自动 materialize，也不因 context pressure 反复 reflect。等 capability
audit 证明有稳定 change/version signal 后，才启用 version-driven stale/materialization。

`adaptive` recall 还要求：本 turn 未执行过 adaptive recall、session mode 可读、lease current、provider
healthy、query 有足够有效文本、context deadline 尚有余量。结果只可作为本 turn local block，不能 publish
到 stable snapshot，也不能 retain；任何失败直接省略该 block。

### Knowledge materialization

触发条件：

- snapshot stale 且 context pressure 允许后台工作；
- Hindsight refresh watermark 变化；
- 显式 `/mctx knowledge refresh` command。

`/mctx recomp` 和 `/mctx wrapup` 只重建当前 session compartment graph。它们不调用 Hindsight、
不做 reflect、不等待远程网络，也不改变 knowledge snapshot。

流程：

```text
claim one materialization lease
  -> capture Hindsight source/version snapshot
  -> reflect/page read within bounded budget
  -> validate source IDs, scope, fingerprint and rendered size
  -> atomic MCTX snapshot replace
  -> release lease
```

失败、cancelled、stale、scope mismatch 或 source-too-large 时保留旧 valid snapshot。不能先删旧
snapshot 再等待 Hindsight。

materialization lease 绑定 `KnowledgeSnapshotIdentity`、owner generation、MCTX snapshot revision 和
request ID。abort/reload/profile change 会取消 client request；远端仍可能晚到响应。publish 前必须再次验证
lease current、generation、identity、source fingerprint 和 MCTX CAS revision。任一不匹配，结果为 `stale`，
不得写 snapshot。lease TTL/renewal、timeout 和 cancellation ownership 使用与 MCTX historian 同等约束。

## 5. Hindsight 能力利用方式

### Retain

保留 pi-hindsight 的 raw structured retain。MCTX 不把已经压缩的 context projection 再 retain
为长期真相；应 retain 原始 session delta、tool action、decision、code change context 等 source。

stable document ID 的 owner 是 pi-hindsight 的 session/import identity helper。MCTX 只提供
provenance metadata，不自行复制 retain cursor、append queue 或 retry。

### Observations

Observations 是 Hindsight 的 consolidation product。MCTX 只消费带 scope/provenance 的 observation
projection，不自己 merge、supersede、strengthen 或 decay。Hindsight observation scope 不能包含 volatile
session tag；project scope 使用 stable project tag，shared observation 必须显式 opt-in。

### Reflect

Reflect 用于：

- first real task 的 session synthesis；
- hard materialization；
- 显式 memory refresh；
- mental model/page refresh 的 server-side workflow。

Reflect 输出先经过 MCTX schema、scope、budget 和 provenance validation，才可进入 snapshot。
Reflect 不能直接修改 MCTX state。

### Mental models

Mental models 是 knowledge baseline 的首选输入，因为它们已经面向 recurring question 综合。MCTX 读取 selected
bank 中的 project-scoped 与允许的 bank-global models，按 active project scope 过滤。MCTX 不自动创建
或刷新 mental model；刷新由 Hindsight 控制面或显式 pi-hindsight agent operation 负责。

### Knowledge pages

如果连接的 Hindsight server 通过 capability audit 证明提供稳定的 page list/read/content/version API，MCTX
才使用 page roster/content 作为本地 section index 的 source。page 是 Hindsight 的组织化视图，不是 MCTX
memory row。upstream Reflect + Pages runtime spec 本身不是当前 0.8.x client/server 的 capability guarantee。

若当前 server/client 只有 0.8 retain/recall/reflect/mental-model surface，则不模拟 pages。第一阶段
可使用 mental models + bounded observations，等 page API capability 明确后再启用 page path。

## 6. 一致性与缓存

### Context budget arbitration

MCTX 是最终 context budget owner。旧 `memories` accounting 随旧 local memory backend 删除；knowledge
snapshot 不与 compartment graph 共用 record。render policy 固定优先级：

```text
required system prompt and tool definitions
-> current user message / protected live tail
-> verified compartment m0/m1
-> knowledge baseline
-> knowledge delta
-> turn-local page sections
```

预算不足时，先省略 turn-local sections，再裁剪/跳过 knowledge delta，再使用较旧但已验证的 baseline；
不能为了注入 Hindsight knowledge 触发 smart drop、提前 historian compaction 或削减 protected live tail。
snapshot render 记录 token count 和裁剪原因，`/mctx` status 显示 knowledge budget/freshness；`/hindsight`
继续显示 bank、queue、retain 和 remote health。

knowledge accounting 分别显示：

```text
knowledgeBaseline
knowledgeDelta
knowledgeLocal
```

### 真相与缓存

```text
Hindsight raw/derived knowledge = long-term knowledge authority
MCTX knowledge snapshot         = context compilation cache
Pi transcript                   = raw conversation authority
MCTX compartment store          = context transformation authority
```

MCTX snapshot 不是 Hindsight transaction。它记录 capture metadata，并通过 content/version
fingerprint 检测 stale。无法获得稳定 source version 时，materializer 必须使用 content fingerprint
和 capture timestamp，且 status 标为 time-based/weak freshness；不能声称强一致。

### Snapshot persistence and response limits

knowledge snapshot 会把 Hindsight-derived text 复制到 MCTX SQLite。因此其 persistence policy 是显式配置：

```text
persistent  = 按 session SQLite 生命周期保存；session delete 清除 snapshot 与 handoff binding payload
ephemeral   = 只保存在内存；不参与 resume/handoff reuse
disabled    = 不保存或注入 Hindsight knowledge
```

默认 `persistent` 前必须显示本地副本范围；status、diagnostic、receipt 和日志不得输出 raw snapshot text。
Handoff payload 只在 reservation/install lifetime 存在，install 或 abort 后清除。

pi-hindsight provider 在 MCTX render 前强制 runtime schema 和大小上限：最大 response bytes、sources、
bytes/source、provenance IDs/source、tags/source、sections 和 section bytes。超过上限的响应整体拒绝或按
documented deterministic prefix 截断，绝不把未验证的大 payload 交给 token renderer。

### Prefix cache

Hindsight refresh 不应直接改变当前 request 的 compartment bytes 或 knowledge baseline bytes。新知识只在下一次
successful materialization 后进入 knowledge baseline/delta。turn-local page sections 必须独立于两类
snapshot fingerprint，并有明确 cache policy。

### Archive / correction

Hindsight observation stale、矛盾或 source correction 由 Hindsight 处理。MCTX 只在下一次 materialization
读取新结果。若 Hindsight 没有可验证的 exclusion/provenance，MCTX 不得宣称旧事实已被移除；status 应显示
`knowledge freshness unresolved`。

### Handoff

handoff 不把 Hindsight knowledge render 写入 Pi transcript，也不把它 retain 为新 source。payload 只携带
`KnowledgeSnapshotIdentity`、render payload、freshness、source provenance 和 integrity fingerprint。

```text
destination validates:
  MCTX knowledge integration enabled
  same project identity
  same resolved bank IDs, profile, strict scope and privacy policy
  compatible Hindsight capability revision
  payload/source integrity fingerprint

all valid
  -> reuse snapshot as validated/stale according to freshness

any mismatch or unavailable capability
  -> do not copy knowledge into transcript
  -> do not use old MCTX memory fallback
  -> retain session compartments only; knowledge state is unavailable or stale
```

compartment parent projection 与 knowledge snapshot validation 是独立 transaction/decision。

## 7. Capability contract

跨 extension 不共享 Hindsight client。Phase 1 只提供 `StableProjectionService`；Phase 3 capability audit
通过后才单独增加 `PageSectionService`。Pages 不进入 Phase 1 contract，也不让 0.8.x integration 假装支持
upstream planned API。

```ts
interface MctxKnowledgeService {
  /** One session-scoped owner lease. Every read validates its captured identity. */
  claimContextInjection(input: {
    projectId: string;
    signal: AbortSignal;
  }): Promise<
    | { kind: "claimed"; lease: KnowledgeInjectionLease }
    | { kind: "denied"; reason: "session-mode-ignored" | "knowledge-mode-disabled" }
    | { kind: "unavailable"; reason: string }
  >;

  getStableProjection(input: {
    lease: KnowledgeInjectionLease;
    projectId: string;
    bankRole: "coding" | "life" | "isolated";
    signal: AbortSignal;
  }): Promise<
    | {
        kind: "projection";
        sources: readonly {
          sourceKind: "mental-model" | "observation" | "reflect";
          sourceId: string;
          version?: string;
          text: string;
          tags: readonly string[];
          /** Product selection happened in pi-hindsight, not in MCTX. */
          selectionRole: "baseline" | "delta" | "epoch-synthesis";
        }[];
      }
    | { kind: "empty" }
    | { kind: "unavailable"; reason: string }
  >;
}

interface KnowledgeInjectionLease {
  readonly identity: KnowledgeSnapshotIdentity;
  readonly generation: number;
  release(): void;
}

interface EpochSynthesisService {
  getEpochSynthesis(input: {
    lease: KnowledgeInjectionLease;
    epochId: string;
    queryFingerprint: string;
    query: string;
    signal: AbortSignal;
  }): Promise<
    | { kind: "synthesis"; sourceId: string; text: string; provenance: readonly string[] }
    | { kind: "empty" }
    | { kind: "unavailable"; reason: string }
  >;
}

interface PageSectionService {
  getPageSections(input: {
    lease: KnowledgeInjectionLease;
    projectId: string;
    signal: AbortSignal;
  }): Promise<
    | { kind: "sections"; version?: string; sections: readonly KnowledgeSection[] }
    | { kind: "unsupported" }
    | { kind: "unavailable"; reason: string }
  >;
}
```

该 capability 拥有 Hindsight routing、network、retry、response validation 和 source provenance。
MCTX 拥有 snapshot publication、context rendering 和 cache invalidation。context injection claim 存在时，
pi-hindsight 不执行自己的 automatic recall hook；claim release、lifecycle abort 或 provider absence 后，
injection owner 回到 `unknown`，必须重新 admission，不能立即恢复自动注入。连接的 server 没有 Page capability
时，pi-hindsight 不注册 `PageSectionService`；MCTX 只使用 stable projection，不伪造 page 实现。

## 8. Failure and fallback policy

- Hindsight unavailable before any snapshot exists: MCTX remains active with no knowledge block and shows
  an explicit diagnostic.
- Hindsight unavailable with a valid snapshot: replay snapshot as stale; show stale status.
- Reflect/page response malformed: reject the new snapshot; retain old snapshot.
- Scope/provenance mismatch: reject the response; never widen recall scope to make it fit.
- Hindsight retain failure: pi-hindsight owns retry/dead-letter; MCTX does not pretend retention succeeded.
- MCTX store failure: do not inject an untracked new knowledge block; preserve Pi raw context.
- No Hindsight provider: no knowledge capability is registered; no alternate backend is silently selected.

The only fallback is replaying a previously validated MCTX knowledge snapshot. This is stale-data replay with
visible status, not a second memory implementation. MCTX knowledge mode 已 active 但 capability unavailable
且无 snapshot 时，pi-hindsight 不得在同一 lifecycle 静默恢复 raw automatic recall；必须显示 unavailable。

## 9. Implementation phases

### Phase 0: capability audit

- Pin the upstream Hindsight revision and connected server/client version.
- Verify page list/read/version/provenance APIs, or record that pages are unavailable.
- Verify mental-model payload, tags, update timestamps and stable IDs.
- Verify observation recall filters, source facts and provenance.
- Verify correction/stale behavior after retain `replace`.
- Define and test `KnowledgeSnapshotIdentity`, admission state transitions and canonical retain source invariant.
- Define old MCTX memory export/import receipt, read-back verification and deletion admission before code deletion.
- Verify redaction, custom-message exclusion, prompt-injection rendering and document correction/deletion behavior.

### Phase 1: stable projection and injection admission

#### Phase 1a: admission only

- Add injection gate, owner state machine and opaque lease.
- Verify direct Hindsight injection and MCTX integration are mutually exclusive.
- Do not read, render or persist knowledge yet.

#### Phase 1b: mental-model stable projection

- Implement pi-hindsight stable projection provider using existing lifecycle/client ownership.
- Validate response schema, limits, scope, provenance and snapshot identity.
- Store MCTX knowledge snapshot in the separate render slot.
- Use mental models only: no reflect, observations, pages or adaptive recall.

#### Phase 1c: persistence and handoff

- Add snapshot persistence policy, late-result publish fence, status and handoff validation.
- Add canonical retain-source and injected-marker regressions before any payload reaches provider context.
- Test exported fixtures, isolated evaluation banks and benchmark harnesses. Do not dual-read or dual-write old
  MCTX memory and Hindsight memory in production.

### Phase 2: Hindsight-backed knowledge compilation

- Use mental models and bounded observations for knowledge baseline/delta, never for compartment m0/m1.
- Add reflect hard materialization with one lease and atomic snapshot replacement.
- Add scope/provenance/fingerprint tests.
- Do not add per-turn remote recall.

### Phase 3: pages and local sections

- Enable only when server capability is verified.
- Build local page section index.
- Add score floor, budget trim, provenance labels and silence-on-low-score.
- Benchmark reflect-only against reflect+pages; reject regressions.

### Phase 4: remove duplicate MCTX knowledge machinery

Only after Phase 1-3 verification:

- remove local embeddings/vector search;
- remove local observation/dreamer/consolidation paths that duplicate Hindsight;
- remove duplicate retain queue only after pi-hindsight owns all required delivery semantics;
- retain MCTX snapshot/compiler state required for deterministic context.

No dual-read or dual-write compatibility path is planned. Any old durable data migration must be a separate,
explicit import operation with a receipt and verification before old tables/code are deleted.

## 10. Verification gates

- Scope isolation: project A cannot appear in project B strict projection.
- Bank-global/life memory cannot enter coding project projection without explicit policy.
- Recalled/retained source provenance survives projection and is inspectable.
- Hindsight response failure never changes existing compartment or knowledge snapshot bytes.
- Materialization CAS conflict leaves old snapshot intact.
- Repeated defer/context passes produce identical snapshot bytes.
- Reload aborts old provider requests and does not publish late results.
- First-task reflect is at most once per session.
- Page section injection makes no remote call on the hot path.
- Low-score page match injects nothing.
- Raw recall is not automatically retained again.
- MCTX-rendered knowledge is not automatically retained again.
- MCTX knowledge mode and pi-hindsight automatic recall never inject concurrently.
- Hindsight retain queue is durable before network delivery.
- Reflect-only and reflect+pages benchmark both beat or do not regress against the chosen baseline.

## 11. Open decisions before implementation

1. Which upstream Hindsight release exposes knowledge pages in the supported server/client contract?
2. Can current recall responses provide stable document/source provenance for MCTX dedupe?
3. Should MCTX compile observations into m1, or only mental models/pages into m0 until observation payload is proven stable?
4. What exact Hindsight freshness/version signal invalidates MCTX snapshot?
5. Does the project want Hindsight to become the sole long-term knowledge authority immediately, or only after
   an explicit import/reconciliation command proves existing MCTX memories were retained?
6. What exact Hindsight event or polling state distinguishes `retain queued`, `retain delivered`, `consolidation
   complete`, `mental model/page version changed`, and `MCTX snapshot refreshed`?

