# pi-ext-memory 记忆预算（Memory Budget）设计

- **状态**：D1–D6 已按建议定稿；**Phase 1–4 已落地**（见 §20、§21、§22、§23）
- **范围**：`packages/pi-ext-memory`
- **相关文档**：`packages/pi-ext-memory/docs/{concepts,how-it-works,configuration}.md`、`docs/architecture/ext-memory.md`、`docs/plans/pi-ext-memory-{enhancements,idle-compaction}.md`

---

## 1. 背景：一次真实事故

会话 `01a0f238`（cwd `/home/chlo/Documents/dev/ovito`，58.1 MB，32 次 compaction）在当前实现下进入不可恢复状态：

| 观测值 | 数值 |
| --- | --- |
| 最后一次 compaction 的 summary | 750,382 字符（≈186k tokens：observations 119,732 + reflections 66,400） |
| 该次 `tokensBefore`（provider usage 口径） | 387,686（模型 `cx/gpt-6-astra` contextWindow = 272,000） |
| 同一内容在另一 provider（`ds`）的计数 | 221,850 |
| 收敛性 | `11:26:00 → 11:28:12 → 11:29:03` 三次 compaction，最后一条 assistant `stopReason: aborted`、`usage = 0` |
| 活跃池增长 | observations 105 条/11.7k → 838 条/119.7k tokens；reflections 0 → 367 条/66.4k tokens |
| 会话文件构成 | 32 条 compaction 共 28.3M 字符（summary 文本 12.9M + details JSON 15.4M），占 58.1MB 文件的 49% |

用 Pi 自身的投影函数在事故现场复算，那次请求的投影是 48 条 entry、972,073 字符，其中 **compaction 条目本身占 794,598 字符（≈198k tokens，模型窗口的 73%）**，其余全部（retained tail + 新消息）只有 ≈44k tokens。

即：**om 交给 Pi 的"压缩结果"比触发它的阈值（`compactAfterTokens` = 81,000）和模型窗口都大**，压缩在数学上不可能收敛。

---

## 2. 根因

### R1 渲染没有上限（正确性缺陷）

`src/hooks/compaction-hook.ts` 只判断 `summary.length === 0`，非空就接管 Pi 的 compaction；`src/session-ledger/render-summary.ts` 把 fold 出来的全量 observation/reflection 直接拼成文本。没有任何地方把渲染结果与 `tokensBefore`、`compactAfterTokens` 或模型窗口比较，也没有截断。

### R2 reflections 没有生命周期（设计缺口）

`src/session-ledger/fold.ts` 只维护 `droppedObservationIds`，ledger 中不存在 reflection 的 tombstone；`src/agents/dropper/agent.ts` 的 schema 只能删 observation id。因此 reflections 严格单调增长。事故中 66.4k tokens 的 reflections 即使 observations 被完美压到目标值，记忆总量仍有 ≈76k tokens。

### R3 唯一的收缩阀门是一个保守的模型判断（可用性缺陷）

dropper 只在"同一轮 consolidation 里 reflector 刚写入非空 reflections"时运行（`src/hooks/consolidation-trigger.ts` `runDropperStage`），而是否删、删多少完全由模型决定（`DROPPER_SYSTEM`：*Default action is KEEP*，且带 preservation floor）。

事故数据：

- drop 时间线：09-30 每几分钟一次（7–45 条）→ 10-01 00:46 一次 303 条 → 01:12 后空 7 小时 → 08:05 仅 74 条 → 09:43 仅 89 条 → 之后再无；
- `maxDropsAllowed`（`src/agents/dropper/pool.ts`）当时算下来有 700+，**不是配额卡住，是模型只提了 74/89 条**；
- 池内 relevance 分布：high 482 条（74,857 tokens）、critical 21 条（2,636）、medium 310（39,814）、low 仅 **25 条（2,425）**——可"安全删除"的材料早已耗尽，而 observer prompt 明确要求不要滥用 high/critical，实际却 60% 落在 high/critical。

### R4 被修正的旧结论、不可信的时间戳（记忆质量问题）

- 66 条活跃 observation（9.2k tokens）是 `Correction to the earlier…`/`the earlier behaviour was wrong` 型，被修正的旧陈述仍留在池中，摘要前言让模型自行按时间仲裁；
- 渲染按 ledger 插入顺序，而 observation 的 `timestamp` 由 observer 模型自己填写（分钟精度）：事故摘要里 **54 处时间倒序**，其中一条是幻觉日期 `2026-07-01 09:52`（差 3 个月）。

### 与"重复垃圾"无关（已排除）

160 个 observer chunk 的 `sourceEntryIds` 零重叠（累计 3,578 个不同 entry），2,006 条 observation 无精确重复、近似重复仅 2–3%。问题是"什么都没删"，不是"记重了"。

---

## 3. 现有机制的约束（设计必须遵守）

1. **ledger 是唯一事实来源**：`om.observations.recorded` / `om.reflections.recorded` / `om.observations.dropped` 三个 custom entry，`foldLedger` 按 first-valid-wins + tombstone 折叠；`buildCompactionProjection(entries, firstKeptEntryId, …)` 用 `coversUpToId` 覆盖率标记决定"到边界为止"的可见集合，并在 observation tokens ≥ `observationsPoolMaxTokens` 时做 full fold。
2. **`session_before_compact` hook 必须保持确定性**：当前实现只做纯计算（无模型调用、不写 ledger）。hook 不写 entry 是它能在 compaction 中安全运行的前提（compaction 进行中 append 会与已计算的 `preparation` 竞态，且 Pi 会以 stale 拒绝）。
3. **可写 ledger 的地方**是 consolidation 流水线（`agent_start`/`turn_end` 触发，带 stale 守卫与 in-flight 锁）与三个 worker 阶段的 append。
4. **三个 memory worker 的输入都包含完整记忆**（observer 的 `priorObservations/priorReflections`、reflector 与 dropper 的全量池），所以"无限记忆"同时会拖垮 worker prompt。
5. **Pi 的 compaction 契约**：hook 收到 `preparation.{firstKeptEntryId, tokensBefore, settings.{reserveTokens, keepRecentTokens}}`、`branchEntries`、`reason: "manual" | "threshold" | "overflow"`、`willRetry`；`shouldCompact` 判据是 `contextTokens > contextWindow − settings.reserveTokens`；cut point 停在 user 消息边界，因此 retained tail 可以显著超过 `keepRecentTokens`（事故中 tail ≈ 44k tokens）。

---

## 4. 目标与非目标

**目标**

- G1 **正确性**：任何一次 compaction 产出的 summary 必须让压缩后的投影落在触发阈值之内（否则压缩不可能收敛）。这条不依赖任何模型判断。
- G2 **收敛性**：活跃记忆池必须能被动地（非模型自愿）收敛回预算，且过期内容不丢失可追溯性（ledger + recall 仍在）。
- G3 **不增加 LLM 调用**：预算执行必须是确定性的纯计算 / 纯 ledger 写入。
- G4 **不隐藏行为**：每一次裁剪、强制回收都要可查（`/om status`、`/om view`、compaction `details`、debugLog），并给出可见但不过噪的提示。
- G5 **可解释的取舍**：记忆的"可见总量"是有限预算，超出部分进入归档（ledger/recall），文档与 prompt 必须诚实说明。

**非目标**

- 不修改 Pi 的 compaction 设置（`reserveTokens`、`keepRecentTokens`）、不修 Pi 的 cut point overshoot；
- 不在 hook 里调用模型改写摘要；
- 不删除 ledger 历史、不做 destructive 迁移、不为旧会话写迁移代码（前向兼容读取即可）；
- 不改动 `recall`/`memory-info`/hindsight 集成；
- 不引入第二套摘要器、第二个 memory 存储、新的窗口/面板 UI；
- 不在本设计内解决 session 文件体积（预算会把单次 compaction 的落盘从 ≈1.7MB 降到 ≈0.3MB，这是副作用而非目标）。

---

## 5. 核心概念：一个预算，三个执行点

引入单一概念 **memory budget（记忆预算，tokens）**，表示"允许出现在可见记忆里的 token 总量"。它在三个地方生效：

