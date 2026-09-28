# 工具 frame「输入段」扩展（request section）设计与实施方案

> 状态：草案（公共契约与渲染规则尚未冻结，见 §8 待定决策）
> 涉及 package：`pi-ext-core`（frame 契约）、`pi-ext-tools`（bash / eval）、后续可选 `pi-subagents`（spawn / send）

## 1. 背景与目标

今天工具 frame 对「输入」的表达能力只有 header 里的一行 `summary`，而 header 还要同时承担身份（glyph + label）、告警（`warning`）和目标（`(host)`、`(timeout Ns)`）等信息。结果是几类工具的输入被压扁、截断甚至完全不可见：

| 工具 | 今天的输入展示 | 问题 |
| --- | --- | --- |
| `bash` | `flattenCommand` 把多行命令用 `; ` 拼成一行，再由 `headerLine: "truncate"` 截断 | 命令尾部**永久不可恢复**：输出 body 只渲染 stdout/stderr，从不重复命令；超过终端宽度即丢失 |
| `eval` | 只有 `summary`（`eval · <首行摘要>`） | cell 代码完全不可见 |
| `spawn_subagent` / `send_subagent` | 只有 `summary: args.agent` / `args.id` | task / message 文本在 TUI 中完全不可见 |

目标：把「输入」提升为 frame 的一等展示内容，形成 **header / request / result / footer** 的四段形态，适用于「输入与输出都值得看」的工具；并让折叠、展开、宽度安全、ANSI 脱敏、历史暗化等既有规则继续成立。

非目标：

- 不改变模型可见内容（新段仅用于渲染，不进入 tool result / prompt）。
- 不改变折叠不变量（自动折叠后仍是 header + 一行摘要 = 恰好 2 行）。
- 不改变「续接式」工具（`apply_patch` / `write` / `edit`）的槽位交接语义（见 §3）。
- 不引入通用 sections 组合器（避免把 frame 变成插件式布局系统）。
- 不把 header 的身份/告警/目标信息搬进 request 段。

## 2. 现状结构（证据）

**宿主侧**（`@earendil-works/pi-coding-agent` `dist/modes/interactive/components/tool-execution.js`）

- `updateDisplay()` :238-281 先挂载 call 渲染器的组件，再（若有 result）挂载 result 渲染器的组件 —— 两个区**同时存在**，call 区不会因 result 到来而消失。两者各自的 `lastComponent` 互相不可见。
- `renderShell: "self"` 时 `render()` :188-198 在整块前加一个空行。

**core 侧**（`packages/pi-ext-core/src/tool-tui.ts`）

- call 区：`:745` `previewing = context.isPartial && latest === undefined`；`:771` 折叠时只输出 header；`:773-790` **仅 previewing 时**才渲染工具自己的 `renderCall` body。
- result 区：`:824-836` 只输出 `ToolBodySection`（无 header）。
- chrome：`ToolBodySection` :626-684 输出 `[rail, ...body, rail, ...footer]`，body 为空时只输出 footer（:653-656）；未展开时按行数裁剪且**只保留尾部**（:667-671，提示语 «earlier lines»）。
- header 输入摘要：`headerFor` :207-220（`summary` 覆盖）、:223-233（bash 分支）；`flattenCommand` :173-188；`headerLine: "truncate"` 文档 :57-64。

**文档契约**（`DESIGN.md:78-91`）

> A tool frame has **one body**. …
> Pi `renderCall` and `renderResult` are host lifecycle slots, **not separate visible sections**. Before a result exists, the call slot may carry the one body; once a result exists, the call slot retains only the header and the result slot owns the body.

本方案即改写这两句为「最多两个 body：request + result」。

## 3. 工具分类（决定改造范围）

| 类型 | 判定标准 | 工具 | 处理 |
| --- | --- | --- | --- |
| **两段式** | 输入文本在 result 段中**不再出现**，丢掉不可恢复 | `bash`、`eval`；建议后续 `spawn_subagent`、`send_subagent` | 新增 request 段 |
| **续接式** | 输入与输出是**同一批行**的不同阶段 | `apply_patch`（`○ create x +1` → `✓ create x +1`）、`write`（新文件 preview → diff）、`edit` | 保持单 body 槽位交接，零改动 |
| **header 已表达** | header 已是完整调用表达，body 只有结果 | `read`、`grep`、`find`、`ls`、`todo`、`list_tasks`、`wait_tasks`、`stop_tasks`、`get/list/stop_subagent` | 保持现状 |

续接式语义有测试护栏：`packages/pi-ext-tools/test/apply-patch-call.test.ts:150-155` 要求结果阶段不再出现 call 阶段的行且该行只出现一次。

## 4. 目标形态与状态机

