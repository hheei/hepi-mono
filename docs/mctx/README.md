# pi-mctx

## Status Panel Display Parity

`/mctx` status panel 的显示内容与布局对齐上游 Magic Context Pi plugin：
标题行、Context 使用率与 token bar、Counts、Historian、Tags、Context
阈值区和关闭提示使用上游顺序与视觉层级。对齐范围只包含 panel renderer
和其可见数据；`pi-mctx` 不具备的 upstream 指标（memory、notes、upgrade
等）不显示，也不为此扩展生命周期或 TUI backend。

上游依据：
https://github.com/cortexkit/magic-context/tree/0e81084f6f9ce8a87df76d975b9d31d10e9c477b/packages/pi-plugin
，具体实现为 `src/dialogs/status-dialog.ts`。

## Message Marker Parity

`pi-mctx` 在每次 Pi host `context` hook 中，为仍在模型上下文里的 user、assistant
和 toolResult 注入稳定的 `§N§` history tag；已 reduce 的内容替换为
`[dropped §N§]`，可通过 `ctx_expand` 读取原文。tag 只存在于模型请求投影，绝不
写回 Pi session transcript。

Pi host 在 hook 前深拷贝消息，故 concrete extension 不能依赖 session entry 和
context message 的对象身份。`pi-mctx` 以完整 session branch 的结构序列匹配 context；
compartment 投影后再对未覆盖的 live tail 做唯一结构匹配。重复或被其他 extension
修改而无法唯一归属的消息保持原样，不能猜测 tag 归属。

`pi-mctx.temporal_awareness: true` 对齐上游 opt-in：当前 user message 与前一条带
时间戳 message 的间隔超过 5 分钟时，在该 user message 的 `§N§` 后插入
`<!-- +Xm -->`。该 marker 只用于模型可见的时间间隔，不写入 session；重复 context
pass 保持幂等。默认关闭，避免改变既有请求字节。

## 非记忆完整迁移

本 package 的目标是完整迁移上游 `cortexkit/magic-context` Pi plugin 的所有
非 memory 行为：context scheduler、cache TTL gate、tag/drop/replay、reasoning
cleanup、caveman text compression、tool-result nudge、todo state、historian
trigger、m0/m1 materialization、Pi native compaction marker、overflow recovery、
fork/clone、status、Sidekick、手动恢复 command 与生命周期清理。memory、embedding、
search、note、Dreamer 和它们的自动注入明确不在本迁移范围。

公开 command 采用本项目唯一入口 `/mctx <subcommand>`，不注册上游 `/ctx-*`
alias。迁移后的 subcommand 为 `status`、`flush`、`recomp`、`wrapup`、`upgrade`
和 `aug`；每项语义、取消、失败和缓存边界与上游对应 command 对齐。model tools
`ctx_reduce` 与 `ctx_expand` 采用上游的 selector 和恢复语义；旧 `pi-mctx`
tag-only `ctx_expand` 参数不保留兼容层。

Pi host 是 context 深拷贝和 native compaction 的 owner。`pi-mctx` 使用 source
entry ID 与完整 branch projection 建立稳定映射，不能依赖对象身份；在一次 context
pass 中，scheduler 先选择 defer/execute，再仅在 execute 或强制恢复时 materialize
会改变 prompt bytes 的 operation。pending drop、reasoning watermark、caveman depth、
compartment boundary 与 compaction marker 都需持久化并在 defer pass 原样 replay。
native compaction 一律由 `pi-mctx` 拦截；只有已验证 MCTX boundary 覆盖 pending
marker 后，extension 才调用 Pi host `appendCompaction()`。

```text
Pi context clone
  -> stable branch alignment
  -> cache scheduler: defer | execute | emergency
  -> replay durable tag/drop/reasoning/caveman state
  -> execute pending operations and historian materialization when admitted
  -> render m0 + m1 + protected live tail
  -> drain verified Pi compaction marker
  -> provider request
```

迁移按上述顺序完成。每一阶段先补 Pi host deep-clone regression，再加入对应 source
state migration；任何对齐失败保持 raw context 或明确阻断，不能猜测、静默丢弃或以
synthetic assistant message 替代 source transcript。

## Status Accounting Migration

状态 panel 的 token 分类、Work tokens 和 cache timing 由 `pi-mctx` 自己生产，
不依赖上游 Magic Context 的数据库或进程。现有 `context` hook 已拿到 Pi
实际送往模型的消息，因此在该边界统计 `System`、`Compartments`、
`Conversation`、`Tool Calls` 与 `Tool Defs`；每次 `turn_end` 更新 response
时间，MCTX store 持久化 work/cache 和分类 snapshot。panel 只读取
`MctxStatusResult`，不直接扫描 SQLite 或 session branch。

Work tokens 遵循上游 Pi 算法：每个 assistant usage 的
`input + cacheRead + cacheWrite` 形成 prompt；prompt 上升量与 output 累加为
`new work`，prompt 下降开启新 phase，各 phase peak 累加为 `total input`。
Cache TTL 默认 5 分钟，过期只由 `last response` 与当前时间计算，不启动新
timer 或改变既有 lifecycle。无数据的上游类别不显示，不伪造零值。

## 状态

已创建独立、可安装的 `@hheei/pi-mctx` package。默认 disabled，保持 Pi native behavior；`pi-mctx.enabled`
启用时，它在 `session_start` 打开/migrate MCTX SQLite store，并绑定当前 project/session partition。Historian 是
runtime 内的可选 producer：只有 `pi-mctx.historian.enabled` 与有效模型同时存在时，`turn_end` 才触发 historian
Completion。关闭 historian 不关闭 runtime、工具、status 或已验证 compartment 的 `context` 投影，也不产生新的
compartment。Pi host 会 clone context messages，因此 transform 对完整 live branch 做唯一的结构匹配；
零个或多个候选都 fail open，绝不替换。`ctx_reduce` 等 MCTX tool 只能在 active MCTX session 中执行；inactive runtime 时它们不在
Pi active tool set 或 Loadout inventory 中出现。它注册唯一 `/mctx` command；bare `/mctx` 与 `/mctx status` 打开只读 status surface。active runtime 还会发布 Parent compressed-context Service：
`pi-subagents` 在 `inherit_context: true` 时读取已验证 compartments 与 live tail；能力缺失、过期或
无效时保持其 Pi-native text fallback。

store adapter 在 Bun-based Pi host 使用 `bun:sqlite`，在 Node host 使用 `node:sqlite` 的 `DatabaseSync`。两者都不可用时，
store admission 按 `fail_closed_blocking` policy 明确失败或保留 Pi native context；extension module 本身不得因某一个
runtime-specific SQLite import 而无法加载。

### 记忆体系挂接状态（当前决策）

记忆体系（`ctx_memory`/`ctx_note`/`ctx_search` 工具、`/mctx dream`/`/mctx embed` subcommand、embedding provider
production 挂接与 Dreamer child 的 `ctx_search` 注入）按产品决策整体禁用：注册调用与挂接点在
`extension.ts`/`feature.ts`/`sidekick.ts` 中以注释形式 park（disabled behind the hook），代码与 focused
tests 全部保留，供 revival 时恢复；historian、history-tags、compartment projection、fork/handoff 与
Dreamer child 的四工具策略（`read`/`grep`/`find`/`ls`）保持 active。schema v11 的
`memory_embeddings` 迁移与 store 方法不受影响，`ctx_history` 仍注册（history-tag 清理属上下文管理域）。

### Loadout tool registration

`ctx_reduce`、`ctx_expand`、`ctx_history` 是当前注册的 executable tools（`ctx_memory`、`ctx_note`、
`ctx_search` 随记忆体系禁用而 park）。Pi host 保留三者的静态 definition，因为 host 不提供 unregister；但 `pi-mctx` 在
`session_start` 完成 runtime admission 后才把它们加入 Pi active tool set，并以 `Magic Context` group 发布动态 Loadout
inventory。runtime disabled 或 activation 失败时，三者从 active set 与 inventory 移除，因此不会进入 model tool list，也不会
显示在 Loadout。active runtime 中三者是 MCTX capability 的固定组成：Loadout 以 `forcedActive` 显示为 enabled/read-only，忽略
任何 global/project `pi-loadout` override，用户不能单独关闭或修改它们。`pi-ext-core` 负责 static registration、managed-tool
识别、动态 inventory、`setManagedLoadoutToolsActive()` active-set 切换与 reload 时同 owner replacement；`pi-mctx` 只保留
runtime admission、参数校验和 session/store ownership。该 ext-core helper 是其他 concrete extension 可复用的 capability bundle
seam：它只接受同 owner 已静态注册的 tools，active 时保留其他 Pi tools 并加入 bundle、注册 lifecycle inventory，cleanup 或
inactive 时移除 bundle。`forcedActive` 是 transport metadata；`pi-loadout` 解释为只读 policy，不让 ext-core 拥有任何 persisted
selection。缺少 `pi-loadout` 时，helper 仍通过 Pi host active set 执行同一可见性与强制启用策略。

## MCTX Settings registration

### Historian 模型选择

Historian model 与 `pi-auto-title` 使用同一套 ext-core 模型选择字段。Settings 页面只列出 Pi model registry 中已配置认证的
模型，保存值仍是精确的 `provider/model` 引用；用户通过上下键在选项间循环，而不需要手动输入 provider 或 model id。
模型选项由 Pi host 在每次 lifecycle start 时注入，provider 不拥有 registry，也不改变 MCTX 的 user-level 配置和 reload-only
生效语义。缺少可用模型时显示 `Not set`，Historian 启用时原有严格校验仍会阻止无效配置保存。

### 核心直觉与目标

MCTX runtime 与 Historian 是两个独立 policy。Historian 不是 model-callable tool，也不是 Loadout resource；它只是在
已启用的 MCTX runtime 中生产新 compartment。`pi-mctx` 把 runtime 开关、Historian 开关与模型配置注册进统一 Settings
provider tree，使用户无需手改 JSON；保存后在下一次 Pi `/reload` 或新 session 生效，不热切换正在运行的 runtime 或 historian。

### 边界与生命周期

- **Pi host** 提供当前 session identity、Settings command context 与 model registry；不解释 MCTX 配置。
- **ext-core** 已有 runtime-scoped `HepiSettingsRegistry`、provider contract 与原子 JSON root update，API 足够，无需新增
  Historian-specific abstraction。
