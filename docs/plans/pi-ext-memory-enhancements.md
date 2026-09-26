# pi-ext-memory 体验与功能增强设计参考（与现行行为对比）

## 1. 目标与背景

根据最新决策，**Footer 抽象暂不实现，相关计划已移出**。`@hheei/pi-ext-memory` 的体验与功能增强不再等待或依赖任何 footer 抽象层，所有新增的可观测性、手动控制与会话管理均收敛至**原生命令（`/om:*`、`/om`）与通知系统**。

本文档针对此前调研（`docs/research/pi-ext-memory-upstream-comparison.md`）中识别的高价值候选特性，提供一份**详尽的参考设计规范**，并逐项与当前 `@hheei/pi-ext-memory` 的现行行为进行全景对比。

核心目标：
1. **解决开销黑盒**：引入会话级与 Worker 级成本统计，让后台记忆消耗透明可查；
2. **填补手动控制空白**：提供按需手动触发整理（Consolidation）与压缩（Compaction）的命令，服务于调试、演示与用户主动管理；
3. **建立历史空间感知**：在 `/om:status` 中提供终端自适应的直观时间轴，一眼洞察压缩裁切点、活跃记忆池与原始缓冲；
4. **理清门控与被动模式**：解耦会话级即时开关（`/om on/off`）与自动化巡航开关（`passive`），支持单会话免打扰与分支持久化；
5. **优化运行反馈**：规范化 Worker 运行过程与终态增量汇报，消除通知踩踏。

---

## 2. 现行行为全貌梳理 (Current Baseline)

当前 `@hheei/pi-ext-memory` 的主要行为基线如下：

| 维度 | 现行实现位置 | 现行行为特征 | 痛点 / 局限 |
| --- | --- | --- | --- |
| **命令接口** | `src/commands/{status,view}.ts` | 仅注册了两个只读命令：<br>1. `/om:status`：纯文本展示条目统计与 Token 阈值百分比；<br>2. `/om:view [full]`：输出记忆文本并尝试写入剪贴板。 | 无法手动介入。想触发提炼或压缩只能等 Token 累积超标或 1800 秒闲置。 |
| **触发机制** | `src/hooks/consolidation-trigger.ts`<br>`src/hooks/compaction-trigger.ts` | 1. **整理**：`agent_end` / `turn_end` 后按 `observeAfterTokens`（10k）、`reflectAfterTokens`（20k）阈值触发；<br>2. **压缩**：上下文达到 `compactAfterTokens`（默认 81k）或闲置达到 `idleCompactionTtlSeconds`（1800s）后触发。 | 阈值驱动完全被动，在小会话、测试或刚完成大任务时无法即时触发提炼整理。 |
| **流水线架构** | `src/hooks/consolidation-trigger.ts:240-300` | 进程内（in-process）顺序流水线：<br>`Observer`（提炼观测）→ `Reflector`（归纳反思）→ `Dropper`（池大小控制剪枝）。 | 任意时刻仅单 Worker 在跑，无并发冲突，但各阶段独立零散发 notify。 |
| **成本追踪** | `src/session-ledger/progress.ts` | 读取 `getContextUsage` 获取会话上下文 Token，但在 Worker assistant message 流中**完全丢弃了 `usage.cost.total`**。 | 用户完全无法得知记忆系统究竟消耗了多少 API 费用（美元）。 |
| **模式控制** | `src/config.ts` | 仅有配置级 `passive: boolean`（支持 `ext_settings.json` 与环境变量 `PI_OBSERVATIONAL_MEMORY_PASSIVE=1`）。 | 无法在会话内动态切换；没有单会话级别的彻底 Opt-out / Opt-in 门控。 |
| **通知与反馈** | 各 Agent 与 Trigger 中分散调用 `ctx.ui.notify` | 阶段开始、阶段失败零散抛出 notify；完成时只记录 Ledger 条目，**不向用户反馈本次新增或淘汰了多少条记忆**。 | 多次通知容易在 TUI 覆盖闪烁；缺乏成果反馈感。 |

---

## 3. 增强能力对比与参考规范 (Feature-by-Feature Reference)

### 3.1 成本追踪与报表 (Cost Tracking & Reporting)

#### 现行行为
- `src/agents/worker-stream.ts` 封装了 `streamSimple`，但在调用完成后只提取 assistant 消息的文本内容和 tool 调用，不提取、不累加 `usage.cost`。
- `src/commands/status.ts` 仅展示 Token 估计值（如 `~1,500 / 20,000 tokens (8%)`），对实际货币开销（USD）毫无感知。

