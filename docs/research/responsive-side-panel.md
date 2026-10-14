# 响应式右侧状态面板调研（Pi 1.2.0 / pi-tui 1.2.0）

> 取证时间：2026-10-13（`date -I`）。
> 调研范围：评估"宽终端右侧面板 + 窄终端紧凑摘要"的可行边界与所有权划分。下文记录当时的证据与方案，不构成当前实现规格。
> 后续决策：用户放弃侧栏、host 补丁与定制 host 分发；实际方案采用原生 status line 合并运行中的 agent 编号和 TODO，已确认的终态报告使用一次性 info entry。当前契约见 [子代理架构](../architecture/pi-subagents.md) 与 [DESIGN.md](../../DESIGN.md)。
> 证据：全部来自已安装的 1.2.0 制品，未使用 1.1 文档推断。

### 取证方式与路径约定

两个包只发布 `dist/*.js` + `.d.ts` + source map，**磁盘上没有 `src/*.ts`**。本文行号取自 source map 的 `sourcesContent`（原始 TS 源码文本），虚拟路径记为 `src/...`，真实文件如下：

| 简称 | 真实路径 |
| --- | --- |
| `PI-TUI` | `packages/pi-ext-ui/node_modules/@earendil-works/pi-tui/`（本次解析到 1.2.0） |
| `PI` | `packages/pi-ext-ui/node_modules/@earendil-works/pi-coding-agent/`（本次解析到 1.2.0） |

对应关系：`PI-TUI/src/tui.ts:N` = `PI-TUI/dist/tui.js.map` 的 `sourcesContent`（源名 `../src/tui.ts`）第 N 行；`PI/src/modes/interactive/interactive-mode.ts:N` = `PI/dist/modes/interactive/interactive-mode.js.map` 的 `sourcesContent` 第 N 行。类型契约可直接读 `dist/*.d.ts`（例如 `PI-TUI/dist/tui.d.ts:249` 的 `ViewportTUI`）。本地仓库引用为普通文件路径。

可直接查看的入口：[Pi UI 文档](../../packages/pi-ext-ui/node_modules/@earendil-works/pi-coding-agent/docs/tui.md)、[Pi 扩展文档](../../packages/pi-ext-ui/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md)、[pi-tui 类型](../../packages/pi-ext-ui/node_modules/@earendil-works/pi-tui/dist/tui.d.ts)、[全屏渲染器](../../packages/pi-ext-ui/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js)。

---

## 0. 结论摘要

**【事实】**

1. **Pi host 的高层扩展 UI 契约没有侧栏插槽。** `ctx.ui.setWidget` 只支持 editor 上下的整宽区域；`ctx.ui.custom({ overlay: true })` / `TUI.showOverlay()` 支持浮层，但不改变底层宽度。低层 `setLayoutRoot` 能替换布局，接入现有 host 布局的限制见第 7 条与 §5。
2. **overlay 是覆盖，不是分栏。** 主内容仍按全终端宽度渲染，overlay 只把行拼接上去（`PI-TUI/src/tui.ts:1350` `compositeOverlays`；全屏调用点 `PI-TUI/src/tui-alt-screen.ts:1692`）。面板会盖住正文，而不是让正文变窄。
3. **靠右的 overlay 可能覆盖原生 scrollbar / ToolView copy 车道**（推导见 §3）：scrollbar 画在 ScrollView 盒子最后一列（`PI-TUI/src/layout.ts:296`），`paintScrollbar` 在所有子盒之后执行（`:376`）；`auto` 模式内容不缩宽（`PI-TUI/src/components/scroll-view.ts:93-95`）。
4. **只要存在可见 overlay，全屏 scrollbar 的 hover 与"新的命中/起拖"就失效**：`PI-TUI/src/tui-alt-screen.ts:1045` `if (this.hasOverlay() || !this.currentLayout) return undefined;`（该判断在 `getScrollbarTargetAt` 入口）。**例外**：已经开始的拖拽不会被中断——`handleScrollbarMouseEvent`（`:1088-1107`）在调用 `getScrollbarTargetAt` 之前先处理 `this.scrollbarDrag`，直接用 `getScrollViewBox` + `getScrollbarGeometry`（不检查 overlay）继续滚动。
5. **存在任何 overlay 条目（含 `nonCapturing`、`setHidden(true)`）都会阻止 Pi 切换 TUI 模式**：`PI-TUI/src/tui.ts:538-540` 只看 `overlayStack.length`；宿主 `PI/src/modes/interactive/interactive-mode.ts:893` 直接返回 false，用户在 `:5120-5123` 看到 "Close active overlays before changing TUI mode"。
6. **regular（main screen）模式不适合常驻面板**：没有组件级鼠标分发、没有 layout/scrollbar；overlay 只做视觉合成（`PI-TUI/src/tui-main-screen.ts:267-269`），且 overlay 会把渲染行填充到终端高度（`PI-TUI/src/tui.ts:1398`），在 main screen 会推挤 scrollback 工作区。
7. **低层布局能力是公开的**（`HStack`/`VStack`/`ScrollView`，以及 `ViewportTUI.setLayoutRoot`，`PI-TUI/src/tui.ts:497-503`），**但 Pi host 没有暴露"取得或包裹当前布局根"的稳定扩展契约**：host 自己挂 root（`interactive-mode.ts:873-877`），切模式时先 `setLayoutRoot(undefined)`（`:908`）再重建重挂（`:926`）。`setLayoutRoot` 只存在于 `TuiAltScreen`，`TuiMainScreen` 没有。
8. **隐藏 subagents widget 无法把 dock 降到 0 行**：widget 为空时仍放 1 个 `Spacer(1)`（`interactive-mode.ts:2498-2520`），非空时再加前导 `Spacer(1)`。

