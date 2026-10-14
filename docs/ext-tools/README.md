# pi-ext-tools 基础工具替换

## 状态

`@hheei/pi-ext-tools` 是 Canonical catalog 工具替换的唯一 extension owner。它不修改 Pi 源码，不引入
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

未展開的 body 默认最多 20 行（保留尾部，并加一行 dim `… (N earlier lines, ctrl+o to expand)`）。工具可通过 `maxBodyLines` 覆写；展开后不截断。Header、rails 与 typed footer 不计在此限额内。Header 默认按宽度换行；工具可用 `headerLine: "truncate"` 声明 header 永不超过一行（超过宽度的部分以 dim `…` 截断，`suffix` 会预留宽度保持可见），适合 body 无法还原 header 文本的工具。成对 rails 一律用 `muted`，不区分 success / warning / error。这个规则保留真实空白 output line；只有 renderer 实际返回零行时省略 body 的两条 rails。body component cache 由 `ToolTui` 从 Pi 的 outer `lastComponent` 解包后交回原 renderer，tool 不需理解 frame component。

## Request body

声明 `request` 的工具在 call 槽常驻渲染一段 request body（工具输入：命令、代码、task 文本），从参数流式期一直保留到结果之后；它取代工具自己的 `renderCall` 预览。request 行按宽度换行而不截断，未展开时保留**头部**最多 10 行（其后一行 dim `… (N later lines, ctrl+o to expand)`），并剥离终端控制序列、保证不超过终端宽度；result body 相反，保留尾部。声明 `request` 的 frame 会让 result body 省略自己的 opening rail，两段之间只有一条 rail；折叠帧仍只有 header + summary 两行。`suffix` 声明 `bash` 形态的 header 调用事实（例如 ` (reset) (timeout 30s)`，dim 色附在 summary 之后），声明后 header 用 `label summary (facts)` 而不是 `label · summary`。

## Tool Output 自动折叠

`grep`、`read`、`write`、`edit`、`find`、`ls`、`bash`、`eval` 在 `frame()` 中声明 `longOutput: true`。Tool Output 设置组
（`toolTui.collapseMode`，选项 `auto` / `on` / `pertrace` / `off`）决定这些工具完成后外框何时收合：

| 模式 | 行为 |
| --- | --- |
| `auto`（默认） | 完成后 15 秒收合为 header + footer，并保留既有 prior Trace 规则 |
| `on` | 完成后的第一次 render 即收合，且不向 host 转发长工具的 partial output |
| `pertrace` | 只保留既有 prior Trace 规则，不启动定时器 |
| `off` | 停用所有外框自动收合 |

任何自动收合——`auto` 的 15 秒定时器、`on` 的首次 render、以及下一次 `agent_start` 的 prior Trace 收合——在用户上翻阅读（不在末尾）时都会延后，回到末尾后立即执行：收合会缩短 transcript，否则会把视口从用户正在读的位置拽到底部，延后期间该 frame 保持展开。这一保护只在 fullscreen 生效，因为只有那里的视口属于 Pi、可被读取（`isFollowingOutput`）；regular 模式的 transcript 是终端自己的 scrollback，Pi 既读不到也移不动，因此该模式**不支持**阅读位置保护，也不允许用 patch 或绕路（打 `pi-tui` patch、monkey-patch `ScrollView`、访问私有成员）伪造。

保存设置会立即应用到当前 session；重新载入会重新读取保存值。15 秒定时器不会跨过 `agent_start`、session
reset 或 shutdown。折叠只影响可见外框，不改变模型可见的 `content`、持久化 details 或 Ctrl+O 展开。

header 文本由 `summary`（label 之后、`summarySeparator` 分隔）与 `suffix`（dim，追加在后的调用 facts，
声明后 header 变为 `label (host) summary facts` 形式）组成；`summary` 返回空字符串表示只有 label 与 facts，
工具输入本身是 request body 时（如 `bash`）使用该形式。

折叠后的 frame 在任意宽度下都是两行：一行 header 与一行 summary，两者都超宽时以 dim `…` 截断而不换行。
未折叠的 header 由工具自己决定：默认按宽度换行，声明 `headerLine: "truncate"` 时保持一行；footer summary
行使用与 header 相同的规则（未折叠时默认换行、声明后截断，折叠后一律截断），因为 Pi renderer 对超过终端
宽度的行会直接报错。footer 只使用 typed details，它不解析模型可见的 `content`。

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

## apply_patch 与 jsdiff runtime

