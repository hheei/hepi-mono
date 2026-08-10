# Read 工具移植调研：Pix、Pi 0.84.0 与 pi-ext-tools

## 范围与结论

本记录比较三个一手实现：vendored Pix `pix-read`（revision `2d308c9f5252460c8c26515098af501bd3be8275`）、仓库已解析的 Pi host `0.84.0`、当前 `@hheei/pi-ext-tools`。只研究 `read` 的执行、schema、`content`/`details`、partial/cancel/error、`output://`、TUI renderer 与 frame；不改变任何实现。

**结论（建议）**：当前没有必须移植 Pix 的证据。`pi-ext-tools` 已复用 Pi 0.84.0 的 schema、文件读取、图像、截断、取消和错误语义；Pix 的主要增量是展示与默认 `limit=400`。若产品确认需要紧凑态文件预览，首选在现有 `packages/pi-ext-tools/src/read.ts` 增加一个只处理未展开成功文本结果的 renderer delta；不要复制 Pix 的 `details` 协议、全局折叠状态或 `cli-highlight` 依赖。

## 已确认事实

### 来源与版本

| 对象 | 本地一手来源 | 固定上游来源 |
| --- | --- | --- |
| Pix `pix-read` | `/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-read/src/read.ts` | [pix-mono@2d308c9：pix-read/read.ts](https://github.com/xynogen/pix-mono/blob/2d308c9f5252460c8c26515098af501bd3be8275/packages/pix-read/src/read.ts) |
| Pi host `0.84.0` | `/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js` | [pi v0.84.0：packages/coding-agent/src/core/tools/read.ts](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/tools/read.ts) |
| 当前扩展 | `/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-tools/src/read.ts` | 本仓库工作树 |

Pi 安装包的 `package.json:2-3` 确认版本为 `0.84.0`，`package.json:82-85` 指向 `earendil-works/pi` 的 `packages/coding-agent`。本地 `read.js.map` 的 `sources[0]` 是 `../../../src/core/tools/read.ts`，与上述 tag URL 的源文件位置一致。远端 `v0.84.0` tag 已解析为 `a5f43bf8aff3c55752432655f7334e3dafd1e256`。Pix vendored tree 是 Git worktree，HEAD 为上述 `2d308c9...`，origin 为 `https://github.com/xynogen/pix-mono.git`。

### 调用链

```text
Pi host ToolExecutionComponent
  -> 当前注册的 read ToolDefinition
     -> withToolFrame.execute
        -> pi-ext-tools/read.execute
           -> output:// ? OutputRegistry.read
           -> 否则 FFF resolvePath（可用且启用时）
           -> Pi createReadToolDefinition(context.cwd).execute
              -> resolve/read/access/image-or-text/truncate
  -> withToolFrame.renderCall/renderResult
     -> Pi 原生 read renderer（除 frame 自己折叠的旧 trace）
  -> Pi host self-render container / 图像组件
```

当前扩展用 `createReadToolDefinition(process.cwd())` 取得 template 以保留名称、说明、TypeBox schema 和 renderer；每次执行又以 `context.cwd` 新建原生定义，避免 extension 构造时 cwd 泄漏到 tool call。它仅在原生执行前处理 `output://` 与 FFF 路径解析；关闭 `readEnhancement`、未建立 FFF runtime、解析失败或异常时均直接回退到原生执行。依据：`packages/pi-ext-tools/src/read.ts:15-49`。

随后 `registerManagedLoadoutTool()` 用 `withToolFrame(tool, trace)` 注册该 definition；Loadout transport 最终调用 Pi 的 `registerTool`，不会替换 execute。依据：`packages/pi-ext-tools/src/read.ts:52-65`、`packages/pi-ext-core/src/loadout.ts:346-359`。

### Schema 与模型可见结果

Pi 0.84.0 的公开 `ReadToolInput` 是严格的 TypeBox object：必填 `path: string`，可选 `offset: number`（从 1 开始）、`limit: number`。其说明、prompt snippet 和 guideline 也来自原生 factory。`pi-ext-tools` 未改 schema。依据：Pi `dist/core/tools/read.js:16-20,130-142`、`read.d.ts:4-10,32`；当前包装 `packages/pi-ext-tools/src/read.ts:15-19`。

Pi 原生文本流程为：UTF-8 读取、按 offset/limit 选择行、再实施 2,000 行或 50 KiB 截断；截断内容与继续读取的 `offset` 提示进入模型可见 `content[0].text`，`details` 只携带可选 `truncation`。图像流程产生文本提示；成功处理时另产生 `{ type: "image", data, mimeType }`。依据：Pi `read.js:130-255`、`read.d.ts:12-32`。

Pix 先把未给 `limit` 的请求改为 `400`，再调用原生 tool。因此它改变模型可见文本的范围，不只是 UI。成功文本时，它以归一化后的**原生返回文本**覆写 `details` 为 `{ _type: "readFile", filePath, content, offset, lineCount }`；成功图像时覆写为 `{ _type: "readImage", filePath, data, mimeType }`。这也会覆盖原生 `truncation` details。依据：Pix `packages/pix-read/src/read.ts:35-97`。

当前 frame 不改 `content`，但成功返回时会在对象型 `details` 合并私有 `__piExtToolsCompletion`（耗时/警告），或在原 `details` 为 `undefined` 时创建只含该私有字段的 details。依据：`packages/pi-ext-tools/src/pretty/frame.ts:101-128,192-211`。因此 Output URI 分支在 `read.ts` 内返回 `details: undefined`，但经最终注册工具返回时仍会有 frame 的 completion details。

### Partial、取消与错误

Pi `read` 接收 `onUpdate` 但从不调用它，故原生 read 没有 partial content；Pix 仅透传该 callback，当前扩展也只透传给原生 definition。Pi API 和 renderer 支持 `isPartial`，但这不是 read 实际产生的状态。依据：Pi `read.js:140-255`、`dist/core/extensions/types.d.ts:307-375`；Pix `read.ts:56-69`；当前 `read.ts:19-48`。

Pi 在 signal 已 abort 或执行中 abort 时 reject `Error("Operation aborted")`；路径、权限、读取、图像处理或 offset 越界错误也 reject。Pix 不捕获这些 reject。当前 frame 记录错误首行与耗时后重新抛出，不将取消或错误伪装成成功 ToolResult。依据：Pi `read.js:140-155,247-253`；Pix `read.ts:63-72`；当前 `pretty/frame.ts:204-211`。

Pi host 的 `ToolExecutionComponent` 把结果 `isError`、`isPartial`、展开状态、图像显示能力传给 renderer；renderer 抛错时 host 回退到文本输出。`renderShell: "self"` 时 host 不绘制默认 Box，但仍在结果 content 中发现图像并按 terminal capability 追加 Image component。依据：Pi `dist/modes/interactive/components/tool-execution.js:44-56,92-105,181-191,206-255`。

Pix renderer 虽含“structured error”分支，但它只有在原生 `execute` 成功返回后才写入结构化 details；上述原生失败会 reject。因此该分支不是普通文件读取失败的已证实运行时路径；其单测使用人工构造的 details。依据：Pix `read.ts:70-97,122-170`、`packages/pix-read/src/read.test.ts:150-205`。

### Output URI

`OutputRegistry` 只接受 `output://` 后接正安全整数的 URI，内容写入 process-shared 临时文件；`read(uri, {offset, limit})` 按 Pi 的 1-based line offset/limit 返回文本，不公开 backing path。`dispose()` 特意不删除内容，进程退出负责清理。依据：`packages/pi-ext-core/src/output.ts:6-15,40-98`、`packages/pi-ext-core/test/output.test.ts:5-35`。

当前 read 在 session lifecycle 已提供 registry 时优先处理 `output://`：它将原请求的 offset/limit 传给 registry，返回一个 text content，且不会调用 FFF 或 Pi 原生 reader。未知或格式错误 URI 的错误由 registry 抛出；若 registry 尚不可用，路径会回退原生 reader。依据：`packages/pi-ext-tools/src/read.ts:19-33`、`packages/pi-ext-tools/src/fff/lifecycle.ts:88-114`、`packages/pi-ext-core/src/lifecycle.ts:110-154`。

这项集成是当前独有行为；Pix `pix-read` 没有 `output://` 分支。它保持分页语义，但 Output URI 没有文件扩展名、MIME、原生 truncation details 或命名元数据。

### TUI renderer 与 frame

Pi 原生 read call renderer 显示路径及行范围；对未展开且非错误的结果返回空文本。展开后，它按文件扩展名高亮，默认展示全部已返回文本；未展开的错误最多展示十行，并显示原生 truncation 提示。依据：Pi `read.js:100-128,258-269`；source map：`dist/core/tools/read.js.map` 的 `sourcesContent`。

Pix 使用独立 `TextComponent` renderer：未展开仍显示最多 `MAX_PREVIEW_LINES` 行；异步调用 `renderFileContent()`，按 offset 加行号、语法高亮、终端宽度截断，并在结果完成后调用 `invalidate()`。它还以 `pix-runtime` 的 timer 在默认 10 秒后将 read 折叠为单行，展开时恢复预览或诊断。依据：Pix `packages/pix-read/src/read.ts:102-223`、`packages/pix-pretty/src/renderers.ts:13-48`、`packages/pix-read/README.md:5-28`。

当前 `withToolFrame` 设定 `renderShell: "self"`，显示 pending/success/error 前缀与路径摘要，移除原生 tool background，再调用原生 `renderCall`/`renderResult`。它传入 `lastComponent: undefined`，所以不会复用 Pi 原生 Text component；但共享同一 renderer state。每轮 `agent_start` 增加 trace，非展开的旧 trace 被 frame 折成标题与耗时/错误摘要，直到用户展开。它不是 Pix 的 per-tool 10 秒 timer。依据：`packages/pi-ext-tools/src/pretty/frame.ts:192-255`、`packages/pi-ext-tools/src/pretty/trace.ts:1-64`、`packages/pi-ext-tools/src/extension.ts:9-19`、`packages/pi-ext-tools/test/pretty/frame.test.ts:45-118`。

## 具体差距

以下是来源可直接验证的差异，不等同于缺陷优先级。

| 范围 | Pix | 当前 pi-ext-tools + Pi | 影响 |
| --- | --- | --- | --- |
| 未展开成功文本 | 行号、高亮、有限预览 | Pi renderer 返回空结果；frame 只保留 call/header | 用户需要展开才看文件内容；Pix 更利于快速审阅。 |
| 折叠触发 | 完成后默认 10 秒 | 下一个 `agent_start` 后旧 trace 折叠 | 折叠节奏和可见性不同。 |
| 默认读取量 | 未指定时 400 行 | 未指定时原生硬上限 2,000 行/50 KiB | Pix 减少模型 context；当前保留 Pi 原生数据契约。 |
| details | 文件路径、文本/图像、lineCount；会覆盖 truncation | 原生可选 truncation，加 frame completion | Pix renderer 数据更富；当前保留原生截断信息。 |
| Output URI | 未见支持 | 只读文本、可分页、无名字/MIME/截断 details | 能读 extension 产生的大输出，但展示会显示 URI，而非可读资源名。 |
| 错误与取消 | 原生 reject；renderer 的结构化错误分支缺少普通失败的 producer | 原生 reject；frame 记录后重抛，host 以 `isError` 渲染 | 两者都不把失败变成功；Pix 单测的结构化失败外观不能视为实测 read 失败行为。 |
| 流式 partial | 原生 read 未产生；Pix 未增加 | 原生 read 未产生；frame 仅能显示 host 传入的 partial 状态 | 无实际 read 进度 UI，非当前移植遗漏。 |

## 最小 Pi 兼容设计选项（建议）

### 选项 0：不改动

维持当前实现。它已提供 Pi 兼容 schema、原生取消/error/图像/截断，以及 Output URI 分页。选择此项时不移植 Pix 的 `limit=400`、`details` 覆写、timer、`cli-highlight` 或全局状态。**这是当前首选**，直到有明确用户需求证明“未展开预览”或“行号”不足。

### 选项 1：只补未展开文本预览

在现有 `packages/pi-ext-tools/src/read.ts` 为 read 增加 renderer delta，保持 `execute`、schema、`content` 和原生 `details` 不变：

1. 仅对 `!expanded && !isError && !isPartial` 的 text result 从 `content` 取前 N 行，使用公开的 `@earendil-works/pi-tui` `Text` 渲染，并显示还有更多行的提示；展开或 error 继续调用当前原生 renderer。
2. 由现有 `withToolFrame` 继续负责 frame、trace、耗时和 host 背景处理；不改 shared frame API，不加 abstraction。
3. Output URI 自动获得同一预览；仍只显示 URI，除非以后确认要引入资源显示名。

此方案无需新依赖，也不触碰 Pi 的私有 `highlightCode` 入口。它只覆盖已确认最大 UI 差距，但不会复制 Pix 语法高亮或行号。实施前应新增一个 focused test，断言 schema/content/details、abort/error 均与原生 factory 相同，并覆盖 collapsed/expanded/error/Output URI。

### 选项 2：上游 Pi host 改进

若期望所有 Pi read consumer 都有未展开预览、稳定行号或 syntax rendering，应在 Pi `read.ts` 的原生 renderer 中实现，再以 host 版本升级获得行为。扩展不应深导入 Pi 未导出的 theme/highlight internals，也不应把 host 私有依赖当公共 API。该选择影响所有 host 用户，需 Pi 项目接受产品契约与版本策略。

### 明确不建议

不要为对齐 Pix 而复制 `{ _type: "readFile" | "readImage" }` details 协议或 `cli-highlight`。前者丢失 Pi 的 truncation details 并把模型返回文本再存一份；后者引入未声明依赖及 Pix 的环境/缓存行为。若未来确实要自动定时折叠，必须把 timer 绑定 session lifecycle 的 AbortSignal，并验证 reload、session replacement 与窄/宽 TUI；在已有 trace 折叠机制上提前加此状态没有已证实消费者。

## 复核清单

本记录只读取本地源码、安装包、source map 与远端 Git refs。未运行或修改 runtime source/test。未来实施选项 1 的最小验证应是：`bunx biome check --write <changed-path>`、`bunx biome check <changed-path>`、`bun test <focused-test>`；若影响公开 read contract，再运行 package typecheck。
