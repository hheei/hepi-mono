# 观测式记忆扩展 (pi-ext-memory) 架构与持久化配置契约

## 压缩保留尾部的 provider 数据

压缩只替换被摘要覆盖的历史；保留尾部的 assistant、工具调用与结果必须保留原始 provider replay 数据，包括 thinkingSignature、thoughtSignature、textSignature 和空文本的签名载体。`encrypted_content` 是协议的不透明数据，不是可以按字段名删除的冗余文本。具体 extension 不解释或清洗它；由 Pi host 的 provider 转换器处理同模型回放与模型切换。

预算按完整尾部计算，优先缩减记忆摘要，不通过写入 context_edit 删除签名来腾出空间。该修复不自动撤销历史中已有的 context_edit；旧 session 的修复必须从原始条目恢复并保持分支语义。

## 空闲压缩契约

`idleCompactionTtl` 到期后只显示提示并记录 `om:idle-notice`；下一次发送消息时在 `before_agent_start` 中等待压缩完成，再请求模型。空闲提示和压缩均不设 token 门槛，移除 `idleCompactionMinTokens` 配置，旧配置字段按未知字段忽略。

仍要求门控开启、非 passive、最近压缩后有新增源条目且记忆投影非空；保留取消、session generation 验证和在途 consolidation 等待。到期计时器不执行压缩；`compactAfterTokens` 的独立压缩路径继续使用原有门槛。

本文档记录 `@hheei/pi-ext-memory` 的架构边界与持久化配置契约，重点阐述从 Pi 宿主 `settings.json` 迁移至 ext-core 统一传输规范 `ext_settings.json` 的契约变更。

---

## 1. 背景与目标

在原设计中，扩展配置直接内嵌于 Pi 宿主的主配置文件中：
- 全局路径：`~/.pi/agent/settings.json` 下的 `"pi-ext-memory"` 对象
- 项目级路径：`<cwd>/.pi/settings.json` 下的 `"pi-ext-memory"` 对象

然而，在 HEPI Monorepo 体系下，所有 concrete extension 的持久化配置统一遵循 ext-core 定义的 `ext_settings.json` 契约，以解耦宿主核心配置与扩展配置。

**本次变更目标：**
将 `@hheei/pi-ext-memory` 的配置持久化路径全面迁移至 `ext_settings.json`，直接使用 ext-core 规范的全局和项目文件路径。

---

## 2. 持久化契约变更

### 2.1 存储路径规范

配置来源统一定位至以下两个层级，使用 ext-core 导出的 `defaultExtensionSettingsPaths(cwd)` 进行解析：

1. **全局配置 (Global)**：
   - 路径：`<agentDir>/ext_settings.json`（通常为 `~/.pi/agent/ext_settings.json`）
   - Section Key：`"pi-ext-memory"`
2. **项目级配置 (Project)**：
   - 路径：`<cwd>/.pi/ext_settings.json`
   - Section Key：`"pi-ext-memory"`

### 2.2 优先级合并规则

配置合并按照严格的单向覆盖顺序：
```
默认值 (DEFAULTS) -> 全局配置 (global ext_settings.json) -> 项目配置 (project ext_settings.json) -> 环境变量 (env)
```

### 2.3 零兼容策略 (No Backward Compatibility Shims)

遵循 Monorepo **“Product rule: No hidden intent. No silent routing. No blind automation.”** 与工程规则 **“NEVER add speculative abstractions, extension points, compatibility shims”**：
- **不保留**对旧 `settings.json` 的 fallback 双读逻辑；
- **不增加**隐式自动数据迁移代码；
- 用户需显式将其旧 `settings.json` 配置迁移至 `ext_settings.json` 的 `"pi-ext-memory"` 键下。

### 2.4 异步加载与版本边界

配置读取使用 ext-core 的 `readMergedJsonSettingsSection()`，因此 `loadConfig()` 是异步
函数。Pi 的 `session_start` lifecycle handler 必须等待 session 配置加载完成后才返回；后续
事件处理器只读取该 session 的配置快照，不在每个事件中重复 I/O。读取使用 lifecycle signal，
session shutdown 或替换时取消未完成的文件读取，且不写入旧 session 的 runtime 状态。

本扩展的最低 Pi 版本为 `0.87.0`。worker 使用 Pi 的 `ModelRegistry.streamSimple` 组合流，
不再保留 `getRegisteredProviderConfig` 或 `@earendil-works/pi-ai/compat` fallback。

