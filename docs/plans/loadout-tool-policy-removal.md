# Loadout 退出工具激活管理（tool policy removal）

## 1. 背景与用户可见目标

### 1.1 背景

Loadout 目前的激活策略（`pi-settings/src/loadout/engine.ts` 的 `apply()`）在引擎启动以及**任何一次 core inventory 发布/取消发布**时，都会整份重写 Pi 的 active tool 集合：

```ts
pi.setActiveTools([...new Set([...preserved, ...selected])]);
```

这带来两个已确认的问题：

1. **抢走工具 owner 的决定权**：工具 owner 自行做的动态激活/停用（例如 pi-ext-tools 的 edit/apply_patch/eval 能力包、`pi-ext-tools` 计划中的按需任务工具）会被引擎的重算撤销。Host 本身在会话启动/`/reload` 时会强制激活全部 extension 工具（`includeAllExtensionTools: true`），在 `/tree` 时会按 transcript 恢复 active 集合，因此“active 集合归谁”必须只有一个 owner。
2. **工具策略面已基本空转**：`forcedActive` 无任何生产者，`conflictSets` 在生产代码里全部是空数组，apply_patch 与 edit/write 的互斥实际由 pi-ext-tools 自己的 `activateEditCatalog` 能力包保证，`publishLoadoutToolActivation` / `observeLoadoutToolActivation` 无任何生产消费者。

### 1.2 已决定的方向

**工具退出 Loadout 管理面**：Loadout 的 active tool 集合不由 Loadout 裁决，引擎不再调用 `pi.setActiveTools`。Loadout 未来的职责是 **agent profile、skill、MCP**（agent profile 接线与 MCP 不在本次范围）。

### 1.3 用户可见结果

- 会话启动、`/reload`、`/compact`、`/tree`、`/ext-settings` 打开/关闭都不再改变任何工具的 active 状态。
- Loadout 页面不再有 `⚒ Tools` 分组与工具行；只保留 `✦ Skills`（当前实现）与 `𖠌 Agents`（尚未接线）。
- 工具 owner 的动态激活不再被撤销。
- settings 里历史遗留的 `tool:<name>` 键继续被接受（不再生效）且不产生任何提示；写入路径拒绝新的 `tool:` 键。

## 2. 契约变化

### 2.1 pi-ext-core（`src/loadout.ts`）

**保留并收敛**：

| 导出 | 变化 |
| :--- | :--- |
| `registerManagedTool(pi, { id, owner }, tool)` | 保留：HEPI-owned 工具的 Pi 注册传输（消除 load-order 依赖、单 owner 校验、`/reload` 允许同 owner 替换）。 |
| `isManagedLoadoutTool` | **重命名** `isManagedTool`：语义是“经 core 注册的 managed tool”，与 Loadout 无关。 |
| `setManagedLoadoutToolsActive` | **重命名** `setManagedToolsActive`：owner 自己的能力包开关（含 `apply(false)` 清理），不再发布/取消发布 inventory。 |
| `registerLoadoutResource` / `observeLoadoutInventory` / `LoadoutInventoryObserver` / `LoadoutResourceMetadata` | 保留：Loadout 的 agent profile resource 面（本次不接生产者）。 |
| `LoadoutInventoryItem` | **删除**：目录只剩 resource，`observeLoadoutInventory` 直接以 `readonly LoadoutResourceMetadata[]` 传递。 |

**删除**（无生产消费者的工具策略面）：

- 类型：`LoadoutToolMetadata`、`ManagedLoadoutToolRegistration`、`LoadoutInventoryRegistration`、`LoadoutToolActivationSnapshot`、`LoadoutToolActivationObserver`
- 函数：`registerManagedLoadoutTool`、`registerLoadoutInventory`、`publishLoadoutToolActivation`、`clearLoadoutToolActivation`、`observeLoadoutToolActivation`
- `LoadoutResourceMetadata` 上仅服务于工具策略的字段：`group`、`origin`、`priority`、`conflictSets`、`conflictsWith`、`forcedActive`（`id`、`kind`、`label`、`description`、`summary`、`projectPrivate`、`owner`、`defaultActive`、`detail` 保留）。

