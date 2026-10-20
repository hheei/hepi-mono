# Python Eval 稳定性调研：窄执行事实账本是否可行

> 调研日期：2026-10-20。本文是研究与建议，**不是已批准的架构或实现规格**。
> 本轮不修改生产代码、公共契约、依赖或会话格式。
> 一手来源：本仓库源码与测试、`docs/architecture/eval.md`、`docs/architecture/bash-execution-recovery.md`、
> `packages/pi-ext-core/src/lifecycle.ts`，以及本地解析的 `@earendil-works/pi-coding-agent@1.3.0` 文档与 `dist`。
> 仓库基线 HEAD：`f298719e`（工作树含与本任务无关的未提交修改，未触碰）。

## 1. 结论先行

1. **窄执行事实 ledger 可行，且值得做。** 但它的价值不在"让 kernel 更稳"，而在**把当前完全不可见的 scope 丢失和中断 cell 变成可读事实**。今天 reload / resume / fork / 新 session 之后，`python_eval` 会以 `restarted: false` + `names: 0` 报告一次"干净"执行（探针 A 实测），而模型的 prompt 被明确要求"只在 cell 报告 kernel restarted 时重跑 setup"（`packages/pi-python-eval/src/tool.ts:44`），于是它会自信地在空 namespace 上继续。这是唯一一个**当前架构下无法靠现有证据发现**的故障。
2. **不恢复 Python namespace，也不做旧 kernel 接管。** CPython 进程内存不可序列化恢复；任何"恢复 scope"的尝试都只能变成重放源码。Bash 的同类结论可直接复用：恢复记录与通知，不恢复执行（`docs/architecture/bash-execution-recovery.md:7-9`）。ledger 只回答"发生过什么、结果是否可信"，永不回答"把变量变回来"。
3. **不要泛化 Bash ledger，也不要抽通用 `ExecutionLedger`。** Bash 的 `BashExecutionLedger` 快照 schema 是命令执行专用的（`command`/`exitCode`/`logPath`/`anchor`/`timedOut`，`packages/pi-bg-bash/src/bash-ledger.ts:53-85`），其复杂度的来源是**跨 session 的进程所有权**：锁文件、POSIX 内核锁、分支交付收据、日志尾部重建。Eval 没有跨 session 进程可拥有（kernel 随父进程消失，`packages/pi-python-eval/src/kernel/child.py:205-221`），把这两套持久化合并只会把 Bash 的所有权复杂度搬进一个不需要它的包。
4. **最小可持续边界：一个只记录 cell 意图→可观察终态的 record-only ledger，每 cell 至多 2 次同步写，且先落在 Pi 会话条目里**（`pi.appendEntry`，不进模型上下文）而不是新开 SQLite；只有当"父进程在 cell 中途被 SIGKILL"被确认为必须覆盖的需求时，才升级为私有 SQLite 文件。理由与选项见 §6。
5. **顺带发现的三个真实缺陷不属于账本问题，不该用账本掩盖**：teardown 时在飞的嵌套 toolResult 会产生 unhandledRejection（探针 D）；`#handle` 被 `void` 调用且能 reject（`host.ts:213`）；frame 行 `JSON.parse` 无保护（`host.ts:212`）。

## 2. 现状：Eval 的执行模型与故障面

### 2.1 生命周期与所有权

| 事实 | 证据 |
| --- | --- |
| 每个 session 一个 runtime，start 时创建 `EvalKernelHost`，shutdown 时 dispose | `packages/pi-python-eval/src/lifecycle.ts:48-70`；`packages/pi-ext-core/src/lifecycle.ts:29-38` |
| 重复 start 会先 dispose 旧 runtime 再接管 | `packages/pi-python-eval/src/lifecycle.ts:35-46` |
| 只有 `python_eval` 在 active 列表里才启动 runtime | `packages/pi-python-eval/src/lifecycle.ts:60` |
| shutdown 先 abort scope signal 再按逆序跑 cleanup | `packages/pi-ext-core/src/lifecycle.ts:66-79`；`packages/pi-ext-core/src/disposer-registry.ts:33-56` |
| `dispose()` 同步 `SIGKILL` 且之后拒绝新执行 | `host.ts:139-143`、`host.ts:327-342` |
| reload 会替换整个 extension runtime，旧 runtime 的状态不可复用 | `pi-coding-agent/docs/extensions.md:50` |
| `session_start.reason` ∈ startup/reload/new/resume/fork，`session_shutdown.reason` ∈ quit/reload/new/resume/fork | `pi-coding-agent/dist/core/extensions/types.d.ts:575-581`、`:637-642` |

