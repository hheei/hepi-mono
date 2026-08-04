# OMP 完整 Bash 工具迁移方案

## 状态

已否决完整迁移；Brush vendor、bridge Shell ABI 和 TypeScript runtime 已移除。本文保留为
历史分析。`bash` 保持 Pi host 原始 backend；PTY、后台 job 等能力须作为独立 feature 另行设计，不能借
`bash` replacement 隐式迁移。上游基线固定为
`can1357/oh-my-pi@01c1f91ff529c6af3fc27724a8ba429d83d41aed`。

原提案目标是在 `@hheei/pi-ext-tools` 中拥有完整 Bash product：普通非交互执行、host-managed
后台任务、local interactive PTY。此目标现已取消。

不迁移 OMP 的 ACP client-terminal backend：本 Pi host 没有对应 ClientBridge contract；它是
编辑器客户端能力，不是本地 Bash 或 PTY 的必要部分。

## 现状与缺口

当前 `bash` 已有：

```text
Pi host createBashToolDefinition
-> pi-ext-tools bash.ts renderer wrapper
-> bash-runtime.ts session-scoped Brush Shell
-> pi-ext-bridge Shell
-> vendored pi-shell / Brush
```

它保留 Pi host 的 `{ command, timeout? }` schema 和 renderer，但没有：

- `{ async: true }` 的 job handle、进度、取消与 artifact 生命周期；
- `{ pty: true }` 的 stdin、resize、terminal state、overlay；
- native `PtySession` N-API contract；
- interactive-shell 的 TERM / output sanitization / input normalization。

Pi host 的 `BashOperations` 只有单次 pipe command、streaming 与 abort。host 的
`examples/extensions/interactive-shell.ts` 可用 `ui.custom()` 停止 TUI 后以 inherited stdio
运行 `user_bash`，但它不是 agent `bash` 的 PTY、job 或 attach API，不能作为迁移 backend。

OMP 的完整工具不能直接复制到 `packages/pi-ext-tools`：其 `bash.ts` 依赖 OMP 私有的
`AgentSession`、`asyncJobManager`、settings、artifact manager、renderer、ACP client bridge 和
prompt assets。本 Pi host 没有 async job 或 ACP public extension API。

## 目标边界

```text
Pi host
├─ pi-ext-tools                  concrete extension；Bash policy、schema、job record、render
│  ├─ noninteractive Bash        current session-scoped Brush Shell adapter
│  ├─ background Bash            extension-owned job registry
│  └─ interactive Bash surface   ui.custom overlay + xterm terminal state
└─ pi-ext-bridge                 N-API/native ownership
   ├─ Shell                       existing pi-shell / Brush backend
   └─ PtySession                  portable-pty backend
```

`pi-ext-core` 不保存 Bash job、process、terminal buffer 或 policy；它只继续提供 lifecycle/
cleanup 和 surface transport。每个 Pi session 拥有自己的 Shell、job registry 与 PTY surface；
session shutdown 必须先 abort job/surface，再释放 handles。普通 `cmd &` 仍由 Brush job table
管理；显式 `async: true` 由 extension job registry 管理，两者不可混同。

## 公共行为

目标 `bash` 参数：

```ts
{
  command: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  async?: boolean;
  pty?: boolean;
}
```

约束：

- `async` 与 `pty` 互斥；拒绝，不降级。
- `pty` 只在 Pi host 有 `ui.custom` 且本地 terminal 可用时执行；否则明确返回 capability error，
  不悄悄变为 pipe command。
- `async` 立即返回 opaque job id；后续 progress/final output 由同一 session registry 交付。
- 每个 async job 使用隔离 Shell；job cancel 只终止该 job。正常 foreground 保持单一 session
  Shell 的 cwd/env 语义。
- PTY 启动系统 shell `-lc command`，拥有 stdin、stdout/stderr merged stream、resize、kill、
  timeout、AbortSignal 与 process-group cleanup。它不是 Brush Shell。
- 继续保留现有 noninteractive Brush runtime；不会以 PTY 或系统 Bash 悄悄替换它。

## 迁移阶段

### 0. 先固定设计与 source record

1. 更新 `docs/ext-tools/README.md`：记录上述新 public schema、PTY/async owner、fallback、
   cancellation 和 unsupported ACP。
2. 因新增 overlay UX，按 `DESIGN.md` 写明 title、状态、Esc kill、input forwarding、narrow/wide
   clipping 规则。
3. 用 `/grilling` 取得明确设计同意；之后才写实现。
4. 在 `references/README.md` 与 `THIRD_PARTY_NOTICES.md` 记录 OMP URL、revision、MIT attribution
   和被复制的精确文件。不得在 `packages/` 放 upstream source snapshot。

### 1. 机械复制：最小 PTY native source

