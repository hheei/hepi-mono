# Pi TUI 渲染机制与 Extension 可修改范围

本文基于当前安装的 Pi Coding Agent、`@earendil-works/pi-tui`，以及本仓库的 `pi-loadout`、`pi-extcore` 实现，说明 Pi 如何把交互界面渲染到终端，以及 Extension 可以修改到什么程度。

重点分析当前界面结构：

```text
────────────────────────────────────────
TEXT
────────────────────────────────────────
<path> (git)
↑in ↓out Rcache Wcache CHhit $cost context       (provider) model · thinking
<loadout>
```

其中第一部分是编辑器，最后三行属于 Footer 或 Footer 状态扩展。

---

## 1. 总体渲染模型

Pi 的交互模式由 `InteractiveMode` 创建一个根 TUI：

```text
TUI
├── headerContainer             启动提示、Logo、快捷键说明
├── loadedResourcesContainer    已加载的 skills、prompts、extensions 等
├── chatContainer               用户消息、模型消息、工具调用和工具结果
├── pendingMessagesContainer    排队中的消息
├── statusContainer             Working、Retry、Compaction 等状态
├── widgetContainerAbove        Extension 放在编辑器上方的 widget
├── editorContainer             主输入编辑器
├── widgetContainerBelow        Extension 放在编辑器下方的 widget
└── footer                      当前目录、统计信息、模型和 Extension 状态
```

实现位置：

- Pi 组装 UI：`@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
- Footer：`@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js`
- 根 TUI 和差分渲染：`@earendil-works/pi-tui/dist/tui.js`
- 输入编辑器：`@earendil-works/pi-tui/dist/components/editor.js`

Pi 使用组件树。每个组件实现类似下面的接口：

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}
```

`render(width)` 返回终端要显示的每一行。组件只负责生成字符串数组，不直接操作终端光标。

### 1.1 终端渲染流程

大致流程如下：

```text
状态变化 / 键盘输入 / Extension 调用 requestRender()
              │
              ▼
        TUI.requestRender()
              │
              ▼
      合并短时间内的多次请求
      最小渲染间隔约 16ms
              │
              ▼
          TUI.doRender()
              │
              ├── 根组件 render(width)
              ├── 处理 overlay
              ├── 查找输入光标位置
              ├── 为每行补 ANSI/OSC reset
              ├── 与上一次的 lines 做差异比较
              ├── 只重绘变化的行
              └── 写入终端 ANSI 序列
```

Pi 默认不是每次都清屏重画，而是保留上次的 `previousLines`，只更新有变化的区域。终端宽度改变时通常会进行完整重绘，因为换行结果可能已经改变。

TUI 还会：

- 使用同步输出 ANSI 序列减少闪烁。
- 检查每一行的可见宽度，超过终端宽度会报错。
- 支持 overlay，在现有内容上合成弹窗。
- 支持 Kitty 图片协议。
- 支持隐藏的硬件光标和 IME 光标定位。
- 在组件调用 `invalidate()` 后重新生成缓存内容。

因此，自定义组件最重要的规则是：

1. 每一行不能超过 `render(width)` 收到的宽度。
2. 状态变化后调用 `tui.requestRender()`。
3. 缓存了带主题颜色的内容时，要在 `invalidate()` 中重建。
4. 不要直接写终端 stdout，除非明确知道自己在做什么。

---

## 2. `TEXT`：主输入编辑器如何渲染

界面中的 `TEXT` 不是普通的 `Text` 组件，而是 `@earendil-works/pi-tui` 的 `Editor`，Pi 默认使用它的子类 `CustomEditor`。

当前关系：

```text
InteractiveMode
└── editorContainer
    └── CustomEditor
        └── @earendil-works/pi-tui Editor
```

Pi 的 `CustomEditor` 负责 Pi 层面的快捷键，例如：

- Escape：中断当前任务。
- Ctrl+D：编辑器为空时退出。
- Extension 注册的快捷键。
- 模型切换、思考级别切换等 App 快捷键。

没有被 Pi 层拦截的输入才会继续交给基础 `Editor`，由它处理文字编辑、光标、撤销、历史记录和自动补全。

### 2.1 Editor 的默认视觉结构

`Editor.render(width)` 大致输出：

```text
上边框：────────────────────────────
输入行：TEXT                         
下边框：────────────────────────────
```

编辑器本身负责：

- 根据终端宽度换行。
- 根据终端高度限制可见行数，默认最多约占终端高度的 30%，但至少保留若干行。
- 光标所在字符使用反色显示。
- 输入法需要时输出特殊的零宽光标标记。
- 输入内容滚动时显示 `↑ N more` 或 `↓ N more`。
- 触发 `/`、`@` 等字符时显示补全列表。
- 根据当前 thinking level 改变编辑器边框颜色。