结论：kernel 的作用域严格等于**一个 extension runtime 实例**，比 session 更短。reload 就是一次 scope 清零，但当前这条边界对模型不可见。

### 2.2 cell 执行与 namespace 报告

| 事实 | 证据 |
| --- | --- |
| 一个宿主进程内最多一个活动 cell，第二个并发立即报错（不排队） | `host.ts:77`；`tool.ts:99`(`executionMode: "sequential"`)、`tool.ts:107` |
| cellId 由 host 生成，kernel 回声对齐 | `host.ts:89`、`host.ts:238-247` |
| 每个 cell（含失败/取消）回报 `names`/`added`/`redundant` | `child.py:279-292`、`child.py:423-455`；`protocol.ts:18-24` |
| 失败 cell 的 namespace 报告搭 `EvalCellError` 回到模型 | `host.ts:250`；`protocol.ts:77-84` |
| "kernel 换了" 只在**同一个 host 实例内**可比对：`#lastKernel` 是实例字段 | `host.ts:39-40`、`host.ts:79-86` |
| 非 reset 引起的更换报告 `restarted`，reset 不报告 | `host.ts:80-82`；测试 `test/eval-kernel-state.test.ts:161-172` |

**关键缺口**：`restarted` 的比较基准是**内存里的对象引用**。新 host（reload/resume/fork/new session）里 `#lastKernel` 为 `undefined`，于是 `restarted = false`。探针 A 实测：

```text
A1 restarted false state {"names":1,"addedCount":1,"added":["x"],...}
A2 value [] restarted false state {"names":0,...}
```

即：scope 丢了，模型收到的是"全新、干净、没有发生过任何事"。

### 2.3 取消与超时

| 事实 | 证据 |
| --- | --- |
| `timeout_ms` 是 host 侧墙钟硬截止，默认 180s，最大 2147483647 | `tool.ts:24-26`、`tool.ts:397-409` |
| 用户 abort 与 deadline 通过 `AbortSignal.any` 合并，嵌套工具调用共享同一 signal | `tool.ts:114`、`tool.ts:387-393`；测试 `test/eval-bridge.test.ts:70-81` |
| 取消做两件事：标记 aborted + 向 kernel 发 `SIGINT`；`interruptMs`（默认 5s）后 `SIGKILL` 并丢 scope | `host.ts:18`、`host.ts:101-104`、`host.ts:317-325` |
| kernel 收到 SIGINT 后能自行收尾：`KeyboardInterrupt` → `done ok:false` + namespace 报告 | `child.py:433-443` |
| host 侧还有一条 **已声明但从未发送** 的 `cancel` 消息 | `protocol.ts:40`（全包无发送点，grep 仅此一处） |

探针 C（`interruptMs: 150`，abort 发生在嵌套工具调用在飞时）实测：cell 在 212ms 以 `Eval was aborted.` 干净失败，无 unhandled rejection，后续 cell 正常，且 kernel **存活**（SIGINT 让 Python 帧退出而非进程）。这说明软取消路径本身是可靠的，账本对它的增量接近零。

### 2.4 输出、协议与边界

| 事实 | 证据 |
| --- | --- |
| NDJSON 单行上限 `1 MiB + 64 KiB`，越界 kill kernel | `protocol.ts:4`、`host.ts:198-209` |
| 输出帧与 fd 1 分离，用随机 drain token 做 barrier | `child.py:20-34`、`child.py:145-191`、`child.py:420` |
| 无归属输出跨 cell 缓冲，上限 8 KiB，下次 cell 前交付 | `host.ts:20`、`host.ts:273-292` |
| POSIX 上 host 消失后 kernel 自杀（watchdog） | `child.py:205-221`、`child.py:462` |
| 非 POSIX 上 watchdog 直接 return | `child.py:206-207` |
| 崩溃后的 kernel 会在下一次 cell 被报告为 restarted | 测试 `test/eval-kernel-state.test.ts:173-186` |

