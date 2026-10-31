# Loadout 退役与原生机制回归架构

## 1. 背景与问题诊断

Loadout 机制最初在 Pi 早期设计，旨在提供一个全局与项目级的资源装配清单（覆盖 Tools、Skills 与 Subagents）。随着系统演进与 Pi 宿主（1.1.0+）能力的成熟，Loadout 暴露出了根本性的架构冲突与脱节：

1. **工具面脱节**：工具所有权属于各个功能扩展自身的能力包，Loadout 重算 active tool 会破坏动态激活，已在前期完全下线。
2. **技能面脱节与虚假控制**：Pi 宿主自身通过 `settings.json` 的 `skills` 字段（支持 `+path`、`-name`、`!glob` 规则）及原生 `pi config` TUI 统一管理技能加载。Loadout 在 `ext_settings.json` 写入的 `loadout` delta 并不被 Pi 宿主读取，导致技能管理成为无法真实控制命令与提示词的影子层。
3. **功能滞后**：Pi 宿主陆续引入 `packages`、`prompts`、`themes` 以及更丰富的资源过滤规则，Loadout 自创的 delta schema 无法跟进上游发展。

因此，已做出明确架构决策：**彻底退役 Loadout 影子层，全面回归 Pi 原生机制**。

## 2. 边界收敛与迁移契约

### 2.1 资源启停全面交回 Pi 原生

- **技能（Skills）、扩展（Extensions）、包（Packages）、提示词模板（Prompts）、主题（Themes）**：
  统一由 Pi 原生的 `~/.pi/agent/settings.json`（全局）与 `<cwd>/.pi/settings.json`（项目）管理，并通过终端命令 `pi config`（或手动编辑对应数组）进行交互式启用/禁用。
- **工具（Tools）**：
  由工具所有方直接调用 Pi 的 `getActiveTools` / `setActiveTools` 按需控制。

### 2.2 包与接口清理

1. **`@hheei/pi-ext-core`**：
   - 移除已无生产消费者的 `LoadoutResourceMetadata`、`LoadoutResourceDetail`、`LoadoutInventoryObserver`、`registerLoadoutResource`、`observeLoadoutInventory`。
   - 移除仅用于影子技能状态发布的 `skill-state.ts`（`setDisabledSkillKeys`、`clearDisabledSkillKeys`、`getDisabledSkillKeys`、`isSkillEnabled`）。
   - `setSessionToolsActive` 已删除。没有任何生产调用方，工具激活留在 Pi 的 `setActiveTools`。
2. **`@hheei/pi-settings`**：
   - 彻底删除 `src/loadout/` 引擎、模型与页面实现。
   - 移除 `/ext-settings` 对 `loadout` 页面的注册，专注于承载已注册扩展设置的 `SettingsPage`（`DualPaneListView` 两栏配置面板）。
   - 移除 `ext_settings.json` 对顶层 `loadout` 组的占用。
3. **`@hheei/pi-ext-addon`**：
   - `$skill` 宏输入补全直接基于 `pi.getCommands()` 过滤技能命令，不再依赖 core 的弱引用技能状态。

### 2.3 持久化与兼容性

- `ext_settings.json` 中的 `loadout` 字段不再读取也不再写入；历史配置留在文件内不产生任何破坏或报警。
- 不再维护任何影子 delta 转换或兼容适配层。