```text
                    ┌──────────────────────── 记忆预算 budget ────────────────────────┐
                    │                                                                 │
   (1) 渲染裁剪     │   (2) 账本收敛                       (3) worker 可见性           │
   session_before_  │   consolidation enforcer 阶段        observer / reflector /     │
   compact hook      │   （确定性，无模型调用）              dropper 的输入 = 预算视图   │
        │           │        │                                     │                  │
        ▼           │        ▼                                     ▼                  │
   摘要 ≤ budget    │  活跃池 → obs 目标值                prompt 有界（不再 186k）     │
        │           │        │                                     │                  │
        └──────────►└────────┴─────────────────────────────────────┘                  │
```

- **(1) 渲染裁剪**：保证 G1（正确性）。hook 内纯计算：按优先级选取预算内的 observations/reflections。
- **(2) 账本收敛**：保证 G2。新增流水线阶段 `enforcer`，在池子越过高水位时按同一套优先级写 `om.observations.dropped`（复用现有 tombstone 机制），不删 reflections（Phase 3 才引入 reflection 生命周期）。
- **(3) worker 可见性**：保证 worker prompt 有界，并让"agent 看到的记忆"与"摘要渲染的记忆"完全一致（避免 agent 对不可见记忆做重复工作）。

配套两个质量问题：**时间戳权威（Phase 4）** 与 **观测分层 kind（Phase 2）**。

---

## 6. 预算推导

```text
window      = ctx.model?.contextWindow（可为 undefined）
trigger     = resolveCompactAfterTokens(config, window)          // calibrated: compactAfterTokens；ratio: ratio×window
piLimit     = window − preparation.settings.reserveTokens        // Pi 自身的 shouldCompact 上界
softLimit   = min(trigger, piLimit)
tail        = Σ estimateEntryTokens(entries after firstKeptEntryId)   // 与 Pi 估算同基（chars/4）
available   = max(0, softLimit − tail − systemTokens)   // systemTokens 优先取真实 system prompt 估算
budgetRender = max(MIN_MEMORY_TOKENS, floor(available × HEADROOM))
budgetCap    = config.memoryMaxTokens ?? defaultMemoryMaxTokens(softLimit, window)
                                 // = min(floor(softLimit × 0.5), floor(window × 0.1))
budget       = min(budgetRender, budgetCap)
```

常量（代码内常量，不进配置，避免配置面膨胀）：

| 常量 | 值 | 理由 |
| --- | --- | --- |
| `MEMORY_SYSTEM_RESERVE_TOKENS` | 6,000 | 宿主无法报告 system prompt 时的保守占位（`ctx.getSystemPrompt()` 可用时改用真实估算） |
| `HEADROOM` | 0.5 | 压缩后要为一轮工作留出空间，否则会每轮都触发压缩 |
| `MIN_MEMORY_TOKENS` | 4,000 | 预算下限，避免 tail 过大时记忆被压成 0 |
| `POOL_WATERMARK` | 1.5 | 池子超过 `budgetCap × 1.5` 才强制收敛（避免过度回收） |
| `FOUNDATION_REFLECTIONS` | 8（见 D1） | 会话最初的 reflections 是定位锚（项目、目标、文档位置），不得被"取最新"裁掉 |

默认值下的两个算例（calibrated、`compactAfterTokens` = 81,000、`reserveTokens` = 16,384、window = 272,000）：

| 场景 | tail | available | budgetRender | budgetCap | budget | 压缩后投影 |
| --- | --- | --- | --- | --- | --- | --- |
| 常规（tail = `keepRecentTokens` 20k） | 20k | 55k | 27.5k | 27.2k | **27.2k** | ≈53k（阈值的 65%） |
| 事故（tail = 44k） | 44k | 31k | 15.5k | 27.2k | **15.5k** | ≈65k（阈值的 81%） |
| 现行实现（事故） | 44k | — | 无 | 无 | 无 | 242k（阈值的 299%） |

两条补充规则：

- `reason === "overflow"`（Pi 的上下文溢出恢复）时，`budget = max(MIN_MEMORY_TOKENS, floor(budget / 2))`：已经溢出说明估算与实际存在偏差，需要更强的收缩。
- `window` 不可得时退回 `budgetCap = floor(trigger × 0.5)`，`budgetRender` 只用 `softLimit = trigger`。

**取舍说明（必须在 configuration 文档中写明）**：`compactAfterTokens` 越小（默认 calibrated 81k），预算越小、遗忘越多。大窗口模型建议使用 ratio 模式；本设计不修改默认值。

---

## 7. 渲染裁剪（Point 1）

位置：`src/session-ledger/`（新增纯函数 `selectVisibleMemory`）+ `src/hooks/compaction-hook.ts`（调用与观测记录）+ `buildCompactionProjection` 增加可选 `maxTokens`。

### 7.1 分节预算

```text
obsShare   = min(config.observationsPoolTargetTokens, budget)      // 现有 key 语义不变：观测的目标占用
reflShare  = max(0, budget − obsShare)
```

渲染时若两节之和 > budget：**按节预算比例分配，未用满的一节把余量让给另一节**：

```text
keepObs  = min(obsTokens,  floor(budget × obsShare  / (obsShare + reflShare)))
keepRefl = min(reflTokens, budget − keepObs)
剩额再补给另一节，直到 budget 用尽或两节都保留完
```

### 7.2 保留优先级（keep-first，确定性）

observations（保留优先，越靠前越先保留）：

1. `kind !== "progress"`（Phase 2 引入；无 `kind` 的旧条目按 `fact` 处理，即不享受"优先丢弃"）
2. reflection coverage：none > partial > strong（覆盖 = 已被反思固化 = 冗余，因此先裁；复用 `src/agents/dropper/coverage.ts`）
3. relevance：critical > high > medium > low
4. 时间戳新者优先（与 dropper 的"先丢旧的"一致；同 timestamp 按 ledger 插入序）

reflections（保留优先）：

1. 前 `FOUNDATION_REFLECTIONS` 条（ledger 序）
2. 之后按 ledger 逆序（新者优先）

### 7.3 稳定性与回退

- 裁剪是纯函数：同一输入 → 同一输出；`budget` 变化时只在边界处增删（不做随机、不做模型判断）。
- 记忆为空（两节都空）时行为不变：`return;` 交给 Pi 原生 summarizer。
- 裁剪后的 `observations/reflections` 一并写入 compaction `details`（`visibleProjection()` 依据它展示"可见记忆"，与摘要严格一致）。
- `details` 新增可选字段 `budget`：`{ maxTokens, renderedTokens, tailTokens, softLimit, trimmedObservations, trimmedReflections }`（旧版本代码读新数据不受影响，`isMemoryDetails` 只校验既有字段）。
- 记账口径：每行按 `estimateStringTokens(line + "\n")` 计入，因此"渲染结果 ≤ 预算"是构造性保证。
- 通知策略：发生裁剪且 `trimmed ≥ max(5, 25% of items)` 时 `ctx.ui.notify(..., "info")` 一次，文本形如
  `om: 记忆预算裁剪 312 条观测 / 41 条反思（budget 15.5k tokens，tail 44k）`；被 `reason === "overflow"` 触发时降级为 `"warning"`。其余情况只写 debugLog 与 `details.budget`，避免刷屏。

---

## 8. 记忆账本收敛（Point 2，Phase 2）

位置：`src/hooks/consolidation-trigger.ts` 新增末阶段 `runEnforcerStage(pi, runtime, ctx)`，排在 `observer → reflector → dropper` 之后。

- **门限**：`obsTokens + reflTokens > budgetCap × POOL_WATERMARK` 才动作；否则直接返回（幂等，无侧写）。
- **目标**：把 observations 压到 `min(config.observationsPoolTargetTokens, max(0, budgetCap − reflTokens))`。
- **候选**：`selectDropCandidates(全部活跃 observation ids, activeObservations, maxDropsAllowed, reflections)`——**复用 dropper 的同一套排序**，只把 rank 扩展为 (kind, coverage, relevance, age)（Phase 2 之后 `kind: progress` 排最前）。`maxDropsAllowed` 复用 `observationPoolMetrics([], target)` 的计算。
- **安全边界**：`relevance === "critical"` 的观测不进入候选（事故中仅 21 条/2.6k tokens）。
- **写入**：单条 `om.observations.dropped`，`coversUpToId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)`，复用 `buildObservationsDroppedData`；与其他阶段相同的 stale 守卫（`isStale` → 丢弃本次结果）。
- **代价**：零模型调用、零 API 成本；debugLog 记录完整决策（水位、目标、候选序、实际删除数）。
- **通知**：`om: 强制收敛记忆池 -N 条观测（池 X → Y tokens，目标 Z）`，`"info"`。
- **与 dropper 的关系**：dropper 仍然先跑（"模型判断优先、质量优先"），enforcer 只填补水位以上的缺口；dropper 正常工作时 enforcer 永不触发。
- **Reflections**：本阶段不做确定性淘汰（避免静默丢失耐久事实），超份额的部分由 Point 1 的渲染裁剪兜底，并在 `/om status` 明确提示需要 `/om consolidate`（Phase 3 提供真正的合并机制）。