探针 B（6 线程 × 400 行并发 print，连续 6 轮）实测：每轮 2600 条 text 事件无丢失、无 unhandled rejection。输出通道在本轮关注范围内不是薄弱点。

探针 E（单行输出规模）实测：40KB 单行正常；1.2MB 单行 → cell 失败 `Eval kernel frame exceeded 1 MiB.`，kernel 被杀，下一个 cell 正常（新 kernel）。即"输出过大"是**已可见的**故障，不需要账本。

### 2.5 已确认的、不属于账本的三处缺陷

| 缺陷 | 证据 | 后果 |
| --- | --- | --- |
| teardown 时有嵌套工具调用在飞 → 其迟到结果触发 `#send` 抛错，被 `void` 丢弃 | `host.ts:213`、`host.ts:253-270`；探针 D 实测 `unhandled after dispose with in-flight tool: 1 ["python eval kernel is not running."]` | 进程级 unhandledRejection |
| 同一路径下迟到 toolResult 被静默丢弃（cell 已结束时直接 return） | `host.ts:236-247` | 嵌套工具的结果无人知道已发生 |
| frame 行 `JSON.parse` 无 try/catch，位于 `data` 事件处理器内 | `host.ts:212` | 非 JSON 输出（如 sitecustomize 打印到真实 stdout，`PYTHONPATH` 被继承于 `host.ts:410`）会变成 uncaught exception |

这三条的正确修法是所有权与错误传播（settle 时 cancel 在飞调用、给 `#handle` 挂 `.catch`、解析失败按协议错误处理），**不是**账本。

## 3. 对照物：BashExecutionLedger / BashJobRegistry 实际解决什么

| 机制 | 目的 | 证据 |
| --- | --- | --- |
| 意图先落盘，再 spawn | 没落盘就不允许产生外部副作用 | `bash-jobs.ts:364`；测试 `test/bash-recovery.test.ts`("failure to persist intent prevents shell start") |
| 终态在输出收集与日志关闭后落盘 | 交付里给的日志路径必须是完整文件 | `bash-jobs.ts:841`、`bash-jobs.ts:772-802` |
| `settled` 但 `running`/`stopping` 一律拒绝 | 拒绝"看起来在跑但没人拥有"的记录 | `bash-ledger.ts:268-275` |
| `synchronous = FULL` + 独立 `.lock` 库 `BEGIN EXCLUSIVE` | 崩溃后 OS 释放锁；两个 writer 不共享历史 | `bash-ledger.ts:183-201` |
| 恢复时未 settled → `unknown` + 重读日志 | 不虚构 exit code/结束时间，不接管旧 PID | `bash-jobs.ts:269-303` |
| 不为恢复写回账本 | 恢复是只读投影 | `test/bash-recovery.test.ts`("repeated recovery refreshes partial logs without overwriting owner evidence") |
| 交付状态不写账本，靠会话分支收据 | 报告是否送达是分支事实，不是执行事实 | `bash-delivery.ts:259-278`、`bash-delivery.ts:292-306` |

**Bash 需要这些，是因为它有意让进程活过 session**（`detached: process.platform !== "win32"`，`bash-jobs.ts:392`），所以"谁拥有这个 PID"必须跨进程持久化。Eval 的前提正相反：kernel 与 host 同生共死（`child.py:205-221`），没有可继承的所有权。**因此照搬 Bash ledger 的复杂度在 Eval 上没有对应的问题。**

## 4. 账本能解决 / 不能解决的真实故障