#### 参考设计规范
1. **数据捕获**：
   - `@earendil-works/pi-ai` 的 `AssistantMessage` 在完成时已原生包含 `usage.cost.total`（为可选的数字，单位为 USD）。
   - 在 `runObserver`、`runReflector`、`runDropper` 的运行退出点，提取当次 Worker 产生的真实 `usage.cost.total`。
2. **汇总口径与生命周期**：
   - 在 `Runtime` 类中维护会话累加器：
     ```ts
     interface WorkerCostStats {
       totalCostUsd: number;
       runs: { observer: number; reflector: number; dropper: number };
     }
     ```
   - **跨 `/tree` 分支不回退**：即使用户切换会话分支，已经发生的物理 API 调用费用依然存在（与 amos 保持一致口径）。
   - **不写入 Ledger**：成本是宿主运行期指标，**严禁通过 `appendEntry` 写入会话 Ledger**，避免污染条目结构、破坏投影与现有纯函数单测。
   - 生命周期与 `Runtime.startSession` 绑定，会话结束或 `/reload` 时清零。
3. **界面展示**：
   - 在 `/om:status` 中增加 `── Cost ──` 小节：
     ```text
     ── Cost ──
     Worker spend:  $0.0125 (4 runs: 2 obs, 1 refl, 1 drop)
     ```
   - 若没有产生任何 Worker 运行，显示 `Worker spend:  $0.0000 (0 runs)`。

---

### 3.2 手动控制命令 `/om:compact` 与 `/om:consolidate`

#### 现行行为
- 没有任何手动命令能够触发记忆的即时整理或压缩。
- 用户如果想手动压缩，只能在全局调用 Pi 的 `/compact` 命令，无法单独指示记忆系统先整理再压缩。

#### 参考设计规范

#### 1. `/om:consolidate`（手动强制整理）
- **功能定位**：立即对当前会话分支执行一次完整的整理流水线（Observer → Reflector → Dropper），无需等待 Token 跨过 10k/20k 阈值。
- **参数**：无参数。
- **并发与状态互斥**：
  - 若 `runtime.consolidationInFlight === true`，提示："Consolidation already in progress." 并退出；
  - 若 `runtime.compactInFlight === true`，提示："Compaction in progress, please wait before consolidating." 并退出；
  - 若当前会话无新增 source entries 且无待提炼的 observations，提示："Memory backlog is already up to date." 并退出。
- **执行逻辑**：
  - 传入 `force: true` 调用 `runConsolidationPipeline`，该标志使 `runObserverStage` 和 `runReflectorStage` 绕过 `stageDue` 检查。
  - 完成后通过 `ctx.ui.notify` 汇总反馈结果（见 §3.5）。

#### 2. `/om:compact`（手动强制压缩）
- **功能定位**：立即基于当前分支已有的 Observations 与 Reflections 触发 Pi 原生 Compaction，截断原始上下文并置入记忆摘要。
- **参数**：无参数。
- **前置与互斥保护**：
  - 若 `runtime.compactInFlight === true` 或 `runtime.compactHookInFlight === true`，提示："Compaction already in progress."；
  - 若 `runtime.consolidationInFlight === true`，**建议先自动等待当前整理流水线完成**（`await runtime.consolidationPromise`），确保压缩使用的是最新的提炼成果；
  - 检查分支条目：调用 `foldLedger(entries)`，若 `activeObservations.length === 0 && reflections.length === 0`，且未压缩 Token 极小，提示："No memory available to compact (pool is empty). Run /om:consolidate first."，**拒绝发起空压缩**，避免误触发慢速昂贵且质量不可控的原生 LLM 总结器。
- **执行方式**：
  - 直接调用 Pi 宿主提供的 `ctx.compact()`。
  - 既有的 `registerCompactionHook`（`src/hooks/compaction-hook.ts`）会自动拦截此请求，生成格式化的 `renderSummary` 并返回给宿主生效。
  - 压缩完成后通知用户上下文已截断。

---

### 3.3 历史结构时间轴条带 (Timeline Strip in `/om:status`)

#### 现行行为
- `/om:status` 仅以数字和百分比呈现进度：
  ```text
  ── Activity ──
  Next observation: ~3,200 / 10,000 tokens (32%)
  Next reflection:  ~8,400 / 20,000 tokens (42%)
  Next compaction:  ~45,000 / 81,000 estimated source tokens (55%)
  ```
