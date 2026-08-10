# Pix Pretty 移植研究

## 范围与结论

本记录只比较三类本地一手材料：vendored `pix-pretty`、本仓库源码、Pi host 安装包。仓库解析的 Pi host `0.84.0` 是最低兼容契约；全局安装的 `0.84.1` 只用于核对增量。

结论：**不要整体移植 `pix-pretty`，也不要现在创建 `packages/pi-ext-tools/src/pretty/`。** `pi-ext-tools` 已接管的 `read`、`edit`、`write`、`bash` 直接保留 Pi 0.84.0 工厂定义的 renderer；FFF 已有 session-scoped runtime、设置和 cleanup。整包移植会把 Pix 的进程级 singleton、`pix-runtime` 配置所有权和已被 Pi host 覆盖的 UI 带入一个 concrete extension，扩大状态与依赖面而没有已证实的消费者。

依据：Pi 0.84.0 的 read、edit、write、bash 工厂都已返回带 `renderCall` / `renderResult` 的 `ToolDefinition`，edit 还使用 `renderShell: "self"`。本仓库通过展开这些工厂定义后仅替换 execute 或补充既有功能来注册工具，因此保留了其 renderer。

- Pi read renderer：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js:130`、`:258`。
- Pi edit renderer 和原生 diff details：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js:158`、`:172`、`:247`。
- Pi write renderer：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js:131`、`:165`、`:181`。
- Pi bash streaming renderer：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:221`、`:352`、`:362`。
- 本仓库对 edit/write 保留 factory template：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-tools/src/tools.ts:24`、`:67`；read 同样只包裹 execute：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-tools/src/read.ts:13`。

## Pix Pretty 实际边界

`pix-pretty` 不是单一 Pi extension，而是供多个 Pix concrete package 导入的库。其默认 export 仅清理高亮缓存、初始化全局 icon mode、注册两个 FFF 命令；工具注册和渲染位于其它 Pix 包。`package.json` 还直接依赖 `@xynogen/pix-runtime`、`cli-highlight`、FFF `0.5.2` 和 `diff`。这与 `pi-ext-tools` 的单一 canonical catalog owner 不同。

