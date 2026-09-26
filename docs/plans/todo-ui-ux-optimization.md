# Todo UI/UX 优化实施方案（轻量原生 setStatus 路径）

## 1. 背景与目标

当前 `@hheei/pi-ext-tools` 中的 Todo 模块采用在编辑器上方（`aboveEditor`）注册多行 widget 的方式展示会话任务概览。随着任务项增多或在紧凑终端界面下，`aboveEditor` widget 会占用过多的纵向屏幕空间，影响提示词编辑与对话上下文的浏览体验。

经过可行性分析，在 `pi-ext-core` 中构建通用 Footer Compositor 存在宿主部件无法复用、侵入性强、过度设计的风险。而 Pi 宿主原生的 `ctx.ui.setStatus(key, text)` 已天然满足所有产品需求：
- **左侧展示**：Pi 原生在底部状态栏左侧拼接各扩展的状态；
- **零纵向占位**：当所有扩展的 status 为 `undefined` 时，Pi 原生 Footer **完全不渲染第三行（仅保留两行基础信息），零高度占用**。

本方案旨在：
1. **取消 Todo 的 header (`aboveEditor`) 多行 widget**：彻底移除编辑器上方 widget，释放屏幕空间。
2. **Todo 接入原生 Footer 状态行（`ctx.ui.setStatus`）**：
   - 未完成/进行中任务：常驻高亮显示（如 `◐ #61 XXX`）；
   - 刚完成任务：显示最近完成的任务（`✓ #61 XXX`），保持展示 **3 分钟**；
   - 阻塞任务：显示最近阻塞的任务（`⊘ #61 XXX`），保持展示 **15 秒**；
   - 超时后或无可显示内容时：置为 `undefined`，通知宿主自动隐藏状态行，不占纵向空间；
   - 混合状态按优先级与最新更新时间稳定裁决。
3. **重构指令为 `/todo`**：
   - `/todo`（默认无参）：只展示当前活跃（`in_progress`、`pending`）及最近（3 分钟内）完成或阻塞的任务，避免历史长列表刷屏；
   - `/todo list`：完整展示所有状态的任务历史；
   - `/todo clear`：清空所有任务，编号重新归 #1；
   - `/todo cancel #1 #2 ...`：支持原子批量取消指定任务，若 active 任务被取消则自动推进下一个 pending 任务。

---

## 2. 状态机与展示时效设计

### 2.1 数据模型调整

在 `packages/pi-ext-tools/src/todo/model.ts` 中：
- `Task` 接口增加 `readonly updatedAt?: number;`（Unix 毫秒时间戳）；
- `applyTodo` 在任务创建和状态或内容变更时写入当前时间戳；
- 新增 `cancelTodosByUser(state: TaskState, ids: readonly number[], now?: number): SuppressTodoResult`：
  - 原子验证所有 ID：必须为合法正整数且存在；
  - 已完成任务不可取消（返回错误）；
  - 已取消任务幂等保持；
  - 批量将状态置为 `suppressed` 并更新 `updatedAt`；
  - 若正在进行的任务被取消，自动推进第一个未完成的 `pending` 任务为 `in_progress`；
  - 全批次校验失败时不修改状态（保持原子性）。

### 2.2 Footer 状态裁决逻辑

在 `packages/pi-ext-tools/src/todo/footer-status.ts` 中封装：
- **优先级与展示内容**：
  1. **近期完成任务**：
     - 若存在后续进行中任务（`in_progress`）：完成的任务 `✓ #<id> <subject>` 显示 **15 秒**，到期后自动切换展示进行中任务；
     - 若无后续任务：显示 **3 分钟**，到期后自动清空隐藏；
  2. **进行中任务**：若无处于 15 秒展示窗口的近期完成任务，存在 `status === "in_progress"` 时显示 `◐ #<id> <subject>`（常驻，无超时）；
  3. **待办任务**：若无进行中但存在 `status === "pending"` 任务，显示首个待办：`○ #<id> <subject>`；
  4. **最近阻塞任务**：若无未完成与近期完成，查找最近阻塞的任务（`updatedAt` 最大且 `now - updatedAt < 15_000`），显示 `⊘ #<id> <subject>`，并排期在剩余到期时间触发刷新；
  5. **空状态**：返回 `undefined`，调用 `ctx.ui.setStatus("pi-ext-tools:todo", undefined)`。
- **定时器与生命周期**：
  - 管理单个活跃定时器，状态变更或 session_tree 切换时清理重置；
  - session 销毁或 abort 时注销定时器并清空状态。

---

## 3. 命令交互设计 (`/todo`)

将原有 `/todos` 迁移并升级为 `/todo`：
- **`/todo`**：
  - 过滤展示活跃（`in_progress`、`pending`）及最近（3 分钟内）完成/阻塞的任务；
  - 若无活跃或近期任务：显示 `No active or recent todos. Use /todo list to view all.`。
- **`/todo list`**：
  - 完整展示当前会话中所有的任务历史。
- **`/todo clear`**：
  - 将状态重置为 `freshTaskState()`（`tasks = []`, `nextId = 1`）；
  - 持久化到 session entry（`pi-ext-tools:todo:state`）；
  - 刷新 footer 状态为 `undefined`，通知用户 `Cleared all todos.`。
- **`/todo cancel #1 #2 ...`**：
  - 解析 ID 列表，调用 `cancelTodosByUser`；
  - 成功后持久化 snapshot 到 session entry；
  - 刷新 footer 状态，通知用户取消结果。
- **未知子命令**：
  - 提示 `Usage: /todo [list | clear | cancel #ID...]`。

---

## 4. 文件改动计划

```
packages/pi-ext-tools/
├── src/
│   ├── todo/
│   │   ├── model.ts          # Task 增加 updatedAt；新增 cancelTodosByUser 批量取消
│   │   ├── state.ts          # snapshot 校验与转换（向下兼容无 updatedAt 的历史快照）
│   │   ├── footer-status.ts  # [新增] 负责 Todo footer 文本生成、优先级裁决与 3min/15s 定时器
│   │   ├── todo.ts           # 接入 setStatus，移除 widget，命令更新为 /todo
│   │   └── widget.ts         # [删除] 移除原 aboveEditor widget
│   └── extension.ts          # 生命周期清理调用
└── test/
    └── todo/
        ├── model.test.ts          # updatedAt 与 cancelTodosByUser 聚焦单测
        ├── footer-status.test.ts  # [新增] 优先级判定与定时器超时单测
        ├── widget.test.ts         # [删除] 随 widget 移除
        └── integration.test.ts    # /todo 命令族、持久化与端到端测试
```

---

## 5. 验证计划

- **单测**：
  - `pnpm exec vitest run packages/pi-ext-tools/test/todo/model.test.ts`
  - `pnpm exec vitest run packages/pi-ext-tools/test/todo/footer-status.test.ts`
  - `pnpm exec vitest run packages/pi-ext-tools/test/todo/integration.test.ts`
- **构建检查**：
  - `pnpm --filter @hheei/pi-ext-tools run build`
- **代码规范**：
  - `pnpm exec biome check packages/pi-ext-tools/src/todo packages/pi-ext-tools/test/todo`
