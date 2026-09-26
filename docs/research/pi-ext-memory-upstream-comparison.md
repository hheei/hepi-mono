# pi-ext-memory 上游对比调研：amosblomqvist 分支的 UI/UX 与特性

> 日期：2026-09-26
> 范围：为 `packages/pi-ext-memory` 评估可借鉴的终端 UI/UX 与特性。**不构成实现规格**，不改变当前行为。
> 调研对象（均固定 revision）：
>
> | 代号 | 仓库 | revision | 说明 |
> | --- | --- | --- | --- |
> | **amos** | [`amosblomqvist/pi-observational-memory`](https://github.com/amosblomqvist/pi-observational-memory) | `78a1efcfdd46332253fb289724f05b26dfc7769e`（2026-08-25） | 独立重写，包名 `observational-memory` v0.1.0，57 文件 |
> | **elpa** | [`elpapi42/pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) | `e891667d10fba3c70dd137fa55823ac1440f6f0d`（2026-09-23） | 本仓库 fork 的直接上游，v3.1.4 |
> | **local** | 本仓库 `packages/pi-ext-memory` | `c74da087b47c20a06c1dfe39ca4b3e5a707fc101` | elpa 的维护分支 + Hindsight |
>
> 证据来自浅克隆 `/tmp/up-amos`、`/tmp/up-elpa` 的源码与测试，以及本仓库 HEAD。

## 0. 结论摘要

1. **amos 不是 GitHub fork，而是同一名字下的独立重写。** GitHub API 显示 `fork: false`、无 `parent`（elpa 同样），创建于 2026-06-26，比 elpa（2026-04-14）晚两个月；它 vendor 了 elpa 的 ledger/tokens/ids/serialize/debug-log 并**删掉了 reflections 层**，把 worker 从 in-process 改成**子进程 `pi -p`**，并新增 `.memory/` 长记忆层与 TUI。两者是"同一设计问题的两种解法"，不是版本前后关系。
2. **最有价值的差异集中在两处：终端可见性（footer + 单行 worker widget + 成本）与 worker 可审计性（子进程 = 可打开的 Pi session）。** 这两点正是 local 目前完全没有的。
3. **成本显示不需要子进程就能实现。** amos 通过 worker 子进程读 pi 内置 `usage.cost.total`（`agent/cost.ts`），但该字段就在 `AssistantMessage.usage.cost.total`（`@earendil-works/pi-ai` `Usage` 接口）上，local 的 in-process `agentLoop` 同样拿得到。这是**投入最小、收益最直接**的候选。
4. **`.memory/` 持久主题文件与 Hindsight 是同一职责的两个 owner**，不应同时引入；建议明确"长记忆 = Hindsight"，把 amos 的 topic/JOURNEY 设计当作对照而非移植目标。
5. **amos 自身有两个不该照抄的细节**：footer 状态行在 gauges 生效后会丢掉 `om` 标签（`renderFooter` 的 `base` 未被使用），README 默认值与 `src/config.ts` 的 `DEFAULTS` 已经漂移（详见 §7）。

## 1. 谱系澄清

`README.md:5` 把 local 标注为"基于 pi-observational-memory 构建"，指向 elpa。实际关系：

```
elpa  v3.1.4 (2026-09-23)  ──────────────►  local  = elpa src/*  +  extension.ts  +  hindsight/*
   │                                            （26/32 个共享文件已分叉修改）
   │  同一设计（observer/reflector/dropper + session-ledger，
   │  in-process，无长记忆文件层）
   │
   └─ vendor ledger/tokens/ids/serialize/debug-log（trim 掉 reflections）
      └─────►  amos v0.1.0 (2026-08-25)  = 独立重写
               in-process  → 子进程 pi worker
               observer/consolidator（无 reflector/dropper）
               + .memory/<sessionId>/ 持久层
               + TUI（footer 状态 + worker widget + timeline）
               + 成本追踪 + per-session 开关
```

文件集对比（`git ls-files`）：

| | amos | elpa | local |
| --- | --- | --- | --- |
| 入口 | `src/index.ts`（orchestrator）+ `agent/index.ts`（worker 扩展） | `src/index.ts` | `src/index.ts` → `extension.ts` |
| worker 执行 | 子进程 `pi -e agent/index.ts -p` | in-process `agentLoop` | in-process `agentLoop` |
| worker 角色 | observer、consolidator | observer、reflector、dropper | observer、reflector、dropper |
| 长记忆 | `.memory/<sessionId>/{INDEX.md,<topic>.md,JOURNEY.md}` | 无（仅 ledger） | 无（Hindsight 承担跨会话） |
| TUI | footer + widget + timeline | 仅 `notify` | 仅 `notify` |
| 测试 | 14 文件 | 29 文件 | 38 文件 / 392 用例 |
| 文档 | README、PLAN.md | README、docs/×3 | README、docs/×3、Hindsight |
| 最近活动 | 2026-08-25（停滞约 1 个月） | 2026-09-23 | 持续 |

## 2. 终端 UI/UX 对比

| Surface | amos | local |
| --- | --- | --- |
| footer 状态行 | **有**：`om` + O/C/X 三条 gauge + `$cost`（直接 `setStatus`） | **无**（新设计将经 core `registerFooterItem`） |
| `ctx.ui.setWidget` | **有**：单个 `om-workers` 单行 widget，并行 worker 并排 | **无** |
| `ctx.ui.notify` | 有，且**合并**同一 tick 的并行 info 行 | 有，每个 stage 一句长句 |
| 命令 | `/om`（开关）、`/om:status`、`/om:compact`、`/om:consolidate` | `/om:status`、`/om:view [full]` |
| spinner | 120ms `◐◓◑◒`，仅在有 running worker 时刷新 | 无 |
| settle（完成后驻留） | 5000ms 后移除该 worker | 无 |
| timeline 条形图 | **有**（`/om:status` 内嵌） | 无 |
| 剪贴板 | 无 | **有**（`/om:view` 复制渲染结果） |
| git/ANSI 宽度处理 | 依赖 `truncateToWidth`（README 声明） | 依赖 Pi 原生 `notify` 换行 |

### 2.1 footer 状态行（amos）

`src/ui/status-controller.ts`：

- 固定 key：`FOOTER_KEY = "om"`（:42），widget key `om-workers`（:43）。
- gauge：`O<bar>` 下一次 observer chunk 进度、`C<bar>` 活跃 observation pool、`X<bar>` 上下文窗口 vs 压缩阈值；`▕████░░░░▏` 8 格，`frac >= 1` 时整条转 `warning` 色（:163-175）。
- 成本：`$0.000`，`dim` 色，跟在 gauge 右侧（:186）。
- attach 时机：`session_start` 且 `enabled && ctx.mode === "tui" && ctx.hasUI`（`src/index.ts` `attachIfEnabled`）；门关时立即 `detach()`。

宿主原生 footer 的实际语义（Pi 0.87.0，`dist/modes/interactive/components/footer.js:203-220`，已回源码核实）：

- footer 最多三行：`pwd (branch) • sessionName`、统计行（`↑ ↓ R W CH% $cost ctx%/window (auto)` + 右对齐的 `(provider) model • thinking`）、**扩展状态行**。
- 所有扩展的 `setStatus` **合并到同一行**（不是每个 key 占一行），按 key 字母序 `localeCompare` 排序，以单个空格连接；无 status 时该行**完全不输出**（零占位是原生行为）。
- 每项先 `sanitizeStatusText`（`\r\n\t` → 空格、折叠连续空格、trim），整行再 `truncateToWidth(width, dim "...")`。

结论：原生路径上**不存在**左右对齐、优先级或按项裁剪的位置；core 要提供这些能力就必须换 transport。这与 `DESIGN.md:108`（Todo 改由 `pi-ext-core` Footer Compositor 统管）和 `docs/architecture/tui.md:59-70` 的既有计划一致，具体方案与取舍见 **`docs/plans/footer-rail-compositor.md`**。

### 2.2 单行 worker widget（amos）

`StatusController.renderWorkersWidget()`（:190-217）：

```
◐ [observer]   ◐ [observer]   ✓ [observer] +4   ✗ [consolidator]
```

- 所有活跃/驻留 worker 渲染到**同一条** `om-workers` widget 行，用 3 空格分隔——README/代码注释明确说明这是对原始 PLAN "per-worker widget 堆叠"（`PLAN.md` A7）的**改变**，目的是让并行 observer 并排而不是纵向堆叠占用多行。
- 成功显示 `✓ [type] +N`（N = 本 run 新增 observation 数），失败显示 `✗ [type]`；两者 5s 后移除，最后一个移除时 widget 整体清空。
- spinner 只在存在 running worker 时 tick（:158-161 的 `hasRunningWorker` 判断），停止后不再重绘。
- 定时器全部 `unref?.()`，`detach()` 清 worker map 与 settle timer。

对 local 的意义：local 的 observer → reflector → dropper 是**同一条 pipeline 顺序执行**（`hooks/consolidation-trigger.ts:250/268/285`），任意时刻最多一个 worker，单行 widget 的"并行并排"价值不成立；它仍可作为"当前在跑哪个 worker"的一行提示，但收益低于 footer 成本显示。

### 2.3 toast 合并（amos）

`src/runtime.ts:66-105` `queueToast()`：info 级 toast 进入 `pendingInfoToastLines`，用 `setTimeout(..., 0)` 合并成**一条多行 notify**；warning/error 立即单独发出，避免与 info 行混淆。动机写在注释里：并行 observer 在同一个 tick 完成时，Pi 的 `showStatus()` 会用后一条替换前一条，导致"只看到最后一条"。`observer-trigger.ts:78-103` 的 start toast 也用同一手法在循环外批量发出。

local 目前每个 stage 一句独立 `notify`（`consolidation-trigger.ts:382/431/458/488/579`），因为串行执行不会撞车；仅当引入并行 worker 时才需要该机制。

### 2.4 `/om:status` 内容对比

| | amos | local |
| --- | --- | --- |
| 格式 | 缩进纯文本 + 内嵌 timeline 图 | `── Memory ──` / `── Activity ──` / `── In flight ──` / `── Last error ──` 分节 |
| 工人态 | observers in flight / concurrency、consolidator idle\|running | consolidation phase、compactInFlight、compactHookInFlight |
| 计数 | active observations、topic 文件数、journey 大小 | observations recorded/dropped/active/visible（带 `+N`/`-N` drift）、reflections recorded/visible |
| 时钟 | next observer、pool（target/consolidate at）、context（vs compactAtContextTokens） | next observation/reflection/compaction、visible pool、active pool、reflection pool（都带百分比） |
| 成本 | `session cost: $X (N runs)` | 无 |
| 门 | 关时提示 `om is off (use /om on to enable)` | 关时提示 passive 模式说明 |
| 尾部 | timeline 条形图 | 无 |

两者都用 `ctx.ui.notify(lines.join("\n"), "info")`——长文本走 toast 是共同选择（Pi 没有专门的命令输出面板）。差异在信息密度：amos 用一个可眼读的 timeline 取代百分比堆叠。

### 2.5 timeline 条形图（amos，`src/ui/timeline.ts`）

一行 glyph 条表示整条 session 的分层管线，**一格 ≈ `chunkTokens` 原始历史**：

```
om timeline · 1 cell ≈ 10.0k tok · 240.0k raw · 2 compactions
▓▓▓▒▒░░░░┊░░▶
  ▓ .memory (2)   ▒ pool (2)   ░ raw   ┊ compaction cut   ▶ tip
```

- glyph：`▓` 已 consolidated、`▚` 跨 pool-target 边界（部分 promote）、`▒` 已观测仍在短期 buffer、`░` 尚未观测的原始历史、`┊` compaction 剪口（`firstKeptEntryId` 位置）、`▶` 当前分支 tip。
- 数据全部来自既有 ledger fold（`collectChunks` 用 `coversUpToId` 映射回分支下标；`compactionCutIndices` 读 `type === "compaction"` 的 `firstKeptEntryId`），**没有新增运行时状态**。
- 宽度：`wrap(cells, 60)` 按固定 60 列折行，与终端宽度无关——移植时需要改成按实际宽度计算，否则违反本仓库 `DESIGN.md`「Every rendered line MUST fit available width」。
- 这是 amos 唯一"一图胜千行百分比"的设计，也是三条路线中唯一沿用 elpa 短期/长期分层直觉的可视化。

### 2.6 命令面与开关

| | amos | local |
| --- | --- | --- |
| 开关 | `/om`、`/om on`、`/om off`（默认 **OFF**） | 无开关命令；`passive` 配置 + `PI_OBSERVATIONAL_MEMORY_PASSIVE` |
| 强制压缩 | `/om:compact`（`ctx.compact()`，绕过阈值） | 无 |
| 强制整理 | `/om:consolidate`（临时把 `consolidateAtPoolTokens` 置 0 触发） | 无 |
| 查看记忆 | 无（直接 `ls`/`grep`/`read` `.memory/`，`PLAN.md` B1「Filesystem **is** the recall interface」） | `/om:view [full]` + 剪贴板复制 |

amos 的开关状态**写入 ledger**（`pi.appendEntry("om.enabled", {enabled})`，`src/index.ts` `readGateFromLedger` 反向扫描分支），因此 `/resume`、`/tree` 后仍然正确；关闭时所有 handler 首行返回、`status.detach()`、`abortAllWorkers()`，扩展"完全不可见"。这是"显式 opt-in + 状态可恢复"的一个干净实现，契合本仓库「重要能力必须显式 opt-in」的约束。

## 3. 模型可见面（compaction 注入块）

两者共享 elpa 的指令前言（"These are condensed memories from earlier in this session." / "Treat these as past records…"），随后分节不同：

| | amos（`src/ledger/render.ts`） | local（`src/session-ledger/render-summary.ts`） |
| --- | --- | --- |
| 节顺序 | `## Journey` → memory map → `## Observations` | `## Reflections` → `## Observations` |
| 条目形态 | `YYYY-MM-DDTHH:MM:SS  content`（**无 id**） | `[id] timestamp [relevance] content` / 反思 `[id] content` |
| 反思层 | 无（被 vendor 时删除） | 有，且是"长期稳定事实"的主载体 |
| 检索入口 | 文件系统（`read`/`grep`） | `recall` 工具（12 字符 id → 源证据） |
| 前言里的工具指引 | 无 | 明确指引何时用 `recall`、禁止当语义搜索用 |
| 剪口 | 对齐 observation chunk 边界，尾段 verbatim 不重复表示 | 由 Pi 的 `firstKeptEntryId` 决定 |
| 空投影 | 不适用 | `summary` 为空时**放弃所有权**交给 Pi 原生 summarizer；idle compaction 则 `cancel` |

结论：local 的模型面信息更"可溯源"（id + relevance + recall CTA），amos 的模型面更"可导航"（memory map 告诉模型有哪些文件可读，Journey 提供叙事定位）。**这两者不是替代关系**——但 amos 的 memory map 依赖 `.memory/` 文件层，而 local 的长记忆 owner 是 Hindsight（已有 8 个 `hindsight_*` 工具 + 首轮页面索引注入），所以模型面不建议再叠加一层 `.memory/` map。

## 4. 长记忆层与成本

### 4.1 `.memory/`（amos，local 无）

- 路径：`<project>/.memory/<sessionId>/{INDEX.md,<topic>.md,JOURNEY.md,.runs/}`，key 用**不可变的 session-header id**（`getSessionId()`），因此同目录两个 session 不互相覆盖（`PLAN.md` Addendum）。
- `INDEX.md` 由 orchestrator 每次 consolidation 后从 topic front-matter 重渲染；`JOURNEY.md` 由 consolidator 维护，**append-mostly + 超 `journeyTargetTokens` 时压缩最老段落**，每次压缩原样推入注入块第一节做"定位"用，prompt 里硬约束"只描述过去、禁止建议/计划/预测"。
- 生命周期：**不随 `/tree` 回滚**（跟踪 session 而非分支）；`/fork` 时 `ensureSessionMemory` 从 parent 一次性拷贝种子（排除 `.runs/`），幂等。
- 写入用 temp+rename 原子替换（`src/spawn/runs.ts` `atomicWrite`）。

风险已被作者自己记录：短期 ledger 随 `/tree` 回滚而长期文件不回滚 → 同一批 observation 可能被重复 promote（`PLAN.md` R1，标为 accepted，靠 consolidator 原地去重）。

### 4.2 成本（amos，local 无）

- worker 侧 `agent/cost.ts` 监听 `message_end`，累加 `message.usage.cost.total`，在 `agent_end` 写到 `.memory/<runId>.cost.json`，**不依赖 session 落盘**（ephemeral worker 也成立）。
- orchestrator 侧 `sumSessionCost(getEntries())` 汇总所有 `om.cost` ledger 条目——刻意用**全部分支**而不是当前分支，使 `/tree` 后显示金额不减少。
- 出口：footer `$0.000` + `/om:status` `session cost: $X (N runs)`。
- local 可行性：`Usage.cost.total` 就在 `@earendil-works/pi-ai` 的 `Usage` 上（`dist/types.d.ts:270-290`），local 的 in-process worker 同样能累加；不需要子进程。

## 5. worker 可审计性（架构级差异）

| | amos | local |
| --- | --- | --- |
| 执行 | `child_process.spawn(pi --no-extensions --no-skills --no-prompt-templates --no-context-files --no-builtin-tools --model <p/i> [-thinking] -e agent/index.ts -n <name> -p <chunk>)`（`src/spawn/launch.ts` `buildWorkerArgv`） | in-process `agentLoop` + 宿主 `modelRegistry.streamSimple`（`src/agents/worker-stream.ts`） |
| chunk 传递 | 作为 `pi -p` 的 user message → **录进 session**，resume 可见（代码注释明确拒绝用 `context` hook 注入，因为那样不落盘） | 拼进 worker 的 prompt/上下文，不产生独立 session |
| 可审计性 | worker 是 `~/.pi/agent/sessions` 里的普通 session，可在 session browser 打开看输入 chunk、工具调用与输出 | 只有 `debugLog` NDJSON + toast |
| 依赖宿主能力 | 只需可执行 `pi` | 需要宿主 `modelRegistry` 的 stream 面（local 曾因 compat `streamSimple` 崩溃而加 `resolveWorkerStreamSimple`，#30） |
| 成本 | 子进程天然有 `usage.cost.total` | 需要自己在循环里累加（同样可得） |
| 并行 | `observerConcurrency` 默认 4，`while (slots > 0)` 派发（`hooks/observer-trigger.ts:84`） | 串行 pipeline |
| 进程开销 | 每个 chunk 一个 `pi` 进程 | 无 |

`PLAN.md` L2 记录了 amos 为什么**不用** pi-subagents：后者用 `--no-session --mode json`，会破坏"每个 worker 都是可打开的普通 session"这一可观测性要求。反过来说，local 选择 in-process 的收益正是"零进程开销 + 复用宿主 provider/凭据解析"——两条路线各有代价，不是升级关系。

## 6. 值得移植的候选（按投入/收益排序）

### 6.0 范围收敛：暂不依赖 Footer 抽象（已移出 Plan）

根据最新决策，**暂不考虑引入新的 Footer 抽象**，相关设计已移出计划。`@hheei/pi-ext-memory` 的体验与功能增强不再等待或依赖任何 footer 抽象层，所有新增可观测性（成本、时间轴、状态）与控制面均收敛至已有的原生命令系统（`/om:status`、`/om:view` 以及新增命令 `/om:compact`、`/om:consolidate`、`/om`）与通知系统。

详细的候选特性规格与现行行为对比参考见 **`docs/plans/pi-ext-memory-enhancements.md`**。

### 6.1 成本统计与展示（建议：做，最小改动）

- 内容：worker assistant message 的 `usage.cost.total` 累加 → `/om:status` 中展示。
- 收益：直接回答"记忆在烧多少钱"，是 amos 最实用的可观测性。
- 代价：需要在 observer/reflector/dropper 的 agent 循环里回传 usage（现在返回值里没有），并在 `Runtime` 维护跨 `/tree` 不回退的会话累计口径。
- 注意：不要让成本统计成为持久化状态（不 appendEntry），避免污染 ledger 与现有 fold 测试。

### 6.2 `/om:compact`、`/om:consolidate` 手动命令（建议：做）

- 收益：现在只能靠阈值/空闲触发，调试与演示无法按需触发；amos 证明这两个命令实现很小（`src/commands/compact.ts` 33 行、`consolidate.ts` 46 行）。
- 代价：几乎为零。`/om:consolidate` 可不必照抄"临时把阈值置 0"的 hack，直接复用 `runtime.consolidationInFlight` 守卫 + 现有 stage 入口更干净。

### 6.3 单行 worker 状态行（建议：做，但语义改为"当前阶段"）

- 收益：把"memory 正在跑 observer/reflector/dropper"从多条零散 toast 整理为清晰的阶段反馈，并在完成时提供 `+N obs, +M refl` 增量信息。
- 代价：local 串行，不需要并排布局；只需在阶段切换与完成时规范化通知文案，避免 notify 相互踩踏与打扰。若未来采纳 6.4（并行 observer），才需要多 worker 聚合。
- 实现约束：遵循 `DESIGN.md`，尊重 `showWorkerNotifications` 开关。

### 6.4 并行 observer（建议：暂缓，先定预算）

- 收益：吞吐（chunk 越大越明显），以及"短会话尽快追上"。
- 代价与风险：并发预算与 `agentMaxTokens` 共享 KV（README 已警告本地 llama.cpp 会 `500 Context size has been exceeded`）；乱序完成的覆盖水位（amos 用 `dispatchedCoversUpToId` + 每个 observer 自己的 `coversUpToId` 解决）；空结果退避（local 已有 `observerEmptyBackoff`，需要并发化）；toast 合并（§6.3）。
- 结论：需要一次显式的设计决策，不适合顺手做。

### 6.5 timeline 条形图（建议：做，缩窄版）

- 收益：`/om:status` 从百分比堆叠变成一眼可读；对 `/tree` 回滚正确性的信心也直观。
- 代价：纯渲染，数据来自既有 fold（`coversUpToId`、`firstKeptEntryId`、`rawTokensSinceObservationCoverage` 都已存在）。**必须**按实际终端宽度折行（不能照抄 amos 的固定 60 列），并遵守 `DESIGN.md` 的宽度与色彩规则。
- 注意：local 没有"consolidated 到文件"这一层，`▓`/`▚` 语义要重新映射为 dropped/promoted 的本地含义，否则图例会误导。

### 6.6 per-session 开关（建议：做，但先统一语义）

- 收益：符合"昂贵/特权能力显式 opt-in"，并让 `/tree`、`/resume` 后状态可恢复。
- 代价：与现有 `passive` 语义**重叠**（amos 同时有 gate 和 `passive`，前者"完全不可见"，后者"关触发器但仍保留命令与 compaction"）。local 应先明确二者的分工：gate = 本 session 是否加载记忆能力；passive = 自动 worker 是否运行。二者都要写进 `DESIGN.md`/README，避免出现两套"关掉"的说法。
- 落点：可复用 Pi 的 `pi.appendEntry` + 分支反向扫描（amos 的做法），或走 ext-core settings；取决于是否要求"跟随分支"。

### 6.7 不建议移植

- **`.memory/` 主题文件 + JOURNEY**：与 Hindsight 争夺"跨会话长记忆"owner，会出现第二个 recall 面、第二套去重与第二套 `/tree` 语义。如果确实想要"文件即记忆、可用 `grep`"的形态，应当作为 **Hindsight 之外的替代方案**单独评估，而不是叠加。
- **子进程 worker**：能换来 worker session 可审计，但要放弃 in-process 对宿主 provider/凭据的复用（local 已经为此修过 #30），并新增 spawn/IPC/路径解析/进程生命周期一整套面。除非"worker 可审计"被明确列为需求，否则不划算。
- **`/om:view` 与 recall 工具**：local 已有，且比 amos 的"文件系统即接口"更贴合 HEPI 的 id 可溯源模型。

## 7. 不应照抄的实现细节

1. **footer 标签在 gauges 生效后消失**（amos bug）。`src/ui/status-controller.ts`:179 声明 `const base = fg("success","om")`，:180 只在无 gauges 时 `return base`，而 :186 的 gauges 分支返回 `${next}  ${pool}  ${ctx}${cost}` —— 不含 `base`；文件头注释却写"gauges shown in the footer, right of '○ om'"。`tests/status-controller.test.ts` 只断言了裸状态 `"om"`，因此该不一致未被测试覆盖。移植时应显式决定"label + gauges"还是"仅 gauges"，并为其写测试。
2. **README 与 `DEFAULTS` 漂移**（amos）。README 写 `chunkTokens: 5000`、`consolidateAtPoolTokens: 20000`、`compactAtContextTokens: 100000`、observer/consolidator = anthropic `claude-sonnet-4-6`；`src/config.ts` `DEFAULTS` 实为 `10_000 / 15_000 / 150_000`、openrouter `z-ai/glm-5.3`，且多出一个 README 未记录的 `resumeAfterMidRunCompaction: true`。引用 amos 任何默认值时都以 `src/config.ts` 为准。
3. **固定 60 列折行**：`renderTimeline(branch, config, width = 60)` 与终端宽度无关，违反本仓库的宽度约束。
4. **`.memory/.runs/` 不回收**（amos 自述 accepted）：若采用文件层，局部 IPC 文件的 GC 需要先设计。

## 8. 证据与复现

```bash
# 上游（浅克隆固定 revision）
git clone https://github.com/amosblomqvist/pi-observational-memory /tmp/up-amos
git -C /tmp/up-amos checkout 78a1efcfdd46332253fb289724f05b26dfc7769e
git clone https://github.com/elpapi42/pi-observational-memory /tmp/up-elpa
git -C /tmp/up-elpa checkout e891667d10fba3c70dd137fa55823ac1440f6f0d

# 谱系判定
curl -sS https://api.github.com/repos/amosblomqvist/pi-observational-memory | jq '{fork,parent,created_at,pushed_at}'

# 本仓库现状
grep -rn "setStatus\|setWidget" packages/pi-ext-memory/src     # 无输出 = 没有 footer/widget
```

主要引用文件：

- amos：`src/ui/status-controller.ts`、`src/ui/timeline.ts`、`src/ledger/render.ts`、`src/memory/index-render.ts`、`src/spawn/{launch,runs}.ts`、`agent/{index,cost}.ts`、`src/commands/*.ts`、`src/config.ts`、`src/index.ts`、`PLAN.md`、`README.md`、`tests/status-controller.test.ts`
- local：`src/index.ts`、`src/runtime.ts`、`src/config.ts`、`src/commands/{status,view}.ts`、`src/hooks/consolidation-trigger.ts`、`src/hooks/compaction-hook.ts`、`src/session-ledger/render-summary.ts`、`src/agents/worker-stream.ts`、`README.md`
- 宿主契约：`@earendil-works/pi-ai` `dist/types.d.ts`（`Usage.cost.total`）；footer `setStatus` 契约见 `docs/plans/todo-ui-ux-optimization.md` §2.1
