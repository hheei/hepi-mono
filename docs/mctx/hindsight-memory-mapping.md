# MCTX 与 Hindsight 功能映射和被舍弃的能力

状态：设计说明，未进入实现。

关联设计：[Hindsight 与 MCTX 记忆架构](./hindsight-memory-architecture.md)。

## 核心模型

MCTX 与 Hindsight 不是两套竞争的记忆系统。它们处理不同问题：

```text
Hindsight = 长期知识库：项目长期知道什么
MCTX      = 上下文编译器：当前模型调用应看到什么
```

```text
Pi transcript
  = 原始对话真相

Hindsight bank
  = 长期知识真相

MCTX compartments/history tags
  = 当前 session 的可验证 context transformation

MCTX knowledge snapshot
  = Hindsight 知识的可替换 context cache
```

当前仓库仍有 `pi-mctx` 的旧 local memory/embedding/search/note/Dreamer runtime。它不是目标架构，
也不应继续作为兼容路径。本说明比较旧 local memory backend 与目标 Hindsight + MCTX 架构；目标是
完成一次显式 export/import（如用户数据有价值）后删除旧 schema、工具、tests、embedding 和 Dreamer，
不在 production 同时运行两套 backend。

## 用户入口

```text
/mctx        = 当前 session context、compartment、drop、historian、knowledge snapshot
/hindsight   = bank、scope、retain queue、session memory mode、explicit recall/reflect、mental models
ctx_expand   = 精确恢复当前 session 已 drop 的 raw source
hindsight_*  = 查询或保存跨 session 的长期知识
```

`ctx_expand` 与 `hindsight_recall` 不可互换：

```text
ctx_expand
  -> 根据 MCTX tag 恢复某次已 drop 的原始 tool/message source
  -> 精确、session-local、可验证

hindsight_recall
  -> 返回跨 session 的语义相关知识候选
  -> 不保证原文、顺序或单一 source
```

## 功能映射

| 旧 MCTX local memory backend | Hindsight + MCTX 目标 | 说明 |
|---|---|---|
| `writeMemory(content, category)` | Hindsight retain raw source -> facts/observations/models；MCTX 编译 selected projection | 不再把手写短文本当长期知识最终真相 |
| SQLite `memories` row | Hindsight bank/document/fact/observation/model | 长期知识 authority 移到 Hindsight |
| `memory_embeddings` | Hindsight embedding/retrieval | 删除 MCTX local vector、provider、backfill |
| local semantic search | Hindsight recall/reflect/pages | 不复制语义检索 |
| active memory list | Hindsight selected mental models/observations/pages | Hindsight 决定知识产品；MCTX 决定 context 预算 |
| category/importance | Hindsight tags/entities/product policy | MCTX 不再维护平行长期分类/排序系统 |
| `archiveMemory` | Hindsight source correction、staleness、provenance lifecycle | MCTX 不直接宣布长期事实失效 |
| deterministic memory render | MCTX knowledge snapshot render | 保留；MCTX 需要稳定 context bytes |
| session-local note | 旧 `ctx_note` 删除；显式 “retain this” 转为 Hindsight retain | 不保留第二套 note subsystem |
| Dreamer | Hindsight reflect | Hindsight 有完整证据和 consolidation 输入 |
| m0/m1 compartments | MCTX 保留 | session graph，不是长期 memory |
| smart drop / `ctx_expand` | MCTX 保留 | 精确历史恢复，不是 semantic recall |
| fork/handoff projection | MCTX 保留 | session/context lifecycle，不迁移到 Hindsight |

## 必须保留在 MCTX 的能力

```text
session compartment m0/m1
history tags
smart drop
ctx_expand
historian
context budget
provider prefix-cache stability
compaction recovery
fork/handoff
knowledge snapshot cache
```

这些能力必须与 Pi session entry、branch fingerprint、partition CAS 和当前 model context 对齐。
Hindsight 无法替代，例如 `ctx_expand 42` 必须恢复特定 tool output 的 raw source，不能改用语义 recall。

## 应由 Hindsight 唯一拥有的能力

```text
raw long-term evidence retain
retain queue / retry / dead-letter
embedding
facts / entities / observations
observation consolidation、contradiction、staleness
mental models
reflect
knowledge pages
跨 session / project / user bank scope
semantic recall
```

Hindsight 的优势不只是 vector search。它保留 source provenance，并能让长期知识随新增证据、矛盾和
时间变化演进。MCTX 不应重写这套 knowledge lifecycle。

