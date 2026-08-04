# Pi TUI 鼠标与局部文本选择

## 状态

这是已实现并由 focused tests 与 PTY smoke 验证的 `@hheei/pi-ext-core` contract。它是 core promotion threshold 之外的受限例外，边界记录在 [ADR 0008](../adr/0008-mouse-selection-core-exception.md)。

## 目标

让独立 Pi extension 的 TUI surface 可以 opt in terminal mouse input 与单组件文本拖选，同时保持 upstream `Component` 接口不变。没有 extension 显式安装 support 时，core 不创建 listener、tracking mode、session state 或 render work。

## 所有权边界

- `pi-ext-core` 拥有 SGR mouse tracking 的启停、TUI input listener、单 sequence 协议解码、规范化事件、region dispatch、capture 和 cleanup；它不读取 `process.stdin`。
- surface owner 提供当前的 `TUI`、生命周期 `AbortSignal` 和 owner-scoped install handle；页面负责注册和移除自己的 region。
- 页面负责布局、滚动偏移、边框排除、cell 到内容位置的映射、selection 状态和 selected text。
- core 不修改 upstream `Component`，不递归遍历 component tree，不拥有页面内容、业务 selection policy 或 clipboard。
- tracking lease active 期间，当前 surface 暂时拥有 terminal mouse input；terminal emulator 的 native selection
  可能被抑制或改变，不能承诺两种 selection 同时工作。没有 active region 时恢复 Pi 原生 input 行为。

## Public Contract

实现只从 `@hheei/pi-ext-core` 根入口导出以下类型与函数；consumer 不得 deep-import 内部模块：

```ts
interface TerminalMouseEvent {
  kind: "down" | "drag" | "up";
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

interface MouseRegion {
  hitTest(x: number, y: number): boolean;
  onMouseEvent?(event: TerminalMouseEvent): "ignored" | void;
}

interface SelectableRegion extends MouseRegion {
  hitTestText(x: number, y: number): TextPosition | null;
  setSelection(selection: TextRange | null): void;
}

interface MouseSupport {
  registerRegion(region: MouseRegion): () => void;
  registerSelectableRegion(region: SelectableRegion): () => void;
  dispose(): void;
}

function installMouseSupport(
  tui: TUI,
  options: { readonly signal: AbortSignal },
): MouseSupport;
```

### Tool Row Layout Hook

`@hheei/pi-ext-core` 的 `getToolResultLayout(context)` 是可选 runtime host bridge：它只验证 host 已提供的
`resultLayout` capability，并返回当前 tool result body 的 viewport `{ x, y, width, height }` 及 layout subscription。
它不修改 Pi、遍历 chat tree 或读取 `ToolExecutionComponent` private fields，也不把 vendored patch 变成 published
package dependency。没有 capability（包括干净的 upstream Pi install）时返回 `undefined`；consumer 必须保留 upstream
renderer，且不得注册 mouse region。

HEPI 本地可选的 Pi `TUI` patch 可以在一轮 layout 后发布这个 capability。patch 必须记录 upstream revision 与 MIT
attribution，并由 Pi TUI focused test、tool selection E2E 和 PTY smoke 锁定；它只是 enhancement，不是 extension
运行或发布的前提。

`x/y` 是零基 viewport cell 坐标；`button` 保留 SGR 低两位编码（`0/1/2` 为 primary/middle/secondary，`3` 通常表示 release）。wheel sequence 不产生 core event，也不被 dispatcher 消费；它会透传给 focused component，让页面保有滚动策略。dispatcher 同时请求一次 coalesced render，确保即使后续 listener 消费该 wheel，host 也会发布 scroll/reflow 后的新 layout snapshot；region 的 hit test 必须读取该 live snapshot，不能保留旧的 viewport 坐标。

`onMouseEvent()` 返回 `"ignored"` 只对 `down` 有 fallback 语义：dispatcher 继续尝试更早注册的匹配 region；省略返回值会建立 capture。`drag/up` 始终留在 down-region，不因 callback 返回值重新命中。普通 region 的 callback 自己负责 `tui.requestRender()`；core 在每次 `setSelection()` 后请求一次 render。

`TextPosition` 是单一 selection content model 内的零基 `{ line, grapheme }`；`TextRange` 是半开 `[start, end)` 区间。terminal event 的 `x/y` 是当前 viewport 的零基 terminal cell 坐标，不是内容位置。

## 输入与 dispatch 语义

