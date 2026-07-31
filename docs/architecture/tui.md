# TUI 宿主架构

## 状态

第一阶段 core runtime、page router 与 BTW consumer 已实现。此文定义 `@hheei/pi-ext-core` 的 TUI 宿主边界；它不定义任何 extension 的页面内容、设置 schema、命令、业务状态或交互 policy。

第一阶段实现并验证 custom surface runtime 与 BTW consumer，并完成 Extension page router 的 focused
contract tests。`pi-settings` 尚未存在，因此不在此阶段迁移 `/ext-settings`；它是明确的后续迁移项，
不是以 `hepi-basics` adapter 临时维持的兼容层。第二阶段另行实现 editor/footer rail compositor，并
迁移现有 statusbar；TODO 和 subagent 仅在该 compositor 通过验证后接入。

## 目标

独立 extension 使用 Pi TUI 时，常常需要同一类资源保证：一个 runtime 内的交互焦点、关闭和 abort、主题和 render 传播，以及 `/reload` 后的资源清理。core 只拥有这些 feature-neutral 的宿主机制；每个 contributor 保有自身的可见内容、数据、状态、输入解释和 policy。

所有 visible behavior 遵循根目录 [DESIGN.md](../../DESIGN.md)。core 不新增颜色 token，不创建命令，也不在没有 consumer 注册时创建 Pi handler、timer、listener、session state 或 render work。

## Custom Surface Runtime

`ctx.ui.custom()` 是 page、popup 和即时问答共用的 Pi 挂载机制，但三者不是同一种 UI。core 提供内部共享 runtime，公开的 page router 和 popup host 各自定义内容 contract：

- 一个 Pi runtime 同时仅运行一个 core-owned custom surface；
- 各 host 必须以稳定 `hostId` 显式声明 `maxPending`，core 不提供隐藏队列容量；容量只统计该 host 的等待请求；
- 请求按 FIFO 排队，component factory 只在真正出队时执行；
- caller 必须提供 `AbortSignal`；abort、session shutdown、factory failure 或 close 都从队列和 active slot 清理；
- core 负责 exactly-once close、theme/render forwarding 与 cleanup。caller 负责其 result、notification、fallback 和业务 cancellation policy。

Extension page router 是 page host：它只拥有 tabs、lazy view lifecycle、theme、render host 和 key fallback。active page 先处理 input；只有未消费的 Left/Right 才由 router 切换 tabs。所有 page visible content、state、actions 和 page-local interaction 都属于注册该页面的 extension。

popup host 是另一份公开 contract。BTW 是第一份 consumer；Ask 只复用其 TUI host，保留自己的
non-TUI dialog fallback、问卷 model 和结果 policy。

## 待迁移的 Settings Host

ADR 0003 要求未来的 `packages/pi-settings` 独占 `/ext-settings [page-id]`，并调用 core router。
当前 command 和 Settings host 仍在过渡性 aggregate `hepi-basics`，不得为迁移而让新 package
依赖该 aggregate。迁移时必须一并处理：

- `packages/hepi-basics/src/core/command/hepi-command.ts` 中 `/ext-settings` command ownership；
- `packages/hepi-basics/src/core/extension.ts` 中 `settingsModule` construction、module registration
  和 lifecycle close；
- `packages/hepi-basics/src/core/ui/settings/` 整个 Settings page（`combined`、`component`、
  `controller`、`index`、`layout`、`model`、`render`、`value-editor`）；
- 它使用的 `packages/hepi-basics/src/core/ui/` helpers：`border`、`keymap`、`layout`、`number`、
  `row`、`scrollbar`、`selector-panel-layout`、`tabs`、`text`；
- 若保留当前 embedded Loadout tab，还包括 `core/ui/shell/component.ts` 及其 coordinated close
  contract。不得让 `pi-settings` import concrete `pi-loadout`；应由 Loadout 作为 router page 注册；
- 相应 command、integration 和 `test/ui/settings/` focused tests。

迁移前必须重新确认 Loadout 从 embedded tab 改为独立 router page 的可见行为，不得在未确认时静默
移除该 tab。

## Editor 邻接区域

Pi 原生 `setWidget()` 是 editor 上方和下方内容区的唯一底座。core 的 widget layout 只封装：

- `aboveEditor` 与 `belowEditor` placement；
- 每个 placement 的 left/right contributor；
- contributor priority 和显式 `maxRows`；
- editor 最小高度保护，按 priority 分配余量；不能完整容纳的低优先级 block 整体隐藏；
- lifecycle-bound registration、theme invalidation、ANSI/cell-width safety 与 cleanup。

这些内容区第一版只展示状态，绝不接管 editor 键盘输入。用户动作由 extension 的 command 或 custom popup 完成。

上下两条 rail 与 widget 区不同：它们由一个唯一 editor/footer compositor 生成单行结构，所有 rail contributor 使用同一 priority order，宽度不足时以该 order 裁剪或隐藏。compositor 保存并恢复前一个 editor/footer factory，避免与 Pi editor、hardware cursor 及其他包装器产生 ownership 冲突。

鼠标拖选不属于此 contract。终端 emulator 决定原生 selection；Pi 当前 extension API 没有公开 mouse-selection surface。contributor 仍应避免无意义的尾随填充，并始终输出可安全复制的文本。

## Ownership、并发与验证

每个公开 TUI API 的 TypeScript 注释必须说明 owner、consumer、缺席 fallback、cleanup、cancellation 和并发语义。runtime state 以 `pi.events` identity 作用域化，跨重复 core module instance 共享；它不得长期保留 ExtensionContext 或 component。

focused tests 必须覆盖 FIFO、每 host queue capacity、abort before/after dequeue、session shutdown、factory failure、exactly-once close、theme invalidation、router page key override、lazy view retry 与 dynamic page removal。可见改动还必须在 Pi 或 `tui-replay` 验证窄和宽终端；测试不能代替真实 render 验证。
