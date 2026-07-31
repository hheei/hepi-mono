# Pi Todo

## 目标

`@hheei/pi-todo` 是独立安装的 Pi extension，拥有任务 tool、`/todos` command、任务状态、提醒与
editor 上方 widget。它依赖 `@hheei/pi-ext-core` 的 session lifecycle，但不依赖
过渡性 `@hheei/hepi-tools` 或 `@hheei/hepi-basics`。

## 边界

- package 注册 `todo` tool 与 `/todos` command；task model、调度、suppression、提醒和 widget 都由
  `pi-todo` 自己持有；
- core 只提供 lifecycle cleanup。widget 继续直接使用 Pi 原生 `setWidget(..., { placement:
  "aboveEditor" })`，不等待尚未实现的 widget layout；
- 不新增 shared TUI frame/background API。widget 的行布局、主题 token 和宽度裁剪仍属于 Todo；
- `hepi-tools` 移除 Todo 注册，不提供 aggregate adapter 或重复 command/tool。

## 当前行为

Todo 的公开行为包括原子 `operations` 批处理、pending 自动推进、用户专属 `/todos suppress #ID`，以及
active task 满足连续有效 turn 与空闲阈值时的隐藏提醒。widget 只在 TUI 显示，位于 editor 上方，
completed task 只暂显到下一次 agent start。session tree 切换会从 fresh state 开始。

## 迁移边界

迁移保留 tool name `todo`、command `/todos`、task 状态模型和用户可见 widget 行为，但明确不兼容
历史 session Todo state：新 package 不将旧 tool-result snapshot 或 `pi-todo:state` custom entry 用于
启动或 branch 恢复，也不迁移旧 task/suppression 数据。每一次新 tool result 仍携带 display snapshot，
供该条结果 renderer 显示状态。

widget key 改为 `pi-todo:tasks`，使 runtime ownership 与 package 名称一致。

`pi-todo` 与移除 Todo 的新 `hepi-tools` 必须在同一 release 发布。旧发布版 aggregate 与新 package
混装不受支持，因为 Pi 对同名 tool/command 的注册顺序没有可靠的升级语义。

## 验证

迁移必须保留 model、integration 与 widget focused tests，并在实际 Pi 或 `tui-replay` 验证窄宽和宽
终端。独立 package 的 `prepack` 构建应能加载其 `pi.extensions` entrypoint。