| 故障 | 当前可见性 | 账本能做什么 | 判定 |
| --- | --- | --- | --- |
| reload / resume / fork / new session 后 scope 静默丢失（探针 A） | **完全不可见**，且误导 prompt 规则 | 记录"上一次 cell 的 kernel generation + 结束时名字数"，下一 cell 报告"kernel 被替换，之前 N 个名字已丢失" | **解决**，最高价值 |
| 父进程在 cell 中途被 SIGKILL / 系统重启，嵌套 `edit`/`write`/`bash` 副作用已发生 | 只有会话里半截 tool call | 意图记录 → 无终态 → 下一次 session 报 `unknown` + "副作用可能已发生" | **解决**，但依赖崩溃可用的持久化（见 §6 选项） |
| frame 超限 kill kernel（探针 E） | 已可见（cell 报错）但**原因丢失**，下一 cell 只说"restarted" | 把 kill 原因写进该 cell 记录，作为下一 cell 的证据 | **小幅改善** |
| 取消 / 超时（探针 C） | 已精确（`Eval was aborted after 1.2s`，`Execution timed out after 30 ms`） | 几乎无增量 | **不需要** |
| kernel 活着但卡死 / OOM / 阻塞在 `_call_tool` | cell 一直挂着，只能靠 host deadline | 账本只在事件边界写，卡死期间无事件可写 | **不能解决** |
| 非 POSIX 上父进程消失 → kernel 变孤儿 | 完全不可见 | 账本只记录事实，不管进程 | **不能解决**（watchdog 缺 Windows 实现，`child.py:206-207`） |
| Windows 上 SIGINT 语义不可靠（`child.kill()` 能否打断 CPython） | 未知 | 无关 | **不能解决**，需独立验证 |
| Python namespace 本身 | 不可恢复 | 若声称恢复就是撒谎 | **明确不做** |
| 交付/通知去重（Bash 的 pending→submitted→recorded） | Eval 就地返回结果，无异步交付 | 无对应问题 | **不需要** |

## 5. 方案选项

### 选项 0：什么都不做

- 成本 0；保留 §2.2 的静默 scope 丢失。
- 代价是模型侧行为错误（按 prompt 规则不会重跑 setup），而不是"少一条日志"。**不推荐**。

### 选项 1（推荐）：会话条目内的 record-only 执行事实

把"上一次 cell 的事实"写成 Pi custom entry（`pi.appendEntry`，`CustomEntry`，不进模型上下文，`pi-coding-agent/docs/session-format.md:167-172`），`session_start` 时读当前分支重建。

- 记录字段（最小集）：`cellId`、`kernelGeneration`（host 自己生成的 uuid）、`startedAt`、`endedAt?`、`outcome: running|completed|failed|cancelled|timed_out|unknown`、`nameCount`、`diagnostic?`。
- 写入时机：cell 开始 1 次（intent）+ cell 结束 1 次（terminal）；不做 per-text / per-row / per-heartbeat 写。
- 语义：`running` 只证明"准备执行"，不证明 kernel 存活；恢复后无终态的 `running` 一律投影为 `unknown`，与 `bash-ledger.ts:268-275` 同一条不变量。
- 收益：天然带分支语义（tree/fork 不需要 `anchor`、不需要 lock、不需要 schema version）；零新依赖；ext-core 已有 `appendEntry` 路径（`pi-bg-bash/src/bash-delivery.ts` 亦用 `pi.appendEntry`）。
- 局限：**不能覆盖父进程在 cell 中途被 SIGKILL**——条目只在 tool 结果落地时写入。
- 迁移面：只动 `pi-python-eval`；`host.ts` 增加 generation 与 terminal 回调，`lifecycle.ts` 增加读取/追加。

### 选项 2：私有 SQLite 执行事实账本

为覆盖"崩在 cell 中途"，需要像 Bash 一样先落盘再执行。

- 必须自带：schema version、`synchronous = FULL`、独占锁（否则 reload 残留的双 writer 会各自声称同一段历史）、行 schema 校验。
- 与选项 1 相比多出约 150–200 行基础设施，收益只有"崩在 cell 中途"这一种情形。
- 与 Bash 共享实现的诱惑要抵抗：见 §7。
- 触发条件：只有当"嵌套工具写入的文件在崩溃后必须被明确标为不可信"成为确认需求时才做。**先不做**。

### 选项 3：把 kernel 换成可恢复的外部进程（不推荐）