- **pi-settings concrete extension** 继续拥有统一 Settings page、field editing、validation flush 与 router surface；不 import
  `pi-mctx`。
- **pi-mctx concrete extension** 在 lifecycle start 注册 `HepiSettingsProvider`，即使 runtime 当前 disabled/invalid 也注册，
  否则用户无法从 Settings 修复配置。provider 拥有字段 schema、现有 `pi-mctx` global JSON 映射和 reload-only 语义；
  lifecycle cleanup 注销 provider。
- **Surface** 复用 Settings page；无新 page、widget、timer 或 background work。project settings 仍只能手动做 opt-out/提高阈值，
  Settings provider 只写 user-level `~/.pi/agent/settings.json`。

```text
/ext-settings
      ↓
pi-settings combined tree ──► pi-mctx runtime + historian provider draft
      ↓ validate + atomic save
~/.pi/agent/settings.json["pi-mctx"]
      ↓ next /reload or session_start
loadMctxConfiguration() ──► resolve runtime ──► active / inactive
                                      │
                                      └── optional historian admission
```

### 字段与存储

Settings 的 `pi-mctx` group 显示：

- `enabled`：boolean，默认 `false`；控制 MCTX runtime、store、partition、工具与 projection。
- `smart_drops`：boolean，默认 `false`；仅在 runtime enabled 时可编辑。开启后在 context 到达 execute
  threshold 时自动回收旧的、未受保护的 tool result，并保留可通过 `ctx_expand` 恢复的 marker source。
  它是 user-level policy，project settings 不可覆盖。
- `historian.enabled`：boolean，默认 `false`；只控制 `turn_end` 的摘要 producer。
- `historian.model`：仅在 runtime 和 historian 都开启时可编辑，保存前要求 exact `provider/model`；认证/可用性仍由下一次
  historian admission 通过 Pi host model registry 检查。

provider 用一个 MCTX-owned custom storage adapter 把 flat Settings state 映射到 `enabled`、`historian.enabled` 与
`historian.model`。保存必须保留 trigger、protected tags、failure policy、`search`、`embedding`、`dreamer` 等所有 sibling；
关闭任一开关不删除 model 或其余配置，便于稍后恢复。此处采用 clean cutover：旧的仅有 `historian.model` 配置不再隐式开启
Historian。高级 threshold/protection/failure policy 继续由现有 JSON contract 管理，不在首版 Settings 中激活第二套编辑面。

### 最小实现 seam 与 focused tests

新增 `createMctxSettingsProvider()`，在现有 `registerExtensionLifecycle()` 的 start 中通过
`getHepiRuntimeSettingsRegistry()`/`registerHepiSettings()` 注册；provider storage 直接复用 ext-core 的
`readJsonSettingsRoot()`/`updateJsonSettingsRoot()`。`feature.start()` 继续只消费 `loadMctxConfiguration()`，不引入第二套 live
configuration path。

focused tests 覆盖：disabled runtime 仍注册 provider；shutdown 注销；独立开关、dependent enabled state 和 cross-field
model validation；flat state 与现有 nested JSON 双向映射；runtime-only session 不获取 completion coordinator、不调用
Historian 但继续投影已提交 compartment；全部 sibling 不丢失；并发 settings writer 不覆盖 sibling；provider 不提供 live
`onChange` callback；真实 Settings registry smoke test 可发现 `pi-mctx` provider。

## Parent compressed-context Service

### 目标

启用 MCTX 的 parent 启动 child subagent 时，child 应继承已经验证的 compartment 和未压缩 tail，而非重新展开已覆盖
raw history。没有可用 MCTX 投影时，行为必须完全回退为 `pi-subagents` 现有的 Pi native inheritance 文本。

### 边界

- **Pi host** 持有 parent `ExtensionContext`、session branch 和 child session 创建。
- **ext-core** 仅导出 runtime-scoped `ParentContextProjectionService` capability/key；它不解释 MCTX record、SQLite 或
  prompt policy。
- **`pi-mctx` concrete extension** 在 active session lifecycle 内提供 capability；`prepare({ purpose, signal })` 每次重新验证
  current branch 和 compartment graph，并返回 `unavailable`、`stale` 或 purpose-specific `result`。
- **`pi-subagents` concrete extension** 只在 `inherit_context: true` 时消费 inheritance result；不会 import/read MCTX SQLite。
  capability 缺失、`unavailable` 或 `stale` 时调用既有 `buildParentContext()`；已选择 result 的异常必须显式失败，不能转 native fallback。
- **Surface/widget** 不参与此路径；没有新 UI、timer、background work 或 persistent cross-session state。

```text
parent Agent tool
      │ inherit_context
      ▼
pi-subagents ── prepare(inheritance) ──► ext-core capability ──► active pi-mctx
      │ unavailable/stale                                          │ validated preamble
      ├── buildParentContext() ◄────────────────────────────┘
      ▼
child initialMessage = inherited preamble + task
```

### 最小公开 seam 与测试

ext-core 的 service key 固定为 `@hheei/pi-mctx/context-projection@1`。inheritance result 的 payload 已是完整、
model-facing preamble；consumer 只拼接 task，不解析、缓存或修改它。provider 必须以当前 `sessionManager` identity 绑定请求，
不能为 fork、reload 前 runtime 或其他 session 返回内容。

focused tests：active provider 返回 compartment + live tail；abort/stale graph/错误 session 返回明确状态；`pi-subagents`
使用 service 输出；provider 缺失/unavailable/stale 时 byte-for-byte 保持现有 fallback；已选择 result 的错误会终止调用。

## Handoff/compaction integration

`/handoff` 在 `waitForIdle()` 后向 provider prepare handoff plan。absence、unavailable 或 stale 才执行 Pi native compact
并写入 native summary。已选择 plan 则直接创建 replacement session，绝不调用 native compact 或写入 `hepi-handoff`；
`install(destination, signal)` 在 setup 中完成 pending `ctx_reduce` replay、destination binding、hidden-entry ordering 与
same-destination idempotency。plan 的 prepare/install error 必须显示 operation error，不能改走 native fallback。新 session
也不会继承旧 session runtime 或 lease。

启用的 MCTX runtime 同时独占当前 parent session 的 Pi compaction。`session_before_compact` 拦截手动 `/compact`、阈值自动
compact 和 overflow recovery；它不会让 Pi 用另一套摘要重写 MCTX 已验证的 compartment 边界。MCTX 只有在
current branch、partition revision、compartment graph 和 live-tail boundary 都再次验证成功时，才通过 `session_before_compact`
返回 MCTX `CompactionResult`，让 Pi host 在**同一 session**调用 `SessionManager.appendCompaction()`：summary 只包含 MCTX
`m0`/`m1` payload，`firstKeptEntryId` 指向 live tail 的首项，
因此 Pi host 负责保留 tail，MCTX 不重复注入它。marker 标记为 `{ source: "pi-mctx" }`，重复或已覆盖到相同/更新 boundary 的
请求不再追加 entry。

这不是 handoff install 的变体：handoff 将 projection 绑定并写入 replacement session；same-session compact 不创建 session、
不写 `mctx-parent-context`，也不修改 SQLite 的 handoff binding。MCTX active 但尚无有效 compartment、branch 已变化、store
读取失败或 runtime 已清理时，hook 才取消 Pi native compact 且不写 marker，保持 MCTX 的 fail-closed ownership；下一次
验证成功的 MCTX compact 才可回收 host context。

## Composite lexical search（首版）

`ctx_search` 只能在五个 source 都有明确索引、privacy、retention 与 exclusion contract 后注册；不得以 SQL
`LIKE` 或当前 session 的部分数据占用同名 tool。Pi host 只传入 tool request 与 active `ExtensionContext`；
`pi-mctx` 负责 source admission、bounded retrieval、去重与结果渲染。首版必须在同一五-source set 上执行
deterministic lexical ranking，不启动 backfill、timer 或网络请求。它不是 SQL `LIKE` table scan；每个 source 先在
自己的 privacy boundary 内收集 bounded snapshot，再统一 token ranking、stable source/identity tie-break、exact dedupe 并渲染
hit。dedupe 先按 source/identity 折叠，再按 exact source-text content hash 折叠；保留 score 更高、再按 source/identity
更靠前的 hit，不做 fuzzy collapse。

```text
ctx_search request
      ↓
pi-mctx validates active project/session and exclusions
      ↓
memory | note | retained history | Git | primer adapters
      ↓
lexical ranking → bounded rendered hits
```

候选 source contract：

- **memory**：只取当前 project 的 active record；archive 立即不可检索。identity 是 project/memory ID/revision/content
  hash。`MCTX_MEMORY_EXCLUSION_SERVICE` 是 ext-core runtime-scoped exclusion seam：memory injection owner 按
  project/session 返回已见 ID，`ctx_search` 每次调用前读取并排除它们。service 缺席明确表示本 session 没有 memory
  injector；provider throw、返回非数组或非法 ID 时 search tool 返回 error，不能以未过滤结果 fail open。
- **note**：只取当前 session 的 active note；identity 是 session/note ID/revision/content hash。hit 只显示同 session
  的 validated anchor，不能泄露另一 session note。
- **history**：project 内 retained tag source 可跨 session 查询；identity 是 project/session/tag/entry binding/content hash。
  fork 复制出的 source 按各自 partition 独立保留。新增 user-owned `ctx_history` 的 list/purge action，purge 只删除
  caller 明确指定的非 active project session，绝不删除 live tag ledger；没有自动 TTL。
- **Git**：只索引当前 project identity 的 committed hash、subject、author、timestamp 与 body；不读 diff、working tree、
  refs 外部仓库或 remote。每次 explicit search 以 HEAD fingerprint 刷新 bounded candidate snapshot，child process 归 tool
  abort signal 所有；Git failure 只移除该 source。
- **primer**：只读 user-level `pi-mctx.search.primer_path` 指定的 project-relative regular text file；缺失、越界、binary 或
  read failure 只移除该 source。identity 是 normalized path/content hash；不自动发现文件。

ranking 对每次 bounded source snapshot 先取 lexical 候选，以 stable source/identity 顺序打破 tie。embedding semantic
rerank 是后续独立 slice：它只能重排同一已 admitted candidate set，不能改变 source、privacy、retention 或 exclusion，
也不复用 memory embedding ledger 作为跨 source index。

