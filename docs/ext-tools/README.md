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

每个 tool module 自己决定如何复用 upstream factory、如何产生 body 语义内容，以及如何处理特定 feature
policy。`pi-ext-core` 的共享 `ToolTui` 统一组装 status header、跨 extension Trace collapse、body rails 与 typed footer；
`pi-ext-tools` 只提供 concrete tool 的 summary、body、footer 与 warning policy。

## Tool TUI module

`ToolTui` 是 `pi-ext-core` 的共享 renderer primitive，不从任一 concrete package entry export。每个 Pi host
以 runtime identity 持有一个 instance；`registerToolTuiTrace(pi)` 幂等安装可见的 `agent_start` handler，
每个 catalog 或 Todo registration 则显式以 `getToolTui(pi).frame(tool, presentation)` 包装 definition。它不注册
tool、不选择 active tool、不改写 schema、execute、model-visible content 或 typed details。

```text
agent_start ------------------------> registerToolTuiTrace() -> shared ToolTui.beginTrace()
tool definition + presentation -----> getToolTui(pi).frame()
                                         |
Pi renderer slots (internal) -----------+
                                         v
header -> opening rail -> one body -> closing rail -> optional footer
```

Pi host 仍拥有 `renderCall` / `renderResult` lifecycle slots、global expand 与 renderer invocation；这两个 slot
只是 `ToolTui` implementation 的 host adapter，不是两个可见 body。result 尚未出现时，call slot 可承载唯一 body；
result 出现后，call slot 只保留 header，result slot 接管同一个 body 位置。`ToolTui` 拥有 session-scoped Trace、
completion persistence、resume restoration、current/historical collapse、header status、rails 与 footer placement。
具体 tool 拥有 body renderer、header summary、typed footer text 与 warning 判定，但不得自行加入 outer rails 或
footer placement。两个 concrete extension consumer 共同使用同一 host-scoped Trace，因此 Todo 与 coding tools 的
历史 blocks 会按同一 `agent_start` 收合。

Result layout 由 `ToolTui` 依 body 实际 render 后的行数决定：

```text
有 body + footer: opening rail -> body -> closing rail -> footer
有 body、无 footer: opening rail -> body -> closing rail
无 body + footer: footer
无 body、无 footer: empty
```

未展开的 body 默认最多 20 行（保留尾部，并加一行 dim `… (N earlier lines, ctrl+o to expand)`）。工具可通过 `maxBodyLines` 覆写；展开后不截断。Header、rails 与 typed footer 不计在此限额内。成对 rails 一律用 `muted`，不区分 success / warning / error。这个规则保留真实空白 output line；只有 renderer 实际返回零行时省略 body 的两条 rails。body component cache 由 `ToolTui` 从 Pi 的 outer `lastComponent` 解包后交回原 renderer，tool 不需理解 frame component。

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
写入前协作检查取消 flag；写入发生在 Patch Core 的 sibling 临时文件上，replace 确认后才算 Changed。

mpatch 只接受 unified diff，不能替代 Codex V4A parser。tool 在 TypeScript 中严格解析
V4A，但容忍 UTF-8 BOM、envelope 外空行与最外层 ` ```patch` / ` ```diff` 代码围栏；内部
grammar、body whitespace 与 path 仍严格校验。workspace 路径是 lexical：相对路径、禁止 `..` 与绝对路径；symlink 可解析到 workspace 外。某个 operation 的 path 冲突、source/destination 不合规或 hunk mismatch 只拒绝该 operation，其他已确认 path 不 rollback。取消不撤回已 Changed 的 path。现有文件与结果都不得超过 32 MiB。

`apply_patch` 使用同一套 Patch Core 覆盖 local Linux/macOS/Windows 与 Unix-like SSH Target。local 按 workspace、SSH 按 alias 持有平台原生 exclusive lock；忙则立刻拒绝，不排队。`/reload` 取消 execute，不重连 mutation。