- 缺乏直观的空间感，用户无法感知会话历史的宏观全貌（哪些历史被扔掉了，哪些被总结了，哪些还在堆积）。

#### 参考设计规范
1. **渲染位置**：在 `/om:status` 的最底部输出紧凑时间轴。
2. **符号与本地语义映射**（重新适配，不照抄 amos 的文件语义）：
   - `▓` **Compacted**：已经被压缩截断、脱离活跃上下文但已沉淀为 Summary 的历史区间（早于 `firstKeptEntryId`）；
   - `▒` **Observed Pool**：已被 Observer 处理、作为当前活跃 Observation / Reflection 留存在活跃上下文中的区间；
   - `░` **Raw Backlog**：尚未被 Observer 覆盖的新产生原始对话区间；
   - `┊` **Cutoff Marker**：最近一次 Compaction 截断点；
   - `▶` **Tip**：会话分支末梢（当前所在位置）。
3. **宽度与自适应规则（严禁硬编码 60 列）**：
   - 必须通过 `ctx.ui` 传入的可用宽度（或保底 60~80 列）计算。
   - 单个 Cell 代表的 Token 步长动态自适应（例如：`stepTokens = max(5000, ceil(totalTokens / (width - 4)))`），确保整条时间轴在标准宽度下保持为 **1 到 2 行**，严防终端折行破坏视觉。
4. **视觉示例**：
   ```text
   ── History Timeline ──
   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┊▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░▶
   [▓ Compacted  ▒ Observed pool  ░ Raw backlog  ┊ Cutoff  ▶ Tip] (~5k tok/cell)
   ```

---

### 3.4 会话门控 `/om` 与 `passive` 模式解耦

#### 现行行为
- 仅有静态的全局/项目配置 `passive: boolean`。
- 若 `passive === true`：关停后台自动 consolidation 和 idle compaction，但 `/om:status`、`/om:view`、`recall` 工具以及手动 Pi compact 仍然加载。
- 缺乏**动态切换**与**彻底 Opt-out** 能力：用户无法在单个会话中临时关停记忆（比如处理不需要长期记忆的敏感单次任务）。

#### 参考设计规范（正交两层契约）

```text
┌──────────────────────────────────────────────────────────────┐
│ 1. 会话门控 (Gate: Enabled / Disabled)                        │
│    命令: /om, /om on, /om off                                │
│    控制: 该会话是否加载与运行记忆系统                          │
└──────────────┬───────────────────────────────────────────────┘
               │ (若 Gate 为 Enabled)
               ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. 自动化模式 (Mode: Active / Passive)                        │
│    配置: passive: boolean (ext_settings.json)                │
│    控制: 是全自动后台巡航，还是纯手动命令响应                  │
└──────────────────────────────────────────────────────────────┘
```

1. **Gate（会话门控：`/om`、`/om on`、`/om off`）**：
   - **默认状态**：默认为 `on`。
   - **当 Gate 为 `off` 时**：
     - **彻底静默**：所有 hook（`session_before_compact`、`before_agent_start`、`agent_end`）直接 return，不执行任何计算；
     - **停用定时器**：闲置压缩定时器与重试定时器全部清理；
     - **工具友好提示**：`recall` 工具若被模型调用，直接返回提示："Observational memory is disabled for this session. (Turn on with /om on)";
     - **命令响应**：输入 `/om` 提示已关闭，显示 "Observational memory is OFF for this session. Run /om on to enable."。
   - **持久化契约**：
     - 采用与 amos 类似的 `pi.appendEntry(OM_GATE_STATE, { enabled: boolean })` 写入会话 Ledger。
     - **收益**：状态自然绑定分支，`/tree` 切换历史与 `/resume` 重新打开时能精确恢复当时的门控状态。
2. **Passive（运行模式：`passive: boolean`）**：
   - 保持现有定位：当 Gate 为 `on` 时生效。
   - `passive: false`（默认）：自动驾驶。后台按 Token 阈值自动跑 consolidation，闲置时自动 idle compaction。
   - `passive: true`：手动驾驶。自动触发器全部休眠，但允许用户通过 `/om:consolidate` 和 `/om:compact` 主动触发，模型也可以正常使用 `recall`。

---

### 3.5 Worker 运行状态与增量反馈优化