从上游复制并保留 attribution 的最小 Rust execution surface，不复制整个 OMP workspace：

```text
crates/pi-ext-bridge/src/pty.rs          <- crates/pi-natives/src/pty.rs
crates/pi-ext-bridge/src/pty-task.rs     <- 所需 CancelToken/task helpers
crates/pi-ext-bridge/src/pty-process.rs  <- 所需 PID/process-group termination helpers
```

复制后立即本地化 module path，删除与 PTY 无关的 pi-natives exports；Cargo 只加入该 closure
实际需要的 `portable-pty`、`parking_lot` 与现有 `flume`。不复制 OMP `pi-natives` 全 crate，
不复制 OMP coding-agent internals。

bridge 新增独立 JS contract：

```ts
new PtySession()
pty.start({ command, cwd?, env?, timeoutMs?, signal?, cols?, rows?, shell? }, onChunk)
pty.write(data)
pty.resize(cols, rows)
pty.kill()
```

`Shell` ABI、`mpatch` ABI 与 bridge version protocol 维持兼容；PTY 是新增 capability，不改写
现有调用者。

验收：native focused tests 覆盖 output、stdin echo、resize、AbortSignal、deadline、process-group
kill；`bun run build:native` 后独立 Bun smoke test 驱动 `cat`/`stty size`。

### 2. 先迁移无 UI 的 async orchestration

新增 `packages/pi-ext-tools/src/bash-jobs.ts`，只拥有每 session 的 job registry：

```text
start -> opaque id -> running updates -> completed|failed|cancelled -> dispose
```

复用当前 `bash-runtime.ts` 的 Shell creation/abort mapping；async job 改为独立 Shell，输出使用当前
Pi update/result contract。不得复制 OMP 的 `asyncJobManager` 或 artifact manager；本仓 host 没有
public contract，registry 必须是 extension-local 并在 session disposer 中 idempotent cleanup。

验收：start result、streamed tail、success/non-zero failure、cancel、session shutdown、并发 job
相互隔离；普通 foreground cwd persistence 不变。

### 3. 再迁移 PTY surface

从 OMP `bash-interactive.ts` 迁移可复用逻辑：kitty input normalization、xterm write queue bound、
output normalization、terminal row rendering。将 OMP `Settings`、`OutputSink`、Theme、ui custom API
替换为本仓适配器；不复制 OMP session、ACP、settings framework。

新增按需加载的 `@xterm/headless` dependency，且仅当 PTY surface 被真正打开时 import。surface：

```text
bash({ pty: true })
-> ext-core openTuiSurface()
-> Pi host ui.custom overlay
-> PtySession.start()
-> keyboard/write + render/resize + Esc kill
-> dispose/kill/drain final output
```

验收：窄/宽布局、`read` stdin、arrow keys、resize、Esc、timeout、session shutdown，以及 `vim`/
`less` 启动和退出的 live smoke test。

### 4. 统一自定义 Bash definition

`createBashToolDefinition()` 的 host schema 无法表达 `async`/`pty`。仅在阶段 2/3 已验证后，
用一个 extension-owned definition 替换其 execute/schema；保留并复用当前 Pi renderer 可复用部分，
而不是复制 OMP 1,774 行 `bash.ts`。

此阶段迁移所有 catalog callsite，删除旧 `createBrushBashOperations()` override 与不再需要的
renderer compatibility state；不能同时保留两条 Bash execution path。

验收：非交互/async/PTY 三条路径 schema validation、renderer、streaming、cancel、error、cleanup
都由 focused tests 覆盖；Pi host live smoke 覆盖每条路径。

## 明确不做

- 不将 Brush `pi-shell` 作为 Pi `bash` 的执行 backend；现有 override 应在独立的恢复任务中
  删除，回到 Pi host `createBashToolDefinition()` 原始 execute。
- 不 vendor 或 copy 整个 OMP `packages/coding-agent`。
- 不迁移 ACP client terminal；日后 Pi host 公开同等 client-terminal capability 才单独设计。
- 不把 PTY 塞进 Brush `Shell`，不让 PTY fallback 成 pipe execution。
- 不复制 OMP 的私有 Settings、artifact、logger、prompt 或 job-manager framework。
- 不引入 shared generic terminal/job framework；当前只有 Bash consumer。

## 上游来源

- `packages/coding-agent/src/tools/bash.ts`
- `packages/coding-agent/src/tools/bash-interactive.ts`
- `packages/coding-agent/src/tools/bash-pty-selection.ts`
- `packages/coding-agent/src/exec/bash-executor.ts`
- `crates/pi-natives/src/pty.rs`

所有来源均来自 `https://github.com/can1357/oh-my-pi` revision
`01c1f91ff529c6af3fc27724a8ba429d83d41aed`。