- 默认 extension：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/index.ts:11`。
- 依赖声明：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/package.json:61`。
- 跨 Pix 包的直接 imports 清单可由 source imports 验证，例如 read、edit、write：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-read/src/read.ts:6`、`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-edit/src/edit.ts:8`、`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-write/src/write.ts:8`。

Pix 可分为以下功能切片：

| Pix 切片 | 原始 owner / 生命周期 | Pi 0.84.0 或当前替代 | 移植判断 |
| --- | --- | --- | --- |
| read 文件预览、高亮、行号 | `pix-read` 在 execute 后把完整内容写入 `result.details`，renderer 异步高亮并调用 `invalidate()`；`pix-pretty` 提供渲染函数和缓存。 | Pi read 原生处理文本、图片、offset/limit、取消，并已有 call/result renderer；当前 `pi-ext-tools/read.ts` 只改变 FFF path resolution。 | 不移植。只有明确要求“Pi 原生 read 不足以显示的视觉行为”时，才在 read owner 内加入该行为。 |
| edit/write split diff、new-file preview | `pix-edit` / `pix-write` 包裹原生 execute，重写 `details` 为完整 old/new text，再由 Pix diff renderer 异步渲染。 | Pi edit 已生成 diff/patch/firstChangedLine 并有 self shell renderer；write 也有原生 call/result renderer。 | 不移植。Pi 原生 UI 不满足且需求指定 split/word diff 时，才评估一个独立渲染 slice。 |
| bash 状态、输出摘要 | Pix 渲染普通文本和 exit status。 | Pi bash 原生支持 partial update、截断和 renderer；`pi-ext-tools` 另有 foreground/async/PTY output owner。 | 不移植。 |
| ls tree/grid、文件图标 | Pix 将 ls plain output 重新布局，并用 Nerd Font glyph。 | Pi 有 `createLsToolDefinition`，但 `pi-ext-tools` 明确 catalog 未含 `ls`。 | 不移植；新增 `ls` 必须先扩展 catalog 合约，不能借 Pretty 隐式加入。 |
| FFF finder、cursor、health/rescan | Pix module singleton 保存 finder、dbDir 和 partialIndex，并由 `pix-grep` 在 session start/shutdown 建立/销毁。 | 当前 FFF runtime 是 `pi-ext-tools` session state，使用 lifecycle resource cleanup，命令经 runtime getter 访问。 | 已替代；绝不复制 Pix singleton。 |
| icon catalog / 持久化 | Pix 使用进程级 mode、listener、`pix-runtime` config。 | Pi 提供 theme；本仓库没有确认的跨 package icon consumer。 | 不移植。需要无 Nerd Font fallback 时，由具体 consumer own 一个明确 setting。 |
| confirm/gate/progress/modal frame | Pix 用 `ctx.ui.custom({ overlay: true })` 自行处理焦点、timer、分页和 input。 | Pi 提供 dialog、`custom`、widget；ext-core `openTuiSurface()` 增加 FIFO、AbortSignal、dispose 和 overlay focus 处理。 | 不放入 `pi-ext-tools`；权限/交互 feature 自己调用 ext-core surface。 |
| widget format helpers | 无 Pi host state，只是 Pix packages 的纯格式化共享层。 | Pi context 已公开 context usage，widgets 可由 ext-core 管理。 | 不移植，除非至少两个本仓库 consumer 出现同一纯格式需求。 |

证据：

- Pix read 结果 details 与异步 renderer：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-read/src/read.ts:71`、`:127`、`:192`。
- Pix edit 的 execute 后 details 和 renderer resize invalidator：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-edit/src/edit.ts:116`、`:169`、`:234`。
- Pix write 的旧内容快照、details 与 preview：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-write/src/write.ts:42`、`:71`、`:104`、`:170`。
- Pix file/highlight/tree/batch functions：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/renderers.ts:14`、`:53`、`:78`；高亮 cache 与 fallback：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/highlight.ts:120`、`:135`。
- Pix FFF module state、初始化和 destroy：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/fff.ts:7`、`:34`、`:54`；Pix grep 负责 session hook：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-grep/src/extension.ts:36`、`:65`、`:77`。
- 当前 FFF lifecycle：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-tools/src/fff/lifecycle.ts:54`、`:80`、`:100`；当前 FFF commands：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-tools/src/fff/register-commands.ts:10`。
- Pix icon 的 mutable global mode/listeners：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/icon-catalog.ts:119`、`:133`、`:143`；其 `pix-runtime` config binding：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/icon-persist.ts:10`、`:39`。

## Pi Host API 对照

Pi 0.84.0 `ToolDefinition` 已公开 `execute(signal, onUpdate, ctx)`、`renderShell`、`renderCall`、`renderResult`。每个 renderer call 可复用 `lastComponent`，共享 row-local `state`，在 async work 完成后调用 `invalidate()`，并依据 `expanded`、`isPartial`、`isError` 渲染。该接口可支撑 Pix 的所有工具展示需求，且不需要改变模型可见 `content`。

- Tool renderer contract：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:314`、`:343`、`:359`、`:373`。
- Pi TUI 可用 `select`、`confirm`、`input`、`notify`、`custom`、`setWidget` 和 `addAutocompleteProvider`：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:68`、`:90`、`:106`、`:125`、`:140`。
- `ExtensionContext.mode` 明确含 `tui` / `rpc` / `json` / `print`，自定义 surface 必须在 TUI mode guard 后使用：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:208`。
- Pi 生命周期公开 session start/shutdown，后者覆盖 quit、reload 与 session replacement：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:415`、`:463`。

本仓库更窄的 owner 已补上 host API 没有表达的生命周期约束：`registerExtensionLifecycle()` 串行 start/shutdown、先 abort 再 cleanup，并对 reload 使旧 handler 失效；`openTuiSurface()` 对 `ctx.ui.custom()` 进行 runtime-wide FIFO 和 abort cleanup；widget owner 统一卸载和重挂。新 Pretty UI 不应绕过它们。

