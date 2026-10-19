# Pi Todo

## 目标

`@hheei/pi-ext-tools` 拥有 Todo：任务 tool、`/todo` command、任务状态、提醒与 Footer
状态行。它复用 `@hheei/pi-ext-core` 的 session lifecycle 与 prompt 段落能力；工具注册走 Pi 原生
`pi.registerTool`，展示框架由 `@hheei/pi-ext-ui` 提供。

## 边界

- `pi-ext-tools` 拥有 `todo` tool definition 与 `/todo` command；task model、调度、cancel、
  提醒和 Footer 状态展示都由该 package 持有；
- `pi-ext-tools` 自己调用 `pi.registerTool` 注册 `todo`，并声明 `defaultActive: false`：只有
  `pi.getActiveTools()` 已包含 `todo` 时，`startToolsLifecycle` 才启动 Todo runtime。是否启用由 Pi host 的
  active tool 集合决定，ext-core 不代为注册；
- Todo 直接使用 Pi 原生 `ctx.ui.setStatus` 维护左侧单行状态，不在 editor 上方挂载 widget；
- Todo 用 `pi-ext-ui` 的 ToolView 渲染自己的 definition，与 coding tools 使用同一折叠与复制交互。
  header、body、typed footer 的 task 语义仍属于 Todo：header 列出本次 task id，mutation 只显示本次
  operation outcome，`list` 显示 state rows，footer 只显示 `active #X · N pending · duration`；
- Todo 不是独立 extension，也没有 adapter、重复 command/tool 或第二个 runtime。

## 当前行为

Todo 的公开行为包括原子 `operations` 批处理、pending 自动推进、用户专属 `/todo cancel #ID...` 与 `/todo clear`，以及
active task 满足连续有效 turn 与空闲阈值时的隐藏提醒。Footer 状态行在 TUI 左侧显示，状态 glyph 使用 Nerd Font 字符
（`󰪠` in_progress、`󰄰` pending、`󰀪` blocked、`󰄴` completed、`󰅚` suppressed）：
- 仲裁顺序：最近完成任务（有后续 `in_progress` 时显示 15 秒，否则保留 3 分钟）→ `in_progress`（常驻）→
  第一个 pending → 最近阻塞任务（15 秒）；没有 `in_progress` 时，最近完成与最近阻塞按 `updatedAt` 取新者；
- glyph 按 status 语义着色（in_progress `warning`、pending `muted`、blocked `dim`、completed `success`），
  task id 用 `accent`，subject 按语义用 `text` 或 `dim`；
- 超时、清空或无需要显示时直接置为 undefined，使原生 Footer 不输出第三行，完全不占纵向空间。
session tree 切换会从当前分支的 snapshot 恢复状态并同步刷新 Footer 状态。

## 调度与可见性

- agent 将一个 pending 或 blocked task 更新为 `in_progress` 时，当前 active task 自动退回 pending；
  completed task 不能重新打开，重做应创建新 task；
- blocked task 保留在 runtime state，仍可通过 `/todo` 和该次 tool result 查询，但不会驱动 guidance 或
  hidden reminder；
- 用户可通过 `/todo` 查看活跃（in_progress、pending）及最近 3 分钟完成/阻塞的任务，`/todo list` 查看全量，
  `/todo clear` 清空所有任务并重置编号，`/todo cancel #ID...` 原子批量取消指定任务。

## 持久化边界

Todo 保留 tool name `todo`、command `/todo`、task 状态模型、Footer 状态行行为，以及 session Todo
state。`pi-ext-tools` 从 `todo` tool-result snapshot 与 `pi-ext-tools:todo:state` custom entry 恢复启动和
branch state；`pi-ext-tools:todo:*` 是稳定的 Todo persistence schema。每一次新 tool result 仍携带
display snapshot，供该条结果 renderer 显示状态。

Footer 状态项的 key 为 `pi-ext-tools:todo`，使 runtime ownership 与 package 名称一致。

## 实现注释

Todo 的关键注释必须说明实际约束，而不是复述类型或语句：

- tool registration 必须记录 `pi-ext-tools` owner、`defaultActive: false` 的语义，以及为什么注册在
  extension construction 发生、而 Todo runtime 只在 `todo` 已 active 时启动；
- tool batch 必须说明先在候选 state 上验证、成功后才提交，避免任何 invalid operation 部分写入；
- Pi event handler 必须说明它只读取当前 session runtime，并在 lifecycle disposal 后成为 no-op，避免
  Pi 无 unregister API 在 `/reload` 后调用 stale closure；
- result `details.snapshot` 是 Todo 的 branch recovery data；`pi-ext-tools:todo:state` 只记录没有 tool result
  的用户 cancel/clear，并且两个 persistence type 都必须经 `stateFromSnapshot` 验证；
- footer status 注释必须说明它如何通过 `ctx.ui.setStatus` 在左侧展示，以及
  活跃/完成 3 分钟/阻塞 15 秒展示窗口的定时器清理与状态机逻辑。

## 验证

迁移必须保留 model、integration 与 footer-status focused tests，并在实际 Pi 验证窄宽和宽
终端。`pi-ext-tools` 的 `prepack` 构建必须包含 Todo implementation。
