# Pi Host Addon

## 状态

`@hheei/pi-ext-addon` 是独立安装的 Pi host addon extension。第一项功能是让 model assistant output 与
thinking block 支持 local mouse selection；未来可以在相同的 host-integration lifecycle 中加入 statusbar addon。
它依赖 `@hheei/pi-ext-core` 的 mouse transport，但不把 assistant、thinking 或 statusbar policy 放进 core。

## 用户可见行为

已安装 addon 且 Pi host bridge 可用时，用户可在已渲染的 assistant text 或 expanded thinking text 上拖选。
selection 用 `selectedBg` 高亮；它是 local selection，不读取 selected text、不自动复制、不访问 clipboard。collapsed
thinking 仍是现有的单行 `thinkingText` label，不建立 selectable region。bridge 不可用、block 不可见或 layout 未知时，
保持 Pi upstream renderer 与 input 行为，不启用 mouse tracking。

遵循 [DESIGN.md](../../DESIGN.md)：assistant 不加背景，thinking 使用 italic `thinkingText`；selection 不改变
padding、wrap、行高或相邻 block 的布局。

## 边界

- `pi-ext-addon` 拥有 builtin assistant renderer adapter、rendered-text selection mapping、selection state、Pi
  lifecycle cleanup 与未来 statusbar addon composition。
- `pi-ext-core` 继续只拥有 SGR mouse transport、capture、`TextRange` 与 feature-neutral cleanup；不拥有
  assistant content、Markdown policy、clipboard 或 statusbar policy。
- Pi host bridge 只发布当前可见 block 的 inner `contentBounds`、layout subscription 与 renderer hook。它不依赖
  HEPI package，也不遍历 chat tree。
- `contentBounds` 已扣除 Pi 的 `outputPad`：`x = outer.x + outputPad`、
  `width = max(0, outer.width - 2 * outputPad)`。addon 不猜测或覆写 padding；hit-test、soft-wrap 与 selection
  均只使用 inner bounds。点击左右 padding 返回 ignored，绝不夹到文本首尾。
- 每个 text/thinking block 各有独立 bounds；assistant 顶部 spacer、block 间 spacer、tool execution 与 collapsed
  thinking label 不属于 selectable content。

## Pi 兼容 bridge

Pi 当前公开 extension API 只支持 custom-message renderer，不能替换 builtin assistant message。HEPI 的
`@earendil-works/pi-coding-agent@0.83.0` Bun patch 因此需要提供一条窄的 builtin assistant renderer hook，附带
Pi-owned `TUI` 与 block layout updates。addon 用该 hook 安装 adapter；未使用 addon 时该 hook 不创建 listener、
selection state 或额外 render work。

adapter 的 normal render 必须保留 Pi 的 Markdown 结果。selection mapping 基于已渲染的可见行，不基于 raw Markdown；
这样 heading、list、code fence、ANSI style 与 soft-wrap 的 cell 坐标保持一致。layout 更新只替换 snapshot，不在
`render(width)` 注册/移除 region；若 down 触发 render，capture 保持到 drag/up 完成。

## 验证

focused tests 覆盖 text 与 thinking、`outputPad=0/1`、左右 padding miss、窄/宽 soft-wrap、block spacer、collapsed
thinking、layout 更新期间 capture 与 bridge 缺席 fallback。host-dependent input 另在真实 Pi PTY 验证；每次 Pi 升级时
复核 Bun patch 的 upstream revision、types 与 component layout。