**【提案，未与用户确认】**

- **P1（推荐方向）真列 = 宿主布局集成**：`HStack[transcript ScrollView, gap, 状态面板]`，位于现有整宽 dock 之上，editor/footer 保持整宽。它保留原生 scrollbar 与 copy 车道的几何一致性，是本次推荐的长期维护方向；代价是**需要 Pi host 提供接入点**（§5）。
- **P2 overlay 只作临时/演示路径**，不是默认方案：它带一组硬限制（§2、§3、§0-3/4/5）。若用于验证交互与内容密度可以，但不能据此认为功能完成。
- **P3 若上游接入点短期不可得**：先只做窄屏单行摘要 widget，宽屏继续用现有 `/subagents` 页面看详细内容——不引入半成品浮层。
- **P4 内容克制**：面板只展示既有字段（id、名称/title、状态、当前工具、必要错误文本），**不新增 usage 计数、不新增设置项、不新增控制键**；窄屏摘要行数（如 `3 running · 1 blocked`）是**建议**而非已确认契约。禁止把现有详细 widget 的行内容原样搬进窄列做换行卡片。

---

## 1. 事实：三种扩展 UI 通道的几何差异

| 通道 | 几何 | 约束 | 能否做面板 |
| --- | --- | --- | --- |
| `ctx.ui.setWidget(key, content, { placement })` | `aboveEditor` / `belowEditor`，**整宽**，位于固定 dock | `string[]` 被 `MAX_WIDGET_LINES = 10` 截断（`interactive-mode.ts:2486`）；**组件工厂不受该上限约束** | 只能做窄屏摘要 |
| `ctx.ui.custom(factory)`（非 overlay） | 替换 `editorContainer` 内容并抢焦点（`interactive-mode.ts:3030-3034`） | 独占编辑区 | 否 |
| `ctx.ui.custom(factory, { overlay: true, overlayOptions, onHandle })` | 浮层：`anchor/width/minWidth/maxHeight/margin/visible` | 不改变底层宽度 | 仅临时/演示 |
| `tui.showOverlay(component, options)`（直接调用） | 同 overlay | 不在宿主生命周期追踪内（`resetExtensionUI` 只 `hideOverlay()` 一次，`interactive-mode.ts:2462`） | 不建议 |

契约位置：`PI/src/core/extensions/types.ts:121-128`（`WidgetPlacement`）、`:187-193`（`setWidget`）、`:220-227`（`custom` 的 `overlay`/`overlayOptions`/`onHandle`）。文档：`PI/docs/tui.md`（overlays、mouse、focus）、`PI/docs/extensions.md`（UI and modes：RPC 仅转发受支持对话框，JSON/print 无 UI）。

宿主实现（`interactive-mode.ts:2966-3043`）只是 `this.ui.showOverlay(component, resolveOptions())` 并把 handle 交给 `onHandle`。

---

## 2. 事实：overlay 几何与交互优先级