- 同一个 `TUI` 共用一个内部 dispatcher；每个 install handle 只拥有自己注册的 region，dispose 幂等。
- 第一个 region 注册时启用 SGR button-motion tracking；最后一个 region 移除时关闭。没有 active region 时不保留 tracking。
- tracking active 期间，已识别的 `down`/`drag`/`up` mouse sequence 都由 dispatcher 消费；未命中的事件不会进入 focused component 的 keyboard `handleInput()`。wheel sequence 例外地透传给 focused component；未识别的普通输入也保持原样。
- 区域重叠时，后注册者优先；`down` 命中的 region 若从 `onMouseEvent()` 返回 `"ignored"`，继续尝试更早注册的匹配 region，其他返回值都在当前 region 停止。region 不要求来自可遍历的 component tree。
- region registration 是 layout snapshot 的更新操作，只在 layout、resize、scroll 或可见性改变时进行；不得在
  `render(width)` 中注册或移除 region。hit test 读取当前 snapshot，不写 registry。
- `registerSelectableRegion()` 使用 region 的 `hitTest()` 选择目标，并用 `hitTestText()` 把
  terminal cell 转成内容位置；普通左键 gesture 驱动 `setSelection()` 并请求重绘。其他按钮和 modifier
  仍只交给 region 的可选 `onMouseEvent()`。
- `down` 命中的 region 捕获同一次手势的 `drag/up`。指针离开该 region 后不改派给其他 region；页面保留最后一个有效的 text position，`up` 只结束 capture。
- 第一版只定义 `down`、`drag`、`up`，不定义 hover `move` 或派生 `click`。默认 selectable gesture 只响应无修饰左键；其他按钮与 modifier 仍交给自定义 region。
- `pi-tui` 的 `StdinBuffer` 已在 TUI input boundary 处理 stdin chunk 分片；core decoder 只接收一个完整
  input sequence，不创建第二个 buffer、不设置第二个 flush timeout，也不向 consumer 承诺 raw parser 语义。
- 普通键盘 input 走无分配的快速非 mouse 路径；mouse dispatch 对 active regions 倒序扫描，在处理或明确接受后停止，`down` 的 `"ignored"` 才继续向下一层尝试。
  core 不在每个 mouse event 上写 terminal、创建 Promise 或执行 I/O。

## Selection 与 clipboard

v1 core 只驱动 `setSelection()`；不在 `up` 自动读取 selection、不写 OSC 52，也不访问系统 clipboard。页面的
`TextRange` 高亮不是 terminal emulator 的 native selection，`Command+C` / `Ctrl+C` 不能复制它。需要复制时，用户必须
使用其 emulator 的 mouse-reporting bypass 修饰键拖出 native terminal selection，再使用该 emulator 的复制快捷键；bypass
修饰键和复制快捷键均因 emulator 配置而异。这个原生选择流程与页面 local selection 无关，extension 不承诺或模拟它。

## 实现注释约定

实现 mouse/selection 时，设计理由必须与对应代码同步写入 TypeScript 注释，不在实现完成后另行补一份脱离代码的说明。注释解释 **why**、不变量、违反后的后果和成本，不逐行复述 **what**：

- `installMouseSupport()` 与公开类型：说明 surface owner、consumer、缺席 fallback、`AbortSignal`、dispose 和重复安装语义。
- TUI input boundary：说明为什么使用 `TUI.addInputListener()`、依赖 `StdinBuffer` 的完整 sequence，以及为什么不能读取 `process.stdin` 或建立第二个 buffer。
- tracking lease：说明 terminal mouse ownership、native selection 可能受影响、reference count 和 cleanup 顺序。
- dispatch/capture：说明后注册优先、down-region capture、指针离开后的不改派和 stale disposer 防护。
- region snapshot：说明为什么 registry 只能在 layout/resize/scroll/visibility 更新时改变，`render(width)` 必须保持无副作用。
- 高频路径：说明普通 input 的快速路径、region 扫描成本，以及为什么事件处理中禁止 terminal write、Promise 和 I/O。

设计取舍、ownership 或性能边界改变时，必须在同一变更中更新邻近注释、本文件和 focused tests；过期注释视为实现缺陷。

## 缺席、取消与验证

未安装 support 时沿用 Pi 原生 input 行为；没有 region 时不启用 tracking。`AbortSignal`、owner disposer、surface close、Pi session shutdown 和 reload 都必须到达同一幂等 cleanup 路径。
若 abort 时 terminal disable write 失败，core 会先 detach owner/listener，但保留 pending reset；后续 `dispose()` 或新的 install 会先重试 reset，成功前不会重新 enable tracking。

focused tests 放在 `packages/pi-ext-core/test/`，覆盖完整 SGR sequence、普通 input passthrough、tracking reference count、owner isolation、overlap order、capture、abort、shutdown 和 stale disposer。Pi input boundary 的 fragmented stdin 另用真实 host/PTY 验证。可见 TUI 行为另用 `tui-replay` 在窄和宽 terminal 验证；现有 debug replay 只作测试 fixture，不是产品 consumer。
