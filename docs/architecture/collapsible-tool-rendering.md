# 工具折叠渲染与深模块设计规范 (Collapsible Tool Rendering & Deep Module Specification)

## 1. 概述与设计哲学

在终端编程智能体（Coding Agent）运行过程中，工具调用（Tool Calls）具有高频、长输出、异步流式以及多形态特征。本规范基于 **Deep Module（深模块）** 架构方法论（参考 `.agents/skills/codebase-design`），确立一套**窄接口（Small Interface）、高杠杆（High Leverage）、强局部性（Locality）**的工具渲染体系。

### 核心架构词汇对齐 (Codebase-Design Vocabulary)
- **Module（深模块）**：`ToolView`（位于 `@hheei/pi-ext-ui`），将复杂的鼠标点击热区、三级折叠状态机、导轨分段染色、剪贴板反馈隐藏在一个纯数据驱动的窄接口之后。
- **Seam（接缝）**：两个真实的接缝——
  1. **组件级 Seam**：各业务 package（如 `pi-ext-tools`, `pi-ext-memory`）直接构造纯声明式的 `ToolViewSpec` 交给 `ToolView`；
  2. **全局扩展 Seam**：通过 `pi.registerToolRenderer` 为第三方无状态/外部扩展（如 `pi-web-access`、MCP 工具）提供零侵入的 **External Adapter**。
- **Deletion Test（删除测试）**：拒绝抽出诸如 `resolveToolStatusIndicator`、`TwoCompartmentFrame`、`MetaToolFrame` 等浅层 pass-through 类或充满闭包的碎片化 helper。如果删除 `ToolView`，所有调用方都必须各自重写点击坐标计算、Ctrl+Click 状态转移、剪贴板定时复位与 ANSI 宽度对齐，证明其具备真实的 **Depth（深度）**。

---

## 2. 核心正交模型与三级折叠状态机

### 2.1 三维正交解耦
工具渲染状态由三个正交维度决定：
$$\text{Render State} = \text{Outcome} \otimes \text{Visibility} \otimes \text{Content Depth}$$
- **结果与折叠解耦**：成功（Ok）、告警（Warn）与失败（Error）均可自由收缩或展开。
- **全周期防抖动与流式策略**：
  - **遵循全局折叠**：规划期（模型流式输出参数时）不搞特殊强制展开，严格跟随折叠态；
  - **流式参数紧凑显示**：折叠时格式固定为 `▸ ⋯ web_search · XX tokens`（估算值 `Math.ceil(chars / 4)`）；
  - **严禁自创私有刷新时间窗口**：完全对齐 Pi 原生渲染层调度（`@earendil-works/pi-tui` 的 `TuiBase.MIN_RENDER_INTERVAL_MS = 16` 物理帧合并）。扩展层仅调用 `context.invalidate()`，交由 Pi 原生 `requestRender()` 合并驱动；
  - 收缩态在规划期、运行期与结算期**恒定保持 1 行高度**，彻底杜绝视口抖动。

### 2.2 点击与 Ctrl+点击 三级状态转移矩阵 (Level 0 / 1 / 2)

- **Level 0 (全收起)**：显示折叠 (Collapsed)，内容受限 (Capped)；
- **Level 1 (一阶展开)**：显示展开 (Expanded)，内容受限 (Capped，截断预览)；
- **Level 2 (两阶全开)**：显示展开 (Expanded)，内容全量展开 (Full，无截断完整内容)。

| 当前状态 | 点击动作 (Trigger) | 目标状态 | 行为描述 |
|---|---|---|---|
| **Level 0 (全收起)** | **普通点击 (Click)** | **Level 1** | 常规展开显示，内容保持受限预览 |
| **Level 0 (全收起)** | **Ctrl + 点击 (Ctrl+Click)** | **Level 2** | **一步到位两阶全开**：同时展开显示与全量内容 |
| **Level 1 (一阶展开)** | **普通点击 (Click)** | **Level 0** | 收起显示，回归折叠态 |
| **Level 1 (一阶展开)** | **Ctrl + 点击 (Ctrl+Click)** | **Level 2** | **单工具独立二阶展开**：就地展开该工具完整内容 |
| **Level 2 (两阶全开)** | **普通点击 (Click)** | **Level 0** | **两阶同时收缩**：直接关回折叠态 |
| **Level 2 (两阶全开)** | **Ctrl + 点击 (Ctrl+Click)** | **Level 0** | **两阶同时收缩**：直接关回折叠态 |

---

## 3. 几何形态与视觉规范

