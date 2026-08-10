# `pi-codex-conversion`：渲染与工具结果传递

> 调研对象：`IgorWarzocha/howaboua-pi-stuff` 的 `packages/pi-codex-conversion`。
> 固定版本：[`d2e26e0e14c410152685fea56dcda48a6603044a`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion)，提交日期 2026-08-09。
> 范围：仅基于该 revision 已克隆的源码；本文的「模型」指下一轮 OpenAI Responses 请求接收者。

## 结论

1. TUI 与模型上下文是两条独立路径。工具返回 `{ content, details }`；`renderCall` / `renderResult` 读 `details` 和展示选项构造 Pi TUI `Component`，但后续模型请求只从 `toolResult.content` 取文本、图像或 web-run 加密项。[工具注册](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/extension/tools.ts#L24-L59) [Responses 转换](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/providers/openai-responses/shared.ts#L193-L229)
2. Structured mode 暴露 `exec_command`、`write_stdin`、`apply_patch`（及可选图像/web 工具），不是 Code Mode 的 `exec` / `wait`。[工具名集合](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/adapter/activation/tool-set.ts#L15-L20)
3. `apply_patch` 是真实结构化工具，不是 shell 替代品：输入为 `{ input: string }`，按受影响绝对路径取得 Pi `withFileMutationQueue` 后调用 bundled Rust helper；成功结果是固定摘要文本，部分成功返回文字结果并由 `tool_result` 标记为 error。[实现](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/tool.ts#L25-L29) [执行与结果](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/tool.ts#L136-L191) [错误标记测试](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/tests/tool-result-contracts.test.ts#L7-L19)

## Structured mode：准确数据流

```text
assistant toolCall
  -> Pi 调用 registered tool.execute(...)
  -> { content, details } 写为 Pi toolResult
  -> TUI: renderCall(args, theme, context) + renderResult(result, options, theme, context)
  -> 下次请求: convertResponsesMessages(context.messages)
  -> Responses function_call_output/custom_tool_call_output
```

`buildRequestBody` 以当前 `Context` 调用 `convertResponsesMessages`，把结果放入 `body.input`；同一处把工具定义转为 Responses `function` 或 grammar `custom` tool。[request-body.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/providers/openai-codex/request-body.ts#L29-L72) [tool schema 转换](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/providers/openai-responses/shared.ts#L256-L285)

对每一条 `toolResult`，转换器行为精确如下：[shared.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/providers/openai-responses/shared.ts#L193-L229)

- 取全部 `content` 中 `type === "text"` 的 `text`，以单个 `"\n"` 连接；忽略 `details`、TUI 组件、ANSI 样式、`isError`。
- 若 `details` 含有效 web-run 加密输出，发送 `{ type: "encrypted_content", encrypted_content }`，覆盖普通文本/图像输出。
- 否则，若有图像且目标模型支持 image input，输出可选 `input_text` 加每个 `input_image` data URL；若不支持，发送文本，或无文本时发送字面量 `"(see attached image)"`。历史正规化中，不支持图像的模型会将工具图像替换为 `"(tool image omitted: model does not support images)"`。[message-history.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/providers/openai-responses/message-history.ts#L7-L52)
- 外层项类型依 grammar custom tool 与否为 `custom_tool_call_output` 或 `function_call_output`；`call_id` 是 `toolCallId` 的 `|` 前段。因此模型实际收到的是该 `output`，不是界面折叠预览。

### `exec_command` / `write_stdin`

两工具把 `UnifiedExecResult` 同时放到 `details`，并把 `formatUnifiedExecResult` 生成的完整文本放进 `content[0]`。文本依序包含可选 `Command:`、`Chunk ID:`、`Wall time:`、退出码或持续运行 session 提示、可选原 token 数、`Output:` 与完整原始 output。[exec_command](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/exec/command-tool.ts#L164-L178) [格式](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/exec/format.ts#L3-L27) [write_stdin](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/exec/write-stdin-tool.ts#L70-L90)。

所以 TUI 截断不是模型截断：`exec_command` 折叠态最多显示 5 个视觉行，且将原 output 限于最近 16,000 字符、160 行；展开态显示 `details.output`。模型仍收到未经过 renderer 的完整格式化 `content` 文本。[折叠 renderer](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/exec/command-tool.ts#L76-L162) `write_stdin` 也仅在 UI 折叠的 partial 更新显示末尾 8,000 字符中的最后 5 行。[write_stdin renderer](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/exec/write-stdin-tool.ts#L97-L119)。

调用显示由 `renderExecCommandCall` 用 `summarizeShellCommand` 分类为 Exploring/Explored 的 read/list/search，或 Running/Ran 的原命令；至多显示五行命令，每行 100 字符。`write_stdin` 显示 interacted/waited 与关联命令预览。[codex-rendering.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/ui/tool-rendering/codex-rendering.ts#L8-L96)

### `apply_patch`

模型调用为标准 Responses `function_call`：`name: "apply_patch"`，参数 JSON 为 `{"input":"*** Begin Patch ..."}`。`prepareApplyPatchArguments` 兼容历史 `patchText` / `patch` 入参，但注册 schema 和执行器的有效契约仍是 `input` 字符串。[参数适配与 schema](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/tool.ts#L16-L54)

- 成功时模型收到且只收到一段文本：`Applied patch successfully`、`Changed files: N`、`Created files: N`、`Deleted files: N`、`Moved files: N`、`Fuzz: N`，以换行连接；详细文件列表在 `details.result`，不会送入 Responses output。[成功路径](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/tool.ts#L173-L191)
- 完全失败时抛出带 `apply_patch failed ...` 的 `Error`；部分失败时仍返回一段文本，含失败文件、必须先 read 失败文件、已应用动作不可盲目重读等恢复指令，并在事件层变为 error result。[失败构造](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/tool.ts#L80-L171)
- TUI 调用阶段先缓存原 patch 与 cwd；参数未完整或空时显示 `Patching`。完成后，collapsed 显示单/多文件增删统计，`showDiffWhenCollapsed` 时最多额外 10 行 diff；expanded 显示所有 parser 推导的变更预览。部分/完全失败把首行和失败目标换成告警/错误色。`renderResult` 故意返回空 `Container`，故 patch 预览全在 call cell，不是 result cell。[状态选择](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/render-state.ts#L118-L142) [diff 预览](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/rendering.ts#L27-L107) [空 result renderer](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/tool.ts#L193-L196)。

## Code Mode：`exec` / `wait` 与嵌套工具

Code Mode 公开给模型的是 `exec({ code })` 与 `wait({ cell_id, ... })`；`exec` 将 JavaScript 交给共享 host，并传入 `runtime.collectTools(ctx)`，后者可包含 `apply_patch`、`exec_command`、`write_stdin` 等嵌套工具。[public-tools.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/code-mode/public-tools.ts#L43-L86) [嵌套工具列表](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/adapter/code-mode.ts#L50-L151)。

嵌套适配器执行原 Pi 工具、把 text/image 更新转发给 host、捕获完整 `{ content, details }` 为 trace；返回给脚本的默认值是 `details` 中的 `output` 对象，否则文本拼接。两个特例：嵌套 `apply_patch` 接受 freeform patch string 并转换成 `{ input }`，部分失败会在脚本层抛错；嵌套 `exec_command` 成功时返回原 `details`（包括 `output`、`session_id`、退出码），不是 Structured mode 的格式化 transcript。[nested-tool-adapter.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/adapter/code-mode/nested-tool-adapter.ts#L39-L120) [Code Mode 特例](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/adapter/code-mode.ts#L55-L117)。

外层 `exec` / `wait` 的 Pi tool result 来自 `toCodeModeToolResult`：首项永远是 `Script completed` / `Still running ...` / `Script terminated` / `Script error: ...`；后接 host 的 text/image content。文本总预算为 `min(MAX_CODE_MODE_OUTPUT_TOKENS, max(1, max_tokens 或 host/default)) * 4` 字符，超出加入 `[Output truncated]`；最多保留 4 张、合计 16 MiB base64 图像。`details` 保留 `codeMode`、cell 状态、嵌套 traces 和脚本错误。[tool-result.ts](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/code-mode/tool-result.ts#L9-L84)。因此下一轮模型收到的是这个已预算截断的 `content`，不是单独再序列化 `details.traces`。

Code Mode TUI 先显示外层 `Running/Started/Ran code` 或 wait 状态；结果 renderer 从外层 content 去掉首个 status（除通知/缺 details），再渲染 traces。每个 trace 优先复用嵌套工具自己的 `renderCall`/`renderResult`，失败则输出 trace error；无自定义 renderer 才显示通用 JSON 输入与 text/image result。外层折叠输出最多 5 个视觉行、宽度 100，展开或 partial 才完整显示；这不改变 model-bound `content`。[Code Mode renderer](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/code-mode/rendering.ts#L45-L186) [trace fallback 与预览](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/code-mode/rendering.ts#L187-L318)。

## 对移植的直接含义

- 需要模型可靠得知 shell 结果时，保留 `content` 的完整 canonical transcript；展示层可独立截断，但不能以展示字符串回写 tool result。
- 需要 Codex 式 patch 时，结构化 `apply_patch` 成功结果应保持小而确定的摘要；错误/部分写入必须带可执行恢复信息，并让宿主记录为 error。
- 若实现 Code Mode，嵌套工具的脚本返回值、trace 持久化和外层 tool result 是三个不同契约；不能把 UI trace 或 `details` 当作模型请求内容。