### 2.1 尺寸与定位

`OverlayOptions`（`PI-TUI/src/tui.ts:254-291`）：`width`、`minWidth`、`maxHeight`、`anchor`（9 种，含 `right-center`）、`offsetX/offsetY`、`row/col`、`margin`、`visible(termWidth, termHeight)`、`nonCapturing`。

`resolveOverlayLayout`（`PI-TUI/src/tui.ts:1200-1300` 区段）：

- `availWidth = max(1, termWidth - marginLeft - marginRight)`；`width = clamp(max(width ?? min(80, availWidth), minWidth), 1, availWidth)`。
- `col` 夹到 `[marginLeft, termWidth - marginRight - width]`。
- `margin: { right: 1 }` ⇒ 占用列 `[termWidth-1-width, termWidth-2]`，仅第 `termWidth-1` 列露出。
- `visible` **每次渲染周期**都用当前终端尺寸求值（`isOverlayVisible`，`PI-TUI/src/tui.ts:902-910`），所以宽度阈值是框架原生能力。
- `overlayOptions` 的函数形式只在 overlay 创建时求值一次（`interactive-mode.ts:3014-3026` `resolveOptions()` 只被调用一次）。每帧变化的是 `visible` 与几何解析，**不是**那个函数包装。

### 2.2 合成顺序

```
renderLayoutFrame(root) → paintBox 子盒 → paintScrollbar（最后一列）
   → compositeOverlays(screen, w, h)   // 覆盖其上
   → applySelection(screen, nextLayout) // 选区按 layout 几何，不知道 overlay
```

（`PI-TUI/src/tui-alt-screen.ts:1684-1692`；overlay 内部实现 `PI-TUI/src/tui.ts:1350-1442`，`:1398` 为高度填充，`:1442` 为按列拼接。）

### 2.3 鼠标与滚轮优先级

- 点击：`tui-alt-screen.ts:937-947` —— 先 `dispatchMouseToOverlay`；未命中才走 scroll-to-end 指示器、scrollbar、layout。
- 滚轮：`tui-alt-screen.ts:712-719` —— 同样先给 overlay；未处理才 `routeWheel`，而 `routeWheel` 用 `getScrollViewsAt(currentLayout, x, y)`，**overlay 不在 layout 中**，因此面板区域的滚轮会落到面板底下的 transcript。
- **被动 overlay 的穿透**：命中 overlay 但组件未返回结果时，事件继续走到 `handleSelectionMouseEvent`（`:947` 之后），按 layout 几何选中面板**底下不可见**的正文。
- **直接放入 overlay 的 `ScrollView` 不会自动获得滚动视口**：它依赖 layout 节点（`scroll-view.ts:221` `[LAYOUT_NODE]()`）与 `updateLayout`（`PI-TUI/src/layout.ts:126-150`），而默认 overlay 路径只调用 `component.render(width)`（`PI-TUI/src/tui.ts:1373`）。该路径不会分配视口高度、绘制原生 scrollbar 或自动路由内部滚动；若浮层需要内部滚动，必须另外承担布局和鼠标路由。
- `Component.handleMouse` 收到的是派发方给的盒宽（`PI-TUI/src/tui.ts:96-113`；layout 派发用 `box.rect.width`）。

### 2.4 焦点、光标、resize

- `nonCapturing: true` 不抢焦点（`PI-TUI/src/tui.ts:729-746`）；被聚焦的 overlay 跨普通渲染保持输入所有权（`PI/docs/tui.md`）。
- `showOverlay` 期间 TUI 调用 `hideTerminalCursor()`（`PI-TUI/src/tui.ts:576/742/845`）只是瞬时的——每次渲染结尾都会按 `cursorPos` 与 `getShowHardwareCursor()` 重新决定：`PI-TUI/src/tui-alt-screen.ts:1772-1776`（对应 `dist/tui-alt-screen.js:1535-1541`）在找到光标标记时写 `\x1b[?25h`/`\x1b[?25l`，找不到则统一隐藏。所以**不存在"面板导致硬件光标永久隐藏"**。
- 但合成顺序意味着另一种碰撞：`compositeOverlays`（`tui-alt-screen.ts:1692`）先于 `extractCursorPosition`（`:1697`）执行，面板若覆盖 editor 光标所在列/行，可以抹掉 `CURSOR_MARKER`，使该帧落入 `cursorPos === undefined` 分支而隐藏光标。这属于**面板与 editor 的几何重叠风险**，与 IME 假光标无关，也没有"浮层对光标有利"的正向结论。
- resize：每帧重新 `renderLayoutFrame` 与解析 overlay 布局（`tui-alt-screen.ts:1684`），位置/尺寸自然跟随；面板若缓存渲染结果必须按宽度失效（`PI/docs/tui.md` "Keep rendering responsive"）。