首版 public tool 为 `ctx_search`：`query` 必填；`sources` 可选为 `memory`、`note`、`history`、`git`、`primer`
的无重复子集；`limit` 默认 20、最大 50。结果只返回 bounded hit 的 source、stable identity、title 与 excerpt。active
session 的 live history 永不作为 history source；当前 MCTX 不自动注入 memory，未来 injection owner 必须在自己的
runtime 中提供 `MCTX_MEMORY_EXCLUSION_SERVICE`，不能把该 policy 交给 model 参数。

## 聚合命令入口（`/mctx <cmd>`）

### 用户意图与边界

MCTX 用户只需记住一个 slash command：`/mctx`。**Pi host** 注册并呈现 command 与参数补全；**pi-mctx**
拥有 subcommand 路由、参数验证、notification 和既有 feature 调用；**ext-core** 不需要新增 command abstraction，
surface 与 historian lifecycle contract 均不改变。`ctx_reduce`、`ctx_expand`、`ctx_history` 是 model tool，
不属于 slash command rename。

当前保留四个已实现的命令名，但不注册旧 `/ctx-*` alias：

- `/mctx status`：打开既有只读 status surface，不接受额外参数。
- `/mctx flush`：立即确认已排队的 `ctx_reduce` tag drop；下一次 context projection 读取已确认的状态。
- `/mctx recomp`：丢弃当前 session 的已发布 compartment，并以当前 live branch 强制启动一次单飞 Historian 重建。
- `/mctx wrapup [messages_to_keep]`：强制启动一次 Historian，并保留末尾至少 N 条消息所在的完整 turn group；省略 N 时保留
  一个完整 turn group。MCTX 的 compartment source 不拆 user/assistant turn，因此当 N 落在 turn 中间时会保守地多保留同组消息。

`flush`、`recomp` 与 `wrapup` 只对 active MCTX session 生效。Historian disabled、unavailable、已有 run 或没有可压缩完整
turn 时，它们返回明确 notification，不启动隐式 background work；`recomp` 在已有 Historian run 时只保留最新 branch snapshot，
并 abort 旧 run，待其 cleanup 后再启动 replacement，始终保持单 writer。

记忆体系仍处于 park 状态，因此 `embed` 不进入 completion、不执行，也不能借本次 command migration 恢复其 production hook。

### Autocomplete、suggestion 与失败语义

`/mctx` 使用 Pi host 原生 `getArgumentCompletions`，这是 Pi terminal editor 的 autocomplete 与 autosuggestion contract。
空 prefix 或首个 token 的部分 prefix 返回 canonical lowercase subcommand；每项同时提供 `label` 与可见 `description`，使
suggestion 能解释行为。`wrapup ` 后建议常用的安全保留值 `2`、`4`、`8`、`16`；未知 prefix 返回 `null`。bare `/mctx` 直接打开
status；未知 subcommand 与无效参数给出带 canonical syntax 的 usage notification，不调用对应 feature。

迁移采用 clean cutover：只注册 `/mctx`，不保留旧 command alias，避免 Pi command palette 出现两套入口。
focused tests 必须覆盖唯一注册名、空/部分/未知 prefix suggestions、description、`wrapup` 数字 suggestions、四条 dispatch、
参数拒绝，以及旧 command 未注册。bare `/mctx` 等同 `/mctx status`，为最常用的只读入口提供快捷路径；未知 subcommand 仍只显示
canonical usage。

## Dreamer manual command（`/mctx dream`，当前 park）

### 目标

手动 command：用户输入 `/mctx dream [query]` 时，`pi-mctx` 同步运行一个受限 read-only child（仅 `read`/`grep`/`find`/`ls`）
评估当前 project 的 pending `smartCondition` notes（可选自由 `query` 追加关注点），返回评估报告并 notify。
评估是只读的：不注入 context、不改 note 持久化状态、不改 store；`smartCondition` 仍只是 pending text，
没有后台 poll、evaluate 或 schedule。这是 legacy project Dreamer task runner 的 manual entry 现代等价；
`evaluate-smart-notes` 的 scheduled lease domain 属于 core 未来 `task` trigger，首版不迁移。

### 边界

- **Pi host**：command dispatch；child `AgentSession` 由 shared read-only child factory 创建。
- **ext-core**：subagent execution contract（`startSubagent` task mode、shared coordinator budget、terminal
  delivery、parent-session 清理）。schedule/cron 是 core 未来 trigger，首版无 scheduled Dreamer。
- **pi-mctx**：恢复记忆体系时注册 `/mctx dream` subcommand；拥有 shared read-only child factory 与 prompt 编译
  （smartCondition 列表 + 可选 query）；不 import `pi-subagents`、不注册 agent type。
- **pi-subagents**：不参与本次 child 执行。

### child factory 与 model 解析

shared read-only factory：builtin `read`/`grep`/`find`/`ls`，`noExtensions: true`；system prompt 换为 Dreamer
评估指令；`maxTurns` 3、deadline 60s。

child model 解析顺序：user-level `pi-mctx.dreamer.model`（exact `provider/model` ref）配置时，经
`context.extension.modelRegistry.find()` 解析并要求已配置 auth——找不到或无 auth 时 command notify error
（显式配置必须明确生效或失败），不使用 parent model 静默回退；未配置字段时 child 用 parent 当前模型
（`context.model`）。project settings 一律忽略 `dreamer` 的 model 字段（model 是 user 偏好）。
该字段仅在 Dreamer 行为存在时启用，不构成空配置面。

### 报告语义

child terminal output 作为评估报告 notify 展示（截断到 `DREAMER_REPORT_CHARS`，4,000 字符）；不注入
context、不改 note/store。失败/abort/timeout 或既无 smart notes 又无 query 时 notify 明确状态。

### 公开行为

`/mctx dream [query]`：未启用 pi-mctx、inactive session 或非 tui → notify error；query 可选（≤500 字符）；
无 query 且当前 session 无 active `smartCondition` notes → notify empty；否则同步等待 child 完成并 notify 报告。

### 最小公开 seam 与测试

- feature 暴露 `dream(query, context)` → `{ kind: "reported", summary } | { kind: "empty" | "inactive" |
  "cancelled" | "failed", ... }`；command handler 薄封装。
- focused tests：inactive 不 spawn；无 smart notes 且无 query → empty；有 notes → spawn + reported；
  query 编译进 child prompt；不改 note/store 状态；abort 调 cancel 返回 cancelled；admission throw 归一化
  failed；显式 model 配置解析与不可用失败。

## Project memory embedding backfill（`/mctx embed`，当前 park）

### 目标

手动 command `/mctx embed`（无参）：同步遍历当前 project 的全部 active memories，跳过已嵌入且 content hash
匹配当前 provider model 的项，批量 passage embedding 剩余项，结束 notify 汇总；abort 绑 lifecycle/caller
signal；同一 active runtime 的 per-project busy 状态拒绝并发运行。这是 legacy project compartment backfill
的现代等价——backfill 对象是 durable memories（现代 compartment graph 是 transform 产物，不持久化向量）。
首版不做自动 GC/retention、不做 semantic search、不做跨进程 SQLite lease。

### 边界

- **Pi host**：command dispatch。
- **pi-ext-embed**：provider lease、`embed`/`embedBatch`、generation fencing（已实现）。
- **pi-mctx**：恢复记忆体系时注册 `/mctx embed` subcommand；拥有 backfill 遍历、coverage 判定、批量调用与 store ledger 写回；复用既有
  `writeMemoryEmbedding` 单事务 content/revision fence（stale 结果静默丢弃）。
- 无 provider（`pi-mctx.embedding` 未配置或 acquire 失败）→ notify error；provider 可用性不影响 backfill
  之外的 MCTX 行为，也不参与 `fail_closed_blocking`。

### 行为

- `/mctx embed`：tui 检查；inactive 或当前 runtime 无 embedding lease → notify error；同 runtime 已有 backfill
  在运行 → notify busy（process-local，不跨进程加锁：重复 work 可容忍，fence 保证 stale vector 不可能发布）。
- 分页读 `listActiveMemories(projectIdentity)`；coverage 判定：store 的 `listMemoryEmbeddingCoverage` 返回当前
  model identity 已嵌入的 `memory_id → source content hash`，active memory 的当前 hash 不在其中或不同 → 待嵌。
- `embedBatch(items, "passage", signal)` 分批（`EMBED_BACKFILL_BATCH_SIZE`，16）；每项成功结果经
  `writeMemoryEmbedding` fence 写回（source 已变返回 false 计为 skipped，provider 返回 undefined 或 throw 计为
  failed 并继续）；已写回结果在 abort 后保留。
- abort（lifecycle/caller signal）中途 → 返回 cancelled；不设独立 wall-clock deadline：backfill 是长时批处理，
  deadline 会误杀大 project，single-batch hang 由 provider 的 signal 契约负责（future multi-process lease slice
  再引入 batch deadline）。
- 结束 notify 汇总 `embedded` / `skipped` / `failed`。

### 最小公开 seam 与测试

- feature 暴露 `embedBackfill(context)` → `{ kind: "done", embedded, skipped, failed } | { kind: "busy" |
  "inactive" | "cancelled" | "failed", ... }`；command handler 薄封装。
- focused tests：inactive/无 lease 不跑；busy 拒绝并发；coverage 跳过已嵌项；embedBatch 调用与 fence 写回；
  abort 中途返回 cancelled 且已写回保留；汇总计数正确。

## `/mctx status` migration design

### 用户意图

`/mctx status`（以及 bare `/mctx`）是只读的单页 TUI overlay：用户打开它，是为了快速判断当前
context-management runtime 是否 active、当前 partition 是否健康，以及下一次
维护动作可能何时触发。它不恢复已 park 的 memory system，也不把旧 legacy
status 的所有指标搬进来。本节记录当前已迁移并可用的行为。

### 边界与公开 snapshot seam

- **Pi host**：提供 usage、theme 与 custom UI admission；不拥有 MCTX 状态或
  snapshot 解释。
- **ext-core**：提供 `openTuiSurface`；拥有 surface admission 后的 FIFO、
  abort 与 cleanup 语义；不新增 status 专用 abstraction。
- **`pi-mctx`**：拥有 context-management domain 的 snapshot、render 与刷新；
  只在 active context-management runtime 可用时提供 status 数据。
- **consumer**：surface renderer 消费一次 snapshot 并按本节字段显示；不读
  SQLite、不推导指标、不缓存跨 surface 状态。