`pi-codex-dollar` 还通过自定义 autocomplete 和编辑器相关逻辑实现 `$skill` 补全、高亮和输入提交前的路径展开。

相关代码：

- `packages/pi-codex-dollar/src/editor.ts`
- `packages/pi-codex-dollar/src/references.ts`
- `packages/pi-codex-dollar/src/picker.ts`
- `@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js`
- `@earendil-works/pi-tui/dist/components/editor.js`

---

## 3. Footer 的三层结构

当前默认 Footer 由 `FooterComponent.render(width)` 返回数组：

```text
第 1 行：工作目录、Git branch、session name
第 2 行：token、cache、cost、context、provider、model、thinking
第 3 行：Extension status，可选
```

源码：

```text
@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js
```

### 3.1 第一行：`<path> (git)`

Footer 会读取：

1. `sessionManager.getCwd()`：当前工作目录。
2. `HOME`：如果当前目录在 HOME 下，会压缩成 `~` 开头。
3. `footerData.getGitBranch()`：当前 Git branch。
4. `sessionManager.getSessionName()`：如果设置了 session name，则继续追加。

例如：

```text
~/Documents/dev/hepi-mono (main)
```

如果设置了 session name，可能变成：

```text
~/Documents/dev/hepi-mono (main) • tui-research
```

Git branch 由 `FooterDataProvider` 负责缓存和监听，branch 改变时请求 TUI 重绘。

### 3.2 第二行：token、cache、context、model

Footer 遍历 session 中所有 assistant message，累计：

- `input`：输入 token。
- `output`：输出 token。
- `cacheRead`：缓存读取 token。
- `cacheWrite`：缓存写入 token。
- `cost.total`：累计成本。
- `CH`：最近一次请求的 cache hit rate。

显示时会压缩数字：

```text
↑12.4k ↓3.1k R40k W2k CH95.2% $0.123
```

Context 部分使用当前 session 的 context usage，而不是简单把所有历史 token 相加。它会考虑 compaction：

```text
82.5%/200k (auto)
```

其中：

- `82.5%`：当前 context 使用率。
- `200k`：当前模型的 context window。
- `(auto)`：自动 compaction 已启用。
- 使用率超过约 70% 时显示 warning 色。
- 使用率超过约 90% 时显示 error 色。

第二行右侧显示：

```text
(provider) model · thinking
```

具体规则：

- `model` 来自当前 `state.model.id`。
- 只有当前模型支持 reasoning 时才显示 thinking level。
- thinking 关闭时显示 `thinking off`。
- 如果可用 provider 多于一个，并且终端宽度足够，才显示 `(provider)`。
- 宽度不足时会先隐藏 provider，再截断右侧内容。

例如：

```text
↑12k ↓2k R30k CH93.1% $0.08 42.0%/128k (auto)       (anthropic) claude-sonnet · high
```

Footer 会保证右侧模型信息尽量右对齐，并根据终端宽度做截断。

### 3.3 第三行：`<loadout>`

`<loadout>` 不是 Pi 核心固定写死的一行，而是 Extension status 系统的一部分。

Pi 核心 Footer 会读取：

```ts
footerData.getExtensionStatuses()
```

然后：

1. 按 status key 字母排序。
2. 清理换行、Tab 和控制字符。
3. 用空格拼接所有 Extension status。
4. 截断到终端宽度。

`pi-loadout` 在 `packages/pi-loadout/src/index.ts` 中调用：

```ts
ctx.ui.setStatus("loadout", statusText);
```

当前 status 格式大致是：

```text
12/18 tools · 5/9 skills
```

如果正在使用 profile，则会带上 profile 名称：

```text
default · 12/18 tools · 5/9 skills
minimal · 8/18 tools · 0/9 skills
```

如果当前状态偏离了 profile，则会带 `*`：

```text
default* · 13/18 tools · 5/9 skills
```

`pi-loadout` 会在以下时机更新它：

- `session_start`：恢复 branch 或 global loadout。
- `session_tree`：切换 session branch。
- settings 加载或修改。
- `/loadout` 或 settings picker 修改工具/技能。
- `showStatus` 被关闭时清除 status。

因此，当前 `<loadout>` 的本质是一个 Footer status，而不是一个独立的布局组件。

---

## 4. Extension 可以修改到什么程度

Pi 的 Extension API 覆盖了三种层次：