fuzzy policy 只读取 `pi-ext-tools.applyPatch.minSimilarity`。默认 `0.7`。`0` 关闭 fuzzy，
只允许 exact apply；`1` 只接受 score 为 `1` 的 fuzzy candidate。user-global settings 可配置；project settings 只能收紧：设为 `0` 关闭 fuzzy，或提高 minSimilarity，不能放宽写入匹配条件。

每次升级 mpatch 必须固定 release、验证每个 archive 的 SHA-256，并更新 package 的 upstream
record 与 MIT notice。

`read`、`grep`、`find`、`edit`、`write`、`bash`、`apply_patch` 每个名称只有一次 static managed definition。不存在 tool-definition
priority、同名 fallback registration 或运行时 provider arbitration。`edit`、`write` 与 `apply_patch` 的 definition 在 construction
时全部注册，让 Pi resume 按当前同名 canonical renderer 重画历史 tool call；session lifecycle 只把本次选中的 execution catalog
加入 active tools 与 Loadout inventory。Loadout priority 仍只属于 activation/inventory policy，不能用于决定哪个 implementation 执行。

catalog 注册项在 Loadout 中归入 `Built-in`，并显式声明 origin 为 `@hheei/pi-ext-tools`；这说明它们是由该 package
提供的 Pi core-tool replacement，而不是把 host 的宽泛 source type 显示为 `Third-party`。未提供 origin 的工具使用 Pi
`sourceInfo.path` 作为精确 fallback；只有 builtin path 才显示 `Pi built-in`。

## 写入工具选择与兼容 guard

`Edit Mode` 默认 `auto`：第一次 `session_start` 用当前模型的 provider/id/name 解析一次，名称含 `gpt`（不区分大小写）则激活 `apply_patch`，否则激活 native `edit`/`write`。之后换模型不会改工具，需 `/reload` 或新 session。也可钉死 `native`、`apply_patch` 或 `none`。inactive definition 只保留历史 renderer ownership，不进入 active tools、模型 tool schema 或 Loadout inventory。

```text
construction -> register edit/write/apply_patch definitions
session_start -> resolve Edit Mode -> activate + publish selected catalog
resume        -> lookup current definition by historical tool name -> render persisted result
```

`edit` resume 优先读取执行时持久化的 typed view。旧 Pi-native result 没有该 view 时，只能从其 persisted unified patch
进入同一 diff renderer；不得读取当前 workspace 反推旧状态，也不得从 model-visible content 猜测 footer metrics。缺失的 typed
edit count、line delta 或 duration 保持不显示。patch 缺失或无法解析时保留 persisted text body，不能显示空结果。

Loadout 将 `apply_patch` 视为 `edit` 与 `write` 这组工具的互斥替代：启用 `apply_patch` 时不会同时暴露
`edit` 或 `write`；禁用它后可同时启用后两者。这个关系按 tool name 声明，避免把 `edit` 和 `write` 错误地彼此排斥；显式的 project/global
Loadout 选择仍优先于默认值。

extension 也保留兼容 guard：当前 active tools 不含 `apply_patch` 时，若模型在 streamed `bash` 调用中开始执行
`apply_patch`，guard 会中止该 turn，并在 agent settled 后仅推荐当时仍 active 的 `edit`/`write`。两者都不可用时，
它明确要求先启用一个写入工具，绝不推荐 disabled tool。`apply_patch` 已 active 时 guard 不介入；它不解析或拦截其它 bash 命令。

## Bash backend

`bash` 保留 Pi-compatible `{ command, timeout }` 参数，但执行、streaming、timeout、输出截断与 output
均由 `pi-ext-tools` 管理；它不复用 Pi host `createBashToolDefinition()`。这是为了避免 Pi host 的
`pi-bash-*.log` 与 extension output 重复持有同一份完整输出，也绝不把 host 临时路径传给模型或 TUI。

