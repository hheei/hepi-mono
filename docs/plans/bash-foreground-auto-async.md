# Bash 前台无超时任务自动转后台（Auto-Async）设计方案与自审

## 1. 目标与背景

在日常开发与 Agent 自主执行过程中，当模型调用 `bash` 工具且未显式指定 `timeout` 时，容易因以下原因陷入永久或长时间阻塞：
1. **长时间运行的任务**：大型项目的编译构建（`cargo build`、`pnpm build`）、全量测试、依赖安装或深度代码搜索。
2. **挂起的意外命令**：无意中触发了交互式等待（如忘记加 `-y` 的交互式包管理器命令、等待回车的脚本、或者对空流执行了 `cat`）。

在现有机制下，前台命令必须等待子进程完全退出后 `bash.execute` 的 Promise 才会 resolve。此时整个 Agent Loop 与交互会话完全被挂起，除非用户手动介入按下 `Ctrl+C`。

**目标**：
为本地、未指定 `timeout` 的前台 Bash 任务引入**自动转后台（Auto-Async）**机制：在持续运行达到阈值（默认 60 秒）时，不强行终止进程，而是自动将其晋升并移交为已有异步任务体系下的 `bash-N` 后台任务，并立即将控制权返回给 Agent，使模型能够感知进展、决定等待或终止，从而彻底避免会话卡死。

---

## 2. 现状与技术底座分析

### 2.1 现有两套执行路径

目前 `packages/pi-ext-tools/src/bash.ts` 中存在两条割裂的执行路径：

1. **前台执行（`runForeground`）**：
   - 依赖上游 `@earendil-works/pi-coding-agent` 的 `createLocalBashOperations().exec()`。
   - 内部封装了进程生成与 `waitForChildProcess`，不向调用方暴露底层 `ChildProcess` 对象。
   - 超时处理直接抛出异常并杀死进程树，无法实现“保留运行中的进程并剥离控制权”。
2. **后台执行（`async: true`）**：
   - 依赖扩展自建的 `BashJobRegistry`（`packages/pi-ext-tools/src/bash-jobs.ts`）与 `AsyncTaskRegistry`（`packages/pi-ext-tools/src/tasks/registry.ts`）。
   - 拥有完整的进程树生命周期控制（进程组 SIGTERM → SIGKILL）、`BashOutputSink` 尾部输出环形缓冲、状态管理，以及会话级的 `dispose` 级联清理。
   - 任务以 `bash-N` 序号格式暴露，支持 `wait_tasks`、`stop_tasks`、`list_tasks`，并在完成时静默注入 `pi-ext-tools:task-terminal` 自定义消息。

### 2.2 核心矛盾与突破口

要实现“运行到 60s 时无缝切到后台且不杀死进程”，核心突破口在于：**必须将本地前台执行的底层进程创建收拢到扩展自身的 `BashJobRegistry`**。
`BashJobRegistry` 已经具备进程持有、输出缓冲和安全清理能力，只需为其扩展实时的流式数据回调（`onData`），即可同时完美满足前台实时 TUI 输出与后台无缝托管的要求。

---

## 3. 详细方案设计

### 3.1 执行面统一与延迟晋升（Promote on Threshold）

不采用“启动时预先分配 `bash-N`”的激进做法，因为 99% 的短命令（耗时 <1s）根本不需要任务编号和后台通知。
采用**延迟晋升（Promote on Threshold）**状态模型：

```text
               bash execute() ── 仅本地且无 timeout
                      │
                      ▼
            BashJobRegistry.start()
           (通过 onData 实时流式输出)
                      │
         ┌────────────┴───────────────────────────┐
         │ 前台竞态监听 (Race)                      │
         ├────────────────────────────────────────┤
         │ 1. 进程退出 (<60s)                     │ ──> 正常返回前台 BashToolResult（无 bash-N、无额外消息）
         │ 2. 用户中止 (signal.aborted)            │ ──> job.stop() 杀进程，返回 "Bash aborted"
         │ 3. 达到 60s 阈值 (autoAsyncTimer)      │ ──> 触发【晋升为 AsyncTask】
         └────────────────────────────────────────┘
                      │
                      ▼ (60s 触发)
      AsyncTaskRegistry.create()
      - 分配稳定 task ID (例如 bash-1)
      - 绑定 job.onTerminal -> tasks.settle()
                      │
                      ▼
         前台 execute() 立即返回 ToolResult
         - 提示任务已转入后台 bash-1
         - 附带前 60s 累计的尾部输出快照
         - 明确告知可用 wait_tasks 或 stop_tasks
                      │
                      ▼
           Agent 获得控制权，继续当前 Turn
           (后台进程继续在后台运行)
                      │
                      ▼ (后台进程结束时)
         tasks.settle() 触发单次终态交付
         (发送 pi-ext-tools:task-terminal 消息)
```