`apply_patch` 在纯 JavaScript worker 中用 jsdiff 匹配并改写文本，不分发或启动独立
executable，也不依赖自有 N-API addon。它是 catalog 中唯一公开的 patch tool；其 JSON 参数固定为
`{ "patch": "<Codex V4A text>" }`。它只接受 `*** Begin Patch` / `*** End Patch`、`Add File`、
`Update File`、`Delete File` 与 `Move to` 组成的 Codex V4A grammar；不接受 raw Git diff、参数别名或
per-call fuzzy option。本机 V4A path 可以是绝对或相对 path；相对 path 从 workspace root 解析，也可用 `..`
到 workspace 外。已确认的本机 workspace 外变更会在模型 result 后给出 warning；判定不 `realpath`，因此
workspace 内 symlink 指向外部不算外部写入。

`@@ 文本` 按顺序限定后续 hunk 的搜索起点；缺失锚点拒绝该 hunk，范围内重复上下文仍拒绝歧义。`*** End of File` 限定文件末尾。纯移动使用 `Update File` + `Move to`，无需内容 hunk。Update 保留源文件换行风格与末尾换行状态；纯移动保留原始字节。

jsdiff 只消费内部编译的单文件、单 hunk unified diff；路径由已解析的 V4A operation 决定。每个 Update 的全部 hunk 在一个短生命周期 worker 中顺序作用于内存 copy；取消 `terminate()` 该 worker。写入发生在 Patch Core 的 sibling 临时文件上，replace 确认后才算 Changed。

jsdiff 不能替代 Codex V4A parser。tool 在 TypeScript 中严格解析
V4A，但容忍 UTF-8 BOM、envelope 外空行与最外层 ` ```patch` / ` ```diff` 代码围栏；内部
grammar、body whitespace 与 path size 仍严格校验。本机 path lexical resolve，但不是 workspace jail：绝对 path
与 `..` 都可用，symlink 也不 `realpath` 追踪。某个 operation 的 path 冲突、source/destination 不合规或 hunk
mismatch 只拒绝该 operation，其他已确认 path 不 rollback。取消不撤回已 Changed 的 path。现有文件与结果都不得超过 32 MiB。

`apply_patch` 使用 Patch Core 覆盖 local Linux/macOS/Windows。local 按 workspace 持有平台原生 exclusive lock，并与 write/edit 共用；后到的请求排队，取消排队中的请求不会改 workspace。`/reload` 取消 execute，不重连 mutation。

发布前复核源基线，检测到准备期间的外部修改时拒绝覆盖。Move 在目标发布后、删除源前再次复核；源冲突时保留目标与源并报告部分成功。此检查与实际 rename/remove 之间仍有竞态窗口，不是原子 compare-and-swap，也不是对外部 writer 的锁。

fuzzy policy 只读取 `pi-ext-tools.applyPatch.fuzzFactor`。默认 `0`。全局可显式设为整数 `2`；project 只能收紧，不能高于 global。旧 `minSimilarity`、`maxConcurrentWorkers`、`maxQueueDepth` 不被支持，也不映射到 `fuzzFactor`。开启 fuzzy 接受 jsdiff first-fit，不承诺 fuzzy 歧义检测。

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
均由 `pi-ext-tools` 管理；它只从 Pi host `createBashToolDefinition()` 取 schema 与 prompt metadata，执行与
renderer 都由本 package 提供。这是为了避免 Pi host 的 `pi-bash-*.log` 与 extension output 重复持有同一份
完整输出，也绝不把 host 临时路径传给模型或 TUI。

`pi-ext-tools` 的 `BashOutputSink` 保留 bounded UTF-8-safe visible tail 与截断 metadata；完整输出不注册为 URI resource。settings 属于 concrete extension，配置 visible-tail 上限。因为模型只收到 tool result 的 text part，`structuredContent` 的 `output`/`truncated`/`exit_code`/`wall_time_seconds` 只服务 codemode 与 python_eval 这类程序化调用方，不承担任何模型可见语义。

失败调用的原因与耗时必须写进 model-visible text，因为 provider 只转发 text part：取消时保留已产生的 partial output 并附一行 `Bash aborted after <duration>`，超时时附一行 `Command timed out after <timeout>s`。命令在启动前就被取消时不报耗时，因为该数字没有信息量。耗时由 ext-core `formatDuration` 统一格式化。