---

## 3. 事实：scrollbar 几何与 ToolView copy 车道

### 3.1 上游几何

- `ScrollView.getContentWidth`：**仅 `always` 时 `width - 1`**（`scroll-view.ts:93-95`）；`render()` 缩宽时给每行补一个空格（`:215-219`）。`auto` 内容保持全宽，scrollbar 覆盖最后一列。
- `getScrollbarGeometry`（`layout.ts:280-306`）：`column = box.rect.x + box.rect.width - 1`（`:296`）；`trackTop/Height = box.rect`；thumb 高 `max(min(2, trackHeight), round(trackHeight²/contentHeight))`（`:290-292`）。
- `paintScrollbar` 在 `paintBox` 末尾（`:309-330`、调用点 `:376`）。
- 命中：`x === geometry.column` 且 y 在轨道内（`tui-alt-screen.ts:1044-1060`），入口被 `hasOverlay()` 短路（`:1045`）；但已进行中的拖拽走 `handleScrollbarMouseEvent` 的前置分支（`:1088-1107`），不受 overlay 影响。

### 3.2 与 ToolView copy 图标的实际关系

本地 `packages/pi-ext-ui/src/tool-view.ts`：

- `#renderHeader`（`:350-371`）为全屏 scrollbar 预留 `rightMargin = 1`（`:363-364`）：行宽 = `safeWidth`，**copy 图标占列 `safeWidth-2`，预留列 `safeWidth-1`**。
- `handleMouse`（`:471-504`）：`innerWidth = max(1, event.width - pad*2)`，`pad = outputPad`；命中条件 `innerX >= innerWidth - 3 && innerX < innerWidth`（`:492-498`，上界是 `< innerWidth`）。即工具内部坐标的 `[innerWidth-3, innerWidth)`，包含图标与右侧预留空格；换算到父组件坐标需加上 `pad`。

overlay（`margin.right = 1`、宽 `P`）覆盖列 `[W-1-P, W-2]`，其中 `W` 为终端宽。以下仅以 `outputPad = 0` 且工具占满正文宽度举例；实际 padding 会把图标向左移动，因此不能直接把表中全局列号用作热点坐标：

| scrollbar | `safeWidth` | 图标列 | 预留列 | overlay 覆盖 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `always` | `W-1` | `W-3` | `W-2` | `[W-1-P, W-2]` | `P=1` 覆盖预留列；`P≥2` 覆盖图标列 |
| `auto` | `W` | `W-2` | `W-1` | `[W-1-P, W-2]` | `P≥1` 即覆盖图标列 |
| `hidden` | `W` | `W-2` | `W-1` | `[W-1-P, W-2]` | `P≥1` 即覆盖图标列 |

结论：**"只留 1 列"只能保住最后一列（`always` 时的 scrollbar 列），保不住 copy 车道**；面板越宽覆盖越多。`getFullscreenScrollbar()` 由设置决定并作用于 `createChatViewport`（`interactive-mode.ts:1366`、`:2438-2439`），所以不存在一个与设置无关的"安全 margin"。真列方案下主列 `safeWidth` 随分栏左移，图标与热点随 layout 宽度一起移动（`event.width` 来自 `box.rect.width`），才可能彻底避开。

**鼠标层面**：面板矩形内的事件先被 overlay 消费（`:937`）；若面板不实现 `handleMouse`，事件不会"误触发 copy"，而是继续落到选区逻辑。所以 copy 的冲突是**视觉与可达性**问题，不是误触发问题。

regular 模式没有组件级鼠标分发（`tui-main-screen.ts` 无 `handleMouse`/`dispatchMouse` 命中），上述约束只在 fullscreen 有意义。

---

## 4. 事实：regular 与 fullscreen 差异

