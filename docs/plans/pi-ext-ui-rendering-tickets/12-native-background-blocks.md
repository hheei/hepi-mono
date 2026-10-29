# 12：collapse views 原生背景块与展开层级 seam

**状态：** 组外壳、组级上下 rail 与展开分层已实现（见 §7）；工具与 thinking 不填自身背景（§3.2 的 ToolView 背景方案已否决）。
**依赖：** 背景调查不依赖 00；最终布局须与 04、05 对齐，真实验收归入 08。
**关联：** [当前 Spec](../../architecture/pi-ext-ui-tool-groups.md)、[DESIGN](../../../DESIGN.md)、[05](05-raw-layout.md)、[06](06-semantic-colors.md)。

## 1. 用户已明确的目标

- 收起的整个 collapse views 使用 Pi 原生风格的背景块；背景覆盖 header、分类摘要和组内 footer，并在 header 下、footer 上各一条 `borderMuted` 组级横向 rail 框住正文。
- 整组展开后，不给整个 collapse view 填背景，也不画组级 rail。
- 工具与 thinking run 不填自身背景；notice 保留 `MessageView` 自己的 `customMessageBg`。不能把“父级透明”实现成递归清除所有子组件背景。
- 本次只记录 seam，不修改运行代码，不以文档记录表示已通过视觉验收。

该目标取代旧文档与 05 中“组始终保留两条横向 rail”的外壳约定；不顺带删除工具自身的 `▎` 导轨、请求/结果分隔或改变计数、footer 归属、尾部迁移。00 中的归属问题仍单独待定。

## 2. 已检查的原生实现

本仓库 pi-ext-ui 的开发依赖为 Pi host/pi-tui **1.3.0**；同时核对本机已安装 Pi host **1.4.0**，以下背景与 shell seam 一致。引用路径通过 `packages/pi-ext-ui/node_modules/` 可直接检查，不依赖机器全局路径。

| 原生位置 | 实际行为 | 对本任务的意义 |
| --- | --- | --- |
| `packages/pi-ext-ui/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js`，constructor、getRenderShell、updateDisplay（约 46–55、71–72、199–212 行） | 默认 shell 创建 `Box(1, 1, bgFn)`；partial 使用 `toolPendingBg`，真实错误使用 `toolErrorBg`，其余使用 `toolSuccessBg`；`renderShell: "self"` 改走普通 Container | 原生背景有公开组合原语；不需要修改 host，也不能指望 self shell 自动补背景 |
| `packages/pi-ext-ui/node_modules/@earendil-works/pi-tui/dist/components/box.js`，render、applyBg、handleMouse、setBgFn | Box 渲染子组件、按可见列数填满整行、应用背景，负责 padding 与鼠标坐标转换；缓存比较 width、子行和背景采样 | 直接复用 Box；不要手写 ANSI 宽度填充、背景 wrapper 基础设施或额外刷新 timer |
| `packages/pi-ext-ui/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js`，rebuild | 默认 custom message 使用 `customMessageBg` Box；自定义 renderer 返回组件时绕过该默认 Box | MessageView 也不会自动得到原生消息背景 |
| Pi `docs/tui.md`、`docs/themes.md`，theme.bg/style | 背景取现有语义 token；system 主题无法取得终端颜色时允许 panel 背景退化为默认色 | 不硬编码 RGB，不把真实主题的默认背景误判为实现失败 |

Box 并非自动处理嵌套背景的语义层：theme.bg 只是前置背景 ANSI、尾部 `49m`。子组件自己的背景关闭序列可能在一行中提前恢复终端背景；不能通过最后给所有子行再包一次父背景来声称嵌套样式正确。整组透明时直接保留子组件输出，另用带 ANSI 的测试验证边界。

## 3. 本仓库可用 seam 与 ownership

### 3.1 整组背景：ToolGroupView

`packages/pi-ext-ui/src/tool-group-view.ts`：

