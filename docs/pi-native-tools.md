# Pi 原生工具、渲染与扩展概览

本文面向为 Pi host 编写 extension 的开发者，说明原生工具如何执行、工具结果如何进入模型和 TUI，以及 extension 可以控制的边界。它是沟通和设计概览，不替代上游 TypeScript 类型、源码或 focused tests。

## 已检查的 Pi 位置

本机安装的 Pi host：

```text
/home/chlo/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent
```

本记录基于已安装的 `@earendil-works/pi-coding-agent` `v0.84.1`。发行包包含编译产物和 source map；source map 的 `sourcesContent` 保留了对应 TypeScript 源码。查阅原生工具时优先使用：

```text
dist/core/tools/grep.js.map
dist/core/tools/find.js.map
dist/modes/interactive/components/tool-execution.js.map
```

上游源码仓库：<https://github.com/earendil-works/pi-mono>。本地安装版本可能落后或领先于上游 `main`，设计和实现必须以所运行的版本为准。

## 心智模型

Pi 将工具结果拆为两条独立但相关的路径：

```text
工具返回 content/details
       │
       ├── 模型路径：最终 toolResult message 的 content 进入下一次模型请求
       │
       └── 显示路径：ToolExecutionComponent 以 renderer 将 call 和 result 显示在 TUI
```

- `content`：给模型的内容块，最终会持久化为 session 的 `toolResult` message。
- `details`：结构化、extension 私有或 renderer 所需数据；同样持久化，但不要求作为模型文本理解。
- TUI renderer 是显示层。它不会自动改变模型收到的 `content`。
- 需要改变模型可见结果时，使用 `tool_result` event；只需要改变终端显示时，使用 `renderCall`、`renderResult` 或 message/entry renderer。

原生工具必须主动限制输出，避免压垮上下文。通用上限是 `50KB` 或 `2000` 行，以先触发者为准。工具可以使用 `truncateHead`、`truncateTail` 和 `truncateLine`，并把截断信息写入 result 和 `details`。

## 工具调用过程

一次工具调用的主要顺序如下。并行工具模式下，相邻工具的 update/end 可以交错；下图只描述一个 tool call。

```text
assistant tool call
  -> tool_execution_start
  -> tool_call                         extension 可改 input、阻止调用
  -> tool.execute(..., onUpdate, ...)
       -> onUpdate(partial result)
       -> tool_execution_update        TUI 可显示 partial result
  -> tool_result                       extension middleware 可 patch 最终结果
  -> tool_execution_end
  -> 按 assistant source order 写入最终 toolResult message
  -> 下一次模型请求读取该最终结果
```

关键规则：

- `tool_call` 的 `event.input` 可变；修改会传给实际执行，但 Pi 不会重新校验被修改后的参数。
- `tool_result` 依 extension 加载顺序串行执行。后一个 handler 会看到前一个 handler 已 patch 的 `content`、`details`、`isError` 或 `usage`。
- `onUpdate()` 是进度/partial output，不是最终 session result。它触发 `tool_execution_update`，不会经过最终 `tool_result` middleware。
- 工具抛出异常才会生成 `isError: true`；返回普通对象不会把调用标为失败。
- `ctx.signal` 是当前 agent turn 的取消信号。执行 I/O、child process 或 nested request 时必须传递它。

## 工具渲染

Interactive mode 用一个 `ToolExecutionComponent` 表示一个 tool call。默认布局是同一 row 内先 call、后 result：

```text
renderCall(args)
renderResult(result, options)
```

这不是“一次 call render 加一次 result render”的严格生命周期。TUI 在参数流式到达、execution start、partial update、最终结果、展开状态、主题变化和窗口宽度变化时，都可能重新调用 renderer。

### `renderCall`

`renderCall(args, theme, context)` 负责工具标题和调用参数的紧凑显示。它通常在工具执行期间已存在，并可以随 arguments streaming 更新。

### `renderResult`

`renderResult(result, { expanded, isPartial }, theme, context)` 负责 output 显示。

- partial update：`isPartial === true`，result 来自 `onUpdate()`；它尚未经过最终 `tool_result` middleware。
- final result：`isPartial === false`，result 已经过 `tool_result` middleware；它的 `content` 是模型将收到的最终内容。
- `isError` 位于 `context.isError`，不在传入 result 对象上。
- `context.lastComponent` 可复用同一个 Component，避免每次 render 创建新对象。
- `context.state` 是该工具 row 的临时共享状态，可在 call/result 两个 slot 间共享；不能作为跨 session 持久化状态。
- 默认 shell 是带 padding/background 的 `Box`。只有需要完全控制边框、padding 和背景时才设 `renderShell: "self"`。

没有 renderer 或 renderer 抛错时，Pi 使用 fallback：call 显示工具名，result 显示 `content` 的文本。renderer 不应成为工具执行失败的原因。