### 3.2 触发判定矩阵

| 场景 | `target` | `timeout` 参数 | `async` 参数 | 执行方式 | 60s 行为 |
|---|---|---|---|---|---|
| **常规短命令** | local | `undefined` | `undefined` / `false` | 前台运行（由 JobRegistry 支持） | 进程在 60s 内结束，返回普通结果，无感知 |
| **超长前台命令** | local | `undefined` | `undefined` / `false` | 前台运行 | **触发 Auto-Async，晋升为 `bash-N` 并立即返回** |
| **显式指定超时** | local | `120` | `undefined` / `false` | 前台运行，超时上限 120s | **不转后台**。若超 120s 按常规超时终止（保持意图明确） |
| **显式指定异步** | local | 任意 | `true` | 后台直接启动 `bash-N` | 从第 0 秒就是异步任务 |
| **远程 SSH 命令** | 远程 host | 任意 | 任何（async 报错） | 远程 TargetRuntime 执行 | **不转后台**。远程目前不具备异步任务控制面 |

### 3.3 晋升时返回给模型的 ToolResult

在 60 秒触发自动转后台时，前台 tool call 立即返回成功的 `BashToolResult`，但内容具有明确的指导性与诊断信息：

```ts
const content = `Command exceeded 60s foreground threshold and was transitioned to background task ${task.id}.\n` +
  `Current output preview:\n${tailOutput}\n\n` +
  `The process continues running in the background. Its final output will be injected into context when complete.\n` +
  `- If you must wait for this task before proceeding, call wait_tasks({ ids: ["${task.id}"] }).\n` +
  `- If the command is stuck or no longer needed, call stop_tasks({ ids: ["${task.id}"] }).`;

return {
  content: [{ type: "text", text: content }],
  details: {
    taskId: task.id,
    type: "bash",
    status: "running",
    autoAsyncTransition: true,
    elapsedMs: 60000,
    purpose: task.purpose,
  },
};
```

**设计要点**：
1. **附带前 60s 的输出快照**：模型能立刻看到卡住前的输出（例如看到输出停在 `Reading package lists... 85%` 说明在正常走；若看到 `Confirm overwrite (y/n)?` 说明挂在等待输入）。
2. **明确的行动选项**：消除模型的困惑，给它两条清晰路径：要么 `wait_tasks`，要么 `stop_tasks`。

### 3.4 终态交付（Terminal Delivery）的连续性

- **前台阶段（0~60s）**：`child.stdout/stderr` 通过 `onData` 发送到 `BashOutputSink` 并调用 `onUpdate`，TUI 界面正常流式显示终端文字。
- **转后台瞬间（60s）**：前台 ToolExecutionComponent 收到返回结果，渲染完成，状态标记为完成（带 warning / 转移提示）。
- **后台阶段（>60s）**：子进程继续向同一个 `BashOutputSink` 写入数据。如果模型调用 `list_tasks` 或 `wait_tasks`，读取的是该 Sink 的最新输出。
- **任务终态**：子进程退出，触发 `onTerminal` → `tasks.settle(taskId, terminal)`，向 Pi host 发送 `pi-ext-tools:task-terminal` 自定义消息（`triggerTurn: false`），保证完整结果沉淀到 context。

### 3.5 配置项与 Opt-out 机制

在 `packages/pi-ext-tools/src/fff/settings.ts` 的 `pi-ext-tools.bash` 配置组中增加配置项：

- **`autoAsyncSeconds`**（类型 `number`，默认 `60`）：
  - `> 0`：超过该秒数未退出的无超时命令转后台。
  - `0` 或 `<= 0`：**彻底禁用**自动转后台功能，回退到无限前台等待。
  - 允许用户通过 `/ext-settings` 界面或 `.pi/ext_settings.json` 自行调整（例如可设为 120s 或 0）。

### 3.6 引导提示（Prompt Guidelines）更新

在 `BASH_PROMPT_GUIDELINES` 中增加规范说明：
```ts
"Local commands without an explicit timeout automatically transition to background tasks (e.g. bash-1) after 60s to avoid blocking the session. Use `wait_tasks` to wait or `stop_tasks` to terminate them."
```