---

## 9. 记忆 worker 的可见性（Point 3）

三个 worker 的输入改为**预算视图**：

- `runObserverStage`：`priorReflections/priorObservations` 从 `fullProjection(entries)` 改为 `selectVisibleMemory(fullProjection(entries), budgetCap)`；
- `runReflectorStage` / `runDropperStage`：`foldLedger(entries)` 的 `reflections/activeObservations` 同样过预算视图。

理由与后果：

- worker prompt 由"随会话无界增长"变为有界（事故中 observer prompt ≈186k + chunk，已是窗口极限）；
- worker 只对"会被渲染出来的记忆"负责，不再为不可见条目做去重/覆盖判断；
- `reflection id = hashId(content)`、fold 是 first-valid-wins，因此"不可见的老 reflection 被重新提出"只会多写一条同 id 的 ledger 条目，渲染时按 id 去重，行为无害（记录为已知限制）。

prompt 措辞同步补充（诚实告知，不隐藏）：

- observer：可见预算是有限的，progress 类事实一旦被 reflection 吸收就会先离开可见窗口；
- reflector：durable reflection 比 observation 更"抗裁剪"，遇到重要且耐久的事实用 reflection 固化；
- dropper/enforcer 共用同一套优先级说明。

---

## 10. 反思生命周期（Phase 3）

目标：让 reflections 也能收敛，而不是只能靠渲染裁剪。

- **新 ledger 条目** `OM_REFLECTIONS_DROPPED = "om.reflections.dropped"`，数据 `{ reflectionIds, coversUpToId }`，与 observation tombstone 同构；
- `foldLedger` / `foldProjection` / `diffProjection` 增加 reflection tombstone 支持（first-valid-wins 不变，tombstone 独立集合 `droppedReflectionIds`）；
- **reflector 获得 `supersedes: id[]`（可选）**：新 reflection 明确声明它取代哪些旧 reflection；stage 在接受该 reflection 时同时写入一条 `om.reflections.dropped`（含被取代 id），语义是"合并/升级"而不是"删除"；
- reflector prompt 增加预算目标（`reflShare`）：超过目标时先合并同类项，再产出新 reflection；
- 渲染裁剪与 §7.2 的 foundation 规则保留为最后兜底。
- **不做**：确定性的 reflection 淘汰（不引入"按时间删耐久事实"的行为），也不做 ledger 历史删除。

---

## 11. 时间戳权威（Phase 4）

- observer 的 tool schema **移除 `timestamp` 字段**；`runObserverStage` 在写回前用 `sourceEntryIds` 推导：

```text
timestamp = 该 observation 的 sourceEntryIds 中最早 entry 的本地时间（"YYYY-MM-DD HH:MM"）
fallback  = chunk 最后一条 source entry 的本地时间；再 fallback = 记录时刻
```

（`sourceEntryIds` 已被 `normalizeSourceEntryIds` 校验为 chunk 内出现过的真实 id，所以 id→entry 的映射总是可解析；`tokenCount` 在推导之后重算。）

- 渲染按 `(timestamp, ledger 插入序)` 稳定排序，使"按时间先后 + 最新者代表最新状态"的前言承诺成立；幻觉日期与 54 处倒序由此消失。
- 旧条目保持原有 `timestamp`（不迁移、不重写 ledger）：排序对旧条目退化为插入序，文档记录这条混用限制；新会话一次 compaction 后即收敛。
- `hashId(content)` 不变，因此推导时间戳不会改变任何已有 id。

---

## 12. 观测分层 `kind`（Phase 2）

- observer schema 新增 `kind: "user" | "decision" | "fact" | "progress"`（必填），`Observation` 增加可选 `kind`；缺失（旧条目）按 `fact` 处理；
- 语义：`progress` = 施工叙事与完成标记（`completed: …`、`verified`、`fixed`、`ran tests`）；`user` = 用户断言/纠正；`decision` = 决策/不变量；`fact` = 代码/文档/环境事实；
- observer prompt：把"Mark concrete completions explicitly"改写为"完成类事实记 `kind: progress`"，并重申 relevance 是**抗裁剪强度**而不是重要性排序（对应事故中 60% high/critical 的膨胀）；
- dropper / enforcer 排序把 `kind` 放在第一位（progress 先走），reflector 的 coverage 判断不变；
- 依据：事故中 242 条 `completed: …`（34,796 tokens = 观测池的 29%）属于过程叙事，是"先丢"的最佳判别维度，而 relevance 已被模型膨胀到不可靠。

---

## 13. 配置与公共契约

| 项 | 变化 | 说明 |
| --- | --- | --- |
| `memoryMaxTokens` | **新增**（可选，正整数） | 可见记忆的硬上限，同时是池收敛目标；默认 `min(floor(softLimit × 0.5), floor(window × 0.1))`；非法值忽略并走默认 |
| `observationsPoolMaxTokens` | 不变 | full-fold 压力阈值 |
| `observationsPoolTargetTokens` | 不变 | dropper 目标 + 渲染中观测的份额 |
| 其他 config | 不变 | 不加 watermark / headroom / foundation 等配置键（代码内常量，见 §6） |
| `Observation` | `+ kind?` | 旧条目无此字段，按 `fact`；`isObservation` 不因缺失而拒绝 |
| `Reflection` | 不变 | Phase 3 才通过 tombstone 支持淘汰 |
| `MemoryDetails` | `+ budget?` | 渲染记账，可查；`version` 仍为 1（既有字段形状不变） |
| `om.reflections.dropped` | **新增**（Phase 3） | reflection tombstone |
| compaction hook 契约 | 变化 | summary 受预算约束；超预算时裁剪并可见告警 |
| `/om status` / `/om view` | 扩展 | 见 §14 |
| 三个 worker 的输入 | 变化 | 预算视图（§9） |

**兼容策略**：不写迁移代码、不双读旧格式；新增字段全部 optional 且 fail-safe（缺失 = 保守保留）。旧会话（如事故会话）在**下一次 compaction 时立即受益**（渲染裁剪生效），无需重开会话。

---

## 14. 可观测性

- `/om status` 新增 `── Memory budget ──` 段：`budget / pool（obs+refl 分节）/ watermark / 最近一次渲染裁剪（来自最近 compaction 的 details.budget）/ tail tokens / 触发原因`；池子越过 watermark 时追加 `over budget — next consolidation will enforce`；reflections 超份额时追加 `reflections over share — run /om consolidate`。
- 一次 compaction 里发生裁剪 → `details.budget` 永久可查（`/om view` 与 status 都能读）。
- debugLog 事件：`budget.render`、`budget.trim`、`enforcer.stage_start`、`enforcer.append`、`enforcer.skip`（含全部输入值），保持现有 `debugLog(scope, payload)` 风格。
- 通知：只对"非平凡裁剪"和"强制收敛"发声（§7.3、§8），其余静默。

---

## 15. 失败与回退路径

| 情形 | 行为 |
| --- | --- |
| 记忆为空 | 保持现状：`return;` → Pi 原生 summarizer |
| 裁剪后投影仍超阈值（tail 过大） | 仍然返回裁剪后的摘要（记忆侧已尽力），并给一次 `warning`：`om: retained tail 本身已接近阈值，压缩空间有限（建议提高 compactAfterTokens 或使用 ratio 模式）` |
| `budget` 被 floor 到 `MIN_MEMORY_TOKENS` | 保留优先级最高的若干条目（reflections 优先），其余进归档；告警同上一行 |
| `window`/`reserveTokens` 不可用 | 退回 `trigger` 口径（§6） |
| 预算裁剪后 summary 长度 > 0 但极小 | 不降级为原生 summarizer（省一次成本），照常返回 |
| enforcer 阶段抛错 | 按现有阶段约定记入 `recordConsolidationStageError`（`/om status` 的 Last error）并中止本次流水线，不影响已完成阶段 |

