# pi-ext-tools 基础工具替换

## 状态

`@hheei/pi-ext-tools` 已实现 Canonical catalog 与 `pi-fff` split migration。它不修改 Pi 源码，不引入
`pi-select`，也不让 `pi-ext-core` 解释具体 tool 语义。每个 catalog module 复用 upstream definition，并在
执行时以 tool call 的 `cwd` 重新创建 definition，避免 extension construction cwd 泄漏。

## 目标

Pi upstream tool 的同名 replacement 由一个 Canonical tool owner 静态注册，而不是由多个 extension 以 priority
竞争同一个 tool name。`pi-ext-tools` 只在明确的 Tool replacement catalog 内接管名称；Pi、Loadout 与用户始终
只看见该名称的一份 definition。

```text
Pi upstream factory -> pi-ext-tools tool module -> one managed registration -> Pi-visible tool
```

每个 tool module 自己决定如何复用 upstream factory、如何 render，以及如何处理特定 feature policy。
`pi-ext-core` 仅提供 managed registration 与 mouse transport。

## v1 Catalog

v1 的显式 catalog 是：

```text
read
edit
write
bash
```

catalog 不从 `pi.getAllTools()` 或 active-tool inventory 自动推断。新增名称必须单独确认 upstream compatibility、
tool schema、rendering、lifecycle、Loadout metadata 与 focused tests。

`read`、`edit`、`write`、`bash` 每个名称只通过一次 `registerManagedLoadoutTool()` 静态注册。不存在 tool-definition
priority、同名 fallback registration 或运行时 provider arbitration。Loadout priority 仍只属于 activation/inventory
policy，不能用于决定哪个 implementation 执行。

## Tool Ownership

- `pi-ext-tools` 是 catalog 中每个名称的唯一 Canonical tool owner，负责 upstream parameter/execute compatibility、
  renderer、ToolRenderContext state、abort、streaming 与 cleanup。
- 每个 module 可以调用对应 upstream `create...Tool()`；这用于复用运行行为，不表示必须复用 upstream renderer。
- `read`、`edit`、`write`、`bash` 保留 upstream-compatible 参数、execute 与 renderer 语义。
- 其他 extension 不得为 catalog 名称直接 `pi.registerTool()` 或 managed-register competing definition。它们不能
  import `pi-ext-tools`；跨包协作若确有需求，另行定义 narrow core capability。

## 本地文本选择

`pi-ext-tools` 只在本 package 内共享纯文本 selection substrate：logical lines、grapheme/cell mapping、visual
soft-wrap map 与 half-open `TextRange` slicing。ANSI、padding、border、call header 与 expand hint 都不进入 logical
text。v1 只显示 local selection，不读取 selected text、不自动 copy、不访问 clipboard；用户通过 terminal emulator 的
手动复制快捷键复制（macOS 通常为 `Command+C`，Windows 通常为 `Ctrl+C`）。

它不是通用 Component framework 或 tool decorator。每个 renderer 自己决定 result body、selection state、highlight
和 clipboard policy。v1 clipboard policy 明确为空。local tool-surface binding 只识别本 package 产生的 result
component；它通过 core 的 optional runtime host bridge 取得 Pi TUI/layout。capability 缺席或格式无效时 fail closed：
保留 upstream renderer，且不注册 mouse region。

`edit`、`write` 保留 upstream renderer 的 padded status shell、diff、partial/expanded output、error 与 timer lifecycle。
`read` 与 `bash` expanded output 通过 Pi 的 vendored `ToolRenderContext.resultLayout` 接收 result body viewport bounds，并注册
local mouse region；extension 不遍历 `Container.children`，不读取 `ToolExecutionComponent` private fields。`bash` collapsed preview
继续由 upstream renderer 处理，不创建 selection region；其他 tool 的 selection 必须分别复制并测试其完整 upstream renderer
行为后才能接入。

未来的 region snapshot 必须在 layout/content revision 改变后异步更新，绝不从 `render(width)` 注册或移除；mouse callback
只读取 selection，不创建 Promise、不执行 I/O，也不接管 `Command+C` / `Ctrl+C`。

## pi-fff 过渡

`pi-ext-tools` 最终取代 `pi-fff`，但第一阶段采取 split migration：

```text
pi-ext-tools: read, edit, write, bash
pi-fff:       grep, find_files, fff_multi_grep, FFF runtime/settings/autocomplete
```

第一阶段的 `pi-ext-tools/read` 不使用 FFF approximate-path resolution，保持 upstream read behavior。`pi-fff`
必须移除自己的 `read` registration；保留它的三个 FFF tool。旧的、仍注册 `read` 的 `pi-fff` release 与
`pi-ext-tools` 不兼容，必须在 release documentation 中明确并同 release 发布 split migration。

当 grep/find/FFF runtime 全部迁入后，`pi-fff` 才能被废弃。过渡期两个 package 不得互相 import。

## 验证与发布

- 每个 catalog tool：upstream schema/execute compatibility、managed registration singleton、abort、streaming（如适用）
  和 Loadout activation tests。
- split release：验证新 `pi-fff` 不再注册 `read`，新 `pi-ext-tools` 是唯一 `read` owner；旧 `pi-fff` 与
  `pi-ext-tools` 的不兼容性写入两个 package README 和 release notes。