---

## 4. 边界处理与容错保障

### 4.1 竞态条件：59.99s 进程退出 vs 60.00s Timer 触发
在定时器回调中，必须依赖 `job` 的状态机进行原子检查：
```ts
if (job.status !== "running") {
  // 进程在最后毫秒已经退出或失败，跳过晋升，让正常的等待完成路径返回前台结果
  return;
}
```
保证同一个 Job 绝不会既作为前台普通结果返回，又被登记进 `AsyncTaskRegistry`。

### 4.2 前台用户取消（Ctrl+C / AbortSignal）
- **如果在 60s 前用户取消**：清除 `autoAsyncTimer`，调用 `jobRegistry.stop(job.id)` 杀死进程树，返回 `"Bash aborted"`。
- **如果在 60s 后用户取消**：此时前台 tool call 早已结束，当前的 tool call AbortSignal 已解绑。用户在交互中可以通过命令 `/subagents` 或调用 `stop_tasks({ ids: ["bash-N"] })` 进行停止；会话级 shutdown 也会通过 disposer 彻底杀死后台作业。

### 4.3 假死命令（Waiting on Stdin）
由于 `BashJobRegistry` 以 `stdio: ["ignore", "pipe", "pipe"]` 启动子进程，任何等待标准输入的命令无法得到键盘输入。
过去此类命令会导致 Agent 永久死锁。引入此机制后，60 秒一到，控制权强制归还模型；模型在输出快照中识别出交互式提示（如 `sudo password:`），便可立即调用 `stop_tasks` 结束它，大幅提升自主恢复能力。

### 4.4 远程 SSH 边界隔离
远程 Bash 执行逻辑（`runRemoteBash`）保持绝对隔离，不接入该自动化。因为 SSH 目前没有远程任务控制注册表，强行转后台会导致无法查看、无法停止和无法获取结果。

---

## 5. 设计自审（Self-Review & Grill）

对照仓库主规则 `AGENTS.md`、`DESIGN.md` 与实际运行架构进行严格自审：

### 审评维度 1：是否违反“不隐藏意图，不静默路由，不盲目自动化”？

- **质疑**：将本应前台运行的命令自动变成后台任务，算不算“盲目自动化”或“隐藏路由”？
- **答辩与判定**：**合格**。
  1. **意图透明**：返回给模型的不是伪造的完成结果，而是明确的“前台超时，已转入后台任务 `bash-1`”以及当前输出快照；
  2. **完全可检查**：转入后台后，该任务立即呈现在 `list_tasks` 中，模型与用户可查、可等（`wait_tasks`）、可杀（`stop_tasks`）；
  3. **提供显式 Opt-out**：提供了配置项 `autoAsyncSeconds: 0` 允许用户一键关闭该自动化；
  4. **尊重显式设定**：如果模型显式传了 `timeout`（哪怕是 `timeout: 300`），本机制不介入，坚决尊重调用方的显式参数。

### 审评维度 2：模型拿到该返回后的心理学与后续行为风险

- **质疑**：模型看到 tool call 结束并提示“转入后台”，会不会以为任务已经完成，直接开始写下一步代码，从而产生幻觉？
- **答辩与判定**：**需在 Prompt 和返回文本做强约束**。
  - 如果只写“Task moved to background”，弱模型可能误以为成功并继续。
  - **改进对策**：返回文本必须醒目标注：`"The command IS STILL RUNNING in the background. Do NOT assume it has finished."`，并显式指导：`"If the next step depends on this output, you MUST call wait_tasks now."`。同时更新 `BASH_PROMPT_GUIDELINES` 形成双重约束。

### 审评维度 3：后台任务堆积与资源泄漏风险

- **质疑**：如果模型连续跑了 5 个死循环命令，全都在 60s 后转后台，会不会在系统里堆积大量跑满 CPU 的僵尸进程？
- **答辩与判定**：**有此风险，需加固安全网**。
  1. 现有的 `BashJobRegistry.dispose()` 保证了在会话结束或 `/reload` 时全部杀死；
  2. 针对自动转后台的任务，建议增加**后台存活时间软上限**（例如后台继续运行最多 30 分钟），超时后自动标记 `timed_out` 并终止进程，防止彻底放飞死循环进程；
  3. `BashOutputSink` 严格限制了最大内存占用（默认 10KiB），不会因为后台持续打印日志导致 OOM。

### 审评维度 4：对现有工具生态与测试的影响