脱离 Pi host 生命周期、由独立 runner 保活 kernel，从而让 scope 跨 reload 存活。这等于给 Eval 引入 Bash 的进程所有权问题，并且仍然无法序列化 CPython 内存：session resume 后只能重放源码。范围、风险与用户可见契约全部改变，**不在本次建议内**。

## 6. 明确不建议的事项

1. **不恢复 Python namespace，不重放源码，不自动重跑失败的 cell。** 恢复只能给出事实与不确定性。
2. **不接管旧 kernel PID，不向旧进程发信号。** 与 `bash-execution-recovery.md:7` 同一原则。
3. **不把 `BashExecutionLedger` 直接复用或泛化成 `ExecutionLedger<T>`。** 它的 schema（`bash-ledger.ts:53-85`）与锁、日志、交付收据耦合；Eval 需要的是 5 个字段的事实行。抽泛型会同时污染两个包的公共契约（`AGENTS.md:14` 禁止未经确认的推测性抽象）。
4. **不为取消/超时加账本。** 探针 C 证明当前路径已精确、可读、可恢复。
5. **不记录逐行输出、不按 text chunk 写盘。** 输出属于 tool result 与 presentation，不属于执行事实。
6. **不引入 `wait`/`list` 之类的 Eval 任务查询工具。** cell 是同步的，没有异步结果需要轮询。
7. **不借这次改动顺手重构 `language` 槽位。** `EvalLanguage` 只有 `"python"` 一个字面量（`protocol.ts:1`），`kernelCommand` 的 `_language` 参数未被使用（`host.ts:345-347`），`cancel` 消息从未发送（`protocol.ts:40`）。这些是可以删的死泛化，但属于独立的小清理，不与账本混在一个提交里（`AGENTS.md` 修改聚焦）。
8. **不把账本当作文档或遥测。** 它是模型判断"我还能信任哪些名字"的证据。

## 7. 推荐的最小可持续边界

```text
python_eval
  └─ EvalKernelHost
       ├─ kernelGeneration: string          # 每次 spawn 生成，替代 #lastKernel 的引用比较
       ├─ onCellStart(cellId, generation)   # intent
       └─ onCellEnd(cellId, outcome, nameCount, diagnostic?)   # terminal
  └─ EvalExecutionFacts（新，小）
       ├─ append(intent | terminal)  -> pi.appendEntry("python-eval-facts", ...)
       └─ loadFromBranch()           -> session_start 时重建
```

- 边界只在 `pi-python-eval` 内部：ext-core 不新增能力，不新增跨 extension 依赖（`AGENTS.md:109`）。
- `#lastKernel` 的对象比较改为 generation 字符串比较：这一个改动就让 reload 后的 scope 丢失变成可见，而且不需要任何持久化——**这是最小起点，可独立落地并独立验证**。
- 恢复投影规则与 Bash 对齐：未终态 → `unknown` + "副作用可能已发生，未重放"；终态 → 原样恢复。恢复路径只读。
- 若后续确认需要覆盖"崩在 cell 中途"，再把 `EvalExecutionFacts` 的存储从 appendEntry 换成私有 SQLite；调用方不变。这是有意的两阶段，而不是提前建表。

## 8. 迁移风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 报告文案扰民 | 每次 reload 后第一个 cell 会多一行 "kernel 已替换" | 只在 generation 变化时输出一次，且与现有 `restarted` 行合并（`tool.ts:203-206`） |
| presentation 契约 | `EvalRow` 的 `state` 行被 `pi-ext-ui` 消费（`docs/architecture/eval.md` "输出、持久化与展示"） | 复用现有 `state` 行类型，不新增 row kind |
| 会话条目污染 | custom entry 不进 LLM 上下文，但会进 JSONL | 用 `customType` 前缀区分；不注册 renderer 则 TUI 不显示 |
| 分支语义 | appendEntry 写在当前分支，tree 导航后旧事实不该被看见 | 只读 `getBranch()`（`pi-coding-agent/docs/extensions.md:236`），与 Bash 的 `reconcileRecorded` 同思路 |
| 写失败 | `appendEntry` 抛错时不能让 cell 结果丢失 | 写失败只降级为诊断文本，不改变 cell 成败（与 `bash-jobs.ts:661-670` 的 "写盘失败不等于执行失败" 一致） |
| 双份事实 | 内存 `#lastKernel` 与持久 facts 可能不一致 | 以 generation 为唯一权威，内存只做缓存 |

