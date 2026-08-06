# MCTX 与 Hindsight 功能映射和数据边界

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

当前 `pi-mctx` 的 local memory/embedding/search/Dreamer runtime 已 parked。它的 schema、测试和
工具接口仍在，但正常 MCTX context path 不把它作为长期知识 authority。本说明比较的是旧 local
memory backend 的能力与目标 Hindsight + MCTX 架构，不表示两者应在 production 同时运行。

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
| session-local note | MCTX note/session artifact | 不自动升级为长期知识 |
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
session-local notes
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
protected live tail / current user message
-> required system prompt and tool definitions
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

## 可逆性分类

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