---

## 16. 并发与生命周期

- 渲染裁剪：纯函数，无状态、无写入，天然并发安全。
- enforcer：运行在现有 consolidation 锁（`runtime.consolidationInFlight` / `launchConsolidationTask`）内，与其他阶段串行；append 使用与其他阶段相同的 stale 处理；重复运行幂等（第一次收敛后水位以下不再动作）。
- 不引入新的定时器、新的跨进程状态或新的持久化文件。
- 会话切换（`sessionGeneration`）与 `/om off` 的门控保持不变。

---

## 17. 测试与验收

**单元（vitest）**

1. `resolveMemoryBudget`：calibrated/ratio、window 缺失、window 很小、`memoryMaxTokens` 覆盖、tail 取 0/20k/44k/200k、`reason === "overflow"`、floor。
2. `selectVisibleMemory`：分节按比例分配 + 余量让渡、优先级顺序（progress/coverage/relevance/age）、foundation reflections、全 critical、budget < 单条、两节之一为空、结果稳定（同输入同输出）。
3. `selectDropCandidates` 的 `kind` rank 与 critical 排除。
4. enforcer：低于水位不动作、高于水位按目标收敛、幂等、stale 丢弃、跳过 critical。
5. Phase 4：时间戳推导（多 sourceEntryId 取最早、fallback）、渲染单调排序、旧条目退化为插入序。

**夹具与集成**

6. 事故形状夹具（838 obs / 367 refl / summary ≈186k tokens）：hook 返回 ≤ budget，`details.budget.trimmedObservations > 0`，投影 < 触发阈值——即"压缩收敛"回归测试。
7. 事故回放脚本（手工、不进 CI）：直接读取本机事故会话文件 `~/.pi/agent/sessions/--home-chlo-Documents-dev-ovito--/2026-09-30T12-09-44-721Z_01a0f238-….jsonl` 的 ledger 条目，跑投影 + 裁剪，断言渲染 ≤ 21.8k tokens（默认预算）而不是 198k。
8. 空记忆 → 仍交回原生 summarizer；tail 过大 → 裁剪 + 单次 warning。
9. worker 可见性：observer/reflector/dropper 的输入在超预算池下不超过 `budgetCap`。

**真实机器**

10. 一个真实长会话（≥ 两次 compaction）：`/om status` 的预算段显示池子收敛、无重复 compaction、无 `aborted` assistant 条目；`/om view` 与摘要一致。

---

## 18. 分阶段实施

每个阶段都可独立发布、可运行、可验证；阶段之间不留临时架构。

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| **Phase 1 正确性** | §6 预算推导 + §7 渲染裁剪 + invariant 检查 + `details.budget` + §9 worker 可见性 + §14 可观测性 | 事故形状夹具与回放脚本显示渲染 ≤ 预算、压缩收敛；无新 LLM 调用 |
| **Phase 2 收敛** | §8 enforcer 阶段 + §12 `kind` + status 的 `over budget` 提示 | 超水位池在一次 consolidation 内回落到目标；dropper 正常时不触发 |
| **Phase 3 反思生命周期** | §10 `supersedes` + `om.reflections.dropped` + fold/projection 支持 + reflector 预算目标 | 池内 reflections 可通过合并下降；渲染不再依赖 foundation 兜底 |
| **Phase 4 顺序可信** | §11 时间戳推导 + 稳定排序 | 新会话渲染单调有序；幻觉时间戳不再影响仲裁 |

文档同步（每阶段完成时）：`packages/pi-ext-memory/docs/{how-it-works,configuration,concepts}.md`（预算语义、`memoryMaxTokens`、`kind`、`/om status` 新段、已知限制），以及 `docs/architecture/ext-memory.md` 的契约段。

---

## 19. 风险、取舍与开放决策

**已识别的风险**

1. **预算单位与实际分词器不一致**：预算用 chars/4 估算（与 Pi 的 `estimateEntryTokens` 同基），而事故中同一内容两个 provider 报 221,850 与 377,686（1.7×）。缓解：预算的 `HEADROOM`/`SYSTEM_RESERVE` 保守化、`/om status` 同时显示估算与 provider usage 口径、允许 `memoryMaxTokens` 显式覆盖。这是本设计最大的未知项（见 D5）。
2. **确定性观测回收可能有损**：被丢弃的观测若其语义尚未进入 reflection，就只剩 recall 可达。缓解：只在 watermark 以上动作、不碰 critical、ledger 与 recall 完整保留、回收计数可见。
3. **Pi 的 tail overshoot 不在我们控制内**：单轮 turn 很大时 `keepRecentTokens` 会被大幅超越，可用预算被 tail 吃掉（事故中 tail 44k 对阈值 81k）。缓解：预算是 tail 的函数（`budgetRender`），并在 tail 过大时显式告警；文档建议大窗口模型用 ratio 模式。
4. **小阈值 ⇒ 小预算 ⇒ 记忆更易遗忘**：默认 calibrated 81k 会让预算停在 ~27k。这是有意识的取舍；本设计不改默认值，但在 configuration 文档说明。

**开放决策（需用户确认）**

- **D1** reflections 的渲染兜底策略：`FOUNDATION_REFLECTIONS = 8` + 新者优先（推荐）／纯新者优先／不裁剪只告警。理由：会话最初的 reflections 是定位锚（项目、目标、文档路径），"取最新"会先丢掉它们；Phase 3 的合并机制才是长期解。
- **D2** 接受"enforcer 可以回收尚未被 reflection 覆盖的观测"（critical 除外）吗？（推荐接受，否则池子无法收敛；事故中 366/838 条无 reflection 覆盖。）
- **D3** 是否引入 `kind` 字段（Phase 2），还是只依靠 relevance（现状已被模型膨胀到 60% high/critical）？推荐引入。
- **D4** 新配置键命名与默认：`memoryMaxTokens` = `min(floor(softLimit × 0.5), floor(window × 0.1))`（推荐）；是否需要暴露 `POOL_WATERMARK`/`HEADROOM`（建议不暴露）。
- **D5** 分词器偏差的处理：先"保守 + 文档 + `/om status` 双口径"（推荐），还是本设计内就加入"按 `getContextUsage()` 实际值校准估算比例"的机制（更准但引入反馈回路）？
- **D6** `reason === "overflow"` 时预算减半（推荐）还是保持不变？

---

## 附录 A：受影响文件

| 文件 | 变更 |
| --- | --- |
| `src/config.ts` | `+ memoryMaxTokens`、默认值与非法值处理 |
| `src/session-ledger/budget.ts`（新增） | 预算推导与分节分配常量/纯函数 |
| `src/session-ledger/select.ts`（新增） | `selectVisibleMemory` 优先级选条 |
| `src/session-ledger/types.ts` | `Observation.kind?`、`MemoryDetails.budget?`、Phase 3 reflection tombstone 类型与校验 |
| `src/session-ledger/projection.ts` | `latestMemoryBudget(entries)`；Phase 3 reflection tombstone。`buildCompactionProjection` 本身不变（裁剪在 hook 里叠加） |
| `src/hooks/compaction-hook.ts` | 预算推导、裁剪、`details.budget`、告警 |
| `src/hooks/consolidation-trigger.ts` | worker 预算视图；Phase 2 enforcer 阶段；Phase 4 时间戳推导 |
| `src/agents/dropper/pool.ts` / `agent.ts` / `prompts.ts` | 排序 rank 扩展（kind）、critical 排除、prompt 措辞 |
| `src/agents/observer/{agent,prompts}.ts` | Phase 2 `kind`、Phase 4 移除 timestamp |
| `src/agents/reflector/{agent,prompts}.ts` | Phase 3 `supersedes` + 预算目标 |
| `src/commands/status.ts` / `view.ts` | `── Memory budget ──` 段与告警行 |
| `packages/pi-ext-memory/docs/*` | 语义、配置、限制同步 |

---

## 20. Phase 1 落地记录（2026-10-01）

已实现并验证的部分（改动只涉及 `packages/pi-ext-memory` 与文档，未提交）：

