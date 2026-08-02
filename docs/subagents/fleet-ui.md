# Agent Fleet UI

## 目的

`/agents` 是 `@hheei/pi-subagents` 的 domain-owned Agent Fleet surface。它让用户查看 root session 中的
active/queued child agent、管理 agent definition，并进入 live conversation。它不属于 `/ext-settings`：
`pi-settings` 只承载通用设置字段，Fleet 自己拥有 agent catalog、profile 文件和 task record 的业务操作。

## 所有权

`@hheei/pi-ext-core` 的 `openTuiSurface()` 只拥有 runtime-wide custom UI slot、FIFO admission、abort、
theme 和 component disposal。它不知道 Agent、profile、schedule 或 file mutation。

`pi-subagents` 拥有 Fleet component、列表内容、selected detail、操作可用性、child transcript 呈现，以及
profile mutation policy。每个 child execution、steer、stop 和 transcript read 仍只能通过 core conversation
handle，Fleet 不保存或暴露 raw `AgentSession`。

## 信息架构

Fleet 首屏有三个分组：

- **Active**：root session 的 queued、running 与 retained terminal child records；选中行显示 operation
  status、purpose、duration 和 usage，Enter 进入 conversation view。
- **Agent definitions**：built-in 与 project/global custom definitions；Detail 显示来源、enabled state、model、
  tool scope、turn budget 和 description。
- **Schedules**：此 slice 只显示 schedule count 和 deferred state，不实现 schedule CRUD。

宽布局是 grouped list、conditional scrollbar、Detail。窄布局改为 list 在上、Detail 在下。两种布局都固定
content row budget，selected marker 固定为 `→ `，description 在 Detail 区 wrap/clip，不能因状态或长文本改变列表
行高。具体 token、truncation 和 keyboard hint 服从根 `DESIGN.md`。

## 交互和文件操作

Fleet 是一个 custom surface，内部状态为 `fleet` 或 `conversation`：

- `Enter` 在 active record 上切到同一 surface 内的 live conversation；viewer 支持 scrolling、steer 和
  two-press stop，`Esc` 返回原 selected row。
- definition actions 产生 typed intent，而非从 Fleet 内嵌套 Pi dialog。surface 先关闭，command handler 再用
  Pi native `editor`、`input` 或 `confirm` 完成 manual create、generate、edit、enable/disable、eject、reset 或
  delete，然后以相同 selection 重开 Fleet。
- Generate 通过 core-backed child conversation 创建已选 scope 的 definition；它必须使用有限 budget，不能产生
  unlimited turn configuration。

editor-adjacent summary 是 core-managed read-only widget。它不接管方向键或 terminal focus；进入 Fleet 的
稳定入口是 `/agents`。当前不注册默认 shortcut，待 user-facing binding 决定后再单独添加。

## Widget 移植计划

Widget 的控制流保持单向：

```text
AgentManager / AgentActivity
        ↓
pi-subagents AgentWidget 计算可见内容
        ↓
registerHepiWidget()
        ↓
ext-core 负责 setWidget、挂载、重挂载、暂停和清理
        ↓
Pi host 在 editor 上方显示
```

`AgentWidget` 仍拥有 finished linger、spinner、usage、activity 和 `widgetMode` 业务规则，但不再直接调用
`ctx.ui.setWidget()`，也不再保存 Pi `TUI` 作为自己的生命周期 owner。它暴露一个 core registration factory 和一个
有限的 render invalidation seam；`HepiWidgetHandle` 负责 visible 状态与 render request。

Widget 只在有 active/queued/短暂 finished 内容时 visible；没有内容时由 handle 隐藏。Settings 通过
`suspendHepiWidgets()` 暂停全部 core-managed widgets，surface abort、session replacement、reload 和 shutdown
都必须使 registration handle 幂等释放。旧的 FleetList 与任何 `focusedComponent`/`onTerminalInput` 路径在这一步删除。

实现顺序：

1. 将 `AgentWidget` 的 Pi widget factory 改为纯 `Component` factory，并抽出 `visible` 与 `requestRender` 的最小适配。
2. 在 `session_start` 的 active runtime 中注册 `registerHepiWidget(pi, runtime.extension, runtime.signal, ...)`，将 handle
   放入 runtime resource cleanup；禁止在 extension factory 或 child session 中产生 widget。
3. 将 `update()`、`dispose()`、`setWidgetMode()` 接到 handle，保持现有 statusbar 行为和 finished retention 不变。
4. 删除旧 `UICtx.setWidget` 类型、FleetList runtime wiring 和 undocumented terminal input/focus code。
5. 增加 focused tests：无内容隐藏、首次出现挂载、内容变化 requestRender、theme invalidation remount、settings suspension、
   abort/dispose idempotency，以及 80/120/216 列宽度的 cell-width 检查。

## 生命周期和验证

surface 的 AbortSignal 终止时必须 detach conversation subscriptions、丢弃 late actions，并释放 widget/surface
resources。session shutdown、reload 与 session replacement 关闭 Fleet，不恢复旧 record 或 component。

验证覆盖：wide/narrow render、ANSI cell-width、fixed rows、group navigation、viewer back/steer/stop、typed action
handoff、abort/reload cleanup，以及 widget mount/suspend/restore。完成前用 tui-replay 和实际 Pi host 验证 `/agents`、
Esc、viewer 与 editor-return 行为。