- **public seam**：`MctxFeature.status(context): MctxStatusResult` 返回受界限、
  只读、可渲染的 status snapshot；store 通过
  `readStatusMetrics(partition)` 提供其 context-management metrics。snapshot 至少
  携带 active/inactive reason、context usage、project/session identity、
  partition revision、compartment m0/m1/total、tag active/pending/dropped、
  historian disabled/unavailable/idle/running/cooling/rebuild-pending、last failure class、effective
  trigger thresholds、protected tags。
- **fallback**：admission、snapshot 或 render 数据不可用时，关闭 surface 并
  保持 Pi native behavior；inactive 只显示明确 reason，不伪造 zero metrics。
  未选择 MCTX snapshot 的路径不得恢复 memory、note、Dreamer、embedding 或
  其他已 park behavior。

### 显示字段与非目标

状态页只显示 current snapshot 实际拥有的字段，不推导、不补零，也不把
inactive/stale/failed 当作 healthy。固定 17 个 content rows 采用 legacy-like
顺序：第一行是 `⚡ Magic Context Status` 加 active/inactive/failed/stale runtime
state；随后是 blank separator、muted `Context` label、`Context  pct · used /
limit tokens` 与 full-width usage bar；再是 blank separator、`Counts:`、compartment
的 `m0`/`m1`/`total`、muted `Tags` label、tag 的 `active`/`pending`/`dropped`
与 protected tags；再是 blank separator、`Historian:`、historian
`idle`/`running`/`cooling`/`rebuild-pending` 与 last failure class、effective
trigger thresholds、partition revision。最后两行
只在 wide 显示 `Project` 与 `Session` identity，窄屏保留为空。字段缺失时保留
对应行但不伪造值或 legacy 指标。

Context usage bar 只使用单一 semantic status token：低于 65% 为 `success`，
65%–80%（不含 80%）为 `warning`，80% 及以上为 `error`；不复刻 legacy 的
category colors。旧 legacy UI 的 fact、memory、note、Dreamer、embedding、
upgrade、cache、work-token、category-breakdown 指标均为非目标；本 migration
不新增这些指标，也不改变 memory system 当前 parked 状态。

### Surface lifecycle、刷新、关闭与并发

`/mctx status` 通过 `openTuiSurface` admission 打开单页 overlay；surface host
  使用 `hostId` 与 `maxPending` 参与 admission；只有 admission
成功后才启动 1 秒刷新。刷新读取最新 snapshot，不能让行位移；关闭由 `Esc`、
`Enter` 或 `Ctrl+C` 触发。关闭、cancellation/abort、surface replacement 与 extension
lifecycle 都必须停止刷新并执行一次 cleanup；cleanup 不删除 MCTX state。

surface 只允许一个当前 status overlay。FIFO admission、snapshot 刷新与关闭
遵循 ext-core owner 的 abort/cleanup contract；过期或并发中的 snapshot 不得
覆盖更新版本，关闭后完成的 refresh 结果必须丢弃。`pi-mctx` 不启动 admission
前后台 timer，也不把刷新变成跨 session 或跨 process 的持久任务。

### Fallback 与验证尺寸

overlay 为 centered、single overlay，外层使用 rounded `borderMuted` frame，
可用时宽度固定为 78 columns；窄于此值时随 terminal width clamp。总高固定
20 行：outer top + 17 content rows + footer + outer bottom；active/inactive/
failed/stale 保持同高。宽屏最后两行显示完整 project/session identity，窄屏
明确保留两行空白，不挪用给其他字段。footer 为 `Press Escape to close ·
Enter / Ctrl+C also close`。刷新仅在 admission 成功后每秒进行，且不改变行位。
布局、semantic tokens、关闭提示与稳定行位移以根 `DESIGN.md` 为准；设计验证
尺寸为 48x20 与 100x24。

## 完整迁移目标

`pi-mctx` 的最终目标不是停在首个 context pipeline，而是替代 `@hheei/pi-magic-context@0.33.1-hepi.0`
baseline。完成定义是：所有仍被 HEPI 用户依赖的 MCTX 行为都有独立 owner、明确的持久化/取消/并发 contract、
focused tests 和可安装 package entry。deprecated `@hheei/hepi-mctx` wrapper 已移除；它的
Loadout、reminder、subagent accounting bridge 不构成 MCTX migration scope。

迁移追求 behavioral parity，不追求旧 package API、tool 名称、settings key、SQLite schema 或 persisted state 的
binary compatibility。需要导入旧数据时，另立带 backup、validation、rollback 规则的数据迁移 feature；不能在
新 runtime 中隐式读取旧 state。

## 完整迁移 TODO

以下 checklist 是当前唯一 migration roadmap。`[x]` 表示实现和 focused verification 已完成；`[ ]` 表示尚未
开始或尚未达到完整 contract。每个未完成项开始前都必须更新本文、完成 focused design discussion、先写测试，再实现。

- [x] 独立 `@hheei/pi-mctx` package、显式 enable/model admission、user-level SQLite context store、project/session
  partition、revision CAS、lease、compartment graph、parent historian、repair/retry、trigger、context transform 与
  same-session branch divergence rebuild。
- [x] **Fork partition projection**：在 Pi fork 的 `session_start` 识别 source partition，验证并复制 child branch
  可见 ancestor compartments 到新的 partition；copy failure fail open，child 后续 rebuild，绝不共享 parent state。source
  session 从 child header 的 `parentSession` 经 Pi `SessionManager.open()` 读取 ID/cwd，再解析 source project identity；
  显式 Pi fork 可以跨 project copy，因为 child 已持有同一 raw branch。仅连续、通过 child branch range/fingerprint
  proof 的 records 可复制；missing source、source revision stale、invalid graph、destination 已存在或 SQLite error 都必须保留
  empty/existing child partition，不能阻止 session start 或读取 parent SQLite state。
- [x] **Pipeline diagnostics**：为 cooldown-eligible historian failure 提供 model-invisible native notification
  和 structured log。
- [x] **Host verification**：以 `packages/pi-mctx/test/host-lifecycle.node.ts` 自有的 hermetic headless Pi fixture 加载真实
  `DefaultResourceLoader`、`AgentSession` 和 MCTX extension；deterministic faux historian 必须验证 context transform、fork、
  reload 与 historian failure notification/diagnostic。执行 `bun run test:host`，先 build dist 后以 Node `node:test` 运行，
  因为 Bun 不实现 production `node:sqlite`。不以网络模型替代四项严格 lifecycle assertion；`tui-replay` 不能代替这些
  host lifecycle cases。
- [x] **Parent-to-child compressed-context Service**：`pi-mctx` 用 ext-core Service 发布 opaque、validated parent
  history projection；`pi-subagents` 只在 `inherit_context: true` 时消费并组装 child prompt。缺席、过期、失效或空值都
  byte-for-byte 保持 Pi native inheritance fallback，consumer 不读取 MCTX SQLite。
- [x] **Handoff projection integration**：provider absence、unavailable 或 stale 使用 native compact；selected MCTX plan
  直接创建 replacement session，不调用 compact 或写 native summary。provider install 写入 opaque non-displayed entry，
  负责 pending drop replay、destination binding 与 idempotency。
- [x] **Session-history tag ledger 与 transform**：建立 `N -> immutable Pi identity` 的 session-local ledger、immutable
  source retention、protected tail、pending/deferred drop、branch/reload/fork proof 和 marker projection；不能用 raw message
  dump 或即时删除替代。
- [x] **`ctx_reduce`**：`pi-mctx` 直接注册此 tool，写入 tag-ledger pending operation；只接受 current active branch 的非保护
  tag，下一 context transform 才投影 marker。disabled runtime 或不合法 selector 返回明确 tool error，不修改 Pi JSONL。
- [x] **`ctx_expand`**：从 current partition retained source 读取一个或多个 `N`/`N-M` tag 的受界限内容；它接受 all
  status tag、对 valid selector partial output，并明确列出 rejected selector。`offset`/`limit` 作用于 tag-order
  rendered result，default/max 均为 30,000 characters。它不读取别的 session/fork partition，不修改 tag status，也不把
  source 自动重新注入 model context。
- [x] **`ctx_history`**：显式列出或清理 current project 内非 active session 的 retained history tag source。
  `list` 默认排除当前 session，可按旧 `session_id` 过滤并分页；`purge` 必须提供旧 `session_id`，store 层拒绝删除
  current session live tag ledger，且不提供 project-wide purge。它不是 search source 注入，也不读取其他 project。
- [x] **Durable memory**：迁移 `ctx_memory` 的 project scope、category、archive、privacy、source provenance 与
  cross-session visibility。它是 user-level durable state，不复用旧 SQLite schema，也不让 project config 或 child session
  取得写权限。
- [x] **Durable notes**：`ctx_note` 以 session-local record CAS 保存 anchor、read/update/dismiss 与 provenance；smart
	condition 仅持久化为 pending text。Dreamer-dependent evaluation、surface trigger 与 stale cleanup 必须等 Dreamer
	feature，不把 cron/polling 偷渡进 tool。
- [x] **Composite lexical search**：已迁移 `ctx_search` 的五-source lexical retrieval；它跨 memory、note、session
  history、git commit 与 primer，并过滤 active-session live history 与 `MCTX_MEMORY_EXCLUSION_SERVICE` 提供的已见
  memory。每个 source 都必须有验证过的 index/privacy/retention contract；不以 SQL `LIKE` 或部分 source 占用同名 tool。
  semantic rerank 另行迁移，且只能重排同一 admitted candidate set。
- [x] **Todo ownership decision**：legacy `todowrite`/`/todos` 不迁入 `pi-mctx`，由独立 `@hheei/pi-todo` 拥有
  `todo` tool、`/todos` command、task state、reminder 和 widget。MCTX 不重复注册 Todo；旧 aggregate 的 removal 与
  `pi-todo` release 配套处理，避免 Pi first-registered tool collision。
- [x] **Pipeline maintenance commands**：已决策 legacy `/ctx-flush` 在 current transform 下没有独立行为，
  `/ctx-recomp`/`ctx-session-upgrade` 是旧 ordinal/schema migration 而不迁移，`/ctx-wrapup` 属于 future
  `hepi-basics` handoff/compaction owner；这些 pipeline maintenance action 不迁移，也不注册任何 maintenance
  command。
