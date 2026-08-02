# pi-ext-tools 基础工具替换

## 状态

`@hheei/pi-ext-tools` 是 Canonical catalog 与 FFF enhancement 的唯一 extension owner。它不修改 Pi 源码，不引入
`pi-select`，也不让 `pi-ext-core` 解释具体 tool 语义。每个 catalog module 复用 upstream definition，并在执行时以
tool call 的 `cwd` 重新创建 definition，避免 extension construction cwd 泄漏。

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
grep
find
edit
write
bash
fff_multi_grep
```

catalog 不从 `pi.getAllTools()` 或 active-tool inventory 自动推断。新增名称必须单独确认 upstream compatibility、
tool schema、rendering、lifecycle、Loadout metadata 与 focused tests。

`read`、`grep`、`find`、`edit`、`write`、`bash`、`fff_multi_grep` 每个名称只通过一次 `registerManagedLoadoutTool()` 静态注册。不存在 tool-definition
priority、同名 fallback registration 或运行时 provider arbitration。Loadout priority 仍只属于 activation/inventory
policy，不能用于决定哪个 implementation 执行。

## Tool Ownership

- `pi-ext-tools` 是 catalog 中每个名称的唯一 Canonical tool owner，负责 upstream parameter/execute compatibility、
  renderer、ToolRenderContext state、abort、streaming 与 cleanup。
- 每个 module 可以调用对应 upstream `create...Tool()`；这用于复用运行行为，不表示必须复用 upstream renderer。
- `read`、`grep`、`find`、`edit`、`write`、`bash` 保留 upstream-compatible 参数、execute 与 renderer 语义。
- `fff_multi_grep` 是唯一 FFF-only tool；FFF runtime 不可用时明确报告 unavailable，不伪装成 native grep。
- 其他 extension 不得为 catalog 名称直接 `pi.registerTool()` 或 managed-register competing definition。它们不能
  import `pi-ext-tools`；跨包协作若确有需求，另行定义 narrow core capability。

## 本地文本选择

`pi-ext-tools` 只在本 package 内共享纯文本 selection substrate：logical lines、grapheme/cell mapping、visual
soft-wrap map 与 half-open `TextRange` slicing。ANSI、padding、border、call header 与 expand hint 都不进入 logical
text。v1 只显示 local selection，不读取 selected text、不自动 copy、不访问 clipboard。这个 `TextRange` 高亮不是
terminal emulator 的 native selection，不能用 `Command+C` / `Ctrl+C` 直接复制；用户需要先用各 emulator 自己的
mouse-reporting bypass 修饰键拖出 native terminal selection，再使用该 emulator 的复制快捷键。修饰键和快捷键均因
emulator 配置而异，且此流程与 local selection 无关。

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

## FFF enhancement

FFF runtime、commands、autocomplete 与 settings 都在本 package 的 `src/fff/`。session start 读取 settings snapshot、
创建 session-scoped runtime、注册 settings/autocomplete，并异步 warm index；shutdown/reload 通过 lifecycle resources
dispose runtime。settings 写入在下一 session 或 `/reload` 生效。

`readEnhancement`、`grepEnhancement`、`findEnhancement`、`autocomplete` 与 `statusUI` 默认开启。read/grep 的 toggle
只控制对应 Pi native tool 的 FFF acceleration/resolution：关闭、runtime unavailable、FFF error 或请求语义不兼容时都完整委托
upstream factory；selection renderer 不受 read enhancement 影响。当前 FFF fuzzy/ranked `findFiles` 不能保真 Pi native
find 的 glob/path/result contract，因此 `find` 始终 native fallback；`findEnhancement` 仅为未来出现保真 mapping 保留。
settings 只读取和写入 `pi-ext-tools.fff`。不注册 `find_files`，也不保留其 cursor/query schema。

## 验证与发布

- 每个 catalog tool：upstream schema/execute compatibility、managed registration singleton、abort、streaming（如适用）
  和 Loadout activation tests。
- FFF enhancement：验证三个 toggle 关闭、runtime unavailable、FFF error、语义不兼容时均完整回退 upstream；验证
  `fff_multi_grep` runtime unavailable 时明确失败；验证 autocomplete reload 只保留 live runtime closure。