凭据解析与 worker 流共用同一个 host registry，因此 `runtime.ts` 的 `ModelRegistryLike` 直接
用 facade 自己的签名声明（`ModelRegistry["getApiKeyAndHeaders"]` 等），只把成员设为 optional，
让无凭据的测试替身可以省略。这样 `ExtensionContext` 能结构化满足 `ConsolidationCtx`，host
context 不再需要 `as unknown as` 转换；`ResolveResult.model` 与 agent 的 `headers` 分别沿用
pi-ai 的 `Model<Api>` 与 `ProviderHeaders`，`ModelRegistry.getApiKeyAndHeaders` 的
`ResolvedRequestAuth` 以 `ResolvedAuth` 导出供调用方与测试引用。

### 2.5 会话门控条目 (`om.gate`)

`/om on` / `/om off` 通过 `pi.appendEntry("om.gate", { enabled })` 写入当前分支，
因此门控状态是**派生值**而非缓存标志：读取方调用 `latestGateEnabled(branch)`，取分支上最新
一条 `om.gate` 条目；分支上没有该条目时视为开启。

不变量：

- `om.gate` 是 `type: "custom"` 的元数据条目，不是 source entry，不参与
  `foldLedger()` 投影，也不推进 observation/reflection/compaction 的任何 token 时钟；
- 因为状态在分支上，`/tree` 切换分支与 `/resume` 自动还原当时的状态，不存在异步写入或
  会话切换导致的过期标志；
- 门控为 off 时，consolidation / compaction trigger / compaction hook / idle compaction
  一律提前返回，`recall` 工具返回显式禁用说明而非空记忆；这些短路发生在读取分支之后，
  所以不依赖额外状态同步；
- `passive` 配置与门控正交：门控决定“这个会话是否运行记忆”，`passive` 决定“自动化 worker
  是否自动跑”；两者都需要明确文档化，避免出现两套“关闭”语义。
- 门控不做取消：关闭门控不会中止已经开始的一次 consolidation/compaction（它们按 session
generation 与 lifecycle signal 自行收敛），只阻止后续触发与新的手动命令。

---

## 3. 配置格式参考

在 `ext_settings.json` 中，配置组织在顶层的 `"pi-ext-memory"` 键下：

```json
{
  "pi-ext-memory": {
    "model": {
      "provider": "anthropic",
      "id": "claude-3-7-sonnet-latest",
      "thinking": "low"
    },
    "observeAfterTokens": 32000,
    "reflectAfterTokens": 48000,
    "compactAfterTokens": 80000,
    "compactAfterTokensMode": "calibrated",
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "memoryMaxTokens": 30000,
    "passive": false,
    "debugLog": false
  }
}
```

### 3.1 记忆预算（memory budget）

`memoryMaxTokens` 是可见记忆的硬上限（tokens）。未设置时派生为
`min(floor(effective trigger × 0.5), floor(contextWindow × 0.1))`，且不低于 `4000`，
显式配置的值按原样生效（含低于下限的值）。它同时约束三处：compaction 摘要的渲染、
dropper 的观测池目标、以及 observer / reflector / dropper 的输入视图。

压缩时的渲染预算由 `softLimit − retained tail − system prompt` 的剩余空间推导（
`softLimit = min(compactAfterTokens 或 ratio 阈值, contextWindow − Pi reserveTokens)`），
`reason === "overflow"` 时再减半。预算内选条是确定性纯函数（观测：未被 reflection
覆盖 → relevance → 较新；反思：会话前 8 条锚点 + 较新），被裁剪的行不删除，仍留在
ledger 中并可用 `om_recall_evidence` 按 id 取回。

每次 compaction 把 `details.budget = { maxTokens, renderedTokens, tailTokens, softLimit,
trimmedObservations, trimmedReflections }` 写入 compaction 条目（`version` 仍为 1，
旧读取方忽略该字段），`/om status` 的 `── Memory budget ──` 段展示最新一次渲染的
预算、实耗、裁剪行数与 retained tail。设计见 `docs/plans/pi-ext-memory-memory-budget.md`。

