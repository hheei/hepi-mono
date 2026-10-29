# Python Eval 架构

状态：已实现 `python_eval`；包边界见[工具拆包规格](tool-packages.md)。

## 目标与 ownership

`pi-python-eval` 独立拥有 Python kernel、NDJSON 协议、cell 状态、嵌套工具策略与输出转换。`python_eval` 默认 inactive、exposure 为 `model-only`；显式启用后执行可信本地 Python，不提供 sandbox。`codemode` 属于 Pi host，与 Python package 独立。ext-core 不拥有语言 runtime、子进程或嵌套工具政策。

具体 extension 之间没有依赖。Python 不保存其他 extension 的 ToolDefinition，不建立第二套工具 registry；嵌套调用全部经过当前 `ExtensionToolContext.executeTool`。Pi host 负责 schema 校验、hooks、权限和实际执行，Python bridge 负责固定允许列表、active 检查、trace 与脚本返回值。

## 请求与生命周期

请求为 `{ code: string, reset?: boolean, timeout_ms?: number }`。`code` 非空，最多 1 MiB；`reset` 在执行前丢掉 kernel 与 scope。`timeout_ms` 是整个 cell 的墙钟硬截止，正整数 1..2147483647，默认 180000 毫秒（180 秒），可显式覆盖；嵌套工具耗时计入。header 不显示 `timeout_ms`：它几乎总是默认值，而 ToolView 已在该行追加执行时长；截止语义由工具描述承担。始终使用当前 session cwd，不接受 language、cwd、后台执行或 wait 参数。

每个 session 一个 Eval runtime，最多一个 Python kernel 和一个活动 cell。并发执行立即 busy，不排队或共享 cell。变量仅活在 kernel 内存；session 结束、reload、resume 时清理，不恢复语言内存。取消同时 abort 嵌套调用，并向 Python 发 SIGINT；约 5 秒后仍不退出则 SIGKILL 并丢弃 scope。软取消保留能继续工作的 kernel。

配置保留 `ext_settings.json` 的 `eval` group 与 `pythonBin`。空值使用 PATH 的 `python3` 或 `python`，要求 Python 3.9+；无效路径在首次执行时报错。provider ID 和 origin 使用新包 owner，不增加旧 ID alias。

## Kernel 与数据流

```text
python_eval → session runtime → Python kernel
                                ├─ print/display/final value → transcript
                                └─ tools.<name>(args) → bridge → Pi host executeTool
cell done/cancel → bounded persisted details → release active cell
session shutdown → dispose kernel
```

每次执行带独立 cell_id，阻塞到 cell 完成或被终止。Python 持久 namespace 跨 cell 保留；`names()` 返回顶层名字排序列表。每个 cell（包括失败或取消）回报当前名字总数、新增绑定、重复 import，作为模型判断 scope 的证据。非显式 reset 引起的 kernel 更换，会在下一次执行报告 earlier names are gone。

kernel 子进程不继承 `*_API_KEY`、`*_TOKEN`、`*_SECRET`；保留 `PYTHONPATH` 与 `LD_LIBRARY_PATH`。每个 cell 重设 cwd，session cwd 放在 `sys.path[0]`。POSIX 上 host 消失后 kernel 退出。Python fd 1 与 NDJSON 协议分离，背景线程持续 drain；结束前使用随机 drain token 屏障，确保 token 前的字节先送完再发送 done。跨 cell 到达的无归属输出在下次 cell 开始前交付，不混入新 cell。

NDJSON 单行约 1 MiB 上限，越界导致 kernel 失败。未捕获错误带有限 traceback。最后一个表达式为 None 时不产生 final-result row；print、赋值等不会额外显示 null。

## 嵌套工具

允许列表固定为 `read`、`grep`、`find`、前台 `bash`、`edit`、`write`、`apply_patch`。每次调用检查工具是否 active；未安装、inactive、参数错误、权限拒绝和取消都失败。禁止递归 python_eval、后台 Bash、子代理控制或任意第三方 extension 工具。Bash 只使用前台 schema，异步参数交给 host 拒绝。

bridge 将 host 的错误状态转换为可序列化 EvalToolError 并保留失败 trace。Python catch 后 cell 可成功；未捕获则外层 isError，之前输出仍保留。host 提供的 structuredContent 优先作为脚本返回值，其次文本，再其次非文本 details。嵌套工具返回的图片不穿过 Python NDJSON kernel，也不写入持久化 trace/details；bridge 在父进程将 Pi 原生图片 block 保留到外层「python_eval」的 AgentToolResult.content，让上游模型接收图片。无直接 ToolDefinition.execute fallback，也不重复生产 schema 校验。

脚本通过 `tools.name(...)`（kwargs 或 dict）调用，`print`、`console`、`display` 和最后表达式形成顺序 transcript。取消信号透传 host；host 保持父子 tool-call 关系和 hooks。

