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
`Component`，不递归遍历 component tree。tracking lease active 期间，surface 暂时拥有 terminal mouse
input，因此 terminal emulator 的 native selection 可能被抑制或改变；不能承诺两种 selection 同时工作。
没有 active region 时恢复 Pi 原生 input 行为。surface owner 把当前 `TUI` 与生命周期 `AbortSignal` 交给 core，
得到 owner-scoped `MouseSupport`；页面负责注册当前布局的 `MouseRegion`、边框排除、滚动偏移、cell 到内容位置的
转换和 selection state。core 在 `SelectableRegion.setSelection()` 后请求 render；普通 region callback 的 state
变化仍由页面自己请求 render。

core 只负责 SGR tracking、规范化 `down`/`drag`/`up`、重叠 region 的后注册优先（`down` 返回 `"ignored"` 时继续下一层）、down-region capture
以及幂等 cleanup。没有 region 时不启用 tracking；tracking active 时已识别 mouse input 不进入 focused
component 的 keyboard handler。region registration 只在 layout snapshot 更新时发生，不得作为 `render(width)` 的
副作用；`pi-tui` 已处理 stdin chunk 分片，core 只解码完整 input sequence。第一版不定义 hover、click、跨组件 selection 或 clipboard action；
`TextPosition` 是零基 line/grapheme，`TextRange` 是半开区间。完整 contract 见
[鼠标与局部文本选择](../mouse/README.md)。

### Runtime Host Bridge

已确认、尚未实现的 Runtime host bridge 留在 `pi-ext-core` 的 opt-in bridge module，不修改 Pi 源码，也不创建
单独的 `pi-select` package。它是唯一可 wrapper Pi private runtime 的位置，使用 Pi `0.83.x` compatibility fence
和完整 shape probe，为当前 Editor 与 HEPI-managed tool output 发布 Host surface identity、lifecycle 与 layout
snapshot。feature 不得获得或 deep-import `InteractiveMode`、container、renderer 或其他 raw Pi private object。

consumer 以自己的 lifecycle signal 获取 Bridge lease；第一个 lease 安装 bridge，最后一个 lease 撤销 capability
并恢复仍由 bridge 持有的 patch。首次 lease 同时发现已经显示和后续出现的 surface。无法安全发现任一类 surface、
probe 不通过、出现未知 wrapper 或 patch 不可恢复时，bridge fail-closed：不启用 host-bound selection、保留 Pi
原行为、每 runtime 只产生一次 native warning。

bridge 不替代本节 Mouse contract。它只为需要 Pi host geometry 的 owner 提供 layout snapshot；owner 继续使用
`MouseSupport`、负责 text mapping、selection state、highlight 与 copy。Managed tool 可在静态 core registration
中声明 optional selection adapter；没有 adapter 时 tool execution 与 renderer 完全不变。完整开发 contract 见
[Pi Runtime Host Bridge](../bridge/README.md)。

## Ownership、并发与验证

每个公开 TUI API 的 TypeScript 注释必须说明 owner、consumer、缺席 fallback、cleanup、cancellation 和并发语义。runtime state 以 `pi.events` identity 作用域化，跨重复 core module instance 共享；它不得长期保留 ExtensionContext 或 component。

focused tests 必须覆盖 FIFO、每 host queue capacity、abort before/after dequeue、session shutdown、factory failure、exactly-once close、theme invalidation、router page key override、lazy view retry 与 dynamic page removal。可见改动还必须在 Pi 或 `tui-replay` 验证窄和宽终端；测试不能代替真实 render 验证。