原生 `grep` 默认只显示 15 行，`find` 默认只显示 20 行；展开工具输出后才显示该结果的其余已保存文本。全局展开状态可由 `ctx.ui.getToolsExpanded()` / `setToolsExpanded()` 查询和设置。

### 实际显示结构示例

以下是用户调用原生 `grep` 后、工具已完成但仍折叠时的示意。文字、颜色、边框和精确标题随 Pi 版本与 theme 变化；标注的结构和数据来源不变。

```text
(A)  grep  pattern="Pi"  path="docs/pi-native-tools.md"
(B)  docs/pi-native-tools.md:1: # Pi 原生工具、渲染与扩展概览
     docs/pi-native-tools.md:3: 本文面向为 Pi host 编写 extension 的开发者，说明原生工具如何执行...
(C)  [15 lines shown. Expand for remaining output]
```

| 标记 | TUI 上的含义 | 对应代码元素 |
| --- | --- | --- |
| A | 调用名称和已解析参数；执行中也会先显示这里。 | `ToolExecutionComponent` 的 call slot；工具的 `renderCall(args, theme, context)`。 |
| B | 结果内容。原生 grep 的每一行使用 `path:line: text` 格式。 | 最终 `renderResult(result, { isPartial: false, ... }, theme, context)`；`result.content` 已经过 `tool_result` handler。 |
| C | 结果折叠提示，不是新的模型内容。展开只改变显示。 | `ToolExecutionComponent` 的 `expanded` state；传给 `renderResult` 的 `options.expanded`。 |

原生 `grep` 当前不会调用 `onUpdate()`，所以它只在完成后显示最终 B 区。若自定义工具在运行中通过 `onUpdate()` 发送进度，B 区会先以 partial result 重绘：

```text
(A)  indexed-search  pattern="Pi"  path="docs/pi-native-tools.md"
(B)  Searching docs/pi-native-tools.md ...
     12 matches found so far
```

此时 B 对应 `renderResult(partialResult, { isPartial: true, ... })`。它仅用于显示进度，未写入最终 `toolResult` message，也未经过 `tool_result` middleware。最终 result 到达后，Pi 重绘 A 和 B；B 改为最终、可持久化的内容。

## TUI 元素和 Pi API 对照

| 用户可见元素 | Pi API / 运行时对象 | 用途和 owner |
| --- | --- | --- |
| 工具调用 row | `ToolExecutionComponent` | Pi host 组合 call/result、背景、展开状态和图片。 |
| 工具标题/参数 | `renderCall()` | ToolDefinition 或 override 提供。 |
| 工具输出 | `renderResult()` | ToolDefinition 或 override 提供。 |
| 普通用户/assistant Markdown | `registerMarkdownTransformer()` | 仅改变显示，不改 session 或模型 context。 |
| 自定义、模型可见消息 | `sendMessage()` + `registerMessageRenderer()` | custom message 参与模型 context。 |
| 自定义、仅 TUI 条目 | `appendEntry()` + `registerEntryRenderer()` | custom entry 不进入模型 context。 |
| 编辑器上/下 widget | `ctx.ui.setWidget()` | editor 邻接内容；extension 负责注册和 cleanup。 |
| footer 状态片段 | `ctx.ui.setStatus()` | 追加到原生 footer。 |
| 自定义 footer | `ctx.ui.setFooter()` | 完全替换原生 footer。 |
| 编辑器 | `ctx.ui.setEditorComponent()` | 替换输入组件；应继承 `CustomEditor` 保留宿主快捷键。 |
| 临时交互界面 | `ctx.ui.custom()` | 暂时替换编辑器；可用 `{ overlay: true }` 显示 overlay。 |
| 通知/对话框 | `ctx.ui.notify()`、`select()`、`confirm()`、`input()`、`editor()` | TUI/RPC 可用程度不同。 |
| 主题、重绘 | callback 中的 `theme`、`tui.requestRender()` | 状态变化后请求重绘；组件 `invalidate()` 必须清除 theme cache。 |

`Component` 的最小契约是 `render(width): string[]`、`invalidate()` 和可选 `handleInput(data)`。每个输出行都不能超过 `width`；使用 `visibleWidth`、`truncateToWidth` 或 `wrapTextWithAnsi` 处理 ANSI 和 cell width。

TUI 相关能力只在 `ctx.mode === "tui"` 时完整可用。RPC mode 提供部分 dialog/notification 协议；print/JSON mode 的 UI 方法是 no-op 或默认返回值。extension 必须为无 TUI 情况提供明确 fallback。

## Extension 可以控制什么

### 工具和 agent flow