| 维度 | regular（`TuiMainScreen`） | fullscreen（`TuiAltScreen`） |
| --- | --- | --- |
| 布局根 | 无 `setLayoutRoot`；`children` 垂直堆叠 | `ViewportTUI.setLayoutRoot`（`tui-alt-screen.ts:327-341`），host 挂 chat-viewport root |
| ScrollView / scrollbar | 无（滚动交给终端 scrollback） | transcript `ScrollView{primary, follow:end, overscroll:chain}`（`chat-viewport.ts:20-30`） |
| 鼠标 | 终端拥有 | overlay → 指示器 → scrollbar → layout |
| overlay | 仅视觉合成（`tui-main-screen.ts:267-269`）+ 高度填充（`tui.ts:1398`） | 视觉合成 + 鼠标参与 |
| 常驻面板 | 当前没有与 fullscreen 等价的稳定分栏接入契约；建议摘要 widget | 浮层可行（有限制）；真列需宿主集成 |

dock 结构（`chat-viewport.ts:31-43`）：`VStack[pendingMessages, status, widgetsAbove, editor(minSize 3), widgetsBelow, footer]`；root = `VStack[transcript(grow, minSize 1), dock(basis auto)]`。

---

## 5. 事实：真列的可用边界

- **公开能力存在**：`ViewportTUI`/`isViewportTUI`（`PI-TUI/src/tui.ts:497-503`，亦见 `PI-TUI/tui.d.ts`）、`TuiAltScreen.setLayoutRoot`（`tui-alt-screen.ts:327-341`）、`HStack`/`VStack`/`ScrollView`（`PI-TUI/src/index.ts:33-70`）、`StackEntryOptions{basis,grow,shrink,minSize,maxSize,visible}`（`stack.ts:5-12`）。
- **没有"取得当前根"的 API**：`ViewportTUI` 只有 `setLayoutRoot`（`tui.ts:497-500`）；`getMountedRoots()` 是 `protected`（`tui-alt-screen.ts:338-340`）。
- **host 拥有根**：`fullscreenLayoutRoot = viewport.root`（`interactive-mode.ts:969-971`），`mountInteractiveTui` 中 `setLayoutRoot`（`:873-879`）；切模式时 `setLayoutRoot(undefined)`（`:908`）→ 重建 renderer（`:910-926`）→ 重挂 host root。扩展替换 root 会在下次模式切换时被丢弃。
- **扩展只能拿到 `tui` 对象**（`custom` 工厂参数、`setWidget`/`setFooter`/`setHeader` 工厂参数；工厂收到的 `tui` 引用由 `createInteractiveTuiReference` 的 Proxy 提供，转发到当前 renderer，`PI/src/modes/interactive/tui-renderer.ts`）。要重建 host 的 chat viewport 只能依赖 `tui.children` 的顺序与角色推断，而 fullscreen 下 `children` 并不参与渲染（`getMountedRoots` 只返回 `layoutRoot`）。
- **结论**：真列需要 **Pi host 提供接入点**（或明确接受脆弱的私有 root 替换）。正确表述是"公开低层布局能力存在，但缺少把扩展面板接入 Pi 现有根、并跨 renderer 重挂载存活的稳定契约"。

---

## 6. 事实：本仓库现状

- **subagents widget**（唯一生产 widget 调用方）：`MAX_ROWS = 8`（`packages/pi-subagents/src/widget.ts:13`），`renderSubagentWidget`（`:57`）输出 标题 1 行 + ≤8 行 + 可选 `+N more` + 末尾空行 ≈ 10–11 行；`createSubagentWidget`（`:118`）走 `registerWidget` 的 `aboveEditor`；1s tick、终态 15s 淡出并冻结 elapsed（`:14-16`、`:118-185`）；装配点 `packages/pi-subagents/src/extension.ts:355-370`。
- **host dock 基线**：widget 为空仍保留 1 行 `Spacer(1)`，非空再加前导 `Spacer(1)`（`interactive-mode.ts:2498-2520`）。
- **ext-core widgets**：`registerWidget`（`packages/pi-ext-core/src/widgets.ts:115`）统一持有 Pi `setWidget` 工厂，带 `AbortSignal` 清理与 `dispose`；`suspendWidgets`（`:170`）为 Settings 提供引用计数挂起；贡献方不直接调用 Pi `setWidget`。
- **ext-core custom surface**：`openTuiSurface`（`packages/pi-ext-core/src/custom-surface.ts:108`）是 runtime 级 FIFO 焦点槽，**直到 `ui.custom()` 的 promise settle 才释放**；常驻面板走这里会长期占槽，阻塞 `/settings` 等。
- **ext-core service**：`createServiceKey`/`provideService`/`getService`（`packages/pi-ext-core/src/service.ts:30/58/75`）为可选、带类型的跨扩展协作通道，`pi-ext-core` 不导入具体 UI 扩展。
- **既有展示基础**：ext-ui 的 copy 车道（§3.2）；`packages/pi-ext-core/src/panel-scrollbar.ts:11` `panelScrollbar()`（每行一个轨道字符 + 实心 thumb），其 thumb 公式与 native scrollbar（`layout.ts:290-296`）**不完全相同**——视觉一致性**未验证**。
- **RPC 模式**：`hasUI` 为真但 `custom` 组件不可用（`PI/docs/extensions.md` "UI and modes"）；任何面板方案都需要非 TUI 退化路径。