```text
增加内容       ── status、widget、通知、命令、autocomplete
替换插槽       ── header、footer、editor、tool renderer、message renderer
拦截行为       ── input、tool_call、context、provider request、session lifecycle
```

### 4.1 增加 Footer status：最安全

如果只想增加或修改类似 `<loadout>` 的信息，使用：

```ts
ctx.ui.setStatus("my-extension", "● active");
```

清除：

```ts
ctx.ui.setStatus("my-extension", undefined);
```

特点：

- 不需要接管 Footer。
- 会和其他 Extension status 拼接到同一行。
- status key 相同会覆盖对方的 status。
- 多个 status 会按 key 排序，不保证注册顺序。
- 适合显示模式、连接状态、任务进度、loadout 摘要。

如果要修改现有 `loadout` 文本，可以在 `pi-loadout` 内部修改 `updateStatus()`；如果是另一个 Extension，则不建议抢占 `loadout` key，而应使用独立 key。

### 4.2 增加编辑器上方或下方内容

```ts
ctx.ui.setWidget("my-widget", [
  "Project mode: review",
  "Press Ctrl+R to refresh",
]);
```

默认位于编辑器上方：

```text
chat / status
my-widget
────────────────────
TEXT
────────────────────
footer
```

放到编辑器下方：

```ts
ctx.ui.setWidget(
  "my-widget",
  ["Progress: 3/10"],
  { placement: "belowEditor" },
);
```

Widget 适合：

- Todo 或进度。
- 当前模式。
- 当前连接或后台任务。
- 不需要修改 Footer 内部结构的提示信息。

Pi 对 widget 有总行数限制，避免 Extension 把编辑器推出终端可视区域。

### 4.3 完全替换 Footer

如果要改变下面这些内容的位置、顺序或格式：

- `<path> (git)`。
- token/cache/cost/context。
- provider/model/thinking。
- Extension status 的排列方式。
- Footer 行数。

就不能只使用 `setStatus()`，而应使用：

```ts
ctx.ui.setFooter((tui, theme, footerData) => ({
  render(width: number): string[] {
    const branch = footerData.getGitBranch() ?? "no-git";
    const model = ctx.model?.id ?? "no-model";

    return [
      theme.fg("dim", `${ctx.cwd} (${branch})`),
      theme.fg("dim", `${model} · custom footer`),
    ];
  },

  invalidate() {},
}));
```

恢复默认 Footer：

```ts
ctx.ui.setFooter(undefined);
```

重要限制：

- `setFooter()` 是整体替换，不是局部 patch。
- 自定义 Footer 需要自己负责宽度、颜色、换行和状态更新。
- 如果要显示完整 token 统计，需要从 `ctx.sessionManager` 的 entries 或 branch 中自行累计。
- `footerData` 可以继续提供 Git branch 和 Extension statuses。
- 多个 Extension 都调用 `setFooter()` 时，后设置的会替换前一个。

因此，如果只是修改 `<loadout>`，优先使用 `setStatus()`；如果要重排整个 Footer，才使用 `setFooter()`。

### 4.4 替换或包装主编辑器

可以替换默认编辑器：

```ts
import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((_tui, theme, keybindings) =>
      new MyEditor(theme, keybindings),
    );
  });
}
```

推荐继承 `CustomEditor`，而不是直接继承基础 `Editor`：

```ts
class MyEditor extends CustomEditor {
  render(width: number): string[] {
    const lines = super.render(width);

    // 修改顶部或底部边框、添加模式标记等
    return lines;
  }

  handleInput(data: string): void {
    if (data === "...") {
      // 自定义输入行为
      return;
    }

    // 保留 Pi 的 Escape、Ctrl+D、模型切换等行为
    super.handleInput(data);
  }
}
```

可以实现：

- Vim/Emacs 模式。
- 修改编辑器边框。
- 增加 INSERT/NORMAL 模式标记。
- 修改光标、自动补全和输入处理。
- 在编辑器内部增加提示行。
- 改变编辑器高度或布局。

如果另一个 Extension 已经替换了 editor，应该先读取并包装它：

```ts
const previous = ctx.ui.getEditorComponent();

ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(theme, keybindings, {
    base: previous?.(tui, theme, keybindings),
  }),
);
```

### 4.5 临时替换编辑器或使用 Overlay

复杂交互可以使用：

```ts
await ctx.ui.custom((tui, theme, keybindings, done) => {
  return new MyDialog({ done });
});
```

它会临时接管编辑器区域，直到调用 `done(value)`。

也可以使用 overlay：