`bash` 的 frame 把完整命令渲染为 request body：逐行原样显示、按宽度换行、剥离终端控制序列，未展开时保留头部最多 10 行（其后一行 dim `… (N later lines, ctrl+o to expand)`）。header 只保留调用 facts（`(timeout Ns)`），因此折叠帧不再重复命令。未展开的 output body 由 `bash` 自己限制为尾部最多 10 行（与 request 上限一致），header、rails 与 typed footer 不计入。

### Optional optimizer integration

RTK 重写策略、配置与生命周期现由独立 [`pi-optimizer`](../optimizer/README.md) 所有。`pi-ext-tools` 不再注册 RTK provider 或重写 hook；旧 `pi-ext-tools.rtk` / `rtkPath` 由 optimizer 原子迁移。未安装 optimizer 时 Bash 不自动改写。

Optimizer 使用 Pi host 的 `tool_call` 参数变更契约，不接管 Bash，也不依赖本 package。仅本地前台调用参与改写，后台任务保持原行为。Bash result 只保留 bounded tail；执行 RTK 包装命令时，输出已经过 RTK 过滤，不能据此恢复被 RTK 丢弃的原始文本。

### Extension-owned background Bash

`bash` 只在前台执行，默认超时 180s（纯搜索命令 25s）。后台命令使用 deferred `bg_bash_spawn({ command, timeout? })`，成功返回 JSON `{ id, path }`，path 是完整日志文件的绝对路径，失败只返回原因，不接受调用方 ID。完成结果以 `bg-bash-report` 自动返回，不轮询或等待。

`bg_bash_get({ id, keys? })` 默认返回 `status,progress`，可选 `diagnostic`；keys 是逗号分隔字符串，未知 key 报错。只返回当前运行信息与终态生命周期，不重复终态输出。progress.path 与 spawn 返回的 path 一致，自动通知也提供日志路径，完整日志由 read/grep 读取。`bg_bash_stop({ id })` 只停止本工具族的后台进程，成功只返回一句确认，失败只返回原因，不控制 child agent。没有 list 或等待工具。

`BashJobRegistry` 拥有进程与 timer：连续 180 秒无 stdout/stderr 时发一次 idle notice，每 1800 秒发 heartbeat；onData 重置尚未发出的 idle timer，无轮询。仅后台 Bash 使用提醒，stop、terminal 和 dispose 全部取消 timer。停止会清理整棵进程树：POSIX 使用进程组，Windows 使用 taskkill。

Bash 和 child agent 通过 ext-core `TaskRegistry` 共享内部活动登记，通过 `BackgroundDelivery` 协调交付。普通结果在 parent 忙时 steer 进入下一模型步骤，空闲时等待全部后台活动结束统一唤醒；提醒可以提前唤醒，但不能携带被门控的普通结果，也不消费结果或修改终态交付状态。通知有固定输出、字节和条目上限；进程日志保留完整输出。终态使用 pending/submitted/observed 确认，失败恢复 pending 并报告。

工具默认 deferred，激活后保持可用，不随任务开始或结束反复变动。未激活时通过 deferred_tools 介绍，激活后通过 bg_bash_guidance 说明自动交付与日志检查。完整生命周期和容量约束见 [后台任务契约](../architecture/background-tasks.md)。

## Tool Ownership

- `pi-ext-tools` 是 catalog 中每个名称的唯一 Canonical tool owner，负责 upstream parameter compatibility、
  renderer、ToolRenderContext state、abort、streaming 与 cleanup；`bash` 保持 Pi host 原始 execute 行为。
- 每个 module 可以调用对应 upstream `create...Tool()`；这用于复用运行行为，不表示必须复用 upstream renderer。
- `read`、`grep`、`find`、`edit`、`write`、`bash` 都保留 upstream-compatible 参数、execute 与 renderer 语义。
- `apply_patch` 是 `pi-ext-tools` owner 的 Canonical V4A-only tool；public JSON transport 接受 `{ "patch": string }`，由 Patch Core 执行。其 call renderer 从 partial 或完整 V4A patch text 生成 model-time streaming preview；它是纯计算，不读取 workspace 或修改 patch，也不得把 recognized rows 标成 validated 或 applied。`execute()` 只在完整参数后启动；执行结果同时报告 Changed、Rejected、Unconfirmed 与 NotApplied。
- 其他 extension 不得为 catalog 名称直接 `pi.registerTool()` 或 managed-register competing definition。它们不能
  import `pi-ext-tools`；跨包协作若确有需求，另行定义 narrow core capability。


## 验证与发布

- 每个 catalog tool：upstream schema/execute compatibility、managed registration singleton、abort、streaming（如适用）
  和 Loadout activation tests。