> `defaultActive` 保留：它是 agent profile 的 discovered default，`resolveLoadoutState` 与页面归一化都在用。
> 工具的 cap 归属：工具 active 集合从此只由 owner（`setManagedToolsActive` / `pi.setActiveTools` / Host）决定。

### 2.2 pi-settings

`model.ts`：

- 删除 `ToolPolicy`、`resolveActiveToolNames`、`toolsConflict`、`sourceRank`、`toolConfigurationKey`。
- 保留 `LoadoutDelta` / `LoadoutConfiguration` / `resolveLoadoutState` / `skillConfigurationKey` / `disabledSkillKeys`。
- `isCanonicalLoadoutKey`（解析路径）继续接受 `tool:` 作为 **legacy 键**（否则现有 settings 会 fail-fast 导致启动失败）；`assertCanonicalLoadoutKey`（写入路径）**拒绝** `tool:`，因为 UI 不再能产生它。

`engine.ts`：

- 引擎收敛为 **skill 过滤器 + 配置持有者**：`start()` 读配置后 `setDisabledSkillKeys(...)`；不再 `pi.getAllTools()`、不再计算 policy、不再 `pi.setActiveTools`、不再 `observeLoadoutInventory`、不再发布 activation snapshot。
- `dispose()` 只 `clearDisabledSkillKeys(pi)`（不再恢复 initial active set）。
- `snapshot()` 返回 `{ configuration }`（去掉 `initialActiveToolNames`）。
- **新增 `reload()`**：重新从磁盘读配置并重新应用 skill 过滤。原因：页面 `flush()` 只写盘并更新自己的本地副本，今天 skill 开关能生效只是“恰好被工具 inventory 变动触发的 `apply()` 顺带带上”；工具面移除后这个副作用消失，必须由页面在 `flush()` 成功后显式调用，否则 skill 开关会静默不生效。

`page.ts`：

- 删除工具行：`toolItem`、`toolOrigin`、`loadoutToolPolicies` 使用、`initialActive`、`lockedBy` / `toolsConflict` 冲突锁定、`⚒ Tools` 分组、排序里的 `kind === "tool"` 分支。
- `entries()` 只剩 `✦ Skills` 与 `𖠌 Agents`（无内容时不渲染分组标题）。
- `flush()` 成功后调用 `engine.reload()`；`toggle()` 不再有 `forcedActive` / `lockedBy` 早退。
- `ResourceItem` 收敛为 skill / agent 两种 kind。

### 2.3 工具贡献方（无契约变化，仅注册调用与字段收敛）

`pi-ext-tools`（read / grep / find / write / edit / ls / bash / fff_multi_grep / todo / task×3 / apply_patch / eval）、`pi-ext-memory`（recall + 8 个 hindsight）把所有 `registerManagedLoadoutTool(pi, { id, owner, group, origin, priority, conflictSets, conflictsWith, defaultActive }, tool)` 改为 `registerManagedTool(pi, { id, owner }, tool)`：

- `pi-ext-tools/src/native-tool.ts`：`createCanonicalToolRegistration(id, conflictsWith)` → `createCanonicalToolRegistration(id)`，返回 `{ id, owner }`；`EDIT_TOOL_REGISTRATION` / `WRITE_TOOL_REGISTRATION` 去掉 `["apply_patch"]`。apply_patch 与 edit/write 的互斥仍由 `activateEditCatalog` 的能力包保证（本次需回归验证）。
- `pi-ext-tools/src/tools.ts`：`setManagedLoadoutToolsActive` → `setManagedToolsActive`。
- `pi-ext-memory`：`RECALL_LOADOUT_REGISTRATION` 等常量重命名为 `*_TOOL_REGISTRATION`；`isManagedLoadoutTool` → `isManagedTool`。