## 正确的联合读取路径

```text
Pi raw session branch
  -> pi-hindsight retain
  -> Hindsight extract/consolidate
  -> selected mental model/page/observation/reflect projection
  -> MCTX knowledge snapshot
  -> stable model context
```

模型 context 的目标顺序：

```text
1. Hindsight knowledge baseline
2. MCTX m0：当前 session 较早历史压缩
3. MCTX m1：当前 session 较近历史压缩
4. protected live tail：未压缩的当前对话和工具结果
5. 当前任务相关的少量 cached knowledge page section
```

Hindsight knowledge 不进入 MCTX `m0/m1`。m0/m1 必须覆盖 Pi branch 的连续 source entry range，
Hindsight observation/model/page 没有该 source contract。

## 自动注入与反馈循环

Hindsight 当前 automatic context path 同时注入 mental models 和 raw recall。MCTX knowledge mode 启用时：

```text
MCTX claims context-injection gate
-> pi-hindsight stops automatic mental-model + raw-recall injection
-> pi-hindsight still owns retain, queue, bank, explicit tools and reflect
-> MCTX renders only validated knowledge snapshot/local sections
```

否则会发生两套自动知识注入、两套 token budget 和不稳定 prefix。

所有 MCTX-rendered Hindsight knowledge 必须带 shared injected-knowledge marker：

```text
provider: hindsight
sourceIds: [...]
retain: false
```

pi-hindsight retain projection 必须排除该 marker。避免反馈循环：

```text
Hindsight model/page
-> MCTX injects it
-> agent_end retain captures it again
-> Hindsight re-extracts the same knowledge
-> repeated amplification
```

Hindsight retain 必须读取 Pi raw branch/agent-end message sequence，不能读取 MCTX `context` hook 的
rendered projection。compartment、knowledge snapshot、drop marker、recall block 都不是 raw evidence。

## Context budget

MCTX 是最终 token budget owner。Hindsight 不直接决定多少知识进入 provider context。

```text
required system prompt and tool definitions
-> current user message / protected live tail
-> verified MCTX compartment m0/m1
-> knowledge baseline
-> knowledge delta
-> turn-local page sections
```

空间不足时：

```text
omit turn-local sections
-> trim/skip knowledge delta
-> use older validated knowledge baseline
```

不能为了注入长期知识而：

```text
trigger smart drop
force historian compaction
remove protected live tail
```

## 为了统一而舍弃、收缩或转移的功能

统一的原则不是“尽量保留每个 API”，而是每种能力只保留一个 owner。下表描述的是目标实现中
哪些现有能力会被删除、停止作为默认路径，或转移给 Hindsight。

### 直接删除：MCTX local long-term memory machinery

这些功能与 Hindsight 的长期知识能力重复，目标实现不再保留：

```text
MCTX local memory content authority
MCTX memory embeddings table
MCTX embedding provider lease
MCTX embedding queue/backfill/coverage maintenance
MCTX local vector search
MCTX local semantic ranking
MCTX local memory consolidation/observation logic
MCTX Dreamer as a second knowledge synthesis engine
MCTX local memory importance ranking as durable-knowledge policy
```

原因：保留它们会产生两套长期知识：一套由 MCTX 的 row、embedding、Dreamer 维护，另一套由
Hindsight 的 document、facts、observations、mental models 维护。两套结果会出现重复、冲突、
不同 scope、不同 freshness 和不同删除语义。

### 转移给 Hindsight：长期知识能力

MCTX 仍可以发起请求或提供用户入口，但不再拥有实现：

```text
raw evidence retain
retain queue/retry/dead-letter
fact/entity extraction
observation merge、contradiction、staleness
semantic recall
reflect
mental-model refresh
knowledge-page synthesis
project/global bank routing
```

用户看到的效果保留，底层 owner 改为 Hindsight。MCTX 只接收经过 scope、provenance 和 budget
验证的 knowledge projection。

### 停止默认：Hindsight 每轮 automatic recall

当前 pi-hindsight 的 automatic recall 会在 context path 同时注入 mental models 和 recall results。
启用 MCTX knowledge mode 后，这条默认路径停止：

```text
删除/关闭：每轮 remote raw recall
删除/关闭：每轮 automatic mental-model injection
保留：显式 hindsight_recall tool
保留：显式 hindsight_reflect tool
保留：agent_end raw retain
保留：retain queue、bank、scope、session mode、status
```