**实现**

- `src/session-ledger/budget.ts`：`resolveMemoryBudget` / `defaultMemoryCap` / `retainedTailTokens` 与常量（`MEMORY_RENDER_HEADROOM 0.5`、`MEMORY_MIN_TOKENS 4000`、`MEMORY_CAP_TRIGGER_RATIO 0.5`、`MEMORY_CAP_WINDOW_RATIO 0.1`、`MEMORY_OVERFLOW_RENDER_RATIO 0.5`、`MEMORY_SYSTEM_RESERVE_TOKENS 6000`）。`softLimit` 在 `contextWindow − reserveTokens` 有效时取二者较小值；`systemTokens` 优先取 hook 的 `ctx.getSystemPrompt()` 估算；`reason === "overflow"` 时渲染预算减半。
- `src/session-ledger/select.ts`：`selectVisibleMemory(memory, { maxTokens, observationTargetTokens })`，观测份额 `min(target, budget)` + 余量互让；keep 顺序为 coverage none→partial→strong、relevance、较新；反思为前 8 条锚点 + 较新；结果按 ledger 序输出；每行按 `line + "\n"` 记账，使"渲染 ≤ 预算"成为构造性保证。
- `src/session-ledger/render-summary.ts`：`summaryOverheadTokens()`（前言 + 两个小节标题的最坏情况）。
- `src/session-ledger/types.ts` / `projection.ts`：`MemoryDetails.budget?`、`isMemoryDetailsBudget`、`latestMemoryBudget(entries)`（旧 compaction 条目无 budget 时跳过）。
- `src/config.ts`：`memoryMaxTokens?: number`（正整数字段，非法值忽略）。
- `src/hooks/compaction-hook.ts`：预算推导 + 裁剪 + `details.{observations,reflections}` 改为可见集合 + `details.budget` + 粗裁剪时一次通知（`reason === "overflow"` 用 warning）。
- `src/hooks/consolidation-trigger.ts`：`visibleMemory(config, contextWindow, memory)`，observer / reflector / dropper 的输入改为 `budget.cap` 视图；dropper 的就绪门限仍基于真实池；新增 `dropper.visible_memory` debug 事件。
- `src/commands/status.ts`：新增 `── Memory budget ──` 段（cap、active memory、最近一次渲染的 tokens / 裁剪行数 / tail，超预算时一行说明）。
- observer / reflector prompt：诚实说明"可见记忆有预算、被裁剪的行不会自动可见、反思是抗裁剪的那部分"。

**验证**

- `pnpm exec vitest run packages/pi-ext-memory/test`：44 files / 487 tests 通过（新增 `session-ledger-budget.test.ts`、`session-ledger-select.test.ts`，扩写 `compaction-hook.test.ts`、`config.test.ts`、`status-command.test.ts`、`test/fixtures/session.ts`）。
- `pnpm exec tsc -p packages/pi-ext-memory/tsconfig.build.json --noEmit`：通过。
- `pnpm exec biome check`（改动文件）：无新增告警。

**与设计稿的差异（实现即事实）**

1. 分节预算用"绝对份额 + 余量互让"，不做按 cap 的比例缩放：`obsShare = min(observationsPoolTargetTokens, budget)`。
2. `buildCompactionProjection` 未接受 `maxTokens`；裁剪在 hook 内对 projection 结果叠加，避免改动 projection 契约与既有测试语义。
3. 通知阈值从 5% 收紧到 25%（保留 `≥5 行` 下限），否则长会话每次 compaction 都会弹提示。
4. coverage 的 keep 顺序确认为 none 优先（与 dropper 的 drop rank 互为镜像）。
5. `systemTokens` 用真实 system prompt 估算，常量只作回退。

**事故会话回放（`/tmp/replay-budget.mjs`，手工、不进 CI）**

读取真实事故会话 `01a0f238` 的分支（5,523 条 entry，最后一次 memory compaction 的 `firstKeptEntryId` 起算），
用新代码重跑 hook 的路径：

| 指标 | 修复前（实际发生） | 修复后（回放） |
| --- | --- | --- |
| 折叠后的活跃记忆 | 815 obs + 364 refl | 同（未变） |
| 渲染出的 summary | 737,671 字符 / ≈184,418 tokens | **94,903 字符 / ≈23,726 tokens** |
| 预算 | 无 | cap 27,200 / render 23,914（tail 27,171、system 6,000） |
| 裁剪 | 无 | 观测 752/815、反思 290/364（仍留在 ledger，可 recall） |

即：同一份记忆渲染量降到约 1/7.8，且满足"渲染 ≤ 预算"（23,726 ≤ 23,914）。回放同时说明：这个会话的
retained tail 本身就有 27,171 tokens，预算因此只剩 23,914——tail 越大记忆越小，这正是 §7 的设计意图。

（`estimateProjectedContextTokens` 在补丁前后都返回 `usageTokens: 377,494`，因为它优先采用最后一次
provider usage 作为基线、只估算其后的 trailing 消息，因此不能用它对照压缩前后的大小；压缩后的实际
上下文应按 `summary + tail + system` 估算，即 ≈56.9k。）

**尚未落地（Phase 2–4）**：`kind` 分层、enforcer 收敛阶段（池子仍可能停在预算之上，只是渲染不再超预算）、reflection tombstone / `supersedes`、时间戳权威化。真实机器长会话验证（≥2 次 compaction 观察收敛）也还没做。

---

## 21. Phase 2 落地记录（2026-10-01）

**观测分层 `kind`**

- `src/session-ledger/types.ts`：`OBSERVATION_KINDS`、`ObservationKind`、`DEFAULT_OBSERVATION_KIND = "fact"`、
  `OBSERVATION_KIND_DROP_RANK`（`progress 0 < fact 1 < user 2 < decision 3`，数字小 = 先离开）、
  `isObservationKind()`、`observationKind()`（缺失或非法一律按 `fact`）。`Observation.kind?` 为可选字段，
  旧条目零迁移；`isObservation` 不因缺失而拒绝。
- `src/agents/observer/agent.ts`：`record_observations` 的 schema 新增**必填** `kind`（带语义描述）；
  入账时按模型给的值保存。
- `src/agents/observer/prompts.ts`：新增"每条观测都要给 kind"的字段说明；把原来的
  "Mark concrete completions explicitly" 改写为"完成类事实记 `kind: progress`"，并说明以 fact 记录
  施工叙事会把叙事伪装成耐久知识、反而把决策挤出活跃记忆；relevance 段改写为"耐久度/可重推导难度，
  不是重要度排序"，并明确 kind 是移除顺序的第一维度。
- `src/agents/dropper/coverage.ts`：dropper 行渲染加入 `[kind]`（summary 行格式不变，故渲染预算口径不变）。
- `src/agents/dropper/prompts.ts`：新增 "Kind guidance" 段（四个 kind 的语义与强度梯度），
  首要 drop 目标改为 progress 叙事，relevance 段同样改写为耐久度语义。
- 排序：`selectDropCandidates` 把 kind 放在**第一位**（其次 coverage、relevance、age、提出顺序）；
  `selectVisibleMemory`（渲染裁剪）把 kind 放在 **coverage 之后、relevance 之前**。

**确定性收敛阶段（enforcer）**

`src/hooks/consolidation-trigger.ts` 新增 `runEnforcerStage`，排在 observer → reflector → dropper 之后，
不调用任何模型、不产生费用：

| 项 | 实现 |
| --- | --- |
| 门限 | `activeTokens = 观测池 tokens + 反思 tokens > floor(budgetCap × MEMORY_POOL_WATERMARK 1.5)` |
| 目标 | `min(config.observationsPoolTargetTokens, max(0, budgetCap − 反思 tokens))` |
| 候选 | 活跃观测中 `relevance !== "critical"` 的那些 |
| 数量 | `min(maxDropCountForPool(全部活跃观测, 观测 tokens, 目标), 候选数)` |
| 排序 | 复用 `selectDropCandidates`（kind → coverage → relevance → age） |
| 写入 | 至多一条 `om.observations.dropped`，`coversUpToId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)`；append 抛 `stale` 时丢弃本次结果，其他错误走 `recordConsolidationStageError("enforcer")` 并中止本次流水线 |
| 幂等 | tombstone 会让下一次 fold 不再包含被删条目，重复运行不再选中任何观测 |
| 可观测 | debugLog `enforcer.skip` / `enforcer.stage_start` / `enforcer.append`（含全部门限与目标值）、一次 `om: enforced pool convergence — dropped N observations (X → Y tokens, target Z)` 通知、`/om status` 的 `Over watermark:` 行与 `lastEnforcerError` |