- constructor 目前是 `Spacer(1) + MouseRegion(header) + body`；组前空行与组内背景应分开，避免背景染到相邻 transcript。
- `render()` 已计算 `#renderedExpanded = #raw || ui.getToolsExpanded()`。这是整组收起/展开外壳切换的现成状态，标题点击与 Ctrl+O 都会走到它，不必新增折叠状态或 host hook。
- `#renderBody()` 在 `#renderFrame()` 与 `#renderRaw()` 间切换；两分支目前都生成横向 rail。背景方案应在该 ownership 内替换组外壳，不在 `host-transcript-patch.ts` 扫描/重写 ANSI 行。
- 建议让同一组实例保留 header/body 与成员身份，仅按展开状态选择背景外壳；不要每次重绘新建所有成员或重置选择。
- 原生 Box 同时负责绘制和鼠标转发。若采用一格 padding，应让 Box 成为相同的 render/handleMouse 路径，而不是只在 render 后装饰字符串。

建议的数据/控制流（不是本轮实现）：

```text
原始 transcript
  -> 既有 host 投影（成员、统计、时钟不变）
  -> ToolGroupView
       整组收起：原生 Box 背景 -> header + 分类摘要 + footer
       整组展开：透明组布局   -> 原组件/独立 block 的各自背景
```

### 3.2 独立工具组件背景：ToolView 与 renderer

- `packages/pi-ext-ui/src/renderer.ts:createRendererResolver()` 返回 `renderShell: "self"`（约 782 行），所以 host 的默认工具 Box 不参与这些工具的实际显示。
- `packages/pi-ext-ui/src/tool-view.ts:ToolView.render()/renderBody()` 拥有 header、预览、详情、padding、copy 热区和折叠 level；本票最终决定它**不**画背景，工具与 thinking 在收起组和展开组里都是透明的。
- 已试过的替代方案（`Box` 包裹 header + body，按状态取 `tool*Bg`）被否决：展开后的每条工具与 thinking 都成了独立色块，视觉噪声大。因此背景只属于整个收起的组，不属于单个成员。
- 不直接把所有 renderer 改成默认 shell：call/result slots 会再次被 host 包裹，会改变现有折叠、输入/结果布局和鼠标几何。采用这种替代方案必须先证明完整生命周期组合，不能作为背景修复捷径。
- 容器 codemode/python_eval 与普通工具一样保留原组件，子调用展示归原提供者；本票不拆容器、不新增跨包背景协议。

### 3.3 thinking/notice 与局部 block

- ToolGroupView 的 `#renderThinking()`、`#renderNotices()` 当前直接 push 字符串，不是每项一个 Box。需要独立块背景时，必须在这些真实内容布局 seam 处理。
- `packages/pi-ext-ui/src/message-view.ts:MessageView.render()` 拥有 notice 的 header/preview/body 与折叠缓存；组内则通过 `previewRows()/bodyRows()` 读取正文，绕过独立 render 的外壳。只改 MessageView.render 不足以覆盖组内 notice。
- `packages/pi-ext-ui/src/host-transcript-patch.ts:NotifyView.rows()/render()` 拥有普通通知的换行和状态文字。通知无 body 时仍不可新增假展开箭头；背景不能变成新增详情层的理由。
- 透明的整组布局应保留组件已经输出的背景；不通过 strip ANSI 删除它们，不扩大 host patch 的职责。

## 4. 状态与待定项

| 当前状态 | 已明确的背景约束 | 现成状态/seam |
| --- | --- | --- |
| 整组收起 | 整个组有连续背景，并由 header 下、footer 上两条组级 rail 框住 | `#renderedExpanded === false` |
| 标题打开整组原始视图 | 组本身透明且无组级 rail，成员也不填背景 | `#raw` |
| Ctrl+O 强制整组展开 | 同上；关闭后回到原聚合状态 | `getToolsExpanded()` |
| 单独展开分类、thinking/notice 项或工具 | 不因外层透明而丢失成员自己的样式：notice 保留 `customMessageBg`，工具与 thinking 保持透明 | `#category`、`#item`、ToolView.effectiveLevel、MessageView.expanded |

实施前需把以下视觉细节定到测试，不能当作用户已经选择：

