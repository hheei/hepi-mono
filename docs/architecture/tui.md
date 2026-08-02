# TUI 宿主架构

## 状态

第一阶段 core runtime、page router 与 BTW consumer 已实现。此文定义 `@hheei/pi-ext-core` 的 TUI 宿主边界；它不定义任何 extension 的页面内容、设置 schema、命令、业务状态或交互 policy。

第一阶段实现并验证 custom surface runtime、page router 与 BTW consumer。`pi-settings` 已作为独立 host
实现，并提供完整 combined-provider Settings page；`pi-loadout` 作为 router page 注册，core-managed widget 会在 Settings
surface 打开期间 suspend。第二阶段另行实现 editor/footer rail compositor，并迁移现有 statusbar；TODO 和
subagent 仅在该 compositor 通过验证后接入。

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

Extension page router 是 page host：它只拥有 tabs、lazy view lifecycle、theme、render host、page-close
coordination、page-declared minimum content height 和 key fallback。active page 先处理 input；只有未消费的
Left/Right 才由 router 切换 tabs。
page 可以在完成自己的异步 flush 后请求 host close。所有 page visible content、state、actions 和 page-local
interaction 都属于注册该页面的 extension。

popup host 是另一份公开 contract。BTW 是第一份 consumer；Ask 只复用其 TUI host，保留自己的
non-TUI dialog fallback、问卷 model 和结果 policy。

## Settings Host

`packages/pi-settings` 独占 `/ext-settings [page-id]`，并调用 core router。`pi-loadout` 额外注册
`/loadout`，以 Loadout 为 initial page 打开同一 router。它们不 import concrete extensions；provider page
与 `pi-loadout` page 都经 runtime-scoped core registry 组合。过渡性
`hepi-basics` 不再注册 `/ext-settings`、`/loadout` 或 `/hepi` module command，也不保留 legacy Settings
shell。

Loadout 是独立 router page，Tools 与 Skills 同页；任一 router command host 打开期间 suspend 所有
core-managed editor widget；Loadout 持有 scope draft，切 scope/离开 page/close 时写入而不 hot-apply。旧
embedded Loadout tab 不迁移。

## Editor 邻接区域

Pi 原生 `setWidget()` 是 editor 上方和下方内容区的唯一底座。core 是 core-managed widget 的唯一 Pi
transport owner；contributor 注册稳定 key、placement、factory 与 lifecycle signal，不能直接接管 transport。
当前 core-managed widget transport 只封装：

- `aboveEditor` 与 `belowEditor` placement；
- lifecycle-bound registration、theme invalidation、ANSI/cell-width safety 与 cleanup。

Settings host 可取得 runtime-scoped suspension lease。任一 lease 存在时 core 卸载全部 core-managed
widget；最后一个 lease release 才重新执行仍有效 contributor factory。lease、registration、surface abort、
reload 和 session shutdown 都必须幂等 cleanup。core 不能且不承诺隐藏没有迁移到这个 registration contract
的 third-party/direct Pi widget。

它尚未实现 rail priority、左右布局、`maxRows` 或最小 editor 高度 compositor。若两个真实 contributor
需要组合，再定义这些 policy；不能预先把它们伪装成已实现能力。内容区不接管 editor 键盘输入，用户动作由
extension command 或 custom popup 完成。

上下两条 rail 与 widget 区不同：它们由一个唯一 editor/footer compositor 生成单行结构，所有 rail contributor 使用同一 priority order，宽度不足时以该 order 裁剪或隐藏。compositor 保存并恢复前一个 editor/footer factory，避免与 Pi editor、hardware cursor 及其他包装器产生 ownership 冲突。

### Mouse 与局部文本选择

`@hheei/pi-ext-core` 提供一个 opt-in 的 TUI mouse/local-selection contract。它不修改 upstream
`Component`，不递归遍历 component tree，也不接管 terminal emulator 的原生 selection。surface owner
把当前 `TUI` 与生命周期 `AbortSignal` 交给 core，获得 owner-scoped `MouseSupport`；页面负责注册当前布局的
`MouseRegion`、边框排除、滚动偏移、cell 到内容位置的转换和 selection state。

core 只负责 SGR tracking、规范化 `down`/`drag`/`up`、重叠 region 的后注册优先、down-region capture
以及幂等 cleanup。没有 region 时不启用 tracking；tracking active 时已识别 mouse input 不进入 focused
component 的 keyboard handler。第一版不定义 hover、click、跨组件 selection 或 clipboard action；
`TextPosition` 是零基 line/grapheme，`TextRange` 是半开区间。完整 contract 见
[鼠标与局部文本选择](../mouse/README.md)。

## Ownership、并发与验证

每个公开 TUI API 的 TypeScript 注释必须说明 owner、consumer、缺席 fallback、cleanup、cancellation 和并发语义。runtime state 以 `pi.events` identity 作用域化，跨重复 core module instance 共享；它不得长期保留 ExtensionContext 或 component。

focused tests 必须覆盖 FIFO、每 host queue capacity、abort before/after dequeue、session shutdown、factory failure、exactly-once close、theme invalidation、router page key override、lazy view retry 与 dynamic page removal。可见改动还必须在 Pi 或 `tui-replay` 验证窄和宽终端；测试不能代替真实 render 验证。