配套改动：`src/session-ledger/budget.ts` 新增 `MEMORY_POOL_WATERMARK = 1.5`；
`src/runtime.ts` 新增 `ConsolidationStage = ConsolidationPhase | "enforcer"`（enforcer 不是 worker，
不计成本、不计 run 数）与 `lastEnforcerError`；`src/commands/status.ts` 新增
`Over watermark: …` 与 `Reflections leave under the observation target: …`（后者提示 `/om consolidate`）。

**事故会话回放（`/tmp/replay-enforcer.mjs`，手工、不进 CI）**

对真实事故会话 `01a0f238` 的分支（838 条活跃观测 / 367 条反思）跑 enforcer：

| 指标 | 值 |
| --- | --- |
| cap / watermark | 27,200 / 40,800 tokens |
| 活跃记忆 | 119,732（观测）+ 66,400（反思）= 186,132 tokens |
| 目标 | **0**（反思 66,400 已超过 cap） |
| 结果 | 回收 817 / 817 条非 critical 观测（117,096 tokens），保留 21 条 critical（2,636 tokens） |
| 之后的一次渲染 | 21 条观测 + 129 条反思 ≈ 26,954 tokens（预算 27,200，反思被渲染裁剪裁掉 238 条） |

同一次回放在第二轮修正后（覆盖率只计被保留的反思）保留 **65** 条观测、summary 95,199 字符 /
≈23,800 tokens，仍在 23,914 的渲染预算内——修正让渲染留下了更多未被裁掉反思覆盖的观测。

即：这个会话能收敛，但方式是"反思独自超预算 ⇒ 观测目标为 0 ⇒ 所有非 critical 观测一次性退出活跃记忆"
（仍留在账本、可 recall）。这是 §8 目标公式的直接结果，也是**必须让用户知道的行为**；
真正的解法在 Phase 3（反思合并），届时反思池收缩、观测才有预算。

**与设计稿的差异（实现即事实）**

1. 渲染裁剪的排序也加入了 kind（放在 coverage 之后）：设计稿只要求 dropper/enforcer 用 kind，
   但渲染是模型每轮真正读到的记忆，让施工叙事在渲染里先被裁掉才合理。旧测试与旧条目（无 kind）不受影响。
2. enforcer 在 dropper 失败/跳过时仍然运行（它不需要模型），但 observer/reflector 阶段失败仍按既有约定中止整条流水线。
3. compaction summary 的行格式不含 kind（保持不变），只有 dropper 的模型可见行加了 `[kind]`。
4. `ConsolidationStage` 与 `ConsolidationPhase` 分离，避免把无模型的 enforcer 记进 worker 成本/run 统计。
5. `isObservation` 不校验 kind 字段本身（缺失/非法在读取时按 `fact` 处理），避免为纯排序字段引入解析失败路径。

**第二轮自检（open-code-review，23 个文件 / 14 条评论）后的修正**

已修（每条都有 revert 验证：改回旧写法会让对应测试失败）：

1. **渲染预算可能超过实际剩余空间**：`MEMORY_MIN_TOKENS` 下限只作用于 cap，渲染预算改为
   `Math.max(Math.min(MEMORY_MIN_TOKENS, available), floor(available × 0.5))`，所以 render ≤ available
   恒成立（available 为 0 时 render 也为 0）。
2. **覆盖率用了会被裁掉的反思**：`selectVisibleMemory` 先选反思、再用**被保留的**反思计算观测覆盖等级，
   否则被裁掉的 reflection 会把它的 observation 标成冗余、两者一起消失。
3. **dropper 的规模指导取自可见视图**：`runDropper` 新增 `activePoolTokens`，删除预算按**真实池**的超额量
   除以可见平均行长计算，并夹在可见条数内；否则可见子集已满足 target 时 `maxDropsAllowed = 0`，
   模型阶段被静默跳过，回收全落到 enforcer。
4. **enforcer 的删除数量按平均行长估算**会不足额：改为按 rank 逐条累加**渲染 tokens**，直到
   `池 - 已释放 ≤ 目标`，剩余量因此一定 ≤ 目标（旧写法在"小行在前、大行在后"的池子里会停在高位，
   又因为低于 watermark 而不再触发）。`maxDropCountForPool` 仍留给 dropper 作为模型可见的上界。
5. **"记忆被全部裁掉"与"没有记忆"混为一谈**：压缩 hook 现在区分两者，前者用新的 `memoryPreamble()`
   只回传前言（仍受预算约束、并引导模型用 recall 工具），并给一次 warning 通知，不再静默回退到 Pi 的
   原生摘要器（后者不受本预算约束）。
6. dropper 行渲染统一为 prompt 文档里的 `[kind: …]` 格式；observer prompt 明确"progress 只表示做过，
   完成标记只给已验证的完成，未完成/失败要照实写"，避免把尝试写成已完成。

**保留未改（附理由）**

- 渲染裁剪遇到第一条放不下的条目就停止（不跳过继续装填）：这是"优先级优先于填满"的有意取舍，也是
  "渲染 ≤ 预算"与"预算单调"两个不变量的基础；代价由第 5 条兜底。单条超长条目的极端情况会有
  warning + 前言摘要。
- 裁剪通知阈值（≥ max(5, 25% 行)）不变：`details.budget` 与 `/om status` 永久保留每次裁剪的完整信息，
  为一次例行裁剪给每个长会话弹 toast 只会变成噪音。
- 模型不可用时整条流水线（含 enforcer）不运行：此时观测池不会增长（观测由 observer 写入），
  而无模型参与的确定性回收是有损的，等模型恢复更安全；`/om status` 会一直显示 `Over watermark:`。
- `packages/pi-status/src/footer.ts` 的 thinking level 显示问题不属于本次改动（该文件是工作区中其他并行
  工作的修改），仅转报用户。

**Phase 4 未落地**：时间戳权威化（observer schema 仍要求模型给 timestamp）。
真实机器长会话验证（≥2 次 compaction 观察池子收敛）仍待补。

---

## 22. Phase 3 落地记录（2026-10-01）

### 22.1 落地内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `OM_REFLECTIONS_DROPPED = "om.reflections.dropped"` | `session-ledger/types.ts` | 数据 `{ reflectionIds, coversUpToId }`，与 observation tombstone 同构；`isReflectionsDroppedData/Entry`、`buildReflectionsDroppedData` |
| `FoldedLedger.activeReflections` / `droppedReflectionIds` | `session-ledger/fold.ts` | first-valid-wins 不变；tombstone 是独立集合，未知 id 也保留 |
| `foldProjection` 过滤被取代的反思 | `session-ledger/projection.ts` | 与观测 tombstone 同一边界语义（`coversUpToId` 落在 `dropsBoundary` 之前才生效） |
| `ProjectionDiff.droppedReflectionsOnlyInFull` | `session-ledger/projection.ts` | `/om status` 的 `-N` 漂移后缀 |
| reflector `supersedes: id[]` | `agents/reflector/agent.ts` | 只有**同时提出替代反思**的提案才能取代旧反思；未知 id 忽略；提案自己的 id 不算目标 |
| 合并可复用既有措辞 | 同上 | 与既有反思同 id（重复提案）时仍收集 `supersedes`，所以"合并成已经存在的那条"也能收敛 |
| `REFLECTION BUDGET` 行 + 合并规则 | `agents/reflector/{agent,prompts}.ts` | 视图给出反思可用份额；超出时 prompt 要求先合并再新增；`REFLECTOR_SYSTEM` 增加 Merging 段 |
| `VisibleMemory.reflectionBudgetTokens` | `session-ledger/select.ts` | 预算分节后反思的份额，供上面那行使用 |
| 阶段写入 tombstone | `hooks/consolidation-trigger.ts` | 先写 `om.reflections.recorded`（若有新条），再写一条 `om.reflections.dropped`；只有合并、没有新条时只写 tombstone |
| 运行摘要 | `hooks/consolidation-trigger.ts` | 新增 `-N superseded`；观测/反思计数仍按"已记录"计（否则 +1/-1 会互相抵消） |
| 消费方改用活跃反思 | `consolidation-trigger.ts`、`commands/{status,compact,consolidate}.ts`、`hooks/compaction-trigger.ts` | 池子门限、dropper 覆盖、渲染视图、`hasIdleCompactionWork` 都只看未被取代的反思 |