`pi-ext-tools` 的 `BashOutputSink` 是 foreground、async 与 PTY 的唯一输出策略 owner。它默认保留最后
10 KiB 的 UTF-8-safe 可见 tail；foreground 与 PTY 仅在输出超过该限制时创建并持续写入 `output://N`，
async 在启动时预留 output。所有终态 tool result 只携带 tail、截断 metadata 和 opaque output URI。
settings 属于 concrete extension：`pi-ext-tools` 的 Bash settings 配置该 visible-tail 上限；ext-core 仅持有
进程范围 output resource，不拥有输出大小、截断或 shell policy。

PTY、stdin 回写、terminal resize 与后台 job 是独立 feature，不能由 `bash` tool 隐式 fallback 提供。

### Optional RTK foreground rewrite

`pi-ext-tools.rtk` 是全局、默认关闭的 boolean setting；`pi-ext-tools.rtkPath` 是全局 string，默认空字符串。`rtkPath` 为空时通过 `PATH` 执行 `rtk`；非空时作为 RTK executable 的明确路径。保存后在 `/reload` 或下一 session 生效。两个字段是 `pi-ext-tools` section 的 direct primitive fields，RTK provider 写入时保留 `fff`、`bash` 与 `edit` sibling groups。旧 `pi-ext-tools.bash.rtkRewrite` 不迁移且不再读取。

启用时，只在普通前台 `bash({ command, timeout? })` 调用前执行 `<rtkPath || "rtk"> rewrite <command>`，使用 1 秒 deadline。`async: true` 与 `pty: true` 保留原 command，不参与此 feature。

RTK 是唯一 rewrite policy owner：extension 不注入 prompt、不维护 command allowlist，也不加入 RTK 的 output compaction、metrics、database path 或单独 config。为避免递归，空白 command、显式 `rtk` 以及 leading env assignment 后仍是 `rtk` 的 command（如 `FOO=bar rtk …`）会跳过 rewrite；这不是 rewrite policy。仅当 RTK 返回 exit `0` 或 `3`，且 stdout 是非空并不同于原 command 的完整 command string 时，extension 才原地替换 Pi `tool_call` input；因此 Pi 记录与工具 call renderer 显示实际执行 command。

`rtk` 缺失、拒绝、空 stdout、超时或执行异常时，原 command 完整执行；每 session 仅显示一次 TUI warning。取消 rewrite 时静默保留原 command。无匹配时同样保留原 command，但不提示。该 fallback 不改变既有 Bash output URI、tail、timeout、abort、async job、PTY 或 renderer contract。focused tests 覆盖 disabled、success、no-match、missing/error/timeout、abort、empty 0/3、exit 2、whitespace、env-prefixed `rtk`、already-RTK、explicit path、lifecycle settings 与 async/PTY bypass。

### Extension-owned async Bash

`bash` 可显式接受 `async: true`。当前路径不是 Pi host Bash 的 fallback：`pi-ext-tools` 创建
session-scoped background job，并立即返回 opaque job id。已确认的后续设计是：任务进入终态后，extension
通过 Pi host 的 custom message 主动把 job id、终态、截断标记和有限 tail 放入当前 session；消息持久化并显示，
但不触发新的 agent turn，使主 session 无需轮询即可查看完成结果而不产生非请求的模型工作。

后台 Bash 与发生截断的前台 Bash 都将完整 stdout/stderr 保存为 output；tool result 仅提示以 `read` 打开该 URI。
后台任务完成消息仍带有限 tail，完整内容绝不内联。Bash job 与其 output 共用同一个线性序号：例如 job `1`
的完整输出为 `output://1`。

output 是 Pi 进程内共享、进程外隔离的 resource：同一 Pi host process 中的主 session 与 subagent session 都能
`read` 同一个 URI，故 subagent 可以返回或创建 output URI；另一个 OS process 中的 registry 绝不解析它。output
在 Pi process 退出时清理，而不能因创建它的单个 session shutdown 而失效。

