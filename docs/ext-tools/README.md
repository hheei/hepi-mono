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
`pi-ext-core` 仅提供 managed registration。

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
V4A，但容忍 UTF-8 BOM、envelope 外空行与最外层 ` ```patch` / ` ```diff` 代码围栏；内部
grammar、body whitespace 与 path 仍严格校验。tool 拒绝 workspace 外 path 与 symlink escape；每个 operation 独立在隔离 staging root 中
预检。某个 operation 的 path 冲突、source/destination 不合规、dry-run failure 或 stale
baseline 只拒绝该 operation，其他合规 operation 仍会提交；取消和无效 grammar 仍拒绝整个
request。真实 workspace 只在对应 source hash 未变化时替换，结果会报告 changed paths 与
rejected operations。
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

`bash` 保留 Pi-compatible `{ command, timeout }` 参数，但执行、streaming、timeout、输出截断与 artifact
均由 `pi-ext-tools` 管理；它不复用 Pi host `createBashToolDefinition()`。这是为了避免 Pi host 的
`pi-bash-*.log` 与 extension artifact 重复持有同一份完整输出，也绝不把 host 临时路径传给模型或 TUI。

`pi-ext-tools` 的 `BashOutputSink` 是 foreground、async 与 PTY 的唯一输出策略 owner。它默认保留最后
10 KiB 的 UTF-8-safe 可见 tail；foreground 与 PTY 仅在输出超过该限制时创建并持续写入 `artifact://N`，
async 在启动时预留 artifact。所有终态 tool result 只携带 tail、截断 metadata 和 opaque artifact URI。
settings 属于 concrete extension：`pi-ext-tools` 的 Bash settings 配置该 visible-tail 上限；ext-core 仅持有
进程范围 artifact resource，不拥有输出大小、截断或 shell policy。

PTY、stdin 回写、terminal resize 与后台 job 是独立 feature，不能由 `bash` tool 隐式 fallback 提供。

### Extension-owned async Bash

`bash` 可显式接受 `async: true`。当前路径不是 Pi host Bash 的 fallback：`pi-ext-tools` 创建
session-scoped background job，并立即返回 opaque job id。已确认的后续设计是：任务进入终态后，extension
通过 Pi host 的 custom message 主动把 job id、终态、截断标记和有限 tail 放入当前 session；消息持久化并显示，
但不触发新的 agent turn，使主 session 无需轮询即可查看完成结果而不产生非请求的模型工作。

后台 Bash 与发生截断的前台 Bash 都将完整 stdout/stderr 保存为 artifact；tool result 仅提示以 `read` 打开该 URI。
后台任务完成消息仍带有限 tail，完整内容绝不内联。Bash job 与其 artifact 共用同一个线性序号：例如 job `1`
的完整输出为 `artifact://1`。

artifact 是 Pi 进程内共享、进程外隔离的 resource：同一 Pi host process 中的主 session 与 subagent session 都能
`read` 同一个 URI，故 subagent 可以返回或创建 artifact URI；另一个 OS process 中的 registry 绝不解析它。artifact
在 Pi process 退出时清理，而不能因创建它的单个 session shutdown 而失效。

Pi host 的 internal URL registry 是所有 tool 的统一解析入口。extension 向 registry 注册受限 resolver；每个 tool
可将接受的路径解析为 internal resource，并按自己的读写能力执行。artifact 是只读 resource：`read`、`grep`、
`find` 等读取工具可消费它，写入工具必须拒绝它，不能把 artifact 当 workspace path。

artifact URI 采用 ext-core process registry 分配的单调十进制 id：`artifact://123`。extension 不选择名称、不持有
host filesystem path、也不得伪造 URI；ext-core 保留 URI 到 process-owned resource 的映射，并在 process exit 清理。

async job 使用 `pi-ext-tools` 自己的 shell-path setting，而不是读取 Pi host 的 private shell setting；
默认 shell 由平台环境决定。`async` 与未来的 `pty` 参数互斥。普通不带 `async` 的调用仍完整委托 Pi host。

### PtySession native boundary

`bash` 以显式 `pty: true` 提供 `PtySession`。它是 `pi-ext-bridge` 的最小 N-API
边界：以明确的 command、cwd、env、rows、cols 创建一条 pseudo-terminal；调用方可写入 UTF-8 bytes、
调整 rows/cols、读取 raw output bytes 并终止 child process group。每个实例独占 reader、writer、child 与关闭状态；
`kill()`、`close()` 与 JS wrapper drop 必须幂等。close 后 child reaping 有 300 ms 上限，避免异常的
platform PTY handle 阻塞 Pi；native output 不跨 session 保存。

Pi host 仍拥有默认 Bash。只有 `mode === "tui"` 且 `PI_NO_PTY !== "1"` 的明确
`bash({ pty: true })` 才能创建 ext-core-managed overlay surface；无 TUI 或被禁用时返回错误，绝不退回
到 async job 或 host Bash。surface 使用一条 full-width shell frame，header 用 `bashMode`，output 用
`muted`，并显示 `Esc` kill/dismiss hint，遵循 [DESIGN.md](../../DESIGN.md)。

## Tool Ownership

- `pi-ext-tools` 是 catalog 中每个名称的唯一 Canonical tool owner，负责 upstream parameter compatibility、
  renderer、ToolRenderContext state、abort、streaming 与 cleanup；`bash` 保持 Pi host 原始 execute 行为。
- 每个 module 可以调用对应 upstream `create...Tool()`；这用于复用运行行为，不表示必须复用 upstream renderer。
- `read`、`grep`、`find`、`edit`、`write`、`bash` 都保留 upstream-compatible 参数、execute 与 renderer 语义。
- `apply_patch` 是 `pi-ext-tools` owner 的 Canonical V4A-only tool；public JSON transport 只接受 `{ "patch": string }`，并委托 package 内 patch coordinator 执行。其 call renderer 从 V4A patch text 生成 streaming、折叠和展开预览；它是纯计算，不读取 workspace、调用 coordinator 或修改 patch。执行结果同时报告成功路径与被拒 operation。
- 其他 extension 不得为 catalog 名称直接 `pi.registerTool()` 或 managed-register competing definition。它们不能
  import `pi-ext-tools`；跨包协作若确有需求，另行定义 narrow core capability。


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
