# Pi Runtime Host Bridge

## 状态

这是已确认、尚未实现的 `@hheei/pi-ext-core` 受限 core contract。它不修改 Pi 源码，也不创建
`pi-select` package。实现前必须先建立根入口 public API、focused tests 与真实 Pi/TUI replay 验证。

## 目标

Pi 的 public extension API 不提供 Editor、tool renderer 的实际 viewport 布局和挂载生命周期。Runtime host
bridge 把对未修改 Pi runtime 的版本受限观察与可恢复 wrapper 集中在 core 内，向 feature 发布窄的 Host
surface capability。这样 feature 不直接访问 Pi private object，仍由各 surface owner 定义文本、selection
和 copy 语义。

```text
feature -> pi-ext-core public capability -> bridge -> Pi runtime internals
```

v1 只覆盖当前 Editor 与 HEPI-managed tool output。它不覆盖 Pi native tool、assistant/model output、任意
third-party Component 或通用 component tree。

## 所有权边界

- `pi-ext-core/bridge` 是唯一可以访问或 wrapper Pi internal runtime shape 的模块；private path、prototype
  和 instance 不得从根入口导出，也不得被 feature deep-import。
- bridge 负责 probe、可恢复 patch、现有与后续 Host surface 发现、layout snapshot、runtime capability
  publication、warning 与 cleanup。
- Bridge consumer 以自身 lifecycle `AbortSignal` 取得 Bridge lease。第一个 lease 才安装 bridge；最后一个
  lease 释放 capability 并恢复仍由 bridge 持有的 patch。未请求 lease 时 core 不创建 patch、listener、state 或
  render work。
- Editor 或 Managed tool owner 负责 logical text、cell 到 `TextPosition` 的映射、selection state、highlight
  和 copy policy。core 不读取或写入 clipboard，不推断 Markdown、ANSI、diff 或 renderer padding 的文本语义。
- Managed tool contributor 在 `registerManagedLoadoutTool()` 时可静态声明 optional selection adapter。未声明
  adapter 时，Pi tool execution 与 rendering 完全保持原行为。
- 本轮不创建 `pi-select`。它若未来存在，只能作为具体 surface 的 convenience adapter，不能成为 bridge 或
  Managed tool selection 的必需依赖。

## Capability Contract

公开 TypeScript API 必须只从 `@hheei/pi-ext-core` 根入口导出，并实现以下语义；具体类型和函数名在 interface
framework commit 中确定，不得绕过这些边界：

- consumer 可以以必填 lifecycle signal 获取 owner-scoped Bridge lease；lease 释放幂等。
- lease 成功时发布当前 Editor Host surface，并持续发布当前与后续 HEPI-managed tool Host surface。
- 每个 Host surface 有稳定 identity、lifecycle signal、当前 viewport geometry、monotonic layout revision 和
  render invalidation/request entry。layout snapshot 只在 layout、scroll、expand、visibility 或 streaming 内容
  改变时更新，不得由 `render(width)` 副作用创建或移除。
- Managed tool selection adapter 与其 ToolDefinition 同时静态注册。adapter 接收匹配的 Host surface，自己
  绑定 `MouseSupport.registerSelectableRegion()` 并在内容 revision 变化时管理 selection state。
- bridge 不自动把 `ToolRenderContext` 或 renderer output 解释成可复制文本。没有 adapter 的 tool 不发布
  selectable behavior。

## 安装、缺席与恢复

bridge 的 compatibility fence 是 Pi `0.83.x` 加完整 runtime shape probe。probe 必须在写入任何 patch 前完成。
版本不在范围内、缺少预期 shape、无法发现当前 Editor、无法发现已显示 Managed tool surface，或无法保证 patch
恢复时，bridge 进入 Bridge unavailability：

```text
不安装或撤销 bridge patch
不发布 Host surface capability
不启用 host-bound selection
保留 Pi 原始行为
每个 runtime 仅报告一次 Pi native warning
```

首次 Bridge lease 必须绑定已经显示的 Editor 和 Managed tool surface，也必须观察后续 surface。不能只支持未来
render、要求 reload，或让当前页面出现半可选状态。

v1 只允许 Recoverable bridge patch：记录 original target 与 bridge wrapper identity；release 时仅当目标仍是该
wrapper 才恢复 original。发现未知 wrapper、丢失 patch ownership 或需要组合第三方 patch 时 fail-closed，不自动
拼接 wrapper，不永久保留 patch 到 session shutdown。

## 与 Mouse Contract 的关系

Mouse contract 仍由 [鼠标与局部文本选择](../mouse/README.md) 定义。bridge 不替代 SGR tracking、capture 或
`SelectableRegion`；它只解决 Host surface 的真实 geometry 与 lifecycle 来源：

```text
bridge snapshot -> surface owner hitTest/hitTestText -> MouseSupport dispatch
```

没有 Bridge lease 或 bridge unavailable 时，已经由页面自己拥有 `TUI` 与 layout 的现有 MouseSupport consumer
不受影响；只有需要 Pi host-bound surface 的 consumer 失去 selection capability。

## 验证

- core focused tests：lease reference ownership、duplicate consumer、absence、一次 warning、late attach、surface
  mount/unmount、layout revision、abort、reload、stale lease 与 recoverable patch identity guard。
- Managed tool tests：未声明 adapter 时行为不变；声明 adapter 时 call/result、partial、expand 与内容 revision
  不泄漏或错绑 selection。
- Editor tests：bridge 只发布 surface，不注入 selection/copy policy。
- host integration：在真实 Pi `0.83.x` 与 `tui-replay` 验证已有和后续 Editor/Managed tool surface、窄宽 layout、
  scroll、streaming、lease 释放和 fail-closed fallback。fake TUI 不能单独证明 private runtime bridge 正确。

实现注释必须和代码同一 commit 写入，说明 private hook 为什么存在、probe 保护什么、patch ownership 如何恢复、
late attach 如何保持完整性，以及为什么不能在 render hot path 扫描或注册 region。