```ts
await ctx.ui.custom(
  (tui, theme, keybindings, done) => new MyOverlay({ done }),
  {
    overlay: true,
    overlayOptions: {
      anchor: "right-center",
      width: "50%",
      maxHeight: "80%",
    },
  },
);
```

Overlay 适合：

- 设置面板。
- 选择器。
- 帮助窗口。
- 预览窗口。
- 不希望清掉聊天内容的 modal UI。

### 4.6 修改输入和 Agent 行为

Extension 不只是 UI，也可以改变输入和 Agent 流程：

| Hook | 能做什么 |
|---|---|
| `input` | 在 skill/template 展开前转换、拦截或处理用户输入 |
| `before_agent_start` | 修改 system prompt，注入额外 message |
| `context` | 修改送给模型的 messages，例如过滤历史 |
| `tool_call` | 修改工具参数或阻止危险调用 |
| `tool_result` | 修改工具返回结果 |
| `before_provider_headers` | 修改请求 headers |
| `before_provider_request` | 查看或替换 provider payload |
| `after_provider_response` | 读取 provider response 状态和 headers |
| `model_select` | 监听模型变化并更新 UI |
| `thinking_level_select` | 监听 thinking level 变化 |
| `session_start` | 恢复状态、初始化 UI |
| `session_shutdown` | 清理进程、socket、watcher、timer |
| `session_before_compact` | 取消或自定义 compaction |

例如，根据模型或 thinking level 更新状态：

