# Eval 架构

> 状态：已同意 kernel/exposition 边界；Sibling Exposition 的 JS 与 Python kernel 为实现中。术语以 [CONTEXT.md](../../CONTEXT.md) 为准。

## 目标与边界

`pi-ext-tools` 拥有 Eval。它让用户显式启用后，在当前 Pi session 里默认执行 trusted local Python；JavaScript/TypeScript 仅在 Bun host 上可用。`@hheei/pi-ext-core` 不拥有语言 runtime、subprocess 或 Nested Tool 政策。

Eval 分成两层，避免以后做 Code Mode 时再换 runtime：

1. **Eval Kernel**：可杀的 per-language 子进程，持久 scope，按注入表做 Nested Tool invoke。
2. **Eval Exposition**：决定模型看得到哪些 provider schema。

v1 是 Sibling Exposition：`eval` 与 read/grep/find/bash/Edit Mode 并列。之后的 Code Mode Exposition 共用同一 Kernel，只改模型可见工具、prompt 注入，以及可选的 `wait`；不引入 Rust V8、Jupyter 或第二套 JS/Py 执行器。

Eval 不是 sandbox。Kernel 隔离是为了可杀与语言后端，不是安全承诺。

## 公开契约（Sibling v1）

Sibling v1 的 public request：

```ts
{ language?: "js" | "py", code: string, reset?: boolean, timeout?: number }
```

`language` 缺省 `"py"`，使用 Python kernel。`code` 非空且最多 1 MiB。`reset: true` 在跑之前丢掉该语言 kernel 与 scope，另一语言不动。`timeout` 与 `bash` 相同：可选秒数，schema 文案为 `Timeout in seconds (optional, no default timeout)`；省略或 `<= 0` 没有 timeout。计时只覆盖 kernel 自己在跑的时间，nested tool 期间暂停，返回后重新开一个同样长度的窗口。没有 `title`、`target`、`cwd`、yield 或模型路由参数。始终使用当前 session cwd。v1 不注册 `wait`。`title` 暂不做。

每种语言一个可杀子进程，共用 NDJSON 协议。Bun host 使用 Bun 执行 JavaScript/TypeScript；Python 使用 CPython 3.9+ 执行持久 namespace。Node host 只提供 Python，并明确拒绝 JavaScript/TypeScript。每次 execute 带 `cell_id`；v1 阻塞到 cell 结束。取消先中断 cell：Python `SIGINT`，JavaScript 在 await 边界 cancel。cell 停下则保留该语言 kernel 与 scope；约 5 秒后仍不停则 SIGKILL，丢掉该语言 scope。session dispose 仍杀掉全部 kernel。

JavaScript/TypeScript：仅在 Bun host 上可用；Node host 会明确拒绝该 language。支持 top-level `await`；无 TypeScript、static/dynamic import、`require`。
Python：同一 Nested Tool / print / display / cwd 语义；无 notebook、ipykernel 或隐式 pip。

Kernel 子进程不继承 `*_API_KEY` / `*_TOKEN` / `*_SECRET`。Python 把 session cwd 放进 `sys.path[0]`。Python fd 1 与 NDJSON 分离，子进程 stdout 进 Transcript 而不是协议。未捕获错误带 capped traceback。

每个 cell 开始时把 cwd 设回 session cwd。JavaScript 把 `process.stdout` / `process.stderr` 的 write 转进 Transcript。soft-cancel 清除该 JS kernel 上尚未触发的 timer。POSIX 上 kernel 在 host 消失后退出。`PYTHONPATH` 与 `LD_LIBRARY_PATH` 会传给 kernel。

NDJSON 单行超过约 1 MiB 时该语言 kernel 失败。details 最多保留 200 行；超出部分进 Output（最多 256 KiB）。每次新的 eval 清掉上一格的 nested live renderer cache。执行过程通过 `onUpdate` 推送 rows。Python fd 1 由背景线程 drain，避免子进程写满 pipe。

`pi-ext-tools.eval.enabled` 默认 `false`。construction 注册 canonical definition 与 renderer；`session_start` 仅在设置启用时把 `eval` 放进 active catalog 与 Loadout。设置变化只在 reload 或新 session 生效。

`pi-ext-tools.eval.codeMode` 默认 `false`。它是 Code Mode 的独立、静态 opt-in，永不从模型名、provider 或一次 Eval 请求推断。当前只持久化并展示该 activation；Code Mode Exposition 尚未实现，因而启用它不会暗中改变 Sibling Eval 的 catalog、模型 schema 或执行语义。