### 3.1 顶针导轨一体化 (Pin & Rail)
- **折叠态（Level 0）**：首字符为闭合微三角 `▸`（U+25B8），无下延导轨（元工具看板除外）。
- **展开态（Level 1 / 2）**：首字符为下垂微三角 `▾`（U+25BE）充当导轨物理顶针；正下方自然垂落坚实细竖条 `▎`（U+258E）贯穿整个 Body。

### 3.2 导轨与原生滚动原则 (Unobtrusive Rail & Native Scrolling)
- **严禁拦截滚轮 (No Wheel Hijack)**：工具内部绝不捕获 `wheel` 事件，防止用户快速向上浏览历史对话时视口被卡在工具中间。所有滚轮事件天然穿透至外层主视口。
- **导轨分段着色 (Segmented Rail Theming)**：全高保持等宽 `▎`，不使用任何内室横向虚线或空白 Padding 行，纯靠导轨段颜色（如输入段 `muted`、输出段 `dim`/`accent`/`error`）与文本主题区分上下室。

### 3.3 标准 Unicode 状态符号体系
采用零字体依赖的标准 Unicode 符号，全终端严格对齐：

| 生命周期阶段 | 状态 | 符号 | Theme Token | 折叠态示例 | 展开态示例 |
|---|---|---|---|---|---|
| **规划期 (Streaming)** | 准备中 | `⋯` | `muted` / `dim` | `▸ ⋯ web_search · 45 tokens` | `▾ ⋯ web_search {"query": ...}` |
| **运行期 (Executing)** | 进行中 | `◐` | `accent` | `▸ ◐ web_search "query" · 1.2s` | `▾ ◐ web_search "query" · 1.2s` |
| **结算期 (Settled)** | 成功 | `✓` | `success` | `▸ ✓ web_search "query" · 340ms` | `▾ ✓ web_search "query" · 340ms` |
| **结算期 (Settled)** | 告警 | `!` | `warning` | `▸ ! web_search "query" · 1.2s` | `▾ ! web_search "query" · 1.2s` |
| **结算期 (Settled)** | 失败 | `✗` | `error` | `▸ ✗ web_search "query" · 12.0s` | `▾ ✗ web_search "query" · 12.0s` |

---

## 4. 语义化免选区复制机制 (Semantic Click-to-Copy)

Header 右侧末端常驻单图标 `󰆏`（点击后切换为 `✓` 绿光持续 1.2s，自动清理定时器并重绘），UI 零啰嗦文字提示：

1. **分室/重输入工具 (Bash, Eval, Codemode)**：
   - **普通单击（Click）**：**默认复制上室（Input 命令/脚本）**，无 `$` 前缀与导轨污染，直接可粘贴运行；
   - **Shift + 单击（Shift+Click）**：**同时复制上下室（命令 + 输出）**。
2. **基础单室 I/O 工具 (WebSearch, Read 等)**：
   - **普通单击**：复制纯净结果内容；
   - **Shift + 单击**：同时复制调用参数与结果内容。
3. **Assistant 回复底部复制按钮**：
   - **普通单击**：复制当次 Assistant 回复正文；
   - **Shift + 单击**：将整轮 Loop 导出为清晰的线性 Flow 纯文本格式（不强加 Markdown 包装）：
     ```text
     [User]
     用户输入指令

     [Tools]
     bash $ pnpm test
     Exit 0 · 1.2s

     [Assistant]
     模型最终回复正文
     ```

---

## 5. 三类工具拓扑形态 (数据驱动分段)

所有工具形态不再拆分为多个碎片化的子类，而是统一抽象为 **導轨分段列表（Rail Sections）** 与 **折叠态摘要行（Collapsed Rows）**：

### 5.1 基础 I/O 工具 (单段 Body)
```
▾ ✓ web_search "pi mono" · 12 results · 340ms                        󰆏
▎ 1. Pi Coding Agent Monorepo ...
▎ 2. Documentation & Architecture ...
```

### 5.2 重输入工具 (上下双段无缝衔接，零横线、零空行 Padding)
```
▾ ✓ bash · exit 0 · 1.2s                                             󰆏
▎ $ pnpm build && pnpm test                           <-- 上段: 导轨 muted 色 · $ 命令语法色
▎ > @hheei/pi-ext-ui@0.1.0 build                      <-- 下段: 导轨 dim/状态色 · Stdout 标准色
▎ ✓ Built in 820ms
```