原因：MCTX 需要单一 context injection owner，避免双重 token budget、重复知识、不稳定 prefix cache
和每轮网络调用。Hindsight 仍完整提供长期知识能力，只把自动注入交给 MCTX knowledge snapshot
compiler。

### 从强同步改为 snapshot：知识即时注入语义

如果旧 MCTX local memory API 允许：

```text
write memory -> 下一次 context 立即可见
update memory -> 下一次 context 立即替换
archive memory -> 下一次 context 立即消失
```

统一后不再保证 Hindsight knowledge 的 read-your-write：

```text
retain queued/delivered
-> Hindsight extraction/consolidation
-> selected projection version observed
-> MCTX knowledge snapshot materialized
-> 下一次稳定 context 可见
```

这不是遗漏功能，而是从本地强同步 memory row 转为 Hindsight 的异步知识生命周期。MCTX 必须显示
queued、stale、unknown 或 unavailable 状态，不能伪装立即完成。

### 删除 MCTX note subsystem

旧 MCTX `ctx_note` 不保留为运行时 subsystem。它的 anchored note、dismiss、revision 和 branch identity
能力不迁移到 Hindsight；它们属于旧 memory/note API。

若用户明确要长期保存，改用 Hindsight explicit retain/knowledge workflow。若旧 note 数据有价值，
只在一次性 export/import 中保留，验证后删除旧 note 表和 command。

### 不再使用的 MCTX memory category/importance 语义

旧 local backend 的 `category`、`importance`、active list ordering 如果只服务于 local memory render，
统一后删除其长期知识含义。替代关系：

```text
category       -> Hindsight product/tags/scope policy
importance     -> Hindsight selection + MCTX context budget
active list    -> Hindsight selected projection
archive        -> Hindsight correction/staleness lifecycle
```

MCTX 仍可以有自己的 render priority，但那是 context placement policy，不是第二套 knowledge truth。

### 不迁移到 Hindsight：MCTX session context machinery

统一不意味着全部交给 Hindsight。以下功能不会被删除或转移：

```text
MCTX m0/m1 compartments
history tags
smart drop
ctx_expand
historian context compression
context token accounting
provider prefix-cache stability
compaction interception/recovery
fork/handoff projection
knowledge snapshot CAS/cache
```

原因：这些能力依赖 Pi branch entry sequence、session partition、source fingerprint、CAS 和当前
context projection。Hindsight 的 knowledge model 不能替代它们。

### 不再保留 production dual-read/dual-write

为比较效果，可以使用 export fixtures、isolated evaluation banks 和 benchmark harness。但 production
不同时读取或写入：

```text
MCTX local memory + Hindsight memory
```

比较完成后，旧 local memory schema、embedding、Dreamer 和相关 API 直接删除。若旧 durable 数据有价值，
执行一次显式 import/reconciliation，验证完成后删除旧路径；不保留运行时兼容层。

### 一次性 import 与删除 admission

旧 MCTX memory 数据只允许通过一次性 import 进入 Hindsight，不能在运行时持续同步。import contract：

```text
old memory ID       -> deterministic Hindsight document ID
content             -> retained source text with old-memory provenance
category/importance -> explicit retained metadata or documented discard
active/archive      -> documented Hindsight scope/correction policy
embedding           -> discard; Hindsight re-extracts/re-embeds
note                -> import only when user explicitly selects it
scope               -> current project bank only by default
```

每次 import 生成 receipt：source row count、selected rows、Hindsight document IDs、read-back scope check、
failures 和 skipped rows。只有所有 selected source rows 都可从 Hindsight read-back 验证、receipt 已持久化、
用户确认后，才允许删除旧 tables/API。失败 row 不得静默跳过，也不得为它们保留 production dual-write。
import 不自动升级任何旧 row 到 global/user/life bank；scope 扩大必须由用户逐条或显式 batch 确认。receipt
还记录 target bank、profile、redaction policy、update mode 和 import tool version，保证后续 correction/deletion
可追溯到 Hindsight document provenance。

## 旧功能删除清单

实现前应逐项确认：