`pi-ext-tools.eval.pythonBin` 指定 Python kernel 的 interpreter。空值使用 PATH 上的 `python3` 或 `python`。必须是 Python 3.9+；无效路径在第一次 `language: "py"` 时失败。同样只在 reload 或新 session 生效。

## Kernel 协议

每个 extension instance 一个 Eval Runtime，拥有每种语言最多一个 Eval Kernel、一把 Eval Lease。并发 `eval` 立即 busy，不排队、不取消、不共享 cell。reload、resume、handoff、session cleanup dispose kernel；不恢复语言内存。

```text
eval request
  -> acquire Eval Lease
  -> kernel.execute({ cell_id, language, code, nested catalog })
       -> print / console ------------> Eval Transcript
       -> display(value) -------------> Eval Display Value
       -> tool.<name>(args) ----------> injected catalog -> canonical execute
       -> last expression ------------> Eval Final Value
  -> cell completes | Eval Cancellation terminates cell
  -> bounded details + optional Output
  -> release Eval Lease
```

每次执行都有 `cell_id`。v1 `eval` 阻塞到 cell 结束或被 terminate。协议允许以后的 `wait`/`terminate` 挂到同一 id；v1 不 yield。取消会 abort Nested Tool，并先中断 cell；必要时杀掉 Kernel。没有默认 timeout。

Detached Eval Work 在 cell 结束或 Kernel shutdown 后不属于 Transcript。

JavaScript 与 Python 共用 host 协议。Node host 默认只提供 Python；JavaScript/TypeScript 仅在 Bun host 上可用。Nested invoke 的运输可以不同（JS IPC，Python 同步 loopback），语义必须相同：同一张注入表、同一 `EvalToolError`、同一 cancellation。

## Nested Catalog Policy

Kernel 不读 Pi registry。每次 execute 由当前 Exposition 注入 invoke 表。

Sibling v1 注入 admitted 集：`read`、`grep`、`find`、foreground `bash`，以及当前 Edit Mode 的 `edit`/`write` 或 `apply_patch`。排除 `eval`、`wait`、`bash_job`、Magic Context 与其它 extension tool。Nested Bash 拒绝 `async: true` 与 `pty: true`。

以后的 Code Mode 可以注入更宽的表，仍必须排除 `eval`、`wait` 与 Magic Context，且仍走 `pi-ext-tools` 的 explicit invoker，不能扫任意 registry。

Pi 没有公开按 name 执行已注册 tool 的 API。每个 invoker 接收同一 `ExtensionContext`、AbortSignal 与 update callback，返回 normalized `AgentToolResult`。

bridge validation、permission、normalized failure 或 execute failure 抛出 serializable `EvalToolError`。source catch 后 outer Eval 成功并保留 failure trace；未捕获则 outer `isError: true`，仍保留此前 transcript。

Eval Script API：`tool.<name>()`、`console`/`print`、`display()`、只读 `cwd()`。不提供 OMP prelude aliases。

## Result、持久化与 TUI

Final Value 是最后 expression 的 awaited 值；`undefined` 不产生 final-result row。model-visible `content` 是有序 Transcript。`details` 只保存 capped structured rows 与 Output recovery reference，不复制 Eval Source 或 raw nested details。

TUI 使用 ToolTui，契约见 [DESIGN.md](../../DESIGN.md)。nested trace 优先重用 owned canonical renderer。resume 只读 persisted Eval Result Detail。

## 已批准、未实现的 Code Mode Exposition

在同一 Kernel 上增加：

- `pi-ext-tools.eval.codeMode` 显式激活；它复用 public tool 名称 `eval`，把 file/shell 移出 provider schema；
- prompt 注入 Nested Tool usage；
- `eval` 新增显式 `async?: boolean`，默认 `false`。`async: true` 的后台 job 完成后以模型可见结果排入一次后续 turn；它不取消用户新消息，不暴露 `wait`，并且每个 job 只触发一次 continuation；
- Nested Catalog 继续排除 `eval`、`wait`、Magic Context 与其它未明确许可的 extension tool。扩展 catalog 仍需独立的明确契约。

不做：第二套 V8/Jupyter runtime、TOML custom tools、用模型名自动打开、`title` 参数。

## 验证

- settings、static registration、Loadout、reload/resume lifecycle；
- kernel execute/busy/cancel/dispose、cell_id、跨 cell persistent scope；
- JS 与 Python 的 Nested Catalog Policy、caught/uncaught Eval Tool Error；
- 不 yield 的 v1 `eval`、无 wait 工具；
- bounded details、Output recovery、ToolExecutionComponent smoke。