#### 现行行为
- 每次 Worker（Observer/Reflector/Dropper）启动、成功、失败都各自调用一次 `ctx.ui.notify`。
- 如果流水线连续执行 3 个阶段，用户会在几秒内收到 3~4 次弹窗通知。
- 完成时用户只看到一条笼统的 "Consolidation complete"，不知道究竟记录了多少条观察、提炼了多少反思、淘汰了多少旧数据。

#### 参考设计规范
1. **阶段演进平滑化**：
   - 阶段开始时使用同一条轻量通知或状态标记更新（避免连续弹多条独立信息）；
   - 仅在 `showWorkerNotifications: true` 且 `ctx.hasUI === true` 时输出。
2. **终态增量汇报 (Delta Summary)**：
   - 汇总流水线前后的 Ledger 投影差异：
     ```ts
     const deltaObs = newObservations.length;
     const deltaRefl = newReflections.length;
     const deltaDropped = droppedIds.length;
     ```
   - 成功时输出清晰的结构化摘要：
     ```text
     Observational memory: consolidation complete (+3 obs, +1 refl, -2 dropped) · $0.0038
     ```
   - 若阶段跳过（无新内容）或未产生新条目，静默或给出简洁的 "Backlog up to date"。
3. **错误精准归因**：
   - 明确指出失败发生的具体阶段与原因：
     ```text
     Observational memory: consolidation failed in [reflector] stage: Model context exceeded
     ```

---

## 4. 综合对比一览表 (Current vs Proposed)

| 特性维度 | 现行行为 (Current) | 参考设计 (Proposed) | 改动范围 | 核心收益与取舍 |
| --- | --- | --- | --- | --- |
| **开销可观测** | 无成本统计；`/om:status` 仅显示 Token 阈值百分比 | 捕获 assistant message 的 `usage.cost.total`；在 `/om:status` 展示会话级成本与运行次数 | `Runtime`、`worker-stream`、`status.ts` | **高收益/低风险**。内存维护，不污染 Ledger；直观回答"花了多少钱"。 |
| **手动整理命令** | 无；必须等待累积 10k/20k Token | 新增 `/om:consolidate`；跳过阈值强制执行三阶段流水线；带并发守卫与防重入 | `commands/consolidate.ts`、`consolidation-trigger.ts` | **高收益/低风险**。满足即时调试、测试与演示需求；无未处理条目时直接退出。 |
| **手动压缩命令** | 无；必须等待达到 81k Token 或 1800s 闲置；调用全局 `/compact` 无法定向控制 | 新增 `/om:compact`；带有效记忆预检（空池拒绝压缩）；调用 `ctx.compact()` 经由现有 hook 生效 | `commands/compact.ts`、`compaction-trigger.ts` | **高收益/低风险**。防止空记忆误调用原生昂贵 summarizer；提供按需压缩能力。 |
| **时间轴结构展示** | 无；仅文字输出各池 Token 计数与百分比 | `/om:status` 底部输出单行终端自适应时间轴条带与图例（`▓ ▒ ░ ┊ ▶`） | `status.ts`、新增 `timeline.ts` 纯函数 | **高体验收益**。直观呈现历史压缩、记忆池与未处理缓冲结构；纯渲染逻辑，无副作用。 |
| **会话动态门控** | 仅有配置文件/环境变量中的静态 `config.passive` | 新增 `/om [on/off]` 切换；Gate（开启/关闭）与 Passive（全自动/手动）两层正交解耦；状态写入 Ledger 分支 | `commands/gate.ts`、`runtime.ts`、各 hook 入口预检 | **规范性收益**。符合敏感/特权能力显式 opt-in 原则；分支持久化支持 `/tree` / `/resume` 状态还原。 |
| **Worker 运行反馈** | 多阶段零散通知；完成时缺乏条目增量统计 | 阶段提示聚合；终态输出明确增量 `(+N obs, +M refl, -K drop)` 与当次费用 | `consolidation-trigger.ts` | **低成本/好体验**。消除通知刷屏，提供确定性的记忆沉淀反馈。 |

---

## 5. 架构与控制流影响 (Architecture & Lifecycle)

### 5.1 并发与互斥矩阵 (Concurrency Matrix)

引入手动控制命令后，必须明确互斥规则以防止重入冲突与状态踩踏：

