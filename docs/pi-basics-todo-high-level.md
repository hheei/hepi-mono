# pi-basics Todo 高层方案（Review Gate）

> 目的：先确认功能边界，再进入详细设计与实作。推荐方案以“够用、可恢复、低提示词成本”为目标，不复制 `rpiv-todo`、`pi-xtodo` 或 `@zhushanwen/pi-todo` 的全部能力。

## 1. 一句话方案

在 `packages/pi-basics/src/modules/todo/` 内新增内建 Todo 功能：提供 `todo` 工具、直接 `/todos` 摘要命令和 editor 上方的轻量状态 widget；状态属于当前 pi-basics session runtime，并从 `todo` tool result 的最新完整快照恢复。


## 2. 推荐功能范围

### 保留

- `todo` 工具；不使用产品前缀，也不注册 `hepi_todo` alias。
- 直接注册 `/todos`，不经过 `/hepi` dispatcher，也不保留 `/hepi todo` alias。
- 四个 operation：`create`、`update`、`list`、`delete`；一次 `todo` 调用提交一个有序 `operations` 数组，可混合 delete + create。
- 三个状态：`pending`、`in_progress`、`completed`。
- 依赖关系：`blockedBy`，必须是无环图；依赖是调度提示，不强制阻止状态转换。
- session runtime 隔离；branch lineage 内 id 单调递增，不同 branch 可复用数字 id。
- 从当前 branch 的 tool-result history 重放；compact 无 snapshot 时保留 live state，tree 无 snapshot 时切换 empty state。
- 仅在 `ctx.mode === "tui"` 注册 editor 上方只读 widget；显示完成计数、进行中和待办任务，空任务时卸载。
- 纯 reducer、不可变 state、可预测错误结果。

### 不做

- 不建新 package；Todo 是 `pi-basics` 内建 module。
- 不用 Settings state 保存 Todo 数据。
- 不写独立磁盘文件；branch history 是唯一事实来源。
- 不增加 `owner`、`metadata`、`description`、`activeForm`。
- 不增加 `get`、`clear`、deleted tombstone、`includeDeleted`。
- 不增加 overlay 折叠快捷键、配置、i18n、replay cache。
- 不接管 editor/footer；只使用 Pi 已有 `setWidget(..., { placement: "aboveEditor" })`。
- 不增加 Todo public SDK；第二个真实消费者出现前保持 module-private。

## 3. 用户可见行为

### 模型侧

```json
{
  "operations": [
    { "action": "delete", "id": 2 },
    { "action": "create", "subject": "Implement replacement" }
  ]
}
```

Operations依序作用于同一 draft；整批先验证，全部合法才一次 commit。任一 operation失败则整批 state不变。省略 task不代表删除；删除必须显式使用 `delete`。`list` 必须是唯一 operation。

合法状态转换：

```text
pending <-> in_progress -> completed
```

`completed` 不可重新打开；需要重做时建立新 task。Task id 在同一 branch lineage 内单调递增，不因删除而复用；从较早节点分叉后，不同 branch 可以出现相同数字 id。

### 人类侧

```text
● Todos 2/4
├─ ◐ #3 Implement reducer
└─ ○ #4 Add lifecycle tests  blocked by #3
```

- widget 只显示未完成任务；标题保留完成数/总数。
- `/todos` 显示完整分组摘要，包括 completed。
- widget 只读，不承担编辑和导航。

## 4. 来源化提示词

```text
promptSnippet: "Manage a task list to track multi-step progress"

promptGuidelines:
- "Use `todo` for complex work with 3+ distinct steps, when the user provides multiple tasks, or after new instructions. Skip single trivial or purely conversational requests."
- "Mark a task `in_progress` before beginning work and `completed` immediately when done; keep exactly one task `in_progress` while work remains, and do not delay completions to batch them."
- "Never mark a task `completed` when work is partial, failing, or blocked; keep it `in_progress` and add a task for the blocker."
- "When several task changes are already known, submit them together in one `operations` batch to reduce tool calls; never infer deletion from omitted tasks."
```

使用门槛、实时状态、完成安全取自 OpenCode / Claude TodoWrite；snippet与状态纪律交叉参考 `pi-xtodo` / `rpiv-todo`；批量优先取自 `@zhushanwen/pi-todo`。Ordered mixed `operations[]` 是本项目基于这些已验证模式作出的本地设计，不宣称任何单一来源已有相同 schema。

## 5. 与参考实现的取舍

