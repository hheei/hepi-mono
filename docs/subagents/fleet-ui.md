# Agent Runtime UI

## 状态

本文记录已批准的目标边界。当前 `FleetSurface` 的 profile、schedule 与 setting 管理能力是待删除的旧 UI，
不能作为新功能的扩展点。

## 目的

agent profile configuration 必须只通过 Loadout/Settings 的 shared router 进入。`pi-subagents` 不拥有
`/agents` configuration GUI；它仅在未来提供 root-session-scoped Runtime popup，用于查看运行中的 child、
live conversation、steer 与 stop。

## 所有权

`@hheei/pi-ext-core` 的 Loadout resource registry 传输 lifecycle-bound `agent:<name>` registration 与
detail controller capability；它不读取 agent profile、持久化配置或决定 activation policy。其 shared router
拥有 surface lifecycle、theme、focus、key routing 与 cleanup。

`pi-loadout` 拥有 scope selection、effective activation、`Agents` group 和同一 surface 内的 detail 入口。
`pi-subagents` 拥有 agent profile fields、validation、profile-file mutation 与未来 Runtime popup 的内容。每个
child execution、steer、stop 和 transcript read 仍只能通过 core conversation handle；任何 UI 不保存或暴露
raw `AgentSession`。

## 信息架构

Loadout 在存在 `pi-subagents` resource registration 时显示一个 **`𖠌 Agents`** group；同一列表的
其它固定 headings 是 **`⚒ Tools`** 与 **`✦ Skills`**：

- 每个 profile 以 `agent:<name>` 表示 effective activation；Global/Project scope 复用 Loadout 的
  enabled、disabled、inherit 语义。
- list row 固定为 `● <agent-name>  <thinking glyph> provider/model-name`；effective disabled 使用
  `○`。thinking glyph 与 activation glyph 分列，model 未指定显示 `inherit`。
- `Enter` 留在同一 router surface，打开该 profile 的 model、thinking、tool scope、memory、isolation、turn
  budget 与来源详情；保存与校验由 `pi-subagents` 提供的 detail controller 完成。
- schedule 和 extension-wide preference 同样是 Settings/Loadout concern；不再出现在 agent runtime UI。

Loadout 宽/窄布局、scope 切换、filter、fixed 20-row content budget、`→ ` selected marker、token、truncation
与 keyboard hint 服从 `DESIGN.md`。`Agents` detail 必须复用这些约束，不创建第二套 `/agents` settings GUI。

## 交互和文件操作

未来 Runtime popup 是一个只读为主的 custom surface，内部状态为 `runs` 或 `conversation`：

- `Enter` 在 active record 上切到同一 popup 内的 live conversation；viewer 支持 scrolling、steer 和
  two-press stop，`Esc` 返回原 selected row。
- popup 不管理 profile、schedule 或 activation configuration；这些操作必须返回 Loadout/Settings。
- popup 的运行态不影响 Loadout resource persistence；profile activation 的下一次 runtime application 遵循
  Loadout 的现有 reload semantics。

editor-adjacent summary 是 core-managed read-only widget。它不接管方向键或 terminal focus；Runtime popup
的稳定入口待 user-facing binding 决定后注册，不能复活 `/agents` configuration command。

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

Runtime popup 的 AbortSignal 终止时必须 detach conversation subscriptions、丢弃 late actions，并释放
widget/surface resources。session shutdown、reload 与 session replacement 关闭 Runtime popup，不恢复旧
record 或 component。

验证覆盖：Loadout `Agents` group 的 wide/narrow render、ANSI cell-width、fixed rows、scope persistence、
detail Enter/Esc/save；Runtime popup 另覆盖 runs navigation、viewer back/steer/stop、abort/reload cleanup，
以及 widget mount/suspend/restore。完成前用 tui-replay 和实际 Pi host 验证 `/loadout`、Esc、profile detail
与 Runtime popup 的 editor-return 行为。