### 5.3 嵌套元工具 (Codemode / Subagents)
- **状态去重规则**：有子工具调用时，顶层 Header **剥离冗余的 `✓` 图标**，状态完全由子调用列表反映；仅当零子调用（纯计算兜底）时顶层才显示 `✓`，或脚本自身崩溃时显示 `✗`。
- **未展开态（Level 0，多行紧凑看板）** vs **展开态（Level 1/2，聚焦代码与最终输出）**：
```
[未展开状态 (Level 0: 导轨挂接子工具看板，顶层省略 ✓)]
▸ codemode "batch search" · 4 calls · 2.1s                           󰆏
▎ ✓ grep "registerTool" · 14 matches (80ms)
▎ ✓ read "src/extension.ts" · 45 lines (20ms)
▎ ✓ read "src/renderer.ts" · 120 lines (35ms)
▎ ✗ write "dist/output.json" · Permission denied (15ms)

[展开状态 (Level 1/2: 隐藏子列表，无缝展示输入脚本与最终聚合产出)]
▾ codemode "batch search" · 4 calls · 2.1s                           󰆏
▎ $ await Promise.all([                                <-- 上段: 导轨 muted 色 · 输入脚本
▎     tools.grep({ pattern: "registerTool" }),
▎     tools.read({ path: "src/extension.ts" }),
▎   ]);
▎ Summary: 3 passed, 1 failed.                         <-- 下段: 导轨 dim/状态色 · 最终输出
```

---

## 6. 深模块架构设计 (Deep Module Design via `codebase-design`)

### 6.1 架构反模式诊断 (What We Rejected)
根据 `improve-codebase-architecture` 的 **Deletion Test** 与 **Shallow Module** 诊断，我们明确拒绝以下设计：
1. **拒绝闭包地狱（Closure Soup）**：当前 `CollapsibleToolFrameOptions` 中充斥着 `header: (collapsed) => Component`、`body: () => Component`、`onToggle: (collapsed) => void` 等回调闭包。这不仅将状态同步的负担泄露给每个调用方（差 Locality），而且容易捕获大对象引发内存驻留。
2. **拒绝碎粒化 Helper 与多子类膨胀**：不单独导出 `resolveToolStatusIndicator`，也不拆分 `StandardFrame` / `TwoCompartmentFrame` / `MetaToolFrame` 三个类。这三个类本质上只是“折叠时有没有摘要行”和“展开时有几个导轨染色段”的区别。

### 6.2 深模块接口定义 (The Deep Module Interface)
整个 `@hheei/pi-ext-ui` 只暴露**一个深模块组件 `ToolView`（或升级后的 `CollapsibleToolFrame`）** 与 **一个外部工具适配器 `registerCollapsibleToolRenderer`**。

调用方（无论是内部其他 package 自己注册工具，还是外部适配器）只需提供**纯声明式的数据结构（Data-Driven Spec，零必选闭包）**：

```ts
export type FoldLevel = 0 | 1 | 2;
export type ToolStatusKind = "streaming" | "running" | "ok" | "warn" | "error" | "none";

export interface RailSection {
  /** 该段左侧导轨 ▎ 的语义颜色 (例如上室用 "muted"，下室用 "dim" 或 "error") */
  readonly railToken: "muted" | "dim" | "accent" | "success" | "warning" | "error";
  /** 该段的内容：可以直接传纯文本行、字符串或已有的 pi-tui Component */
  readonly content: string | readonly string[] | Component;
  /** Level 1 受限态下的最大显示行数（Level 2 自动全量无截断） */
  readonly maxLines?: number | undefined;
}

export interface ToolViewSpec {
  /** Header 展示信息（纯数据，由模块内部统一排版顶针 ▸/▾、状态符与右侧复制图标 󰆏） */
  readonly header: {
    readonly title: string;
    readonly status?: ToolStatusKind | undefined; // "none" 用于有子调用的 codemode 顶层
    readonly summary?: string | undefined;        // 如 '"pnpm build" · 340ms' 或 '45 tokens'
  };
  /**
   * Level 0 (折叠态) 下额外显示的紧凑看板行（如 codemode 的 1~6 个子工具列表）。
   * 普通工具不传此项，在 Level 0 下严格占 1 行。
   */
  readonly collapsedRows?: readonly string[] | Component | undefined;
  /**
   * Level 1 / Level 2 (展开态) 下的导轨分段列表：
   * - 普通 I/O 工具：传 1 个 section
   * - Bash / Eval / Codemode：传 2 个 sections ([上室 Input, 下室 Output])，自动无缝衔接
   */
  readonly sections?: readonly RailSection[] | undefined;
  /**
   * 免选区复制纯文本数据（零闭包）：
   * - primary: 普通 Click 复制的内容（如 Bash 的上室命令，或 I/O 工具的结果）
   * - full: Shift+Click 复制的内容（如 Bash 的命令+输出）
   */
  readonly copy?: {
    readonly primary: string;
    readonly full?: string | undefined;
  } | undefined;
  /**
   * 状态挂载点：直接传入 Pi 原生的 context.state 对象与全局 options.expanded，
   * 由深模块内部全权接管 Level 0/1/2 状态读写与 Ctrl+Click 转移，调用方零状态代码！
   */
  readonly stateHolder?: unknown;
  readonly globalExpanded?: boolean | undefined;
  readonly invalidate?: (() => void) | undefined;
}
```

