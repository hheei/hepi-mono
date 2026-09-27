# 观测式记忆扩展 (pi-ext-memory) 架构与持久化配置契约

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
    "passive": false,
    "debugLog": false
  }
}
```