### 22.2 语义与不变量

- **反思只能被替代，不能被淘汰**：确定性阶段（enforcer）仍然完全不碰反思，唯一的收缩入口是 reflector 在同一次工具调用里声明 `supersedes`。没有第二个入口，也就没有"按时间删耐久事实"的行为。
- **不变量：离开活跃记忆的反思必须有一个替代者**。实现上只要提案的 content 有效（新条或与既有条同 id），其 `supersedes` 才被采纳；被拒绝的提案不产生 tombstone。因此"合并成既有措辞"也安全：替换者是那条已经存在的反思。
- **账本不可删**：tombstone 只是投影层的集合，`foldLedger().reflections` / `reflectionsById` 仍然保留被取代的条目（`/om view full`、diff、recall 都能看到），只是不再进入活跃记忆。
- **生效边界**：与观测 tombstone 一致——反思与 tombstone 都折叠到最近一次 full-fold 的 `firstKeptEntryId`，所以在下一次 full fold 时一起生效。

### 22.3 落地时的偏离与已知限制

- **recall 不标注"已被取代"**：`om_recall_evidence` 按 id 返回账本内容，不区分 active/superseded（观测的 `[dropped]` 标记没有反思对应物）。这是有意的范围控制：recall 的契约是"这个 id 当时记了什么"，且该工具文件当时有并行改动；如需标注应单独做。
- **反思合并的触发依赖模型判断**：reflector 只有在被调度（reflection 阈值）且模型决定合并时才写 tombstone；没有模型就没有合并（`/om consolidate` 可以强制触发一次）。
- **`reflectionBudgetTokens` 是"剩余份额"**：它由渲染行 tokens 计算（不是 `tokenCount` 字段），观测先按 `observationsPoolTargetTokens` 取份额，剩下的才归反思；反思填不满就还给观测。
- **合并到既有措辞会丢掉被取代反思的 support ids**：`foldLedger` 对同 id 是 first-valid-wins，账本没有"更新既有记录"的入口，所以合并成已有措辞时，那条反思保留原来的 `supportingObservationIds`。被取代反思所支撑的观测因此从 partial 掉回 none。这是安全方向（覆盖率是"冗余度"提示：失去覆盖只会让该观测更难被裁掉，不会被删），因此不改；如需精确保留证据，必须引入"更新既有反思"这一新的账本语义，属于另一个设计。

- **测试**：`session-ledger-{types,fold,projection,select,budget}`、`reflector`、`consolidation-trigger`、`status-command` 共新增 22 个用例（528 tests 全绿）。

### 22.4 第二轮自检（open-code-review，27 个文件 / 14 条评论）后的修正

- **取代者必须真的能生效**（真缺陷）：id 是内容哈希、tombstone 是永久的，所以"模型重述一条早已被取代的反思来替换别人"会记录成功但永远不活跃，最终两边都不在活跃记忆里。阶段现在先检查 `result.reflections` 的 id 是否命中 `folded.droppedReflectionIds`，命中则整批放弃写 tombstone（`debugLog reflector.supersede_skipped`），保证"离开活跃记忆必有替代者"不被绕过。
- **预算判断改用真实反思池**（真缺陷）：视图会把中间/较旧的反思裁掉，而 `reflectionBudgetLine` 原来只累计被保留的那些，于是"池子其实超预算"经常不显示 `Over budget`，合并提示形同虚设。现在把 `reflectionPool: { count, tokens }`（账本口径的活跃全场，与 enforcer 的门限同源）传给 reflector，预算行显示"活跃反思 ~X tokens（N 条，其中 M 条未显示）"，超出才提示合并。被视图裁掉的反思仍然无法被 supersede（模型看不到 id），这是已知限制：视图保留会话前 8 条锚点 + 最新若干条，而重复增长来自最新的一侧，所以合并入口覆盖了增长点。
- **未用完的反思份额交还观测**（真缺陷）：`selectVisibleMemory` 原来按"给反思预留的份额"而不是"实际保留下来的 tokens"计算观测预算，一条放不下的超大反思会让 600 tokens 的预算整块闲置、观测照旧被裁。现在 `observationBudget = min(观测总量, budget − 实际保留的反思 tokens)`，除"单条超长"外的边界都不再浪费预算。
- **窗口始终约束 softLimit**（真缺陷）：`reserveTokens` 缺失时 `softLimit` 直接退回 trigger，`reserveTokens ≥ contextWindow` 时同样退回，导致小窗口下渲染预算仍可越过窗口（例：窗口 8,192、无 reserve、tail 6,000、system 1,000 → 渲染 4,000，三者和 11,000 > 窗口）。现在 `softLimit = min(trigger, max(0, contextWindow − reserve))`（缺省按 0），窗口被前台占满时渲染预算为 0。
- **enforcer 的回收结果不受 `showWorkerNotifications` 抑制**（真缺陷）：它是唯一没有模型参与的记忆删除；关闭常规进度通知后，删除已经落账却在会话里完全不可见。现在该通知只看 `ctx.hasUI`；`shouldNotifyWorker` 仍管 observer/reflector/dropper 的进度与运行摘要（用户的有意选择）。
- debugLog 的 `reason` 去掉新引入的多层嵌套三元；`coverageTransitionsByRelevance` 现在先剔除被取代的反思再计入新反思，日志反映合并后的真实覆盖。
- 未采纳：**"预算放不下前导文本时也不要返回它"**。评审指出 preamble 回退不受预算约束（`renderedTokens > maxTokens`，极端情况下可能继续超窗）。这里保留回退，因为三种可选行为都更差：交还 Pi 的原生摘要器（不受任何预算约束，实际会放大几十倍）、取消压缩（阈值路径上 Pi 会在下一轮反复重试且上下文仍然超窗）、或截断用法说明（破坏前言本身的可靠性）。preamble 是常量级（约 240 tokens）、不随池子增长，且该路径已经带 warning 通知（`…; the budget cannot hold a memory line`），用户在 `/om status` 与 compaction 记录里都能看到这次越界。真正需要 0 预算的窗口（窗口 ≤ reserve + tail + system）本身已经无法正常压缩，属于上游问题。
- 未采纳：dropper 里 `observations.length > 0 ? … : 0` 的死分支（已按建议删除）、`scripts/pi-dev.ts` 的 codemode 重复注册与 `pi-status/src/footer.ts` 的 thinking level 显示（都不属于本次改动范围，后者已在上一轮转报用户）。

---

## 23. Phase 4 落地记录（2026-10-02）

### 23.1 落地内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| observer schema 去掉 `timestamp` | `agents/observer/agent.ts` | `RunObserverArgs` 新增必填的 `resolveTimestamp(sourceEntryIds)`；`OBSERVATION_TIMESTAMP_PATTERN` 与对应测试删除（不再有模型写入的时间需要校验） |
| 时间派生 | `hooks/consolidation-trigger.ts` `sourceTimestamps` / `earliestSourceTimestamp` | 用本次 chunk 的 `backlogEntries` 建 `id → 本地 'YYYY-MM-DD HH:MM'` 映射（无有效时间的 entry 跳过），取被引用 entry 中**最早**者；无可用引用时用 chunk 内最后一条有效时间，再退化为记录时刻 |
| 渲染按时间稳定排序 | `session-ledger/render-summary.ts` `sortObservationsByTime` | 排序是稳定的，同一分钟的观测保持账本插入序；行格式与 tokenCount 计算未变（时间戳定宽，长度不受影响） |
| prompt 同步 | `agents/observer/prompts.ts` | 不再要求模型给时间；改为说明"时间由你引用的 source entry 派生，所以引用的 id 也决定了它在时间轴上的位置" |

### 23.2 已知限制：旧条目

既有观测的 `timestamp` 是模型自报的，不做迁移、不重写账本（§11 的决定）；渲染排序对它们只退化为"按其自报时间排序"。

