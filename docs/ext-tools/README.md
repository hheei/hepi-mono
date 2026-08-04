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
apply_patch
```

catalog 不从 `pi.getAllTools()` 或 active-tool inventory 自动推断。新增名称必须单独确认 upstream compatibility、
tool schema、rendering、lifecycle、Loadout metadata 与 focused tests。

## apply_patch 与 native mpatch runtime

`apply_patch` 使用 N-API bridge 内链接的 vendored mpatch `v1.6.4`，不分发或启动独立
mpatch executable。它是 catalog 中唯一公开的 patch tool；其 JSON 参数固定为
`{ "patch": "<Codex V4A text>" }`。它只接受 `*** Begin Patch` / `*** End Patch`、`Add File`、
`Update File`、`Delete File` 与 `Move to` 组成的 Codex V4A grammar；不接受 raw Git diff、参数别名、
per-call fuzzy option 或绝对 path。

mpatch 是 `apply_patch` 的私有 fuzzy worker，不是独立 Pi tool，也不从用户的 `PATH`、
`MPATCH_BIN` 或网络取得 executable。bridge 的一次性 run handle 在文件循环、fuzzy 搜索和
写入前协作检查取消 flag；写入只发生在 coordinator 的 staging 目录。

mpatch 只接受 unified diff，不能替代 Codex V4A parser。tool 在 TypeScript 中严格解析
V4A，拒绝 workspace 外 path 与 symlink escape；所有操作先在隔离 staging root 中完成。每个
Update 先以 exact policy dry-run，再按固定 fuzzy policy dry-run/apply。真实 workspace 只在 source
hash 未变化时替换，失败、取消、无效 grammar、dry-run failure 与 stale baseline 都不写入真实文件。
同 path job 会串行；无交集 path job 可在共享 worker limit 内并发。

fuzzy policy 只读取 `pi-ext-tools.applyPatch` settings。默认值为 `minSimilarity: 0.7`、
`maxConcurrentWorkers: 2`、`maxQueueDepth: 32`、`cacheMiB: 64`。`minSimilarity: 0` 关闭 fuzzy，
只允许 exact apply；`1` 只接受 score 为 `1` 的 fuzzy candidate。user-global settings 可配置完整
policy；project settings 只能收紧 policy：设为 `0` 关闭 fuzzy、提高 minSimilarity、降低 resource
limit，不能放宽写入匹配条件。

每次升级 mpatch 必须固定 release、验证每个 archive 的 SHA-256，并更新 package 的 upstream
record 与 MIT notice。

`read`、`grep`、`find`、`edit`、`write`、`bash`、`apply_patch` 每个名称只通过一次 `registerManagedLoadoutTool()` 静态注册。不存在 tool-definition
priority、同名 fallback registration 或运行时 provider arbitration。Loadout priority 仍只属于 activation/inventory
policy，不能用于决定哪个 implementation 执行。

catalog 注册项在 Loadout 中归入 `Built-in`，并显式声明 origin 为 `@hheei/pi-ext-tools`；这说明它们是由该 package
提供的 Pi core-tool replacement，而不是把 host 的宽泛 source type 显示为 `Third-party`。未提供 origin 的工具使用 Pi
`sourceInfo.path` 作为精确 fallback；只有 builtin path 才显示 `Pi built-in`。

## 写入工具选择与兼容 guard

Loadout 将 `apply_patch` 视为 `edit` 与 `write` 这组工具的互斥替代：启用 `apply_patch` 时不会同时暴露
`edit` 或 `write`；禁用它后可同时启用后两者。这个关系按 tool name 声明，避免把 `edit` 和 `write` 错误地彼此排斥；显式的 project/global
Loadout 选择仍优先于默认值。

extension 也保留兼容 guard：当前 active tools 不含 `apply_patch` 时，若模型在 streamed `bash` 调用中开始执行
`apply_patch`，guard 会中止该 turn，并在 agent settled 后仅推荐当时仍 active 的 `edit`/`write`。两者都不可用时，
它明确要求先启用一个写入工具，绝不推荐 disabled tool。`apply_patch` 已 active 时 guard 不介入；它不解析或拦截其它 bash 命令。

## Bash backend

`bash` 复用 Pi host 原始 `createBashToolDefinition()` execution、参数 schema、streaming、abort、
truncation、错误语义与 renderer。`pi-ext-tools` 仅为 expanded output 增加 local text selection；不替换
shell backend，也不保留 session-scoped native Shell。

PTY、stdin 回写、terminal resize 与后台 job 是独立 feature，不能由 `bash` tool 隐式 fallback 提供。

## Tool Ownership

- `pi-ext-tools` 是 catalog 中每个名称的唯一 Canonical tool owner，负责 upstream parameter compatibility、
  renderer、ToolRenderContext state、abort、streaming 与 cleanup；`bash` 保持 Pi host 原始 execute 行为。
- 每个 module 可以调用对应 upstream `create...Tool()`；这用于复用运行行为，不表示必须复用 upstream renderer。
- `read`、`grep`、`find`、`edit`、`write`、`bash` 都保留 upstream-compatible 参数、execute 与 renderer 语义。
- `apply_patch` 是 `pi-ext-tools` owner 的 Canonical V4A-only tool；public JSON transport 只接受 `{ "patch": string }`，并委托 package 内 patch coordinator 执行。其 call renderer 从 V4A patch text 生成 streaming、折叠和展开预览；它是纯计算，不读取 workspace、调用 coordinator 或修改 patch。
- 其他 extension 不得为 catalog 名称直接 `pi.registerTool()` 或 managed-register competing definition。它们不能
  import `pi-ext-tools`；跨包协作若确有需求，另行定义 narrow core capability。

## 本地文本选择

`pi-ext-tools` 只在本 package 内共享纯文本 selection substrate：logical lines、grapheme/cell mapping、visual
soft-wrap map 与 half-open `TextRange` slicing。`read`、`grep`、`find` 与 `apply_patch` 的可见纯文本 result body 支持
local selection；`apply_patch` result 只暴露完成后的 compact success summary，而其独立 call renderer 显示 patch payload 的 streaming、折叠和展开预览，不显示 coordinator internals。ANSI、padding、border、call header 与 expand hint 都不进入 logical text。v1 只显示 local selection，不读取 selected text、不自动 copy、不访问 clipboard。这个 `TextRange` 高亮不是
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
继续由 upstream renderer 处理，不创建 selection region。`grep` 与 `find` 保留 upstream `Text` renderer；local selection 只替换
可见 result body 行，跳过 renderer 的首个空行和 shell 的左右 padding，保留 expand/truncation UI。soft-wrap 不生成 logical newline，
每行右侧 space/tab 在 selection text 中移除。

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
settings 只读取和写入 `pi-ext-tools.fff`。不注册 `find_files`，也不保留其 cursor/query schema。`src/fff/multi-grep.ts`
保留为未注册的 future implementation；只有形成 translated unified `grep` contract 且出现 product consumer 后才能接入 catalog。

## 验证与发布

- 每个 catalog tool：upstream schema/execute compatibility、managed registration singleton、abort、streaming（如适用）
  和 Loadout activation tests。
- FFF enhancement：验证三个 toggle 关闭、runtime unavailable、FFF error、语义不兼容时均完整回退 upstream；验证 autocomplete
  reload 只保留 live runtime closure。dormant multi-grep implementation 的 tests 不构成 catalog contract。
