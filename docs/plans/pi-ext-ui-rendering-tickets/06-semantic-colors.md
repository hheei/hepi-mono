# 06：统一语义着色，对齐原生 read/bash

**依赖：** 01、02、03。**状态：** 实现完成，待 08 验收（herdr 对照截图未验证）。**来源：** 排查第 5.1 节及两张截图。

## 交付与边界

语义表已先写入 DESIGN.md（Theme → Semantic color table），随后只改工具所属展示层：

- `@hheei/pi-ext-ui` 的 header 词汇（`formatToolHeaderText`）：`状态字形 + toolTitle(bold(名称)) + 摘要 + 次要元数据`。摘要由拥有该工具的层给出：`read` 传已着色的 `accent` 路径 + `warning` 行范围，`bash` 命令用 `toolTitle`+bold，其余工具 `dim`；`meta`（耗时、`timeout`）始终 `dim`。
- read 的路径沿用原生语义：`homedir` 缩写、`pi-tui` 的 `hyperlink`/`getCapabilities` 在终端支持时输出 file 链接（新增 `payload-parser.readHeaderSummary`），行范围复用同一处 `readLineRange`。
- bash 命令成为行内容（与原生 `$ cmd` 的 `toolTitle`+bold 一致），`(timeout Ns)` 与耗时降为 `dim` 元数据。
- 删除 `renderer.ts` 的 `resolveToolCallSummary`：不再 `render(120) → 去 ANSI → 首行` 反向解析原生 renderCall。摘要改为按参数陈述（`extractSummaryArg`）；工具有原生 call 行但没有自有词汇时，仍用与原生 generic 行同形的 `key=value` 参数行，没有原生行的未知工具只显示名称（与改动前一致）。
- 容器看板不再自行决定子工具颜色：`NestedCallsView` 新增可选 `headerSummary`，由 `renderer.ts` 传入同一套语义，因此容器内 read 子行与顶层 read 行同色。
- `pi-python-eval` 不能反向依赖 `pi-ext-ui`，在 presentation 内按同一张表着色（bash 命令 `toolTitle`+bold、read 路径 `accent`、其余 `dim`、耗时 `dim`）。
- 分组层级：header 与分类标签用 `text`，展开的分类标签用 `accent`（箭头仍独立表示状态），rails 用 `borderMuted`，耗时/计数/footer 仍 `dim`。`ToolGroupView` 不按工具名分支、不合成着色子行。
- notice：`info` 正文用 `text`，`warning`/`error` 保留状态色与 `Warning: `/`Error: ` 前缀。

未扩大范围：`@hheei/pi-ext-core` 的 `ToolPresentation` 契约未变（没有新增 summary 颜色字段）；`pi-ext-ui` 自身可选字段（`ToolViewHeaderSpec.meta/summaryStyled`、`NestedCallsViewProps.headerSummary`）是纯增量，现有消费者无需修改。04/05/00 的尾部与 footer 改动、07 的完整命令持久化、Pi host 与 hook 均未触碰。

## 验收条件

- [x] 组标题/分类与次要统计有清晰层级（`text`/`accent` 标签、`borderMuted` rails、`dim` 统计），展开状态仍有箭头，不只靠颜色。
- [x] read 名称 toolTitle+bold，路径 accent，范围 warning；终端支持时保留原生 file 链接。
- [x] bash 命令与原生 toolTitle+bold 一致，timeout/耗时为次要 `dim` 元数据。
- [x] thinking 预览/正文统一 thinkingText+italic；notice info 可读，warning/error 保留语义与文字前缀。
- [x] 普通工具、容器内相同工具、组内/组外一致（`NestedCallsView.headerSummary`）；python_eval 手拼行不再把 bash/read 降为 dim。
- [x] 不再通过固定 render(120)→去 ANSI→首行推导完整工具展示；工具展示由原 renderer/提供者语义与框架词汇共同决定。
- [x] 带可区分 token 的测试 theme 断言路径/命令/范围/耗时实际样式；主题切换后 `invalidate()` 使缓存失效并重绘。
- [ ] herdr 下用同主题对照原生 Pi read/bash，记录主题、列宽与截图（至少窄/宽两布局，内容无缺字）——由 08 汇总。

## 验证

已执行（本机，pi-coding-agent/pi-tui 1.3.0）：

```bash
pnpm run check:changed                                                      # Biome，16 个改动文件，clean
pnpm --filter @hheei/pi-ext-ui run build                                    # tsc 通过
pnpm --filter @hheei/pi-python-eval run build                               # tsc 通过
pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test    # 16 files / 263 tests passed
pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test \
  packages/pi-ext-tools/test packages/pi-bg-bash/test packages/pi-apply-patch/test  # 48 files / 645 tests passed
pnpm run typecheck                                                          # tsc --noEmit 通过
pnpm run test:integration                                                   # 5 files / 12 tests passed
pnpm test                                                                   # 5 失败，均在 pi-subagents/pi-ext-memory 的既有无关用例
graphify update .                                                           # AST 已更新
```

`pnpm test` 的 5 个失败与本次改动无关：`pi-subagents` 的 `tools.ts` 描述文案由工作区其他未提交改动改过（`agents_delegate` 描述断言过期），`pi-ext-memory` 的 hindsight 用例需要外部服务。渲染相关包（`pi-ext-ui`、`pi-python-eval`、`pi-ext-tools`、`pi-bg-bash`、`pi-subagents` 的 presentation 用例）全部通过。

未执行：herdr 实机截图与窄/宽对照记录（见上，由 08 汇总）。