Pi host 的 internal URL registry 是所有 tool 的统一解析入口。extension 向 registry 注册受限 resolver；每个 tool
可将接受的路径解析为 internal resource，并按自己的读写能力执行。output 是只读 resource：`read`、`grep`、
`find` 等读取工具可消费它，写入工具必须拒绝它，不能把 output 当 workspace path。

output URI 采用 ext-core process registry 分配的单调十进制 id：`output://123`。extension 不选择名称、不持有
host filesystem path、也不得伪造 URI；ext-core 保留 URI 到 process-owned resource 的映射，并在 process exit 清理。

async job 使用 `pi-ext-tools` 自己的 shell-path setting，而不是读取 Pi host 的 private shell setting；
默认 shell 由平台环境决定。`async` 与未来的 `pty` 参数互斥。普通不带 `async` 或 `pty` 的调用由 `pi-ext-tools` 的前台 shell 路径执行，并保留其原有 cwd、streaming、abort 与 output contract。

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
- `apply_patch` 是 `pi-ext-tools` owner 的 Canonical V4A-only tool；public JSON transport 接受 `{ "patch": string, "target"?: string }`，由 Patch Core 执行。其 call renderer 从 partial 或完整 V4A patch text 生成 model-time streaming preview；它是纯计算，不读取 workspace 或修改 patch，也不得把 recognized rows 标成 validated 或 applied。`execute()` 只在完整参数后启动；执行结果同时报告 Changed、Rejected、Unconfirmed 与 NotApplied。
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
FFF settings 只读取和写入 `pi-ext-tools.fff`；Bash settings（shell path、output tail）只读取和写入 `pi-ext-tools.bash`；RTK settings 则直接读取和写入 `pi-ext-tools.rtk` 与 `pi-ext-tools.rtkPath`。不注册 `find_files`，也不保留其 cursor/query schema。`src/fff/multi-grep.ts`
保留为未注册的 future implementation；只有形成 translated unified `grep` contract 且出现 product consumer 后才能接入 catalog。

FFF `find` 结果按首次命中顺序聚合目录。一个目录出现至少两个候选时，输出一个 `dir/` 标题，候选行只显示文件名；根目录和仅一个候选的目录保留完整 repo-relative path。分组只改变展示，不改变 FFF 的候选、排序、limit 或 cursor。renderer 使用 grep 一致的 `text` 目录标题、`success` 匹配标签和 `text` 路径。

当 FFF `grep` 达到 page limit 时，原始 tool result 使用 `path:line,line (N matches)` 汇总，模型仍接收此完整文本。TUI 将 path 渲染为 `text`、行号段渲染为 `mdCode`、计数渲染为 `success`；theme 不改变模型上下文。

压缩 grep 汇总也按 parent dir 合并：同一目录至少两个匹配文件时输出 `dir/` 标题，文件行只保留 basename；根目录和单项目录继续输出完整 path。该原始结构同时发送给模型和 renderer。

grep renderer 在每个文件块内以最大行号宽度右对齐 `│` 前的数字。模型 compact output 首行是 `N matches in M files` 或 `N fuzzy matches in M files`；approximate match 仍用 `:`，不引入 `?`。TUI path 使用 `text`，行号与 `│` 使用 `dim`，普通文本保持基础 theme，match range 使用 `success` highlight。未展开的整个结果（含 engine header 与 expansion hint）最多 15 行。

## Target 路由

`read`、`grep`、`find`、`bash` 的 local、Output 与 SSH target contract、session-bound Output persistence、remote search boundary，以及 SSH whitelist settings 见 [Target 路由](targets.md)。`apply_patch` remote 合约已确认、尚未实现。真实 Pi ToolExecutionComponent smoke 仍待补。

## 验证与发布

- 每个 catalog tool：upstream schema/execute compatibility、managed registration singleton、abort、streaming（如适用）
  和 Loadout activation tests。
- FFF enhancement：验证三个 toggle 关闭、runtime unavailable、FFF error、语义不兼容时均完整回退 upstream；验证 autocomplete
  reload 只保留 live runtime closure。dormant multi-grep implementation 的 tests 不构成 catalog contract。