1. 混合组的背景 token：复用原生 token 已确定；是否按 active/error/success 聚合、错误与活动状态的优先级，尚未指定。工具独立背景可参考原生工具规则，thinking/notice 的具体 token 也需明确。
2. “block”在局部展开时是整段分类还是其中每项；分类局部打开是否保留父级连续底色、是否分段填底。当前状态机能区分，不能把 `#category !== undefined` 擅自等同整组展开。
3. 原生 Box 的一格左右/上下 padding 是否全部沿用；组前空行不着色，独立块间隔保持一个空行。现有 ToolView outputPad 不能与 Box 重复计入。
4. 本票背景不决定 00/04 的尾部归属与统计范围；若未来有组外尾项，它不属于整组背景范围。

## 5. 实施验收清单

- [x] 用可区分 bg token 的 theme 断言收起组 header、摘要、footer 全行填底，两条组级 rail 就位，组前空行不染色；不只 strip ANSI 比文字。
- [x] 标题和 Ctrl+O 打开整组都没有组级背景与组级 rail；工具与 thinking 透明，notice 保留自己的背景。
- [x] 局部分类/项目/组件展开与整组展开分别覆盖，不能互相误清状态；容器保留自己的看板。
- [x] 30/80/120 列、长行、空行覆盖；CJK/emoji 与嵌套 ANSI reset 尚无专门断言（`fitRow` 按可见宽度截断，与 06 共用路径）；Box 填行不溢出，不让 footer 被 padding 挤掉。
- [x] 删除组级 rail 后同步 header/body 命中表；加 padding 后验证 x/y/height/width、右侧 copy、OSC 8 链接、空白行不误触相邻项。
- [x] 运行/完成/失败、streaming→final 仅更新真实内容/状态，不重挂载成员、不新增 timer；恢复/fork/reload 不新增持久化。
- [x] 聚焦 UI 单测、对应 package build、真实 host 集成通过；herdr 80/120 列实机对照未做（归 08）验证标题、分类、逐项、Ctrl+O、copy 和主题切换，证据汇入 08。

## 6. 原调查结论

仅完成源代码/上游阅读及设计记录；未修改 TypeScript、未新增 host monkey patch、未执行构建、单测、集成或 herdr。

## 7. 已定稿的实现决策

- **外壳与 padding：** `ToolGroupView` 的 children 为 `[Spacer(1), Box(content, 0, 1, bgFn)]`（展开时改为 `[Spacer(1), header, body]`）。`paddingX = paddingY = 0`：组的行已经按终端宽度排布，ToolView 也有自己的 `outputPad`，再加 Box padding 会双重缩进并把 footer 挤掉；组前空行在 Box 之外，所以不着色。`Box` 同时是渲染与鼠标路径（`Box.handleMouse` 按子组件高度转发），组不手写 ANSI 填底。
- **底色 token：** 取 block 的**最后事实**（组内成员 + 组外尾项中最后一个有状态者）：`running`/`streaming` → `toolPendingBg`，`error` → `toolErrorBg`，其余 → `toolSuccessBg`。结算后保持 5 秒（`SURFACE_HOLD_MS`），到时用一次 `setTimeout` 触发 `redraw` 撤掉底色，回到终端中性背景；block 重新变 live 时清掉 hold 并重新计时。每帧用 `setBgFn` 重设，`Box` 通过采样 `bgFn("test")` 检测主题切换，不需要额外 invalidate。
- **局部展开：** `#category`/`#item` 只改变组内 body 行，仍在同一个 Box 内，所以保留组底色；不按分类分段填底。
- **整组展开：** 不套 Box（外层透明），也不画组级 rail，header 仍显示；组内成员按原组件输出，工具与 thinking run 不填背景，notice 的 `customMessageBg` 由 `MessageView` 拥有。不 strip 子组件已输出的 ANSI。
- **工具自身样式：** `ToolView` 不画背景，也不画 body 横向分隔线；Level 1/2 body 只用各 section 自己的 `▎` 导轨，`noRail` embed 连导轨一起省略。组层不按工具名或状态给工具行补样式，也不改 `renderShell`。
- **间距与几何：** 组与尾项之间恰好一个空行（尾项行归一化）；相邻独立块之间一个空行；Box 填满到终端宽度，右侧 copy/OSC 8 链接的列位置不变，因为 padding 为 0。