```text
                                   渲染位置 / 提供方
────────────────────────────────────────────────────────────────
󰪠 bash (web-1) (timeout 30s)       call 区 · core：status + label + 一行 summary
───────────────────────────────     rail · core
git fetch --all                     request 段 · 工具提供（完整、多行）
git rebase -i main                  ← 未展开时上限 N 行 + 隐藏行提示
───────────────────────────────     rail · core
stdout…                             result 段 · 工具提供（现有逻辑不变）
…
───────────────────────────────     rail · core
exit 0 · 42 lines · 1.2s            footer · 工具提供（现有逻辑不变）
```

```text
① 参数流式中    pending glyph  │ header(部分 summary) │ request 随参数增长 │ 无 result
② 执行中        pending        │ header               │ request(完整)      │ result 流式增长
③ 完成          success/warning│ header               │ request            │ result + footer
④ 折叠          (auto 15s / 上一 Trace) 仅 header + 一行 dim 摘要，恰好 2 行
⑤ Ctrl+O 展开   request 与 result 均不受行数上限约束
```

## 5. 公共契约（第 1 轮 grilling 已冻结；❓ 标注者为第 2 轮待定）

新增 `ToolTuiPresentation` 字段：

```ts
readonly request?: (args: Static<TParams>, theme: Theme, ctx: ToolRenderContext) => Component;
```

术语：代码与文档统一用 `request` / “request section”；「扩展 header」只作为本次改动的一句话描述。

渲染规则：

- **INV-1** request 段只在 call 区渲染；折叠帧不渲染 request（折叠仍是 header + 一行 dim 摘要，恰好 2 行）。
- **INV-2** rail 归属 R2：request 段自带上下 rail，result 段在有 request 时省略其开 rail；相邻段之间恰好一条 rail。结果 body 为空时形态为 `header / rail / request / rail / footer`。
- **INV-3** 未展开时按行数上限裁剪；request 段保留**头部**行（result 保留尾部），提示语为 «… N later lines, ctrl+o to expand»。
- **INV-4** 每行必须宽度安全，永不触发 `TuiMainScreen` 的 “Rendered line exceeds terminal width”：由 core 在 request 段按宽度缓存后逐行兜底（已 fit 的行原样通过，工具仍可自行 wrap）。
- **INV-5** request 段渲染模型可控文本前必须脱敏（`stripTerminalSequences`），与 `bash` 输出行的既有行为一致（`src/bash.ts:166`）。
- **INV-6** 历史 / 上一 Trace 的帧照常渲染 request（按既有规则暗化）。
- **INV-7** header 摘要与 request 段文本来自同一个格式化函数，避免两处真相。
- **INV-8** 组件按宽度缓存行（`LinesBody` / `memoByWidth` 范式），避免每帧重算。
- **INV-9** 参数流式期即渲染 request（随参数增长）；历史 / 恢复的帧同样渲染。

上限：request 段 10 行；result 段 10 行**仅限两段式工具**（`bash`、`eval`），其他工具维持现状（core 默认 20 / 各自内部 cap）。

与既有机制的关系：

- `longOutput` / `on` 模式：只影响 result 流式输出，request 段不受影响（参数在流式期即已就绪）。
- `headerLine` 与 `flattenCommand`：继续只约束 header 与折叠摘要行。
- `maxBodyLines`：两段各自独立上限，取值见上。

## 6. core 改动点（文件级）

- `packages/pi-ext-core/src/tool-tui.ts`
  - `frame()` 的 call 槽：不再以 `previewing` 作为唯一条件，改为「折叠 → 仅 header；否则 header + request 段」。
  - `ToolBodySection`：新增 rail 归属开关与裁剪方向参数（头部/尾部）。
  - `headerFor` / `flattenCommand`：行为不变（header 摘要仍然存在）。
- `packages/pi-ext-core/src/index.ts`：若新增导出类型（如 `ToolRequestRenderer`）需同步导出。
- 文档：`DESIGN.md:78-91` 的「one body」与 host 槽位描述。

## 7. 逐工具迁移

| 工具 | request 段内容 | header 摘要 | 备注 |
| --- | --- | --- | --- |
| `bash` | 完整命令，多行、逐行一行 | `bash (host) <命令摘要> (timeout Ns)`，摘要沿用 `; ` 拼接（✅Q11：接受展开态与 request 段的重复） | 收益最大 |
| `eval` | 完整 code cell | 形式参考 `bash`：`eval <代码摘要> (reset) (timeout Ns)`（具体形态见 ❓Q16） | 需要重新引入 code 预览渲染器 |
| `spawn_subagent` / `send_subagent` | task / message 文本（10 行上限 + 展开） | agent 名 / id（不变） | 第二批（✅Q15） |
| 其他 | — | 不变 | 零改动 |