嵌套工具调用同步阻塞并直接返回结果，写作 `result = tools.apply_patch({"patch": patch})`，不使用 `await`。kernel 不支持顶层 `await`。整个 cell 先编译后执行；编译期 `SyntaxError` 表示该 cell 内的赋值和工具调用均未发生，错误提示要求修正后重跑完整 cell。运行期异常可能保留此前已经执行的赋值与副作用，以 namespace 和工具 trace 为准。

## 输出、持久化与展示

执行事件分三条路径，谁也不借用谁的数据结构：

```text
执行事件（print/display/嵌套调用/namespace/final value/失败）
  ├─ 完整输出账本：逐行追加，上限 8 MiB，超限记一句 note
  ├─ 执行事实：calls 总数与失败数、namespace 行、final value、失败原因
  └─ 有界预览 rows：最多 200 行、每行 4,000 字符，供 onUpdate 与 UI
```

模型 content 取自完整输出账本，不取自预览：预览会丢掉第 200 行之后的内容、并把长行截断，用它生成的 spill 文件里没有可恢复的东西。账本按 chunk 接收原始输出并**即时计量**，不是等整行组好再算——一条没有换行的超长输出因此同样受上限约束；预览侧的行组装只保留 4,000 字符，超过就按截断行显示。cell 结束时账本交给 ext-core 的 `truncateWithSpill`，超出模型预算时把**完整文本**写到 `$TMPDIR/pi-output/`，返回 head+tail 与 `[Full output: 路径]`。账本自身有 8 MiB 上限，超过后停止累积并写明「output stopped at 8MB」——上限存在的理由是这段文本必须在内存里等 cell 结束，而 8 MiB 之后的内容不值得让进程承担。预算是 `limitsForCalls(calls.total)`：一个跑了多个嵌套工具的 cell 按调用数获得更宽的 head+tail。

预览只为展示服务：`rows` 保留 transcript 顺序，供流式 onUpdate 和 TUI 分类详情使用；namespace、final value 和失败行额外占用 4 个保留槽位，普通输出先让位。第 200 行之后被丢掉的普通行计入 `omittedRows`，末尾追加一行省略提示。

details format 为 `pi-ext-tools-python-eval`：

```ts
{ rows, calls: { total, failed }, durationMs, error? }
```

`calls` 是事实而不是 rows 的统计：嵌套调用的 row 可能被预览上限丢掉，计数不能跟着丢——它同时决定模型预算与 UI 的 `N calls` 摘要。嵌套 trace 持久化为 `{ name, text（≤4,000 字符）, summary（≤72 字符）, durationMs, error?, toolCallId? }`：行只画摘要，所以保存的是摘要本身，而不是被展示限额改写过形状的参数；完整结果文本在输出账本里。

onUpdate 推送运行过程（预览 rows + 当前 calls 计数），不持久化 Python 内存或重跑历史源码。

执行事实账本使用 pi-python-eval:execution custom entries 写入当前 session branch。每个 cell 在发送前记录 generation 与 start，结束后记录 completed、failed、cancelled 或 timed_out 终态及名字数量；记录不进入模型上下文。runtime 重建时只读当前 branch，若发现上一条 start 没有终态则报告 unknown outcome；generation 变化则报告 earlier names are gone。账本不恢复 Python namespace、不重放源码、不接管旧 kernel。

账本接口不吞失败：`previous()` 区分「历史为空」与「历史不可读」，`start`/`end` 返回 `{ saved } | { saved: false, reason }`，由 `runWithHooks` 一个位置决定策略。读取失败时下一次 cell 报告 earlier history could not be read，不能声称上一次执行干净结束，generation 比较也退回内存事实。start 写入失败时不执行该 cell：没有 start 事实的 cell 在重启后不可见，等于带着副作用运行却无法报告。end 写入失败不改变 cell 结果，但 cell 内出现 `recovery record not saved: …` 状态行（`onDiagnostic`），说明下一次重启可能把它误报成 unknown outcome。

文本按换行形成 rows；尚未换行的 chunk 改写当前行。print 行剥离终端控制序列；display/result 行带对应 label。cell 成功、失败或取消都以同一方式结束：先刷新未完成的行，再记录失败行，保证 transcript 顺序与 kernel 产出顺序一致——取消路径不能因为提前抛出就丢掉最后一条未换行输出。嵌套 trace 保留工具名、摘要、结果文本、执行时间与错误，供 UI 按原协议解释。

`pi-ext-ui` 可选消费持久化 rows，并提供容器折叠、嵌套工具展示、源码复制和窄宽布局。未安装 UI 时原生文本结果仍完整可用。公共 UI 行为见 [DESIGN.md](../../DESIGN.md)。

## 验证边界

测试覆盖独立注册、原生 executeTool dispatch、允许列表与 active、host 错误与 structuredContent、取消、session 清理、busy、persistent scope、namespace、协议上限、输出 drain 和历史 UI 结果。fixture 提供 host dispatch；不通过生产定义 registry 补回已删除的 fallback。