在事故会话 `01a0f238` 上实测（838 条活跃观测）：**166 条（19.8%）的自报时间与其引用 entry 的最早本地时间不一致**，最大偏差正是那条 `2026-07-01 09:52`（实际 `2026-10-01 07:52`，偏 92 天）；账本序存在 54 处相邻倒序，按时间重排后有 241 条（28.8%）换了位置。所有 838 条的 `sourceEntryIds` 都能解析（0 条未知 id、0 条无可用时间），所以派生规则本身没有覆盖率缺口——问题只在于旧条目没有回填。

新会话（或任何本 Phase 之后记录的观测）全部是派生时间，因此一次 compaction 后即收敛；`/om view` 仍按账本序显示，供人工核对。若希望连旧条目也按派生时间渲染，需要在渲染时用 `event.branchEntries` 重新推导（等于隐式迁移：summary 与 `/om view` 会显示不同的时间），本 Phase 有意不做。

### 23.3 第四轮自检（open-code-review，27 文件 / 14 条）后的修正

Phase 3 的自检报告是累积 diff 视角，14 条里混着已决的旧项；本轮只修与 Phase 4 相关或确实新发现的：

- **fallback 用了未发送的 backlog 条目**（真缺陷，本次引入）：`sourceTimestamps` 原来对整个 backlog 建映射并把"最后一条有效时间"当 fallback，而 chunk 可能被 token 上限截断（`serializeSourceAddressedBranchEntries` 只发完整条目），于是引用不到有效时间的观测会拿到**比它覆盖的对话更晚**的时间，排序失真。现在只按实际发送的 `sourceEntryIds` 建映射并取其中最后一条作 fallback。
- **被永久 tombstone 的反思又被交给 dropper**（真缺陷，本次引入）：上一轮加的"替代者无法生效就不写 tombstone"保护下，`result.reflections` 里可能含一条永远不会活跃的反思；`runDropperStage` 会把它加入覆盖依据，导致"为一条不存在的反思删掉观测"。现在阶段返回的 `sameRunReflections` 先按 `folded.droppedReflectionIds` 过滤，等于没有活跃反思时 dropper 直接不跑。
- **worker 的记忆视图用了 worker 自己的窗口**（真缺陷，Phase 1 遗留）：`resolveMemoryBudget` 的 cap 在未配置 `memoryMaxTokens` 时按窗口推导，而 observer/reflector/dropper 读的是**工作模型**窗口、compaction hook 与 enforcer 读的是**会话模型**窗口。工作模型窗口更小时，worker 看到的是被裁过的记忆，而摘要会渲染更多（反之更少），删除决策于是依赖一个不存在于摘要里的视图。现在三处 worker 视图统一用 `ctx.model?.contextWindow`（chunk 上限仍用工作模型，因为它约束的是 worker 自己的 prompt）。
- **反思池按正文字数记账**（真缺陷，Phase 2 遗留）：`Reflection.tokenCount = estimateStringTokens(content)` 不含 id 与换行，而观测侧用整行 `observationLineTokenCount`，于是高水位判定与实际渲染口径不一致（反思多时低估池子，跳过回收；同时 `cap − reflectionTokens` 给观测留多了空间）。新增 `reflectionLineTokenCount`，enforcer 水位/目标、reflector 的 `reflectionPool`、`/om status` 的 Active memory 与 Reflection pool 行统一用它；`Reflection.tokenCount` 仍是账本里存储的正文口径（旧数据不迁移）。
- **prompt 自相矛盾**：`What to emit` 要求"只输出当前反思里没有的新反思"、`How you work` 还要求"没有新的稳定内容就不要调用工具"，与 `Merging (supersedes)` 允许的纯合并路径冲突。现在明确"新增或合并都算工作，纯合并在没有新增内容时也是合法提案"，只有两者都不需要才不调用工具。
- 渲染排序的嵌套三元改为显式 `if`（违反本仓库样式规则）。
- 未采纳（重复项）：**前导文本回退不受预算约束**（§22.4 已决，见该处理由）、**合并到既有措辞丢失 support ids**（§22.4 已决：覆盖率是冗余提示，丢失只会让观测更难被裁掉）、**裁剪/回收/取代只在 UI 通知或持久条目里可见**（三者都已落成持久账本条目：`om.observations.dropped`、`om.reflections.dropped`、compaction 的 `details.budget`，事件级 session 消息会反过来吃掉被管理的预算）、**反思份额不回收观测未用完的额度**（需要二次分配，属"单行超长"边界；错误方向只是让 reflector 收到偏小的预算而多合并一次近重复项）、`pi-status/src/footer.ts`（用户自身在改的文件，已转报）。
- 2 处 LLM 请求遇到 502 后重试成功，`ocr exit=0`。

### 23.4 验证

- `test/observer.test.ts`：派生时间进入记录、模型伪造的 `timestamp` 被忽略；`test/consolidation-trigger.test.ts`：取最早引用、单引用、空引用 fallback、时间不可解析时退化；`test/session-ledger-select.test.ts`：渲染按时间单调、同分钟稳定。
- 三处 revert 验证（撤销排序 / 撤销"取最早" / 让模型时间重新生效）各自让对应用例失败。
- 全包 44 files / 534 tests、typecheck、build 全绿；本轮修正的 5 处同样各自通过 revert 验证。

## 24. 全仓 open-code-review 后的修正（2026-10-02）

本节记录的是**整仓** review（80 个文件 / 40 条）中属于本包的条目，不是 Phase 4 的 diff。三条是真缺陷：

- **观测清零后反思池无法收缩**（Phase 2/3 遗留）：enforcer 会在反思已占满 cap 时把观测额度算成 0，而 `RecordReflectionsSchema` 要求至少一个 `supportingObservationIds`，于是"纯合并"这条唯一能缩小反思池的路径恰好在这个状态下不可用（没有观测时 `runReflector` 直接返回 undefined，与 dropper 的"零观测"契约同源）。现在 support ids 可选，纯合并原样继承被替换反思的 support ids（账本 `isReflection` 仍要求非空 id 数组，因此合并不会产生非法条目），没有观测时也可以跑 reflector。
- **resurrection 保护按整轮生效**（Phase 3 引入）：`runReflectorStage` 原来在发现任一被接受的替代者永远无法活跃时跳过整轮 tombstone，同一轮里其他合法合并也一起没生效。保护下沉到 `runReflector`，只跳过"内容哈希正好落在永久 tombstone 上"的那一条提案（`droppedReflectionIds` 变为必填参数）。
- **观测未用完的额度不回流反思**（Phase 1 遗留）：`selectVisibleMemory` 只把反思没用的额度回流给观测，反向不回流，于是"观测份额用不完 + 反思被整条裁掉"时预算白白浪费。现在反思的选择多一轮**有界**回填（仍受行级预算与既有 keep order 约束）。

另两处：

- **源时间戳按本地时间字符串比较**（Phase 4 引入）：`fmtLocal` 输出的字符串在 DST 回拨那天不再单调，可能选错"最早的源条目"；改为按 epoch 比较。
- `/om status` 的高水位文案改为"下一次 consolidation 会尝试回收非关键观测"：原来承诺"会回收"，而反思占满预算、或没有非关键观测时 enforcer 会跳过，等于长期空头支票。

未采纳/转报：`src/hindsight/*` 与 `test/session-ledger-render-summary.test.ts` 是用户自己在改的文件（转报），`pi-ext-tools`、`pi-ext-addon`、`pi-status`、`scripts/pi-dev.ts` 的问题属于其他工作线（一并转报，不在本包内修改）。

### 24.1 验证

- 回归测试：`test/reflector.test.ts`（没有观测也能纯合并并继承 support ids；只退休能生效的那些合并）、`test/session-ledger-select.test.ts`（观测用不完的额度回流反思）、`test/consolidation-trigger.test.ts`（把永久退休的反思集合交给 reflector）。
- 全包 44 files / 538 tests、package typecheck 与 build 全绿（与 pi-subagents 一起收口时整仓 72 files / 838 tests）。
- revert 验证：撤销"纯合并继承 support ids"、"按提案分组保护"、"额度回流"三处，各自让对应用例失败；epoch 比较按构造正确（`consolidation-trigger.test.ts` 的断言依赖 `fmtLocal` 的默认 TZ，无法在不污染整文件的前提下造 DST 定点用例），因此没有定点测试。