| 参考能力 | 决策 | 原因 |
|---|---|---|
| `pi-xtodo` / `rpiv-todo` 的纯 state + reducer | 保留 | 最容易测试和重放 |
| 完整 snapshot 写入成功 tool result `details` | 保留 | 最新成功快照即可恢复；失败调用抛错且不写 snapshot |
| `blockedBy` DAG | 保留 | 多步骤计划的核心语义 |
| session-runtime state | 保留 | 复用 pi-basics 现有 active-session lifecycle，不建立第二套 session owner |
| above-editor widget | 保留但简化 | 仅 TUI 绑定；直接提供进度反馈，不增加交互状态 |
| `@zhushanwen/pi-todo` 的 closure-owned state 与 sequential execution | 保留语义 | 由现有 active runtime owner + `executionMode: "sequential"` 提供，不复制可变共享对象 |
| no-op update 明确返回 `No change` | 保留 | 模型能区分真实 mutation 与重复调用，避免同参数循环 |
| mixed operation batch | 保留 | `@zhushanwen/pi-todo` 明确以 batch减少调用；采用本地有序 mixed operations，避免 OpenCode/Claude full-list replacement 的 omission-as-delete |
| full hidden per-turn context、stall/completion steer、state auto-clear | 删除 | 避免每轮 token成本与tool snapshot之外的domain mutation |
| conservative inactivity reminder | 保留但简化 | 连续5个完整agent turn未成功调用todo后，只为当前turn追加一次next-task system prompt；tool disabled时不注入，不写session message |
| RPC `details.__gui__` / rich renderer | 删除 | 当前没有真实 RPC GUI 消费者；默认 tool rendering 已满足 v1 |
| 磁盘 fallback | 删除 | 两份事实来源、同步 I/O、路径/损坏处理不符合极简目标 |
| deleted tombstone | 删除 | 最新完整快照可表达删除；历史审计不是当前需求 |
| `owner` / `metadata` / long description | 删除 | 增加 schema、prompt 和持久化面，无当前消费者 |
| `get` / `clear` | 删除 | `list` 已可观察；逐项 delete 更明确且较不危险 |
| completed render auto-hide | 保留但简化 | 全部完成后保留两轮success header，再只卸载widget；task、snapshot与nextId不变 |
| 配置、快捷键、i18n | 删除 | 不影响核心 Todo 契约 |

## 6. 与 pi-basics 的相容方式

- 目录：`packages/pi-basics/src/modules/todo/`。
- `TodoFeature` 自己拥有当前 runtime 的 domain state；Todo command/state不进入 `HePiRegistry`。
- `todo` tool、`/todos` command与 compact/tree/`tool_execution_end` hooks由 `pi-basics` 唯一 extension entry注册一次；session start/shutdown复用现有 `HePiLifecycleController`。Tool execute先独立返回 result，再 best-effort刷新 widget。
- Tool 必须先于 session-start 的 Loadout inventory 建立，使现有 Loadout 发现 `tool:todo`；默认 active，用户禁用后同时移除 schema/prompt/执行能力。
- `/todos` 通过 `pi.registerCommand("todos", ...)` 直接注册；若 tool 被 Loadout 禁用，命令/widget仍只读显示既有 branch state。
- widget 使用 Pi additive widget API，不扩展尚未实现的 editor/footer contribution API，且只在 TUI mode 绑定。
- Todo 不进入 Settings/Loadout mutable state，不改变现有 shell tab。

## 7. Review 决策点

请以此表作为功能确认入口；推荐项已写入详细设计。

| 决策 | 推荐 | 可选替代 |
|---|---|---|
| 安装边界 | `pi-basics` 内建 module | 独立 `pi-todo` package |
| Tool 名称 | `todo`，不加产品前缀 | `hepi_todo` namespace prefix |
| 人类命令 | 直接 `/todos` | `/hepi todo` dispatcher route |
| 持久化 | branch tool-result replay | branch + disk fallback |
| 删除 | hard delete，id 不复用 | deleted tombstone |
| Task 字段 | `id/subject/status/blockedBy` | 加 description/activeForm |
| 依赖更新 | `blockedBy` 完整替换 | add/remove delta fields |
| Batch 输入 | 有序 `operations[]`，显式 mixed operations，原子 commit | full-list replacement `todos[]` |
| UI | 只读 above-editor widget | 可交互 Todo panel/tab |

## 8. 完成定义

- 模型可在一次调用中建立、更新、列出或删除任务；delete + create可原子组合。
- DAG 无悬空、自依赖或 cycle。
- session reload/compaction/tree 后，按已定义 snapshot fallback 恢复。
- session runtime替换时不共享 mutable task state。
- `/todos` 与 widget 反映同一 active-runtime state。
- Loadout 能发现、启用和禁用 `todo`。
- prompt guidance 四条，语义来自线上 OpenCode、Claude TodoWrite、`pi-xtodo`、`rpiv-todo` 与 `@zhushanwen/pi-todo`。
- no-op update 有明确 `No change` 回应；已 abort 的调用不 mutation。
- 不新增磁盘格式、配置格式、全局 editor/footer owner 或跨 module mutable state。

详细设计见 [`pi-basics-todo-design.md`](./pi-basics-todo-design.md)，实施步骤见 [`pi-basics-todo-implementation.md`](./pi-basics-todo-implementation.md)。