| 当前正在运行的操作 | 用户执行 `/om:consolidate` | 用户执行 `/om:compact` | 闲置定时器触发 Idle Compact | 用户在前台继续对话 (Turn Start) |
| --- | --- | --- | --- | --- |
| **Consolidation** (正在整理) | 拒绝并提示已在运行 | **安全等待** `consolidationPromise` 完成后再压缩，确保使用最新提炼成果 | 放弃当次闲置压缩排程 | 允许（in-process worker 运行中若前台发新 turn，正常按 signal 协作） |
| **Compaction** (正在压缩) | 拒绝并提示等待压缩完成 | 拒绝并提示已在运行 | 放弃当次闲置压缩排程 | Pi 宿主原生拦截（提示稍后重试） |
| **空闲状态** | 立即启动整理流水线 | 立即发起压缩流程 | 满足条件则启动闲置压缩 | 正常开启前台 turn |

### 5.2 存储与 Ledger 不变量 (Storage & Ledger Invariants)
- **成本指标绝不落盘**：`WorkerCostStats` 纯属内存运行态数据，不创建任何自定义 Ledger entry，确保 Ledger 历史纯度与重放稳定性；
- **门控条目遵循 V3 规范**：若采用 Ledger 记录 `/om on/off`，条目类型应为明确命名的自定义条目（如 `om:gate`），并确保 `foldLedger` 将其作为元数据处理，不影响 source entries、observations 与 reflections 的计数与投影。

---

## 6. 逐步实施路线建议 (Implementation Roadmap)

建议分为三个轻量、聚焦的迭代分步推进：

### 阶段一：纯观察与手动控制（无持久化变更，低风险即刻见效）
1. **成本捕获与展示**：`worker-stream.ts` 抓取 `usage.cost.total`，`Runtime` 累加，并在 `/om:status` 中输出；
2. **手动命令 `/om:consolidate` 与 `/om:compact`**：实现互斥校验、空池守卫与强制触发；
3. **成果增量通知**：在整理完成时输出增量变更条目统计。

### 阶段二：可视化感知（纯渲染，零状态副作用）
1. **时间轴渲染器 `timeline.ts`**：实现基于终端宽度的自适应步长算法与 ANSI-safe 截断；
2. **集成至 `/om:status`**：作为状态面板的末尾模块输出。

### 阶段三：会话门控与持久化（涉及 Ledger 条目契约）
1. **设计 `om:gate` 条目模式**：在 `session-ledger` 中定义门控变更条目；
2. **实现 `/om`、`/om on`、`/om off`**：关联 `pi.appendEntry` 与分支状态反向扫描；
3. **Hook 守卫全量拦截**：当门控为 off 时全面短路，确保彻底静默。

---

## 7. 实施状态与设计偏差 (Implementation Status)

本计划已实施完成（提交于本次变更）。以下记录实际落地时对设计稿的修正：

| 设计稿 | 实际实现 | 修正原因 |
| --- | --- | --- |
| 门控状态存在 `Runtime` 标志位，并在 `session_start` 时反向扫描分支加载 | 完全取消缓存标志：`latestGateEnabled(branch)` 每次从分支派生 | 缓存标志在 `/tree` 中途切分支时会过期；分支派生让 `/tree` 与 `/resume` 天然正确，且无需在生命周期里同步状态 |
| 门控常量命名为 `om:gate` | 实际使用 `om.gate` | 与既有 `om.observations.recorded` / `om.reflections.recorded` / `om.observations.dropped` 命名保持一致 |
| 时间轴按 chunk 单元（照抄 amos 的 `chunkTokens`） | 按自适应 token 步长（`stepTokens = ceil(total / cellBudget)`），并预留 `┊` 标记与 `▶` tip 的列宽 | 本地没有 `chunkTokens` 这一概念（chunk 上限由模型上下文推导），固定步长会导致不同宽度下折行；预留列宽才能真正保证单行不溢出 |
| 时间轴宽度由 `ctx.ui` 传入 | 取 `process.stdout.columns`（无值则 80 列保底），最后再用 `truncateToWidth` 兜底 | `/om:status` 通过 `notify` 输出纯文本，拿不到组件渲染宽度；这样既跟随真实终端，又对未知宽度安全（Pi 对超宽行会报错） |
| 门控关闭时 `recall` 返回通用提示文本 | 新增 `disabled` 工具状态与 TUI note 行 `memory off` | 让模型与 TUI 都能区分“记忆为空”与“记忆被关闭” |
| 阶段通知改为“同一条轻量通知更新” | 保留各阶段起始通知，删除阶段完成通知（`N observations recorded`），新增运行结束增量行 | Pi 的 `notify` 没有原地更新语义；删掉与总结重复的完成通知即可达到减少刷屏的目的 |
| `/om:consolidate` 需要先判断池是否超 target 才执行 | 只要存在未覆盖对话或已有记忆就执行；dropper 仍按 target 自行决定是否剪枝 | 本地流水线不只服务于池剪枝；用户请求“立刻整理”时应跑完整三阶段，而不是提前拒绝 |
| 成本口径记录“全分支求和” | 按 **session generation** 累计（`startSession` 清零），分支切换不回退 | 等价结果且无需读分支；`/reload` 后归零符合“运行期指标”定位 |