---

## 7. 【提案】所有权与几何方案（待用户确认）

**所有权**

1. 面板渲染/几何/阈值策略归 `pi-ext-ui`（已有 tool-view 的列/热点与宽度失效经验）。`panelScrollbar` 是 **ext-core 的通用工具**（`packages/pi-ext-core/src/panel-scrollbar.ts:11`），不归 `pi-ext-ui` 所有，需要时按既有方式复用。
2. 生命周期与参与契约归 `pi-ext-core`：沿用 `registerWidget`（AbortSignal + dispose + Settings 挂起）作窄屏摘要通道；沿用 service key 作可选参与通道；**本阶段不新增 API、不改 `DESIGN.md`**。
3. `pi-subagents` 通过 service key 暴露**只读**状态快照；`pi-ext-ui` 取不到即退化，不报错；`pi-ext-core` 不感知具体扩展。
4. 面板默认被动：不抢焦点、不注册热键；详细交互留在 `/subagents`；不做持久化，`session_shutdown` 幂等清理。

**几何**

- **推荐**：真列 `HStack[transcript ScrollView, gap, 面板]`，位于现有整宽 dock 之上（editor/footer 保持整宽）。相比"包住整个 Pi root"，它不会同时压缩编辑区与 footer。

```text
┌──────────────────────────────────────┬──────────────┐
│ 正文 / 工具        copy │ scrollbar  │ 状态 panel   │
│ transcript ScrollView               │ 既有状态投影 │
├──────────────────────────────────────┴──────────────┤
│ 窄屏摘要（仅窄屏时） / editor / footer：保持整宽     │
└─────────────────────────────────────────────────────┘
```

图中框线仅表示区域边界，不要求实际 UI 绘制边框。
- **过渡**：若必须先用 overlay 验证，`anchor: "right-center"` + `margin: { right: 1 }` + `visible` 阈值，并显式接受 §2/§3 的限制；不要把它当默认交付形态。
- **阈值示意（示例，非约定常量）**：`threshold = mainMin + gap + panelWidth`，例如 `80 + 1 + 32 = 113`；真实取值需与最小可用主列宽、copy 车道、scrollbar 设置一起定，且**高度维度（fullscreen/regular、dock 已占行数）应独立评估**。
- **窄屏摘要**：单行 widget（如 `Agents 3 · 1 blocked`），走既有 `registerWidget(aboveEditor)`；宽屏启用面板时由 subagents 侧关闭详细 widget（10–11 行 → 0 行，但 host 仍留 1 行 Spacer）。摘要计数由既有状态派生，**不新增 usage 指标**。
- **溢出优先级（提案）**：blocked/error > running > 最近终态；只展示既有字段（id、名称/title、状态、当前工具、必要错误），不做 usage 计数、不做换行卡片。

---

## 8. 显式不确定项

1. **上游是否愿意提供 sidebar/slot 契约**：1.2.0 文档与类型中未发现此类 API；这是能力缺口判断，不等于上游拒绝。
2. **`children` 顺序/角色是否稳定**：无文档承诺；依赖它属脆弱实现。
3. **浮层与原生 scrollbar 的最终取舍**（视觉覆盖 vs 真列）是产品决策。
4. **面板期间 scrollbar 新命中失效、模式切换被阻断**是否可接受（宿主当前是硬失败：`:893` + `:5120-5123`）。
5. **光标行为**：光标由 renderer 每帧决定（`tui-alt-screen.ts:1772-1776`），不是持久隐藏；但面板覆盖 editor 光标位置时的 marker 抹除风险（`compositeOverlays` 早于 `extractCursorPosition`）**未实测**。
6. **RPC/print 退化路径**未设计。
7. **`panelScrollbar` 与 native scrollbar 视觉一致性**未验证。
8. **resize 下的重复渲染/闪烁**（每帧重解析 + 面板缓存）未实测。

