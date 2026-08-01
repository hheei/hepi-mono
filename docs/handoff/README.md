# Handoff

## 目的

`/handoff` 由 `@hheei/pi-handoff` 独立 extension 拥有。它在用户主动请求时压缩当前 parent session，创建一个带
`parentSession` link 的新 Pi session，并把可继续工作的 context 写为隐藏 `hepi-handoff` message。它不是
`pi-mctx` command，也不是自动 compaction 或 session-history rewrite。

## Native First Slice

首 slice 只实现 Pi native path：

1. `/handoff` 不接受参数；有参数时显示 usage，且不改 session。
2. command 先等待当前 agent idle，避免与 streaming 或 tool execution 并发。
3. 调用 Pi `ctx.compact()`，取得 native summary 后才创建 replacement session。
4. new session 保留当前 session file 作为 `parentSession`，在 setup 期间追加不可见的
   `<handoff-summary>` payload，并提示完成状态。
5. 用户取消只显示 cancellation notice；compact、session creation 或 setup error 显示 failure notice。source session
   仍可 resume，但 Pi public `newSession()` 会在 `setup` 前切换 replacement，setup failure 没有 public rollback。

这保留已验证的旧用户工作流，但不兼容旧 bundle 的 runtime `globalThis` bridge。Pi native summary 是此 slice 唯一
payload source；Handoff 不读取 MCTX SQLite、compartment graph、tags 或 retained source。

## Future MCTX Projection

当 `pi-subagents` 真实实现 `inherit_context` 后，它与 Handoff 才构成两个 installable consumer。届时两者通过
`@hheei/pi-ext-core` existing Service key `@hheei/pi-mctx/context-projection@1` 发现 optional MCTX projection。
MCTX provider 缺席、disabled 或返回 `undefined` 时，Handoff 继续上述 native path；provider 返回已选择的 projection
后，payload/setup error 必须显示 operation error，不能静默改用 native compact，以免遗失 chosen projection。

MCTX projection 的 opaque `install()` 负责 destination binding、drop replay、verified graph 和 hidden-entry ordering；
Handoff 只创建 destination session 并调用它。它不解析或拼接 MCTX payload。

## 非目标

首 slice 不包含 MCTX Service provider/consumer、inheritance、`ctx_reduce` materialization、historian execution、
fork graph projection、background compaction、progress UI、wait/poll command 或旧 wrapper compatibility bridge。

## 验证

focused tests 覆盖 usage、idle ordering、native compact success、new-session cancellation、compact/setup failure 与 hidden
entry。Pi command/session replacement 是 host behavior，完成前以 real Pi host 验证；unit tests 不能替代它。