- **质疑**：前台改用 `BashJobRegistry` 会不会影响既有前台测试用例或破坏行为一致性？
- **答辩与判定**：**低风险，可控**。
  - `BashJobRegistry` 使用的同样是系统 Shell（`spawn(shellPath, ...)`）和同样的进程组杀灭逻辑。
  - 现有的 `createLocalBashOperations` 在上游主要也是为了本地执行包装，收拢到 `BashJobRegistry` 反而统一了前后台的输出收集、shellPath 解析和清理机制，消除了一套冗余的执行器。

---

## 6. 实施路线图（Implementation Roadmap）

1. **Step 1（执行层基础设施）**：在 `packages/pi-ext-tools/src/bash-jobs.ts` 为 `BashJobRequest` 增加 `onData` 回调，使 JobRegistry 支持外部流式监听。
2. **Step 2（配置层）**：在 `packages/pi-ext-tools/src/fff/settings.ts` 增加 `autoAsyncSeconds` 配置（默认 60），并导出解析方法。
3. **Step 3（工具实现与晋升逻辑）**：重构 `packages/pi-ext-tools/src/bash.ts` 中的 `runForeground`，使用 `BashJobRegistry` 驱动，加入 60s 延迟晋升逻辑。
4. **Step 4（提示词与错误格式）**：更新 `BASH_PROMPT_GUIDELINES`，打磨模型返回消息与 details 结构。
5. **Step 5（双重验证与测试）**：
   - 编写单元测试：50ms 短命令不触发任务注册；
   - 编写单元测试：长命令在超时时成功返回 `taskId`，并在后台完成后接收到 `pi-ext-tools:task-terminal`；
   - 编写单元测试：配置为 `0` 时不转后台；显式传 `timeout` 时不转后台；
   - 敏感性探针验证。

---

## 7. 实施状态与落地验证

本计划已全部实施完成。

### 落地文件清单
- `packages/pi-ext-tools/src/bash-jobs.ts`：`BashJobRequest` 增加 `onData` 流式回调；`BashJobRegistry` 增加 `waitFor(id, signal)` 与 `bindTerminal(id, onTerminal)`。
- `packages/pi-ext-tools/src/tasks/bash-task.ts`：导出 `promoteBashJobToTask`，支持将运行中的 Job 无缝登记入 `AsyncTaskRegistry`。
- `packages/pi-ext-tools/src/fff/settings.ts`：`FffSettings` 增加 `autoAsyncSeconds`（默认 60，0 禁用），在 `pi-ext-tools.bash` 配置组中提供持久化与校验。
- `packages/pi-ext-tools/src/bash.ts`：`runForeground` 接入 `BashJobRegistry` 与 60s 延迟晋升，更新 `bashFooter`、`bashResultWarning` 与 `BASH_PROMPT_GUIDELINES`。
- `docs/ext-tools/README.md` 与 `packages/pi-ext-tools/README.md`：同步更新相关文档与使用说明。

### 落地测试清单
在 `packages/pi-ext-tools/test/bash-jobs.test.ts` 中新增以下覆盖（均通过灵敏度验证）：
1. `short foreground command runs to completion without creating an async task`：短命令（<60s）正常前台完成，不创建 task ID，不发送 terminal 消息。
2. `non-timeout command transitions to background task when exceeding autoAsyncSeconds`：无 timeout 长命令在超过阈值时立刻返回 toolResult，带前 60s 输出快照与 `autoAsyncTransition: true`；后台任务在完成后向 context 交付 `pi-ext-tools:task-terminal`。
3. `explicit timeout does not transition to async task`：显式指定 `timeout` 的命令在超时时终止并返回 `timedOut: true`，不晋升为后台任务。
4. `auto-async disabled when autoAsyncSeconds is 0`：配置为 0 时彻底禁用自动转后台，命令继续在前台运行至完成。
5. `aborting foreground command kills the process before auto-async`：前台 abort 信号先于超时触发时直接终止进程，不创建后台任务。
6. `renders auto-async transition warning and footer in framed tool`：验证转后台的 toolResult 在 ToolTui 中渲染黄色警告符（`!`）以及 `transitioned to bash-1 · running in background · 60s` 提示。
7. `waitFor and bindTerminal on BashJobRegistry`：验证底层任务等待与延迟绑定终端回调逻辑。
8. `stops streaming onUpdate to completed tool call after auto-async transition`：验证 60s 转后台后立即阻断前台 `onUpdate` 流式回调，避免后台长输出干扰已完成的 tool call 组件。