**池上限（enforcer）**：渲染裁剪只约束一次 summary，账本本身由 consolidation 流水线的
最后一个**无模型**阶段收敛——活跃记忆超过 `budgetCap × 1.5` 时，把非 critical 观测回收到
`min(observationsPoolTargetTokens, max(0, budgetCap − 反思 tokens))`，每次最多写一条
`om.observations.dropped`（`coversUpToId` 取最新 observation coverage marker），幂等；
`critical` 观测永不回收，被回收的行仍留在账本中并可 recall。反思单独超过 budgetCap 时
目标为 0，意味着所有非 critical 观测一次性退出活跃记忆；`/om status` 会在反思占掉少于
`observationsPoolTargetTokens` 的余量时显示 `Reflections leave under the observation target`。
回收按 rank 逐条累加渲染 tokens，直到池子进入目标（而不是按平均行长估算条数），
因此最终剩余量一定 ≤ 目标。

**观测时间戳权威（Phase 4）**：观测的 `timestamp` 不再由模型书写，而是由 `runObserverStage`
从该观测引用的 `sourceEntryIds` 派生：取被引用 entry 中**最早**的本地分钟时间（`YYYY-MM-DD HH:MM`），
无可用引用时退化为 chunk 内最后一条有效时间、再退化为记录时刻。渲染 summary 时观测按时间稳定排序
（同一分钟保持账本插入序），前言承诺的"时间顺序 + 最新者代表最新状态"因此成立。旧条目不做迁移，
仍按其自报时间排序（已知限制）。

**观测分层 `kind`**：`Observation.kind?: "user" | "decision" | "fact" | "progress"`
（缺省按 `fact`，旧条目无需迁移）。它是记忆移除的第一排序维度：progress（施工叙事）
最先离开活跃记忆，然后 fact，最后是有断言/纠正语义的 user 与决策 decision；`relevance`
退化为同一 kind 内的次序。dropper 的行渲染会带 `[kind]`，compaction summary 的行格式不变。

**反思生命周期（合并 / 取代）**：反思没有确定性淘汰路径，唯一的收缩入口是 reflector 在同一次
`record_reflections` 调用里声明 `supersedes`：新反思明确列出它取代哪些旧反思，阶段随后写一条
`om.reflections.dropped`（`{ reflectionIds, coversUpToId }`）。不变量是"离开活跃记忆的反思必须有一个替代者"——
提案 content 不合法时不产生 tombstone，与既有反思同 id 的重复提案（合并成已有措辞）仍可取代其他条目。
每条提案的 `supersedes` 各自成立：替代者永远不会重新活跃的那条提案被跳过，同一轮里其他合并照常退休各自的目标。
换成新内容的合并继承被替换反思的 `supportingObservationIds`，因此"观测已被 enforcer 全部回收、只剩反思"这个状态下
合并依然有依据，反思池也就仍然能收缩（没有观测时可以只做合并）。
投影层新增独立的 `droppedReflectionIds` 集合：被取代的反思仍留在账本里（`/om view full`、diff、recall
都能看到），只是不再进入活跃记忆、不再计入 budgetCap 的反思份额、也不再提供 coverage。
`/om status` 的反思行因此是 `N recorded / M superseded / K active / V visible`。
反射器的输入视图会附带 `REFLECTION BUDGET` 一行（渲染预算分节后反思的份额），超出时 prompt 要求
先合并同类项再新增。

---

## 4. Hindsight 原生 MCP 契约

Hindsight 工具由 Pi host 通过 session-scoped MCP 注册、发现与执行，不再由 memory 定义 schema 或注册旧 hindsight_* 名称。常用记忆工具 direct，其余工具 deferred；工具集合与 authoring / 运维能力由服务端 allowlist 决定。未来服务开放工具后无需复制客户端注册。

memory 只负责 bank 解析、自动 recall、transcript 写回与本地诊断。使用单 bank endpoint；保留已有显式 bank，不自动迁移数据。共享 bank 只保证连接范围，不保证仓库隔离，SDK 自动写回仍可附带 repo tags。

Pi host 拥有连接、取消、重连、权限管线与完整结果；ext-core 经 renderer resolver 提供共享 ToolTui。session 清理撤销 extension 注册，不撤销文件配置。子 agent 的 child bridge 阻止保留名称 mcp__hindsight__ 下的调用，包括嵌套与未来新增工具。

具体配置、清理、缓存和 UI 不变量见 [Hindsight 原生 MCP 集成](hindsight-mcp.md)。