```ts
pi.on("model_select", async (event, ctx) => {
  ctx.ui.setStatus("my-extension", event.model.id);
});

pi.on("thinking_level_select", async (event, ctx) => {
  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

### 4.7 修改工具和工具渲染

Extension 可以：

- 注册新工具。
- 修改 active tools。
- 覆盖 built-in tool。
- 只替换执行逻辑而保留 Pi 默认渲染器。
- 自定义 tool call/result 的 TUI。

```ts
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Custom tool",
  parameters: Type.Object({}),

  async execute() {
    return {
      content: [{ type: "text", text: "done" }],
      details: {},
    };
  },

  renderCall(args, theme) {
    return new Text(theme.fg("toolTitle", "My Tool"), 0, 0);
  },

  renderResult(result, options, theme) {
    return new Text(theme.fg("success", "✓ done"), 0, 0);
  },
});
```

如果覆盖 `read`、`bash`、`edit`、`write`、`grep`、`find` 或 `ls`，可以只覆盖 execute，未定义的 `renderCall`/`renderResult` 会继承内置渲染器。但必须保持结果 shape 兼容，否则会影响 session state 和 UI。

---

## 5. 针对当前界面的可行修改方案

### 方案 A：只修改 `<loadout>` 内容

推荐。修改：

```text
packages/pi-loadout/src/index.ts
```

重点函数：

```text
updateStatus(ctx)
```

当前逻辑：

```ts
ctx.ui.setStatus("loadout", `${prefix}${counts}`);
```

可以改成：

```text
[tools 12/18] [skills 5/9] profile=default
```

优点：

- 改动小。
- 不接管 Pi 核心 UI。
- 不影响 token、context、model 显示。
- 与其他 Footer status 兼容。

### 方案 B：增加一行信息

使用 `ctx.ui.setWidget()`：

```text
TEXT 上方或下方增加一行
```

适合显示更长内容，例如当前 profile 的完整工具列表。不要把完整列表塞进 Footer status，因为 Footer status 会被压成一行并截断。

### 方案 C：重排整个 Footer

使用 `ctx.ui.setFooter()`。

适合目标：

```text
<path> · model
context/cache/cost
loadout
custom diagnostics
```

代价是需要自己复制或重新实现 Pi 默认 Footer 的逻辑，包括：

- Git branch。
- session name。
- token 累计。
- cache hit rate。
- cost。
- context usage。
- provider fallback。
- 宽度不足时的截断。

建议只有在布局确实需要整体改变时使用。

### 方案 D：修改 `TEXT` 编辑器区域

使用 `setEditorComponent()` 并继承 `CustomEditor`。

适合目标：

- 改成 Vim modal editor。
- 在边框内增加 mode indicator。
- 改变输入区高度。
- 增加 prompt 前缀。
- 自定义 autocomplete。
- 在输入区渲染额外信息。

不要直接修改 Pi 安装目录中的 `interactive-mode.js` 或 `editor.js`，因为升级 Pi 后会丢失改动，而且会让整个项目无法跟随上游版本。优先使用 Extension API。

### 方案 E：完全改变整个 TUI

如果需要改变根组件的固定顺序：

```text
header → chat → editor → footer
```

或者要修改 Pi 内部状态管理、消息组件组合、滚动策略，则 Extension API 可能不够，需要：

1. 在现有 Extension API 上组合实现，或
2. fork Pi Coding Agent，维护自己的 interactive mode。

一般不建议为了改 Footer 或 Editor 而 fork Pi；`setFooter()`、`setEditorComponent()`、`setWidget()`、`ui.custom()` 已经覆盖大多数需求。

---

## 6. 修改边界与工程注意事项

### 6.1 不要超出宽度

TUI 会检查每行可见宽度。不要只用 `string.length`，应使用：

```ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
```

```ts
render(width: number): string[] {
  return [truncateToWidth(text, width)];
}
```

ANSI 颜色码不计入可见宽度，中文和宽字符也不能简单按 JavaScript 字符数计算。

### 6.2 状态变化后请求重绘

```ts
this.mode = "normal";
tui.requestRender();
```

对于 `setStatus()`、`setWidget()`、`setFooter()` 等 Pi API，Pi 通常会自动请求重绘；自定义组件内部状态变化仍然需要自己调用。

### 6.3 主题变化时重新构建缓存

错误做法是把旧主题生成的 ANSI 字符串永久放在缓存中。正确做法是：

```ts
invalidate(): void {
  super.invalidate();
  this.rebuildWithCurrentTheme();
}
```

主题来自 `ctx.ui.custom()` 或组件 factory 的参数，不要在 Extension 中导入一个固定的全局主题实例代替当前主题。

### 6.4 TUI、RPC、JSON、Print 模式不同

Extension 可能运行在不同模式：

| 模式 | `ctx.mode` | `ctx.hasUI` | 能力 |
|---|---|---:|---|
| Interactive | `tui` | true | 完整终端 UI |
| RPC | `rpc` | true | UI 通过 JSON 协议交互，`custom()` 有限制 |
| JSON | `json` | false | UI 方法通常是 no-op |
| Print | `print` | false | 不能弹出终端交互 UI |

终端专属代码应先判断：

```ts
if (ctx.mode !== "tui") return;
```

### 6.5 多个 Extension 的冲突

- `setStatus(key, text)`：相同 key 会互相覆盖。
- `setFooter()`：后设置的 Footer 会替换前一个。
- `setHeader()`：后设置的 Header 会替换前一个。
- `setEditorComponent()`：后设置的 Editor 会替换前一个，应该先读取并包装旧 factory。
- `ui.custom()` overlay：多个 overlay 按 focus order 管理输入焦点。

### 6.6 长生命周期资源

不要在 Extension factory 中直接启动永不结束的 watcher、socket、timer 或子进程。应在 `session_start` 或真正使用时启动，并在 `session_shutdown` 中清理。

---

## 7. 结论

对当前界面而言，可以按成本分层：

| 目标 | 推荐 API | 成本 |
|---|---|---:|
| 修改 `<loadout>` 文本 | `ctx.ui.setStatus()` | 低 |
| 增加编辑器附近一行 | `ctx.ui.setWidget()` | 低 |
| 增加模式指示器 | `setStatus()` 或自定义 Editor | 低到中 |
| 修改 `TEXT` 的边框和输入行为 | `setEditorComponent()` + `CustomEditor` | 中 |
| 修改 Footer 行顺序和统计内容 | `ctx.ui.setFooter()` | 中 |
| 增加弹窗、选择器、设置面板 | `ctx.ui.custom()` / overlay | 中 |
| 修改工具输出样式 | `renderCall()` / `renderResult()` | 中 |
| 修改输入、工具、上下文、provider 行为 | Extension events | 中到高 |
| 修改整个根布局、滚动和差分渲染 | fork Pi 核心 | 高 |

最推荐的实现路径是：

1. 只改 `<loadout>`：继续使用 `setStatus("loadout", ...)`。
2. 需要更多状态：增加独立 status 或 widget。
3. 需要改变整条 Footer：使用 `setFooter()`，不要修改 Pi 安装目录。
4. 需要改变 `TEXT`：继承 `CustomEditor`，保留 `super.handleInput()`。
5. 只有在需要改变根组件顺序或底层渲染算法时，才考虑 fork Pi。

当前本仓库已经采用了比较合理的分层：

- `pi-loadout` 负责 loadout 状态、active tools、skills 过滤和 Footer status。
- `pi-extcore` 负责共享 settings panel、settings provider 和 TUI layout helpers。
- Pi 核心负责根布局、默认 Editor、Footer、消息和差分渲染。

这意味着大部分 Extension 行为修改都可以在 `packages/*/src/index.ts` 或自定义 TUI 组件中完成，不需要修改 Pi 核心。