- lifecycle：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-core/src/lifecycle.ts:29`、`:83`、`:112`。
- custom surface：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-core/src/custom-surface.ts:108`、`:221`。
- widget：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-core/src/widgets.ts:118`、`:173`。

### 0.84.1 增量

全局 `0.84.1` 与仓库 `0.84.0` 的 extension type diff 只增加 `ToolCallEventResult.terminate`；read declarations 额外导出 `readToolSystemPromptContribution`。两者都与 Pretty renderer、TUI、session lifecycle 无关，故本次建议不依赖它们。

- 仓库版本：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/package.json:3`。
- 全局版本：`/home/chlo/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/package.json:3`。
- `0.84.1` 新增 `terminate`：`/home/chlo/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:786`。
- `0.84.1` 新增 read prompt export：`/home/chlo/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.d.ts:10`。

## 迁移风险

1. **依赖和私有入口。** Pix 高亮依赖 `cli-highlight`，目标 package 未声明它；Pi host 的 `highlight.js` 和 `diff` 是 host 私有依赖，extension 不能深导入或把 transitive resolution 当 public contract。`pi-ext-tools` 当前只直接声明 FFF、ext-core、better-result、TypeBox。
2. **会话串扰。** Pix FFF、resize invalidator 与 icon mode 都是 module-level mutable state；尤其 `resize.ts` 永久订阅 `process.stdout` 并保留 tool-call invalidators。复制会在 reload、session replacement 或并发 session 下遗留 state。
3. **数据安全与并发。** Pix edit 在原生 write 后再读工作区以定位改动行；该读与并发 writer 无同一 mutation queue。新的 renderer 只能消费 execute 已返回的 immutable details，或在写入前于同一 execute 路径采样。
4. **TUI 不可用和焦点。** Pix overlay 直接调用 custom component；必须 guard `ctx.mode === "tui"`，传递 session abort signal，并让 surface close 时释放 timer/listener。Pi UI API 的 dialog 能力并不等于 JSON/print 下存在 terminal surface。
5. **模型内容不变。** renderer 是展示层。任何视觉增强不得截断或重写 `result.content`；大结果的恢复路径应保留在现有 output/details contract。

来源：Pix highlight dependency/fallback：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/highlight.ts:1`、`:135`；Pix global resize listener：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/references/pix-mono/packages/pix-pretty/src/resize.ts:5`、`:13`；Pi host dependencies：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/node_modules/@earendil-works/pi-coding-agent/package.json:45`；目标 direct dependencies：`/home/chlo/orca/workspaces/hepi-mono/ext-tools/packages/pi-ext-tools/package.json:46`。

## 最小架构与验证

当前最小架构为零新增 Pretty 文件：

```text
Pi 0.84.0 factory renderer
        |
pi-ext-tools canonical tool wrapper
        |
execute/result content + Pi renderer
        |
Pi host TUI

FFF command/tool -> pi-ext-tools session runtime -> ext-core lifecycle cleanup
interactive feature -> owning concrete extension -> ext-core surface/widget -> Pi UI
```

若未来已确认某一个原生 renderer 有明确产品缺口，按以下顺序实现，不建立通用 Pretty facade：

1. 在拥有该 tool 的现有模块内用 Pi `ToolRenderContext` 添加一项 renderer delta，复用 factory execute，保留 schema、cancellation 和 `content`。
2. 仅当第二个 `pi-ext-tools` tool 使用**同一纯函数**时，才创建 `packages/pi-ext-tools/src/pretty/<purpose>.ts`；它只能接收显式输入并返回 render data，不能读 config、持有 singleton、注册 command 或订阅 process event。
3. overlay、permission、footer、widget 不进入 `pi-ext-tools/src/pretty/`。它们由对应 concrete extension owner 使用 ext-core surface/widget；FFF 继续留在当前 runtime。

若实施单一 renderer delta，focused validation 应包括：

- 在仓库解析的 Pi `0.84.0` 下 typecheck，禁止 import `0.84.1` 专有 symbol。
- 一个 focused Bun test：相同 tool input 下 execute 的 `content` 与原 factory 一致；新增 `details` 仅供 renderer，abort/error/partial result 不触发异步 stale repaint。
- renderer test 覆盖 collapsed/expanded、窄/宽 width、theme change、无 TUI fallback；任何 session resource 额外覆盖 reload/shutdown cleanup。
- 运行 `bunx biome check --write <changed-paths>`、`bunx biome check <changed-paths>`、`bun test <focused-test-path>`；只有触及 public tool contract 或 package boundary 时才运行更广 typecheck。