---

## 9. 建议的后续验证

- **resize**：跨越阈值宽度（含 §7 示例边界两侧）往返后面板/摘要的行数与内容一致性。
- **copy 热点**：三种 scrollbar 设置下点击图标与相邻列；真列方案确认 `event.width` 与渲染宽度同源。
- **scrollbar 交互**：overlay 存在时确认"新的 hover/起拖"不可用（`tui-alt-screen.ts:1045`）、以及"拖拽中途出现 overlay 仍继续滚动"（`:1088-1107`）是否符合预期。
- **模式切换**：面板存在时 fullscreen/regular 切换的用户可见行为（`:5120-5123`）与重挂载后的恢复/丢失。
- 断言公共行为（渲染行数、热点命中、可见性切换、清理幂等），不写"内部属性不存在"式负面断言；热点测试写法可参考 `packages/pi-ext-ui/test/collapsible-tool-frame.test.ts:257-273`。

---

## 10. 引用索引

**`PI-TUI`（`@earendil-works/pi-tui@1.2.0`，行号来自对应 `dist/*.js.map` 的 `sourcesContent`）**

- `src/tui.ts`: 96-113 鼠标派发/重定位；212-291 `OverlayAnchor`/`OverlayOptions`；307-322 `OverlayHandle`；464-494 `TUI` 接口；497-503 `ViewportTUI`/`isViewportTUI`；535-541 `overlayStack`/`hasOverlayEntries`；729-841 `showOverlay` 与焦点恢复；862-900 overlay 命中/焦点目标；902-910 `isOverlayVisible`；1200-1300 `resolveOverlayLayout`；1350-1442 `compositeOverlays`。
- `src/tui-alt-screen.ts`: 202-210 类声明；327-341 `setLayoutRoot`/`getMountedRoots`；712-719 滚轮优先级；937-947 点击优先级；1044-1060 scrollbar 命中（`dist/tui-alt-screen.js:847-849` 同样可见 `hasOverlay()` 短路）；1684-1697 渲染管线与光标提取；1772-1776 光标写入（`dist/tui-alt-screen.js:1535-1541`）；1784 `currentLayout`。
- `src/tui-main-screen.ts`: 267-269 overlay 合成；354-357 overlay 与 clearOnShrink。
- `src/layout.ts`: 126-150 scroll 节点 `updateLayout`；280-306 `getScrollbarGeometry`；309-330 `paintScrollbar`；376 绘制顺序。
- `src/components/scroll-view.ts`: 74-79、93-95、215-222。
- `src/components/stack.ts`: 5-12；`src/components/h-stack.ts` `HStack` 渲染；`src/index.ts`: 33-70、158-175。

**`PI`（`@earendil-works/pi-coding-agent@1.2.0`）**

- `docs/extensions.md`（UI and modes、Tool rendering）、`docs/tui.md`（overlays、mouse、focus、rendering）。
- `examples/extensions/overlay-qa-tests.ts`: 227-243 响应式侧栏；941-967 `tui.showOverlay(nonCapturing, top-right, width 22)`；`examples/extensions/widget-placement.ts`。
- `src/core/extensions/types.ts`: 121-128、187-193、205-208、220-227。
- `src/modes/interactive/interactive-mode.ts`: 569-573；873-879；890-908；969-974；1366-1368；2398-2440；2462；2486；2491-2520；2966-3043；5120-5123。
- `src/modes/interactive/chat-viewport.ts`: 20-43；`src/modes/interactive/tui-renderer.ts`。

**本仓库**

- `packages/pi-subagents/src/widget.ts`: 13-16、57-116、118-185；`src/extension.ts`: 355-370。
- `packages/pi-ext-core/src/widgets.ts`: 115-183；`custom-surface.ts`: 108-280；`service.ts`: 30-95；`panel-scrollbar.ts`: 11-25。
- `packages/pi-ext-ui/src/tool-view.ts`: 350-371、453-468、471-504；`test/collapsible-tool-frame.test.ts`: 257-273。