已落地的测试（均有灵敏度验证，回退对应实现即会失败）：

- 门控：`test/gate-command.test.ts`（7 例）、`test/session-ledger-progress.test.ts` 门控与成本段、
  `test/consolidation-trigger.test.ts` 与 `test/compaction-trigger.test.ts` / `test/compaction-hook.test.ts` 的短路用例、
  `test/recall-tool.test.ts` 的禁用与恢复用例；
- 手动命令：`test/manual-commands.test.ts`（18 例，含跨 await 后重新校验门控/in-flight/会话代际）；
- 时间轴与宽度：`test/timeline.test.ts`（6 例，含可见宽度上界）、`test/status-command.test.ts` 的逐行宽度上界用例；
- 成本与增量汇总：`test/consolidation-trigger.test.ts`、`test/runtime.test.ts`、`test/status-command.test.ts`。

### 7.1 实现后代码审查修正 (Review Follow-ups)

对本次实现做了一轮外部 AI 代码审查（alibaba/open-code-review）。逐条判断后的结论：

| 审查发现 | 判断 | 处理 |
| --- | --- | --- |
| `/om:consolidate` 与 `/om:compact` 的 in-flight 检查与 `ensureConfig`/等待 consolidation 之间存在 `await`，而 `launchConsolidationTask` 与 `runtime.compactInFlight = true` 都会无条件占用锁，可能同时跑两条流水线 | 成立（高） | 把门控、in-flight、会话代际和空池校验全部下沉到最后一个 `await` 之后，使 check→claim 在同一 tick 内原子完成 |
| 等待结束后没有重新校验会话代际与门控，stale command context 可能在新会话/门控关闭后启动 worker 或压缩 | 成立（高/中） | 两个命令都保存入口处的 `runtime.sessionGeneration` 并在 await 之后用 `isSessionCurrent` + 重新读取 branch 校验；失效时静默返回 |
| `agent_settled` 的延迟路径（`setTimeout(...,0)`）没有重新检查门控，与 idle timer 路径不一致 | 成立（中） | 延迟回调里在拿到 `currentEntries` 后补一次 `latestGateEnabled` 检查 |
| 旧会话的 worker 仍可能在新会话里回调 `onCost`，污染新会话统计与下一次运行的增量金额 | 成立（中） | 新增 `costRecorder(runtime, ctx)`，回调内先校验 `isSessionCurrent(ctx.sessionGeneration)` 再记账 |
| `force` 会绕过阈值，使分支没有新对话时仍强制调用 observer 并计费 | 部分不成立 | observer 在调用模型**之前**已有空 chunk 短路（`sourceEntryIds.length === 0`），不会产生费用；额外增加 `tokens === 0` 判断反而会在“条目实际存在但估算 token 为 0”时误跳过真实内容，因此不采纳，改为在阈值处注释说明 force 的边界 |
| `runForcedConsolidation` 使用当前 generation 而非调用方上下文 | 成立但已由命令侧修复覆盖 | 命令在启动前同一 tick 校验会话货币性，并在 `runForcedConsolidation` 的 JSDoc 中明确该调用约束 |
| 只有时间轴行做了宽度截断，`/om:status` 其余行仍可能超出终端宽度 | 成立（中） | `/om:status` 输出改为逐行 `truncateToWidth`；同时修正时间轴多行块被当作单行截断的问题（改为 push 各行） |

已知残留：无。

审查修正之后又补了一次运行级成本归因：原先汇总行的金额是“运行前后会话总花费的差”，而同一会话里被中止运行的 worker 若在下一次运行窗口内才回调 `onCost`，其金额会被计入后一次运行。现在 `Runtime.recordWorkerCost` 返回实际入账金额，`runConsolidationPipeline` 为每次运行维护自己的 `RunCost` 累加器，汇总行只报告本次运行累计到的金额；会话总花费仍然记录这笔钱（钱确实花在本会话），只是不再冒充后一次运行的成本。

