# Pi Todo

## 目标

`@hheei/pi-todo` 是独立安装的 Pi extension，拥有任务 tool、`/todos` command、任务状态、提醒与
editor 上方 widget。它依赖 `@hheei/pi-ext-core` 的 session lifecycle，但不依赖
旧 aggregate package。

## 边界

- package 拥有 `todo` tool definition 与 `/todos` command；task model、调度、suppression、提醒和
  widget 都由 `pi-todo` 自己持有；
- core 在 extension initialization 代为向 Pi 注册 `todo` executable tool，并发布同名 Loadout
  inventory item。metadata 固定为 owner `@hheei/pi-todo`、group `Tasks`、priority `100`、无
  conflict、default active。没有 `pi-loadout` 时，core 保留 Pi 默认 activation；安装
  `pi-loadout` 后才由其 policy 决定是否启用；
- core 还提供 session lifecycle cleanup。widget 继续直接使用 Pi 原生
  `setWidget(..., { placement: "aboveEditor" })`，不等待尚未实现的 widget layout；
- 不新增 shared TUI frame/background API。widget 的行布局、主题 token 和宽度裁剪仍属于 Todo；
- 旧 aggregate package 不再注册 Todo，不提供 adapter 或重复 command/tool。

## 当前行为

Todo 的公开行为包括原子 `operations` 批处理、pending 自动推进、用户专属 `/todos suppress #ID`，以及
active task 满足连续有效 turn 与空闲阈值时的隐藏提醒。widget 只在 TUI 显示，位于 editor 上方，
completed task 只暂显到下一次 agent start。session tree 切换会从 fresh state 开始。

## 调度与可见性

- agent 将一个 pending 或 blocked task 更新为 `in_progress` 时，当前 active task 自动退回 pending；
  completed task 不能重新打开，重做应创建新 task；
- blocked task 保留在 runtime state，仍可通过 `/todos` 和该次 tool result 查询，但不会驱动 guidance 或
  hidden reminder；
- block 操作所在 turn 不计数。其后的两次有效 assistant turn（`stop` 或 `toolUse`，且该 turn 未更新
  Todo）后，blocked task 从 editor 上方 widget 隐藏。它不会再占 GUI 行，但不从 state 删除。
  隐藏前它以 `dim` 图标与删除线 subject 呈现，不使用 `warning`。

## 迁移边界

迁移保留 tool name `todo`、command `/todos`、task 状态模型和用户可见 widget 行为，但明确不兼容
历史 session Todo state：新 package 不将旧 tool-result snapshot 或 `pi-todo:state` custom entry 用于
启动或 branch 恢复，也不迁移旧 task/suppression 数据。每一次新 tool result 仍携带 display snapshot，
供该条结果 renderer 显示状态。

widget key 改为 `pi-todo:tasks`，使 runtime ownership 与 package 名称一致。

`pi-todo` 已独立拥有 Todo 注册。旧发布版 aggregate 与新 package 混装不受支持，因为 Pi 对同名
tool/command 的注册顺序没有可靠的升级语义。

## 实现注释

Todo 的关键注释必须说明实际约束，而不是复述类型或语句：

- managed tool registration 必须记录 owner、Loadout default、无 policy host 时的 fallback，以及
  为什么 registration 只能在 extension initialization 发生；
- tool batch 必须说明先在候选 state 上验证、成功后才提交，避免任何 invalid operation 部分写入；
- Pi event handler 必须说明它只读取当前 session runtime，并在 lifecycle disposal 后成为 no-op，避免
  Pi 无 unregister API 在 `/reload` 后调用 stale closure；
- result `details.snapshot` 仅用于当前 tool-result renderer，不能被描述为 session 或 branch persistence；
- widget 注释必须说明它为何继续使用 native above-editor mount，以及 completed/blocked 可见性集合的
  ownership 和 reset 时机。

## 验证

迁移必须保留 model、integration 与 widget focused tests，并在实际 Pi 或 `tui-replay` 验证窄宽和宽
终端。独立 package 的 `prepack` 构建应能加载其 `pi.extensions` entrypoint。