## 8. 待定决策（grilling 冻结）

| # | 决策 | 结论 | 状态 |
| --- | --- | --- | --- |
| Q1 | 本次范围与批次 | 本次 bash + eval；`spawn`/`send` 列入第二批 | ✅ 已定 |
| Q2 | core API 形态与术语 | 新增 `presentation.request`（A1），术语用 request section | ✅ 已定 |
| Q3 | rail 归属 | R2：request 自带上下 rail，result 省略开 rail | ✅ 已定 |
| Q4 | 折叠态与 header 摘要 | 折叠仍 2 行；header 保留一行输入摘要 | ✅ 已定 |
| Q5 | request 裁剪方向与提示语 | 头部裁剪 + «later lines» | ✅ 已定 |
| Q6 | request 行宽度策略 | wrap（完整、可复制） | ✅ 已定 |
| Q7 | 行数上限预算 | 两段各自独立，**各 10 行** | ✅ 已定（范围见 Q10） |
| Q8 | ANSI 脱敏责任 | 工具在 request 渲染器内脱敏（与 bash 输出一致） | ✅ 已定 |
| Q9 | request 段生命周期边界 | 参数流式期即渲染；历史/恢复行同样渲染（暗化） | ✅ 已定 |
| Q10 | result 段 10 行的适用范围 | 仅两段式工具（bash、eval）；其他工具维持现状 | ✅ 已定 |
| Q11 | bash header 摘要与 request 段的重复 | 接受重复：header 保留 `; ` 拼接的一行摘要 | ✅ 已定 |
| Q12 | eval 的 request / header 形态 | request = 完整 code cell；header 参考 bash（细节见 Q16） | ✅ 已定（待 Q16 定形） |
| Q13 | 宽度安全的责任方 | core 在 request 段兜底（逐行、按宽度缓存） | ✅ 已定 |
| Q14 | 提交粒度与文档节奏 | 三个 commit：① core + DESIGN.md + core 测试 ② bash ③ eval | ✅ 已定 |
| Q15 | 第二批 spawn / send 的显示范围 | 采纳，request 段显示 task / message（10 行上限 + 展开） | ✅ 已定 |
| Q16 | eval header 的落地形式（是否新增 `presentation.suffix`） | 见 §8 第 3 轮 | ❓ 待定 |

## 9. 测试与文档影响（预估）

- 断言需更新：`packages/pi-ext-core/test/tool-tui.test.ts`（rail / header / 折叠不变量）、`packages/pi-ext-tools/test/tool-execution-smoke.test.ts`、`test/eval-bridge.test.ts`、`test/tools.test.ts`（bash / eval 段）、`test/bash-backend.test.ts:254`、`test/bash-jobs.test.ts:664`。
- 必须保持绿：`test/apply-patch-call.test.ts`（续接语义）、`test/collapse-modes.test.ts`（折叠 2 行、`longOutput` 计时器）。
- 文档：`DESIGN.md`（§5 契约与 §3 分类）、`docs/architecture/eval.md`、`docs/ext-tools/README.md`、必要时 `docs/architecture/tui.md`。
- 按仓库流程：先冻结契约并更新 DESIGN.md，再动 core，再迁具体工具。

## 10. 验证策略

- 变更跨越公共导出（`pi-ext-core` 的 frame 契约属于公共 API）：需要根 `pnpm run typecheck` + 受影响 package（core / tools，必要时 subagents）的测试文件。
- 不预设全量 `pnpm test`；若 frame 行为可能影响全仓渲染，再升级到全量。

## 11. 落地顺序

1. 冻结 §8 决策，改写 `DESIGN.md` 契约（先于实现）。
2. **commit ①**：`pi-ext-core` 实现 `presentation.request` 与 `ToolBodySection` 的 rail / 裁剪参数；行为中性（所有工具输出不变），只加 core 单测 + DESIGN.md。
3. **commit ②**：`bash` 接入 request 段（命令不再丢失）。
4. **commit ③**：`eval` 接入 request 段与 bash 形态的 header。
5. 第二批：`spawn_subagent` / `send_subagent`（可先只加 request 段，不返工 core）。

验证：每步跑受影响 package 的测试文件 + 根 typecheck；不改动全局 `DEFAULT_MAX_BODY_LINES`。

## 12. 风险

- **重复渲染**：输入与输出共享行词汇的工具误用 request 段会导致信息重复（护栏：§3 分类 + apply-patch 的 `not.toContain` 断言）。
- **真相源分裂**：header 摘要与 request 段需共用同一格式化函数（INV-7）。
- **纵向占用**：current-trace 期间每个调用多占 1 + N 行；实测每行约 0.025µs/帧（60 个 mounted bash 行、width 100），性能可忽略，但视觉噪音需要靠上限与折叠控制。