## 3. 迁移

- 不做数据迁移、不重写用户 settings。`tool:` 键留在原处并被忽略（写回时原样保留，不丢数据），**不产生提示**（用户已确认直接忽略）。
- 释放用户“用 Loadout 关闭某个扩展工具”的能力：改由 Pi 原生工具配置承担；本次不新增替代机制。

## 4. 文档

- `docs/architecture/loadout.md`：重写 Tool Registration / Activation Policy 两节（工具不再是 Loadout resource；core 的 managed tool 注册是传输而非策略；Loadout = skill + agent profile + MCP 方向），移除上一条“引擎日后不再对工具做限制”的过渡表述。
- `docs/architecture/pi-ext-core.md`：更新 loadout 导出清单与 `setManagedToolsActive` / `isManagedTool` 说明。
- `docs/plans/task-tools-on-demand-injection.md` §4.5：改为引用本方案（Loadout 已退出工具面，任务工具只依赖自身 owner 的激活）。
- 包 README 里提到 managed Loadout registration 的段落（pi-ext-tools / pi-ext-memory / pi-settings）按新契约更正。

## 5. 聚焦测试与敏感度探测

新增/修改：

1. `packages/pi-settings/test/loadout/engine.test.ts`：引擎启动与 `dispose()` 都让 `pi.setActiveTools` **零调用**；`reload()` 按磁盘 delta 重发 skill 状态；legacy `tool:` 键不改变任何 active 状态；首任务 apply 失败时回滚且可重试。
2. `packages/pi-settings/test/loadout/engine.test.ts`：`reload()` 后 skill 过滤按磁盘最新配置生效（先写盘再 `reload()`）。
3. `packages/pi-settings/test/loadout/page.test.ts`：页面不再渲染 `⚒ Tools` 分组与任何工具行；只有 skill 行可切换；`flush()` 触发 `engine.reload()`。
4. `packages/pi-settings/test/loadout/model.test.ts`：`parseLoadoutDelta` 接受 legacy `tool:` 键并保留，`assertCanonicalLoadoutKey("tool:read")` 抛错。
5. `packages/pi-ext-core/test/loadout.test.ts`：`registerManagedTool` 的单 owner / 重复注册 / `/reload` 替换语义保持；`setManagedToolsActive(true/false)` 只增删本组 id，且不再影响 inventory；`registerLoadoutResource` + `observeLoadoutInventory` 仍可用。
6. `packages/pi-ext-tools/test/tools.test.ts`、`test/todo/integration.test.ts`：注册调用与 catalog 断言更新；新增“edit/write 与 apply_patch 互斥由能力包保证”的回归（同一会话内切换 Edit Mode 后 active 集合恰好只含一组）。

敏感度探测（按仓库规范：改回旧行为必须让新测试失败）：

- 把引擎 `apply()` 里的 `pi.setActiveTools(...)` 加回去 → “零调用”测试必须失败。
- 把页面 `flush()` 里的 `engine.reload()` 去掉 → “skill 开关即时生效”测试必须失败。
- 把 `assertCanonicalLoadoutKey` 对 `tool:` 放宽 → 对应的拒绝写入测试必须失败。

## 6. 风险

| 风险 | 影响 | 对策 |
| :--- | :--- | :--- |
| 用户依赖 Loadout 关闭某工具，升级后工具变常开 | 中（行为变化） | 文档说明；工具 owner 自己负责的默认激活不变（用户在 Loadout 页面上不再看到工具行） |
| skill 开关依赖 inventory 变动才生效的老行为被移除后暴露 | 中 | 新增 `engine.reload()` 并由页面 `flush()` 调用，配套回归测试 |
| 跨 package 契约删除（core 导出） | 中 | 仓库内全部消费者同批修改；`pnpm run typecheck` 作为升级验证 |
| agent profile 面在移除后仍无生产者 | 低（已知） | 本次不接线 agent profile，页面在无 agent resource 时只显示 Skills；接线另开 |
| 包版本 | 低 | `@hheei/pi-ext-core` 是破坏性导出变更，发布时按独立版本策略提升 |