## 9. 验证计划

按 `AGENTS.md` 的"最低足够验证"，全部落在单个 package 内。

阶段 1（generation 化，无持久化）：

1. `packages/pi-python-eval/test/eval-lifecycle.test.ts`（新建）：start → 跑 cell → shutdown → 再 start → 跑 cell，断言第二个 runtime 的第一个 cell 报告 "kernel 已替换" 且 `names: 0`。当前实现会失败（探针 A 即此用例）。
2. 回归：`test/eval-kernel-state.test.ts:173-186` 的"cell kill 了 kernel 就报告 restart"必须继续通过——generation 化后该用例的语义不变。
3. 保留 `reset` 不报 restart 的用例（`test/eval-kernel-state.test.ts:161-172`）。

阶段 2（appendEntry facts）：新增 `packages/pi-python-eval/test/eval-facts.test.ts`，覆盖：

- intent 写入后无 terminal → 重建时投影 `unknown`，且**不**重跑、不 spawn 任何额外进程；
- terminal 写入后重建 → 原样返回 outcome/nameCount；
- 写失败不改变 cell 结果（注入抛错的 `appendEntry`）；
- tree 导航到事实之前的节点 → 事实不可见；回到原节点 → 可见；
- 恢复路径只读：重建过程不产生新的 appendEntry。

必须补的、与账本无关但同属本次稳定性范围的用例（独立提交）：

- `host.ts:213` 的 `void #handle` 必须挂 `.catch`：teardown 时在飞 toolResult 不产生 unhandledRejection（探针 D 复现脚本可直接转成用例）；
- `host.ts:212` 的 `JSON.parse` 失败按协议错误处理，不抛到事件循环。

命令（阶段 1 + 阶段 2 完成后）：

```bash
pnpm exec biome check packages/pi-python-eval/src packages/pi-python-eval/test
pnpm exec vitest run packages/pi-python-eval/test
pnpm --filter @hheei/pi-python-eval run build
```

升级条件：只有改动 `pi-ext-core` 或 `packages/pi-python-eval` 的公共导出时，才额外跑 `pnpm run typecheck`。需要真实子进程的崩溃/孤儿用例若新增，放入 `packages/pi-python-eval/test-integration/` 并单独运行 `pnpm run test:integration`（当前该 package 没有 `test-integration/`）。

## 10. 关键事实索引