### 6.3 深模块隐藏的内部复杂性 (What Sits Behind the Seam)
通过上述窄接口，`ToolView` 在内部完全封装并消化了以下所有复杂性（**High Leverage & Locality**）：
1. **三级折叠状态机管理**：直接在 `stateHolder`（即 Pi 的 `context.state`）上读写 `FoldLevel (0 | 1 | 2)`，自动合并全局 `Ctrl+O`（`globalExpanded`）与局部 `Click` / `Ctrl+Click` 的优先级；
2. **鼠标热区精确命中（Hit Testing）**：在 Header 单行内自动区分“左侧折叠点击区（Click / Ctrl+Click）”与“右侧末端 `󰆏` 复制图标点击区（Click / Shift+Click）”；
3. **剪贴板写入与 1.2s 状态自愈**：内部管理 `󰆏 -> ✓` 的定时回退与 `invalidate()` 触发，并在组件销毁或重复点击时幂等清理 timer；
4. **导轨合成与按行截断**：在 Level 0 时完全跳过 `sections` 的渲染（Lazy Evaluation）；在 Level 1 时对每个 `RailSection` 按 `maxLines` 截断并前置对应颜色的 `▎ `；在 Level 2 时全量输出。

---

## 7. 实施落地计划 (Implementation Plan)

### Step 1: 深模块核心重构 (`packages/pi-ext-ui/src/collapsible-tool-frame.ts`)
1. 实现纯数据驱动的 `ToolView` / `CollapsibleToolFrame`：
   - 内置 `FoldLevel (0 | 1 | 2)` 状态转移函数（支持普通 Click 与 `event.ctrl` 修饰键）；
   - 实现 Header 左右分区 Hit Testing（左区切换折叠等级，右区 2 列触发 `copy.primary` / `copy.full` 剪贴板写入与 1.2s `✓` 反馈）；
   - 实现 `collapsedRows`（Level 0 专属，供元工具看板使用）与 `sections: RailSection[]`（Level 1/2 专属，支持多段不同颜色的 `▎` 导轨无缝拼接，无横线、无空行）。
2. 确保**不拦截任何 `wheel` 事件**，滚轮 100% 穿透给外层视口。

### Step 2: 外部工具适配器升级 (`packages/pi-ext-ui/src/renderer.ts`)
1. 将 `registerCollapsibleToolRenderer` 改造为 `ToolViewSpec` 的薄适配器（Thin Adapter）：
   - 规划期（Streaming）自动计算 `Math.ceil(chars / 4)` 生成 `· XX tokens` 摘要，直接复用 Pi 原生帧合并；
   - 根据工具形态映射为 1 段（标准 I/O）或 2 段（重输入/元工具）`RailSection`，配置对应的 `copy.primary` 与 `copy.full`。

### Step 3: 接口级测试覆盖 (`packages/pi-ext-ui/test/`)
遵循 `DEEPENING.md` 的 **"The interface is the test surface (Replace, don't layer)"** 原则，直接通过 `ToolView` 的公开接口断言可观测行为：
1. **三级折叠矩阵测试**：验证 Level 0 $\xrightarrow{\text{Click}}$ Level 1、Level 0 $\xrightarrow{\text{Ctrl+Click}}$ Level 2、Level 1 $\xrightarrow{\text{Ctrl+Click}}$ Level 2、以及 Level 2 下 Click / Ctrl+Click 均归零回 Level 0；
2. **三类拓扑渲染快照测试**：
   - 单室工具在 Level 0 恒定 1 行；
   - 双室重输入工具（上室 `muted` 导轨 + `$ `，下室状态色导轨，零空行、零横线）；
   - 元工具在 Level 0 展示子工具看板且顶层无 `✓`，在 Level 1/2 隐藏看板展示代码与输出；
3. **免选区复制与滚轮穿透测试**：验证点击右侧图标触发 `primary`、Shift+点击触发 `full`，以及 `wheel` 事件返回 `undefined` 不阻断外层滚动。