```text
[ ] local memory row 不再是长期知识 authority
[ ] memory_embeddings 删除
[ ] embedding provider/queue/backfill 删除
[ ] local semantic search/ranking 删除
[ ] local Dreamer 删除，改用 Hindsight reflect
[ ] memory category/importance 不再决定长期知识
[ ] note -> project memory 的隐式升级删除
[ ] Hindsight automatic recall 与 automatic mental-model injection 关闭
[ ] production dual-read/dual-write 删除
[ ] ctx_expand、smart drop、m0/m1、historian、handoff 保留
```

## 数据边界与可逆性

区分三类影响：

```text
A. 原始证据丢失
B. 派生数据丢失或过期
C. 当前 context 不再显示，但原始数据仍存在
```

### 旧 MCTX local memory backend

| 操作 | 影响 | 可逆性 |
|---|---|---|
| `writeMemory` | 新增 SQLite row | 可删除；没有完整证据链 |
| `updateMemory` | 覆盖 content，revision 增加 | 旧 content 不在当前 row；需 DB backup 才能恢复 |
| `archiveMemory` | `status=archived`，删除该 memory embedding | 内容仍在 row；embedding 可从内容重算 |
| embedding publish | 覆盖旧 vector | 旧 vector 丢失，但可重算 |
| physical row delete | 内容、metadata 消失 | 不可逆，除非 backup |
| Dreamer report | 只读 report | 可丢弃，不改变 memory |
| note dismiss | 改 session note status | 内容是否可恢复取决于 note lifecycle API |
| smart drop | context 显示 marker | raw source 仍在 Pi transcript/history tags，可 `ctx_expand` |
| compartment replacement | 旧 summary 被新 summary 替换 | raw Pi session 仍在，可重新 materialize |

旧 backend 的主要风险是 MCTX 本地直接覆盖或 archive 唯一长期文本，没有 evidence/provenance/
contradiction lifecycle。

### Hindsight

| 操作 | 影响 | 可逆性 |
|---|---|---|
| retain append | 新 raw source 进入 queue/bank | 写入后可停止使用；派生 facts/observations 可能已存在 |
| retain replace | 同 document ID 更新 source | 新 source 可见；旧派生数据的 stale 时序由 Hindsight lifecycle 决定 |
| observation consolidation | 多证据合成 belief | 由新证据修正/stale；MCTX 不直接覆盖 |
| reflect | 生成 synthesis | 只作为 snapshot source 时可丢弃，不应自动成为长期真相 |
| mental model refresh | 更新长期综合模型 | Hindsight 管理版本/更新；MCTX 只读取已选 projection |
| recall | 只读查询 | 不修改知识 |
| page-section injection | 仅当前 provider context | 不写 transcript/knowledge，可逆 |
| queue dead-letter | retain job 留在本地磁盘 | 可 retry/delete/export；仍须按敏感 source 管理 |
| wrong scope/tag retain | source 进入错误 bank/scope | 高风险：已抽取 observation/model 可能需专门 correction |

Hindsight 最危险的不可逆操作不是覆盖一条文本，而是把错误或敏感 raw evidence 写入错误 bank/scope，
并让它影响派生 facts、observations 或 mental models。

## 联合架构的安全规则

### Drop 不等于 forget

```text
MCTX smart drop
-> only changes current context projection
-> does not delete Pi transcript
-> does not delete Hindsight document/observation
```

### Hindsight refresh 不得删除 compartment

```text
Hindsight source/version change
-> knowledge snapshot becomes stale
-> materialize a new validated snapshot
-> CAS publish replacement
```

Hindsight failure、scope mismatch、source-too-large 或 cancellation 时保留旧 validated snapshot。
knowledge snapshot publish 与 compartment publish 是独立 CAS。

### `ignored` 不等于 erase

Hindsight session mode `ignored` 表示：

```text
stop future read
stop future retain
stop future injection
```

它不删除已存在的 Hindsight bank/document/observation。真正删除、纠正或清除长期知识必须使用 Hindsight
明确的 document/bank/provenance 操作，不能由 `/mctx` 隐式完成。

## 最需要谨慎处理的操作

```text
1. retain 错误或敏感 raw source 到错误 Hindsight bank/scope。
2. 物理删除 Hindsight source/document，且没有 export/provenance。
3. 删除 Pi session transcript。
4. 删除唯一 history tag source，导致 ctx_expand 无法恢复。
5. 删除旧 local MCTX memory 数据前，未完成并验证一次性 Hindsight import。
```

下列操作必须设计为可重建、可替换或仅影响当前 context：

```text
smart drop
compartment replacement
knowledge snapshot replacement
page section injection
recall
reflect result render
```