- `pi.registerTool()`：注册工具；可提供 schema、execute、partial update、renderer 和 prompt metadata。
- 同名注册 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`：覆盖原生实现。缺少的 renderer slot 会继承原生 renderer。
- `pi.getActiveTools()` / `setActiveTools()`：读取或修改当前 active tools；CLI `--tools`/`--exclude-tools` 也会限制可用集。
- `pi.on("tool_call")`：修改 input 或 block。
- `pi.on("tool_result")`：修改最终模型可见结果及其 details/usage/error 状态。
- `pi.on("context")`、`before_agent_start`、`before_provider_request`：分别修改模型 context、Pi system prompt 或 provider payload；它们是不同层，不应混用。

### 会话和界面

- 可注册 command、shortcut、flag、provider、message renderer、entry renderer、Markdown transformer。
- 可监听 session、agent、turn、message、tool、model 和 compaction lifecycle event。
- 可通过 `ctx.ui` 管理状态行、widget、footer、editor、custom component、overlay、theme 和工具展开状态。
- extension factory 有完整进程权限，但 Pi 不替 extension 管理自行创建的 timer、socket、watcher 或 process。它们必须在 `session_shutdown` 幂等清理。

不要用 extension 直接持有宿主内部 runtime。使用 `ExtensionAPI`、event、tool result details 和已公开的 UI/context 门面。session replacement 或 `/reload` 后，旧 `pi` / `ctx` session 对象可能已失效。

## 原生 `grep`：ripgrep 包装器

源码位置：`dist/core/tools/grep.js.map`，对应上游 `src/core/tools/grep.ts`。

`grep` 是对 `rg` 的结构化包装，不是 shell alias。执行参数核心为：

```text
rg --json --line-number --color=never --hidden [options] -- <pattern> <searchPath>
```

| Pi 参数 | ripgrep 行为 |
| --- | --- |
| `pattern` | regex；`literal: true` 时加 `--fixed-strings`。 |
| `path` | 解析为 cwd 内绝对搜索 root。 |
| `glob` | 加 `--glob <glob>`。 |
| `ignoreCase` | 加 `--ignore-case`。 |
| `context` | Pi 自己重读命中文件，生成前后 N 行。 |
| `limit` | 默认 `100`；到达后停止 `rg` child process。 |

Pi streaming 解析 `rg --json` 的 `match` event。无 context 时使用 rg 提供的 matched line；有 context 时通过 `readFile()` 重新读取文件。结果格式为 `path:line: text`，context 行格式为 `path-line- text`。

每个展示行最多 `500` 个字符；整体仍受 `50KB` 限制。达到 match、byte 或 line 截断时，结果会附带可操作 notice，并在 `details` 标识原因。

Pi 查找可执行文件的顺序是自带 bin 目录、系统 PATH、下载。`rg` 缺失且非 offline 时，会从 `BurntSushi/ripgrep` release 下载；`PI_OFFLINE` 禁止下载。Termux 不下载不兼容的 Linux binary。

注意当前 `GrepOperations` 只暴露 `isDirectory()` 和 `readFile()`，用于路径验证和 context 行读取；实际匹配仍由本地 `rg` child process 执行。不要把它当成完整 remote grep transport。

## 原生 `find`：fd 包装器

源码位置：`dist/core/tools/find.js.map`，对应上游 `src/core/tools/find.ts`。

`find` 使用 `fd`，不是 POSIX `find`：

```text
fd --glob --color=never --hidden [git behavior] --max-results <limit> -- <pattern> <searchPath>
```

| Pi 参数 | fd 行为 |
| --- | --- |
| `pattern` | fd glob。包含 `/` 时加 `--full-path`，并修正为 `**/<pattern>` 以匹配 absolute candidate path。 |
| `path` | cwd 内搜索 root。 |
| `limit` | 默认 `1000`，同时仍受 `50KB` 限制。 |

在 git repo 内，Pi 保留 fd 默认的 git-aware ignore，以使 nested repo 正确形成 ignore boundary；repo 外增加 `--no-require-git`。结果统一相对化为 search root，并归一为 POSIX `/` separator。

`FindOperations.glob()` 是完整替换点：提供时不会执行 `fd`，并收到 glob、search root、`node_modules`/`.git` ignore 和 limit。它适合 SSH、container 或索引后端。没有 custom operation 时，Pi 以自带 bin、`fd`/`fdfind` PATH、下载的顺序解析 `fd`；下载来源是 `sharkdp/fd` release。

## 开发沟通模板

与 agent 讨论工具或 TUI 改动时，先明确以下问题：

1. 改动影响模型可见 `content`、持久化 `details`、还是仅 TUI？
2. 改动在 `tool_call`、工具 execute、`tool_result`、renderer，还是 session lifecycle 发生？
3. partial update 是否需要显示？最终结果是否需要保留完整、可恢复 details？
4. 无 TUI、取消、reload/session replacement 和 renderer failure 时的 fallback 是什么？
5. 现有 Pi renderer、TUI primitive 或内建工具 override 是否已经覆盖需求？

优先使用已有 Pi API 和 renderer。只有当原生工具或 primitives 不能表达明确需求时，才增加 extension 自有状态或抽象。