- [x] **`/mctx status` 单页只读 TUI overlay**：已按 [`/mctx status` migration design](#mctx-status-migration-design)
  迁移；snapshot、字段、surface lifecycle、刷新、关闭、并发与 fallback 已达到该章节及根 `DESIGN.md` 的完整
  contract。
- [x] **Dreamer 与 embedding commands**：legacy `/ctx-dream`、`/ctx-embed` 的 manual behavior 已迁移并随记忆体系
  park；恢复时以 `/mctx dream`、`/mctx embed` 暴露，不恢复旧 command 名。scheduled
  Dreamer 等待 core 未来 `task` trigger，backfill 的自动 GC/retention 与 semantic search 仍待 retrieval consumer。
  - `/mctx dream [query]`：manual Dreamer child（仅 `read`/`grep`/`find`/`ls`）评估 project 的
    pending `smartCondition` notes，可选 query 追加关注点；报告只 notify、不注入 context、不改 note/store 状态。
    child model 由 user-level `pi-mctx.dreamer.model`（exact `provider/model`）指定，未配置时用 parent 当前模型；
    显式配置不可用则 command 明确失败。abort/admission 归一化与 `runMctxChildTask` 骨架处理。
  - `/mctx embed`：project memory embedding backfill——分页遍历 active memories，按当前 provider model identity 的
    coverage（`listMemoryEmbeddingCoverage`）跳过已嵌入项，`embedBatch` 分批嵌入剩余项并经既有
    `writeMemoryEmbedding` 单事务 content/revision fence 写回；abort 绑 lifecycle/caller signal，已写回保留；
    process-local per-project busy 拒绝并发；结束 notify `embedded/skipped/failed` 汇总。不自动 GC/retention、
    不做跨进程 lease（fence 保证 stale vector 不可能发布，重复 work 可容忍）。
  - embedding storage 基线（上轮）：user-level `pi-mctx.embedding` 配置存在时，activation 动态 import
    `@hheei/pi-ext-embed` 并 acquire provider lease；`ctx_memory` write/update 启动 detached、abortable passage
    embedding，经 provider snapshot 与 content/revision fence 写入 per-model `memory_embeddings` ledger，
    archive 同事务删除该 memory 的 vector；provider 缺失/失败不影响 memory write，也不参与 `fail_closed_blocking`。
    共享 capability、multi-process fencing、provider lifetime 与公开 API proposal 见
    [`docs/architecture/embeddings.md`](../architecture/embeddings.md)。
- [ ] **Historian-adjacent services**：按已验证需求设计 Dreamer、embedding provider、background maintenance、search
  index 与 retention/data-management。自动 TTL prune、shutdown deletion 或语义删除在得到明确 retention contract 前保持禁止。
- [ ] **Reserved configuration activation**：逐字段启用当前 opaque 的 upstream-shaped configuration，定义 user/project
  scope、runtime validation、default、reload semantics 和 invalid-value fallback；不得因保存过某字段而隐式开启 feature。
- [x] **Installer migration 与旧 wrapper retirement**：独立 package entry、安装文档和 Loadout ownership 已迁移；
  deprecated `@hheei/hepi-mctx` wrapper 与 aggregate bundle 中的重复注册已移除。wrapper bridge 不迁移。

完成 migration 前，不得宣称 `pi-mctx` 已替代 Magic Context。每个 checkbox 需要独立 commit；跨 package contract
change 还必须更新 `docs/architecture/` 和相关 ADR。

Legacy `@hheei/pi-magic-context@0.33.1-hepi.0` 的首次 public-surface inventory 见
[研究记录](../research/pi-magic-context-0.33.1-inventory.md)。它是已发布 bundle 的证据索引，不是旧 API compatibility
承诺；后续 feature 只能以其确认的用户行为为输入，不能从内部 SQLite table 或 bundle private helper 推导新 contract。

### Historian diagnostics

Historian terminal `failed`/`invalid` 会产生无 source/context payload 的 structured event：partition identity、failure
class、completion attempt 和 lease terminal outcome。默认 sink 使用 `console.warn` 写 JSON，安装者可将 stderr 接入其
日志系统；测试可注入 sink。Pi native warning 只显示 failure class 和保留旧 context 的事实，不显示 provider error
message。相同 class 在一次 session 内只通知一次，直到下一次 successful publication rearm；每次 terminal failure
仍写 structured event。lease-held、lease-loss、caller cancellation、stale CAS 和 raw branch rebuild 属于预期并发/取消
结果，不触发用户 warning。unexpected runner throw 记录为 `unknown`、attempt `0`，同样不输出异常文本。真实 Pi host
或 `tui-replay` 的可见行为验证尚未完成。

### Session-history tag ledger

`ctx_reduce` 与后续 `ctx_expand` 共用一个 session-local ledger。用户和模型引用短 selector，例如 `` 或 `8`；
SQLite 永久绑定到 immutable Pi identity，不能以 tag number、文本值或 entry position 定位 source。tag number 仅在一个
MCTX partition 内递增，不能跨 session、fork 或 project 使用。

每个可投影 payload 获得一个 tag：message text、tool call/result aggregate、以及 file/reference descriptor。text 和
可展示 tool output 在 model-visible content 中使用严格 legacy 前缀 `§N§ `；file/reference 的 retained source 只保存
可序列化 descriptor（例如 URL、media type 与 name），绝不复制 binary attachment。tool aggregate 的 immutable binding
包含 owner assistant entry ID 与 tool-call ID，避免不同 assistant turn 的相同 call ID 发生碰撞。

ledger 为每项保留 immutable source copy，供 future `ctx_expand` 在 reload、Pi compaction 或 source branch 不再暴露原 entry
后恢复。source copy 不自动注入、不能跨 partition 读取，且在独立 retention/data-management contract 出现前不会自动过期或
删除。

`ctx_reduce` 只把 validated selector 写为 pending operation。manual 与 automatic drop 都只接受 verified compartment
`liveTailStartIndex` 之后的 current Pi active-branch tag；automatic candidate 还必须在 imminent context 中存在 exact tool-result
identity。已经由 compartment 覆盖的 source 必须拒绝，不能留下无法 materialize 的 pending record。下一次 MCTX `context` transform 在当前 Pi active branch 重新验证
entry/tool identity、tag status 与 protected tail 后才将目标内容替换为严格 marker `[dropped §N§]`；raw Pi JSONL 永远不被
改写。默认 `protected_tags` 为 20，user-level setting 只接受 1–100，project settings 无权改变它，reload 后生效。受保护、
已 dropped、未知、别的 branch/fork 或无法证明 identity 的 tag 必须拒绝，绝不按 position 猜测删除。

所有 active MCTX tools（`ctx_reduce`、`ctx_expand`、`ctx_history`）的 tool output 都以严格的
`[magic context]` 开头，随后直接给出对应 operation payload。只有 `ctx_reduce` 输出 `pending: #N, ...` 和
`rejected: #N, ...` queue summary；它不预先把 queued tag 声称为 dropped，marker materialization 后的实际
dropped tag 只由后续 context projection 确认。`ctx_expand` 直接给恢复 source，`ctx_history` 直接给 list/purge
payload，错误也不伪造无关的 tag count。

### Smart drops 设计基线

Smart drops 让 MCTX 在上下文压力下自动回收已经不再需要的旧 tool result，补足 model 未调用
`ctx_reduce` 时的可用性。它与 compartment historian 不同：historian 压缩完整、稳定的历史 turn；smart drops
只将仍在 live tail 中、可证明身份的单个 tool result 替换为可恢复 marker。两者可以在同一 context pass
先后发生，但任一方失败都不影响另一方或 Pi native context。

固定上游 `@hheei/pi-magic-context@0.33.1-hepi.0` 的可见配置是 user-level
`pi-mctx.smart_drops`。它必须是 boolean，缺省为 `false`，且 project settings 不得启用、禁用或改变策略；保存后在
下一次 `/reload` 或新 session 生效。这样与上游 `smart_drops === true` 的 opt-in 语义一致，也避免用户仅启用 MCTX
runtime 时不知情地扩大自动丢弃范围。

**Core intuition and goal:** 用户在 context 接近 configured execute threshold 时，仍可看到最新工作、用户意图和
assistant reasoning；系统只回收较早且已完成的 tool result，留下 `[dropped §N§]` marker，模型需要原文时仍可通过
`ctx_expand` 显式读取 immutable ledger source。

**Boundary mapping:** Pi host 提供 imminent context messages、branch identity 与 token usage。`pi-mctx` concrete
extension 拥有 candidate planning、SQLite CAS、marker projection、status metric 与 session-local cooldown；它不调用
model、不创建 background job，也不改写 Pi JSONL。ext-core 不认识 tag、drop 或 MCTX policy。Surface/widget 不参与
reclaim；status surface 只读取 MCTX 已提交的 metrics。runtime disabled、`smart_drops: false`、unknown usage、stale
partition、branch mismatch 或 store read failure 都 fail open，保留未修改的 Pi context。session shutdown/reload 取消当前
pass 后不保留内存中的 plan；只提交成功 CAS 的 `pending`/`dropped` 状态。

```text
Pi context pass + usage at/above execute threshold
        |
        v
pi-mctx reads current branch + tag ledger
        |
        +-- invalid/stale/no candidate --> raw projection unchanged
        |
        v
plan old unprotected tool-result candidates by estimated reclaim
        |
        v
queue active -> pending with partition CAS
        |
        v
existing identity-verified transform projects [dropped §N§]
        |
        v
mark pending -> dropped with partition CAS
```

**Eligibility and ordering:** planner 先读取并验证 compartment graph；只有 graph 的 `liveTailStartIndex` 之后、当前
imminent context 中仍以 exact tool-result identity 出现的 `kind: "tool"` active tag 才是候选。invalid/rebuild graph
不进行 automatic reclaim。候选再排除 newest `protected_tags` active tags。它永不
automatically drops user messages, assistant text/tool-call messages, references, image/file descriptors, pending/dropped tags,
or any tag whose source/branch identity cannot be proven. Candidate estimated reclaim is derived from retained textual source with
a deterministic conservative estimator。上游可安全证明的 supersession rules 先选择：零值 metadata tool、保留最近一个的
`todowrite`、保留最近五个的 `ctx_reduce`，以及有可证明 file path 的旧 edit result；随后按 tag number oldest-first
选择 remaining candidate，直到 configured target reclaim 达成。相同候选只选一次；无法回收正值时不写 mutation。

The emergency target is derived from the same model-aware execute threshold already used by historian. When live input is at or
above that threshold, smart drops target enough eligible tool-result source to return below the re-arm threshold
(`threshold - 10 percentage points`, plus the existing absolute-threshold guard where configured). Cooldown starts only after the
queue CAS accepts at least one tag; no candidate, a stale CAS, or rejected candidates leave it armed for a later eligible pass.
The planner makes at most one successful automatic plan for an unchanged Pi usage sample; it re-arms only after the lower threshold
This avoids repeated marker writes while Pi reports stale usage after a transform. upstream private tool-tier ranking、
system-injection stripping 和 caveman text rewriting 仍不迁移：这些需要更宽的 tool metadata，或会改写 user-visible text。
reasoning clearing 已迁移为 Pi-safe typed/inline replay；它只使用 durable branch entry identity，redacted blocks 不改写。

Manual and automatic requests share the same atomic queue primitive but preserve intent. Manual `ctx_reduce` keeps its current
behavior and may target any eligible tag. Smart drops pass only its planner output to that primitive. On the following context
pass, both use the existing immutable-identity marker transform; a failed projection leaves the tag pending for a later proven
branch pass rather than silently considering it dropped. `ctx_expand` continues to expose retained source for active, pending and
dropped tags without reinjecting it.

**Implementation seam and focused tests:** `planMctxSmartDrops()` 接收 branch-proven active tags、verified live-tail
candidates、resolved threshold 和 `protected_tags`，返回 deterministic no-op 或 tag numbers plus estimated reclaim。Feature
`onContext` owns graph validation, one-session cooldown and the existing store queue/marker path；store 不推断 candidates。
Tests cover disabled/default behavior, protected-tail exclusion, tool-only/live-tail eligibility, supersession ordering,
cooldown admission, stale CAS, branch divergence, projection failure/retry, manual/automatic deduplication, and `ctx_expand`
recovery after an automatic marker。host lifecycle tests cover Pi runtime admission, projection/reload, forks, historian failure
fallback, and handoff. Smart-drop marker materialization remains covered at the feature/context-hook seam until the host fixture
can drive a real tool-result turn through `AgentSession`.

### `ctx_expand`

`ctx_expand` 只接受同一 selector grammar 的 `N`/`N-M` range。它读取 current active MCTX partition ledger 中 immutable
source copy，允许 `active`、`pending` 和 `dropped` status；source 除显式 tool result 外绝不重新进入 model context。unknown、
other-partition 或 malformed selector 绝不按 entry position 猜测：malformed selector 返回 tool error，valid selector 仍按
tag-number order 返回，ineligible selector 单独报告。

tool 的可选 `offset` 与 `limit` 作用于完整 rendered result，而不是逐 tag pagination。`limit` 的 default 和 maximum 都是
30,000 characters。truncated result 报告 next offset；它既不改 status，也不将 source 恢复到 active context。`ctx_expand`
绝不读取另一 session/fork partition，也不让 retained source 提供给 background work、cross-extension Service 或 automatic prompt
injection。

### Durable memory

`ctx_memory` 首版只在 active parent `pi-mctx` session 中工作；disabled runtime 和 child session 返回明确 tool error。memory
属于一个 stable project identity，任何解析到同一 identity 的 parent session/worktree 可按 ID 读取；其他 project、fork 或
child session 永不取得 read/write capability。它不是 automatic prompt injection：只有显式 tool call 返回 memory content，
future child retrieval 必须另行定义自己的 privacy contract。

首版 action 为 `write`、`get`、`update`、`archive`，category 固定为 `PROJECT_RULES`、`ARCHITECTURE`、`CONSTRAINTS`、
`CONFIG_VALUES`、`NAMING`。`get` 仅接受 project-local ID，避免在 search/index contract 前提供 unbounded list；`archive`
保留 source/provenance，不提供 delete/restore/merge。每条 record 保存 creator/last-writer session ID、timestamps 和 monotonic
revision。`update`/`archive` 必须带 `expectedRevision`，stale revision 返回 tool error，绝不 last-writer-wins 覆盖另一
session 的 edit。

### Durable notes

`ctx_note` 只在 active parent `pi-mctx` session 中工作。notes 属于 stable project identity 下的单一 parent session，
不能由其他 session、fork 或 child read/write；它们也不自动进入 model context。首版 action 为 `write`、`read`、`update`
和 `dismiss`。`read` 默认返回 active notes，可显式读取 dismissed notes；dismiss 保留 note、anchor、condition 与 provenance，
不提供 delete 或 restore。

可选 `anchorTag` 只能引用 current active branch 的 MCTX history tag。runtime 先将该 session-local ordinal 解析为 immutable
Pi entry ID、kind 与 tool-call ID，再写入 note；未知、旧 branch 或其他 session tag 明确失败，绝不把 ordinal 直接持久化。
每条 note 记录创建/更新 session ID、timestamps 和 record revision；`update`/`dismiss` 必须带 `expectedRevision`，避免静默覆盖。

可选 `smartCondition` 仅作为 pending text 保存。首版不 evaluate、poll、auto-surface、expire 或 cleanup smart notes；这些行为
属于未来 Dreamer ownership，不能在 tool mutation 中隐式启动后台工作。

## 目的

`@hheei/pi-mctx` 将成为 HEPI 对父 Pi 会话进行上下文管理的唯一 owner。未来它可以维护摘要、
compartment 和父会话长期上下文，并为子代理提供经过父会话压缩的继承内容。

它不是旧 wrapper 的 adapter 或重命名；旧的 `@hheei/hepi-mctx` wrapper 已移除。

`pi-mctx` 的目标是 behavioral parity：保留已确认的用户可见上下文管理结果，但不兼容旧 package API、
tool/command 名称、配置键、存储格式或已持久化 state。

## 边界

### pi-mctx

- 未来拥有父会话的 MCTX state、压缩决策、compartment、持久化和取消。
- 未来在 `inherit_context` 请求中提供父会话已压缩的历史内容。
- 不拥有 child agent、model、tool、worktree 或 delivery policy。

### pi-subagents

- 拥有 child session 的创建、agent/model/tool/worktree policy 和 prompt 组装。
- child 默认使用 Pi 原生自动 compaction。
- child 不运行 MCTX historian、memory、note、持久化、状态或 MCTX tools。
- 未来只在 parent `pi-mctx` 可用时消费其继承内容；未安装或 provider 明确过期时，保留
  Pi 原生 branch inheritance。

### pi-ext-core

- 只提供 runtime-scoped lifecycle、cleanup 和 first-provider-wins `Service` 协调。
- 不认识 MCTX state、摘要格式、Pi branch shape 或 child prompt。
- 不为当前单一 consumer 预建 MCTX 专属 contract、opaque boundary 或 projection helper。

跨 package 的 future inheritance provider 使用 `@hheei/pi-ext-core` 既有 Service 发现机制。
provider 和 consumer 分别声明相同的 namespaced service ID，不互相 import。provider 负责从
当前 parent branch 取得自身所需的压缩前缀与 tail；`pi-subagents` 只把结果放入自己的 child prompt。

### 预留的跨扩展 projection API

`/handoff` 是 `hepi-basics` 的未来独立 command，不属于 `pi-mctx`。为避免每个 consumer 读取 MCTX SQLite 或
解析 compartment XML，`pi-mctx` 将来只发布一个窄的 runtime-scoped projection capability。它服务两个已定义的
consumer：`hepi-basics` 的 handoff 与独立 `pi-subagents` 的 inheritance；memory、notes、search 或任意第三方
extension 不得借此取得 MCTX state，未来各自需要独立 capability。

projection 有明确的 feature-neutral 中间层价值时，可以在第二个 installable consumer 出现前创建窄 Service key
或 provider-only runtime；不得因此扩大为 MCTX state 的通用读取入口。届时相关 package 通过 `pi-ext-core` 的
Service 使用同一预留 ID `@hheei/pi-mctx/context-projection@1`；MCTX runtime 是唯一 provider，first-provider-wins，
生命周期 cleanup 自动撤销。以下是 contract 的设计基线，不是当前可 import API：

```ts
import type { SessionManager } from "@earendil-works/pi-coding-agent";

interface MctxContextProjectionService {
	prepare(input: {
		readonly purpose: "handoff" | "inheritance";
		readonly signal: AbortSignal;
	}): Promise<MctxContextProjection | undefined>;
}

type MctxContextProjection =
	| {
			readonly purpose: "inheritance";
			/** Opaque content; consumer appends it verbatim in its own child prompt boundary. */
			readonly payload: string;
	  }
	| {
			readonly purpose: "handoff";
			/** Installs the opaque hidden entry and atomically binds destination state. */
			install(
				destination: Pick<SessionManager, "getSessionId" | "appendCustomMessageEntry">,
				signal: AbortSignal,
			): Promise<void>;
	  };
```

`prepare()` snapshots only committed, graph-validated compartments plus the MCTX-owned protected tail. It never exposes
SQLite rows, source branch entries, revision internals or an editable summary. `handoff.install()` is idempotent for the
same destination session; it owns hidden-entry ordering and the destination marker that prevents fork projection from
duplicating the already materialized parent graph. It must not leave a durable destination marker when installation fails
or its signal aborts. Each operation is tied to the caller signal and parent lifecycle; concurrent handoff preparation for
one parent partition is rejected rather than publishing competing destination mappings.

No provider, disabled MCTX, no eligible committed projection, or an explicitly stale artifact resolve to `undefined` and
make the consumer use its Pi-native fallback. Once an enabled provider returns a plan, malformed payload, store failure,
or installation rejection is an operation error: consumer must surface it and must not silently switch to native fallback,
because doing so can lose an already chosen MCTX projection. Consumers never await `waitForService()` inside `session_start`;
they own cancellable continuation and fallback policy.

## Package 约定

`packages/pi-mctx` 的首版只包含一个 Pi extension entry。它直接依赖
`@hheei/pi-ext-core`，并以 Pi packages 为 peer dependency。core 提供 Pi settings JSON 的 locked file transport；
SQLite 使用 Node 内建 `node:sqlite`，不引入 SQLite npm dependency。它不得依赖：

- `@hheei/pi-magic-context`；
- 任何 concrete HEPI extension。

没有 session resource 时，extension entry 不注册空 lifecycle。真正创建 resource 的功能必须通过
`registerExtensionLifecycle()` 取得 session-scoped owner，并将取消和 cleanup 注册到该 owner。

## 首个行为里程碑

package skeleton 后，首个实现是 parent session 的 context pipeline：将符合条件的 history 组织为
compartment，并向后续 parent turn 注入确定性渲染结果。它不实现 memory、note、search、Dreamer、embedding、
command、status 或 UI。

context pipeline 的 canonical state 是 MCTX-owned SQLite context store。它保存 parent session 的
compartment graph；Pi session branch 保留 source transcript 与 host compaction entry，但不是 MCTX 摘要的
canonical source。选择 SQLite 而非只依赖 Pi compaction entry 的理由见
[ADR 0005](../adr/0005-pi-mctx-owned-context-store.md)。

context store 是 user-level shared DB，按 stable project identity 与 Pi session identity 分区。多个
worktree 或 Pi process 可以安全打开同一个 DB；一个 partition 的 compartment 只能由其原 parent session
读取，不能作为跨 session shared state 复用。Pi fork 只复制有效 ancestor state 到新的 child partition。

project identity 优先使用 `git:<root-commit>`，使同一 repository 的 worktree/clone 对齐；non-git project 使用
`dir:<SHA-256(realpath)>`。transient Git failure 只能复用当前 process 的 last-known Git identity，否则使用
directory fallback；permission-denied 不可靠地界定 project boundary，拒绝 activation 并呈现 diagnostic。identity
不得来自 remote URL 或 development-machine absolute path。

context store 位于 `<getAgentDir>/mctx/context.db`。它与 global settings file 分开，不能放入 project/worktree，
也不能依赖开发机绝对路径。

store 使用 SQLite WAL、短事务和 busy timeout。每个 partition 维护 monotonic revision；写入必须比较预期
revision，冲突时重读并重算，不能以 last-writer-wins 覆盖较新的 compartment。

store 提供 revision CAS primitive：调用者提交当前 partition snapshot，成功时得到 revision 加一的新 snapshot；若
conditional update 未命中则得到 `undefined`，必须重新读取/recompute。CAS 不写 compartment 内容，后续 publication
会在同一 transaction 内组合 payload write 与该 revision fence。

schema v3 增加每个 partition 一个 historian lease。worker 使用唯一 owner token 获取 finite TTL；持有者可在到期前
renew 或 release，错误 token 不能影响其他 worker。expired lease 可由新 worker 在短 transaction 中替换；未拿到 lease
的 process 跳过本次 historian run。当前 historian run 会在 active 时续约 lease；具体 terminal semantics 见后文。

schema v4 增加 immutable compartment records：partition、`m0`/`m1` tier、source entry range、source fingerprint、
rendered payload 与 publication revision。`publishCompartment` 仅接受当前 partition snapshot，并在一个 transaction 内插入
record 和推进 revision；stale snapshot 不写任何 record。read API 只返回当前 partition 的 revision-ordered records。
结构、coverage、graph validation 与 historian output mapping 是当前 publication fence 的组成部分。

draft validator 不序列化或猜测 Pi message。它只接收 ordered source entry IDs 与该 immutable snapshot 的 fingerprint：
draft 必须使用 `m0`/`m1` tier、匹配 fingerprint，且 start/end ID 必须在同一 snapshot 内按 source order 形成 inclusive
range。跨-tier merge topology、historian JSON mapping、repair prompt 与 publication policy 由 historian publication
path 执行，不能由 store schema 推断。

source snapshot 从 `sessionManager.getBranch()` 的 active branch 顺序读取 entry IDs；它验证 nonempty/unique ID，并以
SHA-256(JSON entry-ID array) 生成 fingerprint。snapshot 不序列化 message content，避免在未确认 Pi entry shape 前把
lossy projection 当 canonical source；后续 historian mapper 必须保留这份 source branch 与 snapshot fence。

historian output mapper 只接受 exact JSON object：`tier`、`sourceStartEntryId`、`sourceEndEntryId`、`renderedPayload`。
它拒绝 Markdown fence、extra key、错误 type 或 invalid JSON；不信任模型提供 fingerprint，而是注入 immutable source
snapshot 的 fingerprint，再调用 source validator。mapper 的 stable invalid reason 可直接进入一次 repair Completion；
mapper 本身仍不调用 Completion 或 publish。

historian executor 使用 ext-core `startSubagent(..., { mode: "completion" })`，只提供 no-tools JSON-only completion。
caller 提供 source text 与 immutable snapshot；executor 将 ordered entry IDs 和 exact output schema 放入 prompt，并将 core
terminal result 规范为 completed/cancelled/failed。run-local abort 会 cancel handle；executor 不重试、不 repair、不获取 lease，
也不 publish record。

historian orchestrator 是显式 async function：以 current partition snapshot 获取一次 finite lease，运行 primary completion，
mapper invalid 时仅以 diagnostic 运行一次 repair completion，然后用同一 snapshot 原子 publish。lease acquisition failure
返回 skipped；CAS conflict 返回 stale，不重试；任意路径在 `finally` release lease。active run 续约 lease；仅 core
结构化分类为 `transient` 的 provider failure 可在同一次 lease 内最多重试两次，retry delay 使用 cancellable jitter。
它不做 trigger 或 Pi context rendering。

source-history projection 从 `sessionManager.getBranch()` 的 ordered `SessionEntry[]` 工作，使用 Pi
`sessionEntryToContextMessages()` 作为唯一 entry-to-message projection。一个 complete turn group 从 user message 开始，
包含直到下一 user message 前的所有 entries，且必须以 assistant message 收尾；最新 complete groups 保留为 protected tail。
eligible groups 的 entry IDs 建立 source snapshot，canonical projected messages 用 JSON source text 交给 historian；不自行猜测
Pi content block 或 tool-result shape。

branch runner 只组合 source-history projection 和 historian orchestrator。caller 提供 active branch entries、current runtime
partition/model/store 与 abort signal；ineligible projection 不取 lease、不调用 model，eligible projection 交给同一 explicit
orchestrator。parent `turn_end` 使用已实现的 token-pressure policy 调用该 seam，但 handler 不 await background job。

默认 compartment trigger 在 parent `turn_end` 检查 token usage 的 threshold 与 hysteresis。越过阈值后，
`pi-mctx` 异步执行一次 compartment run；handler 不 await historian。job 使用 session-local
`AbortController`，`session_shutdown` 或 `/reload` 先 abort job、再 close store。它只处理稳定 history
snapshot，不能阻塞 prompt、改写 active turn，也不能在 parent session replacement 后发布旧结果。

每次 parent model invocation 在 `pi.on("context")` 从 context store 读取最后一个已 materialize 的
cache-stable context block，替换即将发送的 Pi messages，并将 live tail 裁剪到 compartment boundary。in-flight
historian 不会阻塞本次 invocation；它完成后的新 revision 只在后续 context pass 生效。`pi-mctx` 不把 summary
物化为 Pi compaction entry，也不插入 synthetic conversation message。这保持 source transcript、MCTX canonical
summary 与 model-visible rendered context 三层分离。

首个 pipeline milestone 不在 `before_agent_start` 追加 MCTX system-prompt block。该 surface 只在未来出现
guidance、memory、docs 等 system adjunct 时单独设计。

开启 Historian 时，它必须有显式、形状有效的 model config，负责把 history snapshot 写成 compartment；它不隐式复用
parent agent model。Historian 关闭时，active runtime 不产生 compartment、不获取 completion coordinator，也不调度
`turn_end` 或 rebuild 工作；已提交且仍通过 graph 验证的 compartment 继续投影。Historian runtime authentication 或
model-availability failure 仅拒绝 Historian admission，保留 active runtime 与上次 committed context。

parent historian 是 `@hheei/pi-ext-core` 的 Completion consumer。`pi-mctx` 提供已解析的 historian
model 与 prompt policy；core 负责 completion 的 admission、execution、timeout/abort、terminalization 和
dispose。`pi-mctx` 不直接调用 Pi AI，也不启动 `pi-subagents` child。

Historian admission 前，`pi-mctx` lifecycle 配置或复用 core exported canonical coordinator budget（active `2`、pending
`16`、retained terminal `32`），与现有 core Completion consumers 对齐；SQLite lease 仍将 historian 限为每个 context
partition 一次。若已有 coordinator 使用不同 budget，只拒绝 Historian admission 并产生 diagnostic；MCTX runtime 不受影响。
MCTX 不直接调用 Pi AI，也不向 core 引入 implicit default。

pipeline 启用后，context store 无法 open、migrate 或通过 schema validation 时默认 fail closed：阻止 parent
turn 并呈现可操作的 storage error。用户可通过 `fail_closed_blocking: false` 显式 opt out，回退 Pi native behavior。
无 historian model config 属于可选能力缺席，不是 context-store failure。

store foundation 使用 Node `node:sqlite`。schema v2 新增 `projects` 和 `partitions`：partition 以 stable project
identity 与 Pi session ID 唯一标识，初始 revision 是 `0`。get-or-create 在短 `BEGIN IMMEDIATE` transaction 内保证
同一 key 只得到一个 partition；不创建 lease、compartment 或 context block。migration 从 v1 metadata fence 原子升级；
未知 nonempty database、foreign application ID 或高于当前版本的 schema 均拒绝打开。成功 store 是 session runtime
resource，shutdown 必须 close；enabled pipeline 的 open/migration/schema failure 先显示 storage error，再让 lifecycle
start fail，不能留下无 store 的 active runtime。

stable project identity resolver 独立于 SQLite：它先 canonicalize Pi `cwd`，再读取 Git reachable root commit，得到
`git:<commit>`，使 worktree/clone 对齐。non-Git directory 使用 `dir:<SHA-256(realpath)>`；raw path 不进入 identity
或 database。Git command transient failure 只可重用本 process 同一 canonical directory 的 last-known Git identity；
该 LRU cache 最多保留 64 个 canonical directory，淘汰后退回 directory identity；canonicalization permission failure 不能安全 fallback，拒绝 activation。resolver 本身不创建
project 或 partition row。

enabled session activation 在 store open 后解析 project identity，并以它和 Pi session ID get-or-create partition；
runtime 持有该 partition。identity 或 partition 失败会关闭刚打开的 store、呈现 storage error 并失败 lifecycle start，
不能留下未分区 runtime。runtime 后续在 `turn_end` 执行 historian，并在 `context` pass 使用该 partition 的 verified graph。

`pi-mctx` 自己拥有 HEPI/Pi-native configuration：user-level `pi-mctx` namespace 加 optional project `.pi`
override。保存配置不热改 active pipeline；extension 只在下一次 `session_start` 或 `/reload` 读取并应用。它不
依赖 `hepi-basics` settings provider，也不读取 CortexKit config 路径。

configuration 使用既有 Pi settings layout：global `<getAgentDir>/settings.json` 和 project
`<cwd>/.pi/settings.json` 的 `pi-mctx` section。两处都保存 raw schema，但 active runtime 使用 field-scoped merge：user
config 必须启用 runtime；project 只可 disable runtime，不可单独启用。Historian enablement/model、fail-closed policy 与
SQLite tuning 是 user-only；project 只能提高已由 user 设置的 trigger threshold，不能引入或降低 threshold。future reserved
field 必须在其 feature milestone 决定 scope，不能继承 blanket override。
它通过 atomic read-modify-write、process queue 和 file lock 更新，不能覆盖同一 settings file 的 sibling section；
它不与 SQLite context store 混用。

core 的 merged settings entry 同时提供 `global`、`project`、默认 project-wins `merged` 和 structured key path
来源查询，供不需要额外 trust policy 的 consumer 使用。MCTX 保留 raw layers 执行上述 field-scoped merge；不能以
默认 `merged` 允许 project 开启或选择 Historian，或改变 fail-closed policy。

迁移期保留完整 upstream-shaped MCTX configuration schema。当前 milestone 只读取已实现的 `enabled`、
`historian.enabled`、historian model、trigger budget 和 fail-closed policy；其余字段保存为 reserved/inactive，暂不产生
行为。它们不是 backward-compatibility promise；未来每项 feature 启用其字段时，代码必须用 `ponytail:` 注释说明
当前 inactive ceiling 与 activation trigger。schema baseline 固定为
`@hheei/pi-magic-context@0.33.1-hepi.0`；public CortexKit source 只能辅助研究，不能让 validation 跟随
upstream `master` 漂移。reserved/inactive values 作为 opaque JSON 保存；首版只 validation active pipeline
fields，不提前复制 Dreamer、embedding、experimental 等未实现 feature 的 runtime validator。

MCTX runtime 默认关闭。用户必须显式启用 `pi-mctx.enabled`；只有启用后才打开或 migrate context store、注册 context
transform，并进入 fail-closed storage contract。Historian 默认关闭且需要独立开启及配置 model。未启用的 package 不改变 Pi runtime。

若 `enabled: true` 但 `historian.enabled: true` 的 parent historian configuration 无效，`pi-mctx` 只拒绝
Historian admission：仍打开 store、注册 transform 并保留 runtime-only 行为，同时呈现 config diagnostic。它不是
context-store failure；用户修正配置并 reload 后才启用 Historian。

runtime activation 在 `session_start` 读取 config：disabled config 保持静默 native behavior；runtime config invalid、
store 或 partition failure 按既有 failure policy 处理。active runtime 随后只在 `historian.enabled` 时用 Pi
`modelRegistry.find()` 与 `hasConfiguredAuth()` 解析显式 historian model 并配置/reuse canonical coordinator budget；
Historian invalid、unavailable/unconfigured model 或 coordinator budget collision 显示 diagnostic，但不关闭 runtime。
shutdown 会清除 runtime holder。store/partition wiring、可选 `turn_end` historian 和 verified `context` projection 已附加。

已激活的 compartment trigger budget 使用 model-aware percentage threshold、absolute-token fallback/guard 和
hysteresis。具体 default 必须在 `pi-mctx` schema 与 focused tests 中固定；它不隐式追随会变化的 upstream
default。

trigger policy 是 pure state decision；parent `turn_end` 使用它但不改变配置读取。percentage 默认值为 `65`，并且必须在
`20..80`；known context window 时 trigger token threshold 是 `max(ceil(window * percentage / 100), absolute)`，
其中 absolute 可缺省。unknown context window 时只使用 absolute；两者都没有时结果为 unavailable。一次 trigger
将状态设为 cooling；cooling 仅在 usage 不高于 percentage threshold 减少 `10` percentage points，且（若配置）
不高于 absolute 的 `90%` 时 re-arm。usage、context window 和 absolute threshold 必须是正 safe integer。

context store 使用 upstream-aligned tiered graph：stable、cacheable `m[0]` history tier 加 newer
materialized `m[1]` tier，再接 compartment boundary 后的 live tail。context transform 将这三层组合为
model history；它不使用单一 rolling summary。

context transform 只处理已验证 graph。它使用 Pi `sessionEntryToContextMessages()` 重建 branch 的 raw
message sequence，并只在该 sequence 以 object identity 连续存在于 imminent `context` event 时替换 covered
segment；这样保留其他 extension 已注入的 messages。无法匹配时 fail open，不改 Pi context。replacement 使用两个
model-visible、`display: false` custom messages（`pi-mctx:m0`、`pi-mctx:m1`）和 branch live tail；每个 tier
payload 以稳定 order 拼接，timestamp 固定为 `0` 以保留 m0 cache stability。store read failure 仍遵守 enabled
pipeline 的 fail-closed contract。

canonical tier graph 以 `publishedRevision` 严格递增排序。每个 record 的 source range 必须在 current
branch 重新计算 fingerprint；相邻 record 的 range 必须连续、不可 overlap 或 gap，tier 只能从零或多个
`m0` 进入零或多个 `m1`，不得在 `m1` 后回到 `m0`。第一个 range 可以位于 Pi initial metadata 之后；
最后一个 verified range 的 end 是唯一 live boundary。任何不满足这些条件的 graph 不注入 model context，
而是保留 raw Pi history，等待后续 rebuild。后续 historian publication 必须从该 verified boundary 后
开始，不能再次覆盖已有 range。空 graph 的首个 publication 必须是 `m0`；已有 verified graph 的
publication 必须是 `m1`。成功 publication 返回的新 partition revision 成为该 session runtime 的下一次
compare-and-commit snapshot。

live tail 使用 token-budgeted recent complete parent turn groups。user input、其 assistant response 和关联
tool/result 不能被 compartment boundary 切开；只有 boundary 前的 eligible head 可以交给 historian。

Pi fork 在 `session_start` 创建新的 context partition，并从 source partition 过滤复制仍在 child branch 中有效的
ancestor compartments。复制失败 fail open，child 后续 compartment run 可 rebuild；forked child 绝不与 parent
共享 partition。

同一 Pi session 的 branch divergence 在每个 context transform 验证 stored source-range fingerprint 与
boundary。若不匹配，`pi-mctx` 原子失效 divergent compartments、保留可验证 ancestor，暂时传递 raw eligible
history，之后由 historian rebuild；不会新建 leaf partition，也不会注入 stale summary。

recovery planner 只把 range missing/reversed 或 fingerprint mismatch 视为可恢复 branch divergence：它从首个
失效 `publishedRevision` 起标记 tail，保留此前连续 verified graph，并给出 rebuild source start。gap、overlap、tier
regression 或 revision disorder 是 store corruption，不推测删除任何 record，继续 fail closed。无 verified ancestor
时，rebuild 从失效 range 仍可定位的 start 开始；若 start 不在 branch，则从 index `0` 重新评估完整 raw branch。
tail prune 与 partition revision compare-and-commit 在同一 SQLite transaction；stale snapshot 不删除任何 record，
caller 必须 reread 并重新 plan。

成功 prune 后，当前 context pass 保留 raw history，并立即安排一项 cancellable rebuild historian job，不等待普通
token trigger。若旧 branch historian 仍运行，先 abort 它并保留唯一 pending rebuild；旧 job terminal 后才启动新 job。
shutdown/reload 清除 pending rebuild 并 abort current job。

每个 context partition 使用 SQLite compartment lease 实现 historian single-flight。lease 有 finite TTL；run 每半个
TTL renewal，abort/shutdown/terminal path 均 release 最新 owner lease；其他 process 在持有期跳过该 run，crash 后可以在
TTL expiry 后接管。renewal 未命中代表 owner 已丢失 lease，orchestrator abort 当前 Completion、拒绝 publication，并在
`finally` release；lease 不替代 publication revision transaction。production interval 固定由 lease TTL 推导；测试可仅通过
historian request 的 private timing seam 缩短 interval，不能成为 user configuration。

首个 pipeline milestone 不对 context partition 做 automatic semantic deletion。可以进行 non-destructive
SQLite maintenance，但 TTL prune、shutdown deletion 和 user-facing data-management contract 都延后到独立 feature。

parent historian output 必须通过 structural、chunk coverage、protected-tail boundary 和 graph-invariant
validation 才能原子 publish。首次 validation failure 运行一次 repair Completion；repair 或任何 validation
failure 都保留上次 committed context，不写 partial state。

transient parent historian provider failure 最多进行两次 cancellable jittered retry。core 只根据数值 HTTP
`status`/`statusCode` 与标准 transport `code` 生成 retry classification；未能可靠分类的 error 不重试，不能从
message 文本猜测。abort、authentication、HTTP 400 或其他 client error、configuration error 与 validation
failure 不重试；validation repair 是独立的一次 Completion，且共享该 run 的总 retry budget。

首个 pipeline milestone 使用 model-invisible Pi native notification 加 structured log 报告 invalid config、
context-store failure 与 cooldown-eligible historian failure。它不注册 `/ctx-*` command、statusbar 或 custom
renderer。

parent-to-child inheritance Service 与 `pi-subagents` integration 不属于首个 pipeline milestone。该 milestone
不公开 service payload、不注册 provider，也不让 `pi-subagents` 读取 MCTX SQLite；parent transform/store/historian
须先独立通过 focused tests。

## 延后决策

- 具体 schema default、token accounting source、stable project identity，以及 SQLite schema/migration 版本；
- memory、note、search、Dreamer、embedding、command、status 和 UI 的具体行为；
- parent-to-child inheritance Service payload 和 `pi-subagents` integration；
- child `mctx-lean` historian profile。只有 Pi 原生 compaction 在长任务中被证实不足时，才单独
  提出该 profile；它不应成为 child 默认行为；

任何上述功能开始前，先更新本文档并完成 focused design discussion、测试设计和用户确认。
