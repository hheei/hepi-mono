# 观测式记忆扩展 (pi-ext-memory) 架构与持久化配置契约

本文档记录 `@hheei/pi-ext-memory` 的架构边界与持久化配置契约，重点阐述从 Pi 宿主 `settings.json` 迁移至 ext-core 统一传输规范 `ext_settings.json` 的契约变更。

---

## 1. 背景与目标

在原设计中，扩展配置直接内嵌于 Pi 宿主的主配置文件中：
- 全局路径：`~/.pi/agent/settings.json` 下的 `"observational-memory"` 对象
- 项目级路径：`<cwd>/.pi/settings.json` 下的 `"observational-memory"` 对象

然而，在 HEPI Monorepo 体系下，所有 concrete extension 的持久化配置统一遵循 ext-core 定义的 `ext_settings.json` 契约，以解耦宿主核心配置与扩展配置。

**本次变更目标：**
将 `@hheei/pi-ext-memory` 的配置持久化路径全面迁移至 `ext_settings.json`，直接使用 ext-core 规范的全局和项目文件路径。

---

## 2. 持久化契约变更

### 2.1 存储路径规范

配置来源统一定位至以下两个层级，使用 ext-core 导出的 `defaultExtensionSettingsPaths(cwd)` 进行解析：

1. **全局配置 (Global)**：
   - 路径：`<agentDir>/ext_settings.json`（通常为 `~/.pi/agent/ext_settings.json`）
   - Section Key：`"observational-memory"`
2. **项目级配置 (Project)**：
   - 路径：`<cwd>/.pi/ext_settings.json`
   - Section Key：`"observational-memory"`

### 2.2 优先级合并规则

配置合并按照严格的单向覆盖顺序：
```
默认值 (DEFAULTS) -> 全局配置 (global ext_settings.json) -> 项目配置 (project ext_settings.json) -> 环境变量 (env)
```

### 2.3 零兼容策略 (No Backward Compatibility Shims)

遵循 Monorepo **“Product rule: No hidden intent. No silent routing. No blind automation.”** 与工程规则 **“NEVER add speculative abstractions, extension points, compatibility shims”**：
- **不保留**对旧 `settings.json` 的 fallback 双读逻辑；
- **不增加**隐式自动数据迁移代码；
- 用户需显式将其 `observational-memory` 配置迁移至 `ext_settings.json`。

---

## 3. 配置格式参考

在 `ext_settings.json` 中，配置组织在顶层的 `"observational-memory"` 键下：

```json
{
  "observational-memory": {
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
