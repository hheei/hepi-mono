# Pi Todo

## 目标与边界

`@hheei/pi-todo` 独立拥有 `todo` tool、`/todo` command、任务模型、调度、提醒与 Footer 状态行。工具通过 Pi host 的 `pi.registerTool` 注册，声明 `defaultActive: false`；只有 active tool 集合包含 `todo` 时才启动 session runtime。ext-core 提供生命周期和可选展示契约，`pi-ext-ui` 提供折叠、布局与复制交互，没有 UI 时使用原生文本。

任务语义与展示数据归 Todo：header 列出本次 task id，mutation 只显示本次 operation outcome，`list` 显示 state rows，footer 显示 `active #X · N pending · duration`。Footer 状态行使用 Pi 原生 `ctx.ui.setStatus`，不在 editor 上方挂载 widget。

## 任务行为

`todo({ operations })` 按顺序处理 create、update、list、delete。整个 batch 先在候选 state 上验证，全部成功后才提交；任一操作失败都不会部分写入。

- 启动 pending 或 blocked 任务时，当前 active task 自动退回 pending。
- completed 为终态；重做工作需创建新 task。
- blocked task 保留并可查询，但不驱动 guidance 或 hidden reminder。
- `/todo` 查看活跃任务与最近完成、阻塞任务；`/todo list` 查看全部任务。
- `/todo clear` 清空任务并重置编号；`/todo cancel #ID...` 原子取消指定任务，agent 无法修改被用户取消的任务。

active task 满足有效 turn 与空闲阈值时产生隐藏提醒。提醒、timer 和 hook 读取当前 session runtime；dispose 后不能继续使用已结束的 runtime。

## Footer 状态

状态 key 为 `pi-ext-tools:todo`，显示在 TUI 左侧。状态 glyph 为 `󰪠` in_progress、`󰄰` pending、`󰀪` blocked、`󰄴` completed、`󰅚` suppressed。

展示顺序为最近完成任务、in_progress、第一个 pending、最近阻塞任务。完成后有后续 in_progress 时保留 15 秒，否则保留 3 分钟；blocked 保留 15 秒。没有 in_progress 时，最近完成与阻塞按更新时间取新者。无可见任务时清除 status，不占纵向空间。

glyph 按 status 着色，task id 使用 accent，subject 使用 text 或 dim。状态切换、超时和 session 清理均需刷新或清除 Footer。

## 持久化与分支

启动与 tree 切换从当前分支恢复状态：读取最新的 `todo` tool-result snapshot 或 `pi-ext-tools:todo:state` custom entry。用户 clear、cancel 写入 custom entry；tool result 自带 display snapshot。两种数据都通过 `stateFromSnapshot` 验证后使用。

恢复只影响当前分支的任务状态；刷新 Footer，重新建立当前 session 的提醒和 timer。dispose 幂等清理状态、timer 与提醒。

## 验证

聚焦测试覆盖任务模型、原子 batch、提醒、session lifecycle、分支恢复和 Footer 仲裁。渲染测试覆盖窄宽布局。`pi-todo` 的构建产物包含自身完整实现。
