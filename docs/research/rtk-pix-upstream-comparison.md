# RTK Bash 优化：Pix 与 pi-rtk-optimizer 对比研究

> 日期：2026-08-14  
> 范围：为 `@hheei/pi-ext-tools` 的 `bash` 评估一个**显式 opt-in** 的 RTK 命令改写；不构成实现规格，不改变当前行为。  
> 本地 Pix 基线：`references/repos/pix-mono`，commit `1ca2d05aec5fdba679c6b3ac7b7b57822962c205`（`origin`：`xynogen/pix-mono`）。  
> 上游 RTK 扩展基线：`MasuRii/pi-rtk-optimizer`，commit [`d155d253`](https://github.com/MasuRii/pi-rtk-optimizer/commit/d155d253cb2f1358e34e717d47a82ebccb08cb8e)。本报告只使用这两个源码树和 GitHub API/raw 内容。

## 结论

建议只实现一个 session-scoped、默认关闭的 `pi-ext-tools` Bash setting：启用后，**仅**对普通前台
`bash({ command, timeout? })` 的 `tool_call` 在执行前调用 `rtk rewrite <command>`；只在 RTK 明确返回改写文本时，原地替换
`event.input.command`。`async: true`、`pty: true`、缺失/失败/超时/空输出、已带 `rtk` 的命令全部保留原命令。

不要移植 Pix 的 prompt 注入或自写 shell 分段器；不要移植 `pi-rtk-optimizer` 的 output compaction、`RTK_DB_PATH` 注入、独立
config modal、全局 metrics 或 renderer 改写。这样保留现有 Bash 的输出 URI、UTF-8-safe tail、PTY、async job、取消和 ToolTui
契约，且用户能清楚选择是否让外部 `rtk` 参与命令处理。

## 1. 三种模型

| 维度 | 本地 Pix | `pi-rtk-optimizer` 上游 | 对 `pi-ext-tools` 的含义 |
| --- | --- | --- | --- |
| 改写来源 | 静态 allowlist + 自写 `&&`/`||`/`;`/`|` 分段；匹配段前插入 `rtk`。引号不平衡时跳过。 | 每次候选调用 `rtk rewrite <完整命令>`；按 RTK exit code 和 stdout 决定。 | 复用上游 provider 的调用协议，不复制 Pix parser 或 allowlist。RTK 才拥有命令语义。 |
| 模型提示 | 每 turn 注入长 RTK prompt，并在 `tool_call` 兜底改写。 | 不需依赖 prompt；支持 `rewrite` 或 `suggest`，且会显示通知。 | 不注入 prompt。模型显式写 `rtk` 仍照常执行；setting 只改变执行前命令。 |
| 默认/配置 | `pix-runtime.optimizer.rtk` 默认 `on`，由 `/optimizer` 和 `~/.pi/agent/pix.json` 持久化。 | extension 私有 `config.json` 默认 `enabled: true`、`mode: rewrite`，并注册 `/rtk` 配置 UI。 | “optional”要求本功能默认 `off`；放在已有 `pi-ext-tools` settings，不新增 command、文件或跨包 config。 |

**Pix 证据。** `rtk.ts` 在 `before_agent_start` prepend prompt、在 `tool_call` 原地写 `event.input.command`；`rewriteChain()`
仅理解少量 shell operator，且仅对 `RTK_COMMANDS` 改写。[本地 Pix RTK 源码](../../references/repos/pix-mono/packages/pix-optimizer/src/rtk.ts)
[`#L75-L86`](../../references/repos/pix-mono/packages/pix-optimizer/src/rtk.ts#L75-L86)
[`#L93-L227`](../../references/repos/pix-mono/packages/pix-optimizer/src/rtk.ts#L93-L227)
[`#L260-L347`](../../references/repos/pix-mono/packages/pix-optimizer/src/rtk.ts#L260-L347)。其 runtime section 默认值为
`rtk: "on"`。[本地 Pix optimizer section](../../references/repos/pix-mono/packages/pix-runtime/src/sections/optimizer.ts#L5-L34)。

**上游证据。** 上游先跳过空命令和已有 `rtk` 前缀，再执行已解析的 `rtk rewrite`；exit `0`/`3` 使用非空且不同的 stdout，
`1` 表示无匹配，`2` 或其他状态保留原命令并返回 warning。
[`rtk-rewrite-provider.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/rtk-rewrite-provider.ts)
[`#L31-L127`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/rtk-rewrite-provider.ts#L31-L127)。extension 在
`tool_call` 对 `bash` 调用这个决策，再原地赋值；`suggest` 不改写。
[`index.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/index.ts#L286-L343)。

## 2. stdout、stderr 与结果元数据

当前 `pi-ext-tools` 前台 Bash 为 stdout、stderr 各装一个 `data` listener，按事件到达顺序写入同一个 `BashOutputSink`，并以
`onUpdate` 流式返回 sink snapshot；结束时结果保留 `output`、`truncated`、可选 `outputUri`、`exitCode` 和可选 `timedOut`。
因此两个 fd 间不存在可承诺的原始全局顺序，现有合并行为不应被 RTK 改变。
[本地 Bash 执行](../../packages/pi-ext-tools/src/bash.ts#L145-L205)
[本地 output sink](../../packages/pi-ext-tools/src/bash-output.ts#L23-L91)。

上游改写 subprocess 使用 `pi.exec()` 的独立 stdout/stderr：stdout 仅用于取得 rewritten command，stderr 仅用于诊断；它不把
`rtk rewrite` 自身输出并入 Bash result。
[`rtk-rewrite-provider.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/rtk-rewrite-provider.ts#L58-L127)。

但上游还在 `tool_execution_update/end` 删除 ANSI，并在 `tool_result` 对 `bash`、`read`、`grep` 修改模型可见 content；它将
`rtkCompaction` 挂入 `details` 与 `details.metadata`，其中记录 technique、截断和字符/行数变化。
[`index.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/index.ts#L203-L284)
[`index.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/index.ts#L345-L380)
[`output-compactor.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/output-compactor.ts#L404-L489)。

**判断：** 不复用 compaction。`pi-ext-tools` 已将完整 output 存为 process-owned `output://` resource，并在终态 result 中只暴露
tail 和 truncation 元数据；第二个 lossy filter 会损坏“完整结果可读”的既有契约，也会让 ToolTui footer 的输出/行数不再对应 native
result。[Bash 设计](../ext-tools/README.md#bash-backend)
[Bash footer](../../packages/pi-ext-tools/src/bash.ts#L57-L145)。若将来需要可观察性，最多加入一个非破坏性
`details.rtk` 记录（`rewritten: boolean`、原命令长度、resolver），不得覆盖 `output`、`outputUri`、exit/timeout 字段或 content。

## 3. async、PTY、取消与并发

`pi-ext-tools` 不是 host Bash 的纯 renderer wrapper。普通前台调用自行 spawn shell，AbortSignal 和 timeout 都调用 child kill；
`async` 创建 session-scoped detached job；`pty` 走 interactive surface，二者由 schema 排斥。
[Bash routes](../../packages/pi-ext-tools/src/bash.ts#L22-L60)
[前台取消](../../packages/pi-ext-tools/src/bash.ts#L145-L205)
[async/PTY 分派](../../packages/pi-ext-tools/src/bash.ts#L321-L382)
[async group cleanup](../../packages/pi-ext-tools/src/bash-jobs.ts#L73-L219)。

上游 RTK extension 没有 PTY 或 background-job implementation。它在 `tool_call` await 至多 3 秒的 rewrite provider，运行时可用性
缓存 30 秒；其 `tool_execution_*` hooks 只观察/修改 streamed result content，不控制 subprocess lifecycle。
[`index.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/index.ts#L203-L284)
[`index.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/index.ts#L286-L343)
[`rtk-rewrite-provider.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/rtk-rewrite-provider.ts#L31-L127)。

**判断：** V1 只改写没有 `async`/`pty` 的 foreground call。rewrite lookup 的 timeout、failure、cancel 都 fail open 为原命令，且
不启动/追踪独立长生命周期进程。未来若支持 async，应在启动 job 前完成 rewrite 并把最终 command 写进既有 job metadata；PTY 则必须先
确认 RTK 不会破坏 interactive stdin、TTY detection 或 terminal control sequence。两项不是本次最小切片。

## 4. 配置、路径与安全边界

上游启用时在 `session_start` 创建/加载 extension-owned config；正常化 JSON 的字段、范围和 enum 不合法值会回退默认值，保存使用 tmp
file + rename。其 default config 同时默认开启 rewrite、binary guard 和多种 output compaction。
[`config-store.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/config-store.ts#L31-L201)
[`types.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/types.ts#L1-L70)
[`config.example.json`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/config/config.example.json)。

它还通过 `which`/`where` 获取第一个 path，失败才退回字符串 `rtk`；随后执行 `--version` 或 `rewrite`。
[`rtk-executable-resolver.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/rtk-executable-resolver.ts#L1-L89)。另一个 helper 会在
命令前插入 `export RTK_DB_PATH='<tmp>/pi-rtk-optimizer/history.db';`，除非命令/环境已含该变量。
[`rtk-command-environment.ts`](https://github.com/MasuRii/pi-rtk-optimizer/blob/d155d253cb2f1358e34e717d47a82ebccb08cb8e/src/rtk-command-environment.ts#L1-L76)。

**判断：**

- 使用已解析 executable path 可降低随后 `PATH` 变化的歧义，但 `which`/`where` 本身仍遵从用户 `PATH`；将 resolved path 和 resolver
  显示/记录给用户，且只在 setting opt-in 后解析。
- 不注入 `RTK_DB_PATH`。它会在模型可见 command 中新增 shell 语法，并为 RTK history 引入额外文件写入和临时目录 policy；这与
  “无隐藏 intent”及 `pi-ext-tools` 当前不暴露 host temp path 的规则冲突。[Bash backend](../ext-tools/README.md#bash-backend)
- 不将 rewrite stdout 当 shell text 拼接；它只能完整替换已验证的 string command。任何非零（除 RTK 定义的 no-match）、空 stdout、超时、
  exception 或 cancellation 都保留原 command，最多在 UI 做一次 bounded warning。
- 不绕过现有 `tool_call` 顺序、Bash timeout、AbortSignal、cwd 或 shell-path setting；RTK lookup 使用 host `pi.exec`，shell
  execution 仍仅由 `pi-ext-tools` 持有。

## 5. 可复用切片与不可移植部分

| 切片 | 结论 | 原因 |
| --- | --- | --- |
| `rtk rewrite` provider：跳过空/已有 RTK、执行、exit-code envelope | 可复用，压缩为 package-local helper | 独立于 UI 和 output；比 Pix parser 更接近 RTK 自身行为。 |
| resolver：`which`/`where`、首个非空 stdout path、`--version` 探测 | 可复用，但仅在 opt-in setting 启用后调用 | platform 差异已有明确处理；仍应把真实 path 暴露在 result/UI metadata。 |
| Pix `splitChain` / `rewriteChain` / prompt injection | 不复用 | parser 不是完整 shell grammar；allowlist 会与 RTK 漂移；prompt 是 always-on token 和行为修改。 |
| 上游 config modal、`/rtk` command、metrics、notice trackers | 不复用 | `pi-ext-tools` 已拥有 setting/lifecycle/TUI；没有第二个 consumer 证明需要通用抽象。 |
| 上游 output sanitizer/compactor、read/grep mutations | 不复用 | 破坏现有 output URI、tail、ToolTui 和完整结果契约；超出 Bash rewrite 范围。 |
| Windows pipeline safety fixups、`RTK_DB_PATH` env prelude | 不复用 V1 | 针对上游自行插入 export 与 Windows pipe 行为；移除 prelude 后无直接需求。 |

## 最小后续方案

```text
pi-ext-tools Bash setting (default off)
  -> bash tool_call: default route only
  -> resolve/probe rtk (opt-in, cached per session)
  -> rtk rewrite <command> (bounded)
  -> changed stdout ? mutate event.input.command : keep original
  -> existing foreground / async / PTY lifecycle and renderer
```

最小 public contract 仅需一个 boolean setting 和一个可检查的 result detail（若产品需要显示改写）。focused tests 应覆盖：disabled、RTK
missing、no-match、rewrite、already-prefixed、timeout/error、`async` bypass、`pty` bypass，以及原有 Bash `outputUri`/abort/timeout
不变。不要引入新依赖、独立 extension、prompt、command、config file、output post-processor 或 cross-package API。

## 明确未知项

1. 本地已安装 `rtk` 的 `rewrite` exit `3` 是否仍是长期稳定的“成功改写”协议；该结论来自上游 extension 源码，未在 RTK CLI 自身源码/文档中验证。
2. `rtk rewrite` 是否会创建 history/database 或执行其他本地副作用；本研究未读取 RTK CLI 源码，故不能把它视为纯函数。
3. Pi host `pi.exec` 是否接受 caller AbortSignal；上游只传 timeout。V1 应先验证当前 `@earendil-works/pi-coding-agent` public API，不能假设 lookup 可随 Bash cancellation 中断。
4. RTK 对 PTY、交互 stdin、ANSI 和 Windows shell/pipeline 的兼容性未知；因此 V1 排除 `pty`、且不移植 Windows rewrite fixup。
5. 用户需要 global 还是 project-level opt-in 尚未决定；沿用 `pi-ext-tools` 当前 setting ownership即可，具体 scope 应在实现设计阶段确认。