## 7. 落地顺序

1. 本设计文档（已完成）→ 用户确认。
2. pi-ext-core：契约收敛 + 重命名 + 删除死 API（含 core 测试）。
3. pi-ext-tools / pi-ext-memory：注册调用与字段收敛（含各自测试）。
4. pi-settings：engine / model / storage / page 收敛 + `reload()`（含测试）。
5. 文档更新（loadout.md、pi-ext-core.md、计划文档交叉引用、包 README）。
6. 聚焦验证：改动文件的 Biome、受影响 package 的 vitest、`pnpm --filter @hheei/pi-ext-core run build` 及受影响 package 的 build；因跨 package 公共契约变更，收尾跑一次 `pnpm run typecheck`。

## 8. 已确认项

1. legacy `tool:` 键：**直接忽略**，不产生任何提示（用户确认）。
2. core 工具注册契约按 §2.1 收敛（`{ id, owner }`，删除 group/origin/priority/conflictSets/conflictsWith/forcedActive 与 activation snapshot）。
3. agent profile 本次不接线；Loadout 页面在无 agent resource 时只剩 Skills。

## 9. 实现状态

已按 §7 顺序落地（未提交）：

- **pi-ext-core**：`loadout.ts` 收敛为 managed tool 注册传输 + resource inventory；导出 `registerManagedTool` / `isManagedTool` / `setManagedToolsActive` / `registerLoadoutResource` / `observeLoadoutInventory`；`test/loadout.test.ts` 重写为 11 例（含“能力包只增删本组 id”与“resource disposer 幂等”）。
- **pi-ext-tools**：`createCanonicalToolRegistration(id)` 只返回 `{ id, owner }`；12 处注册点改用 `registerManagedTool`；`activateEditCatalog`/`activateEvalCatalog` 改用 `setManagedToolsActive`；`tools.test.ts` 用“恰好一组 mutator 处于 active”替换原先的 inventory provenance 断言，`todo-extension` / `todo integration` 删除 inventory 断言。
- **pi-ext-memory**：recall 与 8 个 hindsight 工具（共 9 处）改用 `registerManagedTool`；`RECALL_LOADOUT_REGISTRATION` → `RECALL_TOOL_REGISTRATION`；`isManagedTool` 替换 `isManagedLoadoutTool`。
- **pi-settings**：engine 只剩 skill 过滤 + 配置持有（新增 `reload()`）；model 删除 `ToolPolicy` / `resolveActiveToolNames` / `toolsConflict` / `toolConfigurationKey`；`tool:` 在解析路径接受、在写入路径拒绝；page 删除工具行与 `⚒ Tools` 分组，`flush` 成功后调用 `engine.reload()`，并去掉“Reload to apply”提示。
- **文档**：`docs/architecture/loadout.md` 重写（managed tool 注册不属于 Loadout policy、Activation Policy 只覆盖 skill/agent、group heading 只剩 ✦ Skills / 𖠌 Agents）、`docs/architecture/pi-ext-core.md`、`pi-settings/README.md`、`CONTEXT.md`（Eval Activation 不再提 Loadout）。

验证：`pnpm run typecheck` 0 error；受影响 package 测试 108 files / 986 tests 全绿（pi-ext-core 17、pi-settings 8、pi-ext-tools 36、pi-ext-addon 6、pi-ext-memory 41）；四个 package（pi-ext-core / pi-settings / pi-ext-tools / pi-ext-memory）build 通过；三条敏感度探测（引擎回写 `setActiveTools`、页面去掉 `engine.reload()`、放宽 `tool:` 写入校验）都能让对应测试失败。