| # | 事实 | 来源 |
| --- | --- | --- |
| S1 | kernel 作用域 = extension runtime 实例；dispose 后拒绝执行 | `packages/pi-python-eval/src/kernel/host.ts:75`、`:139-143` |
| S2 | `restarted` 依赖实例内 `#lastKernel` 对象比较 | `host.ts:39-40`、`:79-86` |
| S3 | 新 host 报告 `restarted:false` + `names:0`（scope 静默丢失） | 探针 A（本文 §2.2） |
| S4 | 第二个 cell 并发立即失败；tool 声明 sequential | `host.ts:77`、`tool.ts:99`、`tool.ts:107` |
| S5 | 每个 cell 报告 namespace | `child.py:279-292`、`protocol.ts:18-24` |
| S6 | 失败 cell 带 namespace 回到模型 | `host.ts:250`、`protocol.ts:77-84` |
| S7 | 取消 = abort + SIGINT，5s 后 SIGKILL | `host.ts:18`、`:101-104`、`:317-325` |
| S8 | kernel 自行处理 KeyboardInterrupt 并回 done | `child.py:433-443` |
| S9 | 取消路径实测干净（212ms 失败，无 unhandled，kernel 存活） | 探针 C（本文 §2.3） |
| S10 | 超时是 host 墙钟硬截止，嵌套调用计入 | `tool.ts:24-26`、`:397-409`、`:114` |
| S11 | frame 1 MiB 上限，越界 kill kernel | `protocol.ts:4`、`host.ts:198-209` |
| S12 | 1.2MB 单行 → cell 失败、kernel 被杀、下个 cell 正常 | 探针 E（本文 §2.4） |
| S13 | fd1 与协议分离 + drain barrier | `child.py:20-34`、`:145-191`、`:420` |
| S14 | 无归属输出 8 KiB 缓冲，跨 cell 交付 | `host.ts:20`、`:273-292` |
| S15 | 6 线程并发 print 无丢失 | 探针 B（本文 §2.4） |
| S16 | POSIX watchdog；非 POSIX 直接返回 | `child.py:205-221`、`:206-207` |
| S17 | teardown 中在飞 toolResult → unhandledRejection | `host.ts:213`、`:253-270`；探针 D |
| S18 | frame 行 `JSON.parse` 无保护 | `host.ts:212` |
| S19 | `cancel` 消息声明但从未发送 | `protocol.ts:40`（全包唯一出现处） |
| S20 | `kernelCommand` 的 language 参数未使用 | `host.ts:345-347` |
| S21 | Bash：意图先落盘再 spawn | `packages/pi-bg-bash/src/bash-jobs.ts:364` |
| S22 | Bash：终态在日志关闭后落盘 | `bash-jobs.ts:841`、`:772-802` |
| S23 | Bash：settled 但 running/stopping 被拒绝 | `packages/pi-bg-bash/src/bash-ledger.ts:268-275` |
| S24 | Bash：`synchronous=FULL` + `.lock` 独占锁 | `bash-ledger.ts:183-201` |
| S25 | Bash：恢复投影为 `unknown`，不接管 PID、不重跑 | `bash-jobs.ts:269-303`；`docs/architecture/bash-execution-recovery.md:7-9` |
| S26 | Bash：交付状态不写账本，靠分支收据 | `bash-delivery.ts:259-278`、`:292-306` |
| S27 | Bash 进程 `detached`，因此需要跨 session 所有权 | `bash-jobs.ts:392` |
| S28 | Pi：reload 替换整个 extension runtime | `pi-coding-agent/docs/extensions.md:50` |
| S29 | Pi：`session_start.reason` / `session_shutdown.reason` 取值 | `pi-coding-agent/dist/core/extensions/types.d.ts:575-581`、`:637-642` |
| S30 | Pi：custom entry 不进 LLM 上下文 | `pi-coding-agent/docs/session-format.md:167-172` |
| S31 | Pi：分支敏感状态在 `session_start` 从 `getBranch()` 重建 | `pi-coding-agent/docs/extensions.md:236` |
| S32 | ext-core：shutdown 先 abort 再逆序 cleanup，聚合失败 | `packages/pi-ext-core/src/lifecycle.ts:66-79`、`packages/pi-ext-core/src/disposer-registry.ts:33-56` |
| S33 | 架构文档：变量只在 kernel 内存，session 边界清理，不恢复语言内存 | `docs/architecture/eval.md:15` |
| S34 | prompt 规则依赖 `restarted` 才重跑 setup | `packages/pi-python-eval/src/tool.ts:44` |
| S35 | 仓库约束：禁止未经确认的推测性抽象 | `AGENTS.md:14` |
| S36 | 仓库约束：具体 extension 可以不依赖彼此，跨包协作优先走 ext-core | `AGENTS.md:109` |

官方文档（Node.js）：

- `node:sqlite` `DatabaseSync`（选项 2 若采用需要）：https://nodejs.org/api/sqlite.html
- `child_process.spawn` 的 `stdio` / `detached` 语义：https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
- `AbortSignal.any`：https://nodejs.org/api/globals.html#static-method-abortsignalanysignals
- `process.kill` 与进程组信号（Bash 侧对照）：https://nodejs.org/api/process.html#processkillpid-signal

## 11. 探针脚本说明

§2 中的 A–E 均为一次性脚本（`/tmp/eval-probe-{a,b,c,d,e}.ts`），通过 `node --import jiti/register` 直接加载 `src/kernel/host.ts`，不需要构建。它们未提交、未修改仓库文件，只在本文中作为证据引用；阶段 1/2 的正式用例将用 `vitest` 在 `packages/pi-python-eval/test/` 内重写。
