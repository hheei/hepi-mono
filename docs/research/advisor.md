# Advisor `/advisor` 研究与功能边界

> 状态：历史研究；Advisor 当前没有 concrete extension implementation。以下内容只保留产品边界与研究结论。
> 日期：2026-07-22
> 范围：只定义产品和技术边界，不是实现规格，也不代表功能已经落地。

## 1. 摘要

本报告研究了三种 advisor/consult 设计：

- `rpiv-advisor`：executor 主动调用零参数 `advisor()` 工具，触发一次无工具 reviewer side-call；
- `bpx-consult`：在单次咨询之上扩展 solo、council、debate、persona、CLI backend 和自动触发；
- `pi-omplike-advisor`：一个长期存在的只读 shadow agent，每个主 Agent turn 都接收增量上下文，仅在发现具体问题时向主会话注入 advice。

结合“只有一个 `/advisor` 指令，并在 Settings 指定 advisor 模型和思考强度”的目标，建议独立 Advisor extension 实现 **OMPlike-lite**，而不是复制 RPIV 的 executor 工具或 BPX 的咨询编排：

1. 只注册一个 slash command：`/advisor [on|off|status]`。
2. 注册一个唯一 id 的模块 settings provider，其中 `advisor` group 有 `model` 和 `thinking` 两个字段；该 provider 再由现有 combined settings 聚合显示。
3. 不向 executor 注册 `advisor`/`consult` 工具。
4. Advisor 是 session-scoped、long-lived、read-only Agent，自动审阅每个主 Agent turn。
5. Advisor 只能通过内部 `advise` 工具提交结构化意见，不能直接编辑、执行 shell 或改变 session。
6. nit 在 turn 边界交付；concern/blocker 必须经过下一次 review 或 terminal catch-up 重新确认，再通过 custom message 以 `steer` 交还主 Agent。
7. V1 包含 advisor self-compaction，且绝不 hard-interrupt 主 Agent。
8. V1 不实现 council、debate、persona、CLI backend、自然语言触发、executor blocklist、自定义 prompt 文件或复杂 context ledger。

这个方案保留 OMPlike 的本质：**持续旁路审阅、独立上下文、只读验证、边界化反馈**；同时把公开配置和维护面压缩到 Advisor extension 自己的 command、settings、session lifecycle 与 TUI 边界内。

## 2. 需求解释

### 2.1 “一个指令”

“一个指令”应解释为只注册一个 Pi command 名称 `advisor`，而不是只允许一种无参数行为。建议在同一命令内支持：

```text
/advisor         等同于 /advisor status
/advisor status  显示状态、模型、思考强度和最近错误
/advisor on      为当前 session branch 启用 advisor
/advisor off     为当前 session branch 禁用 advisor 并释放 runtime
```

不新增：

- `/hepi advisor`
- `/advisor-config`
- `/advisor-model`
- `/consult`
- 自然语言短语触发

旧 aggregate 的 `HePiModule` registry 已删除，不能作为 `/advisor` owner；Advisor 应直接注册独立 command，沿用公开入口原则。

### 2.2 “一个 setting”

“一个 setting”建议解释为一个 `HePiSettingsProvider`，而不是把模型和思考强度编码为一个字符串字段。该 provider 下包含两个有类型的字段：

```text
Advisor
  model     enum: "" | provider/model-id
  thinking  enum: off | minimal | low | medium | high | xhigh | max
```

原因：

- 模型和 thinking 是两个独立约束，模型变化会改变可用 thinking levels；
- ext-core settings 已支持 provider/group/field、在 provider 创建时生成的 options、validation 和异步 storage；
- 组合字符串会迫使 UI、校验、迁移和错误信息重复解析一套隐式协议。

Settings 公共类型和生命周期见 [ext-core settings API](../../packages/pi-ext-core/src/settings.ts)。自动标题已经提供了 `provider/model` 选项、解析、认证验证和写入 `.pi/settings.json` 的可复用模式。[Auto Title settings](../../packages/pi-auto-title/src/index.ts)

## 3. 三个参考设计

### 3.1 RPIV Advisor：显式的一次性 reviewer 工具

#### 设计特色

RPIV 注册一个零参数 `advisor()` tool、一个 `/advisor` 模型/effort picker，以及 session restore 和 active-tool reconciliation hooks。

一次调用会读取 Pi 已解析的当前 branch context，删除正在执行但尚无 tool result 的 `advisor()` call，必要时补一个 user tail，然后调用指定 reviewer。Reviewer 请求显式使用 `tools: []`，返回 `plan`、`correction` 或 `stop signal` 类型的文本指导。[入口](https://github.com/juicesharp/rpiv-mono/blob/700c2d370353ca145d2658c61df1eee6297e8d80/packages/rpiv-advisor/index.ts) [执行](https://github.com/juicesharp/rpiv-mono/blob/700c2d370353ca145d2658c61df1eee6297e8d80/packages/rpiv-advisor/advisor/execute.ts) [上下文修正](https://github.com/juicesharp/rpiv-mono/blob/700c2d370353ca145d2658c61df1eee6297e8d80/packages/rpiv-advisor/advisor/context.ts) [系统提示词](https://github.com/juicesharp/rpiv-mono/blob/700c2d370353ca145d2658c61df1eee6297e8d80/packages/rpiv-advisor/prompts/advisor-system.txt)

它还提供：

- 可过滤模型 picker；
- reasoning level capability 检测；
- persist-first 配置切换；
- advisor tool 的动态 active/inactive；
- executor model/effort blocklist；
- executor tool inventory 和稳定序列化缓存；
- 多版本 `pi-ai` compatibility adapter；
- 统一的成功、取消、认证、provider error 和空响应 envelope。

#### 值得采用

- side-call 开始时 snapshot model/thinking，避免异步期间设置变化污染本次结果；
- 认证失败、取消、空响应和 provider error 都有明确结果；
- session context 必须复用 Pi 已处理 compaction/branch 的结果；
- 不能把 in-flight tool call 作为孤立 call 转发给另一个 provider；
- 保存配置成功后才更新运行时状态；
- reviewer 的职责必须由独立 system prompt 限定。

#### 不适合本目标

- 它依赖 executor 主动决定何时调用工具，不是持续 shadow review；
- tool schema、prompt snippet 和 guidelines 会占用 executor prompt，并改变 executor 策略；
- blocklist、guidance override、tool inventory cache 和多版本兼容不是 V1 必需能力；
- `/advisor` 自带模型 picker，与“模型在统一 Settings 中配置”重复。

结论：RPIV 适合作为 **context、安全调用和错误处理** 的参考，不适合作为产品交互模型。

### 3.2 BPX Consult：咨询编排平台

#### 设计特色

BPX 把一次咨询扩展为 `solo`、`gut-check`、`council` 和 `debate`。它还包含 persona roster、stance、confidence/agreement、CLI backend、短语触发、when-stuck/on-done 自动触发、feedback mode、每 turn 调用预算和大型配置 UI。[入口](https://github.com/gabelul/bpx-mono/blob/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult/index.ts) [配置](https://github.com/gabelul/bpx-mono/blob/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult/src/config.ts) [Council](https://github.com/gabelul/bpx-mono/blob/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult/src/council.ts) [Debate](https://github.com/gabelul/bpx-mono/blob/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult/src/debate.ts)

BPX 最有价值的工程部分是 context engine：

- 根据 **advisor 自身 contextWindow** 计算输入预算；
- 为响应预留 tokens 和安全 margin；
- 删除 in-flight consult call；
- 对 user/assistant/tool result 分别限长；
- 裁剪后修复 tool call/result 配对；
- 在最小 pinned context 仍放不下时 fail closed；
- context-too-long 时缩小 effective window 后有限重试。

见 [Context engine](https://github.com/gabelul/bpx-mono/blob/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult/src/context-engine.ts) 和 [Solo retry](https://github.com/gabelul/bpx-mono/blob/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult/src/solo.ts)。

#### 值得采用

- context 预算必须以 advisor model 为准，而不是主模型；
- 截断必须保留或修复 tool call/result 配对；
- 超时需要链接父 AbortSignal，并有固定 wall-clock 上限；
- 无法构造合法上下文时应 fail closed，不发送已知会失败的请求；
- 错误与 usage 应可观察，而不是只写 debug log。

#### 不适合本目标

- council/debate 会把一次 review 扩展为多次并行或顺序调用；
- persona、confidence、stance 和 synthesizer 引入第二套产品语言；
- CLI backend 增加 subprocess、协议解析和额外认证边界；
- 短语/自动触发和 delivery modes 会与 OMPlike 的 turn observer 重叠；
- 完整 evidence ledger 与大型 configurator 超出 Advisor extension 的维护预算。

结论：BPX 适合作为 **context-window invariant、timeout 和部分失败处理** 的参考，不应复制其编排层。

### 3.3 OMPlike Advisor：持续 shadow reviewer

#### 设计特色

OMPlike 创建一个长期存在的独立 `Agent`：独立模型、thinking level 和 message history；`read`、`grep`、`find` 只读工具；一个内部 `advise` tool；每个主 Agent turn 结束后接收一个 transcript delta。

它不是 executor，不能 edit、write、bash 或改变 session。Advisor 的普通模型文本不展示给用户；只有 `advise` tool 产生的结构化 note 才能进入主会话。[README](https://github.com/pasky/pi-omplike-advisor/blob/43eb9a976d751c06016a62b5423e2c6ddaff43a1/README.md) [Agent runtime](https://github.com/pasky/pi-omplike-advisor/blob/43eb9a976d751c06016a62b5423e2c6ddaff43a1/extensions/advisor.ts)

Advice 有 `nit`、`concern`、`blocker` 三个 severity。原实现为解决异步审阅导致的 stale feedback：

- nit 在合适 turn boundary 交付；
- concern/blocker 首次先 hold；
- 下一次 review 要求 advisor 重新确认，静默表示问题已经解决；
- 真正交付后才写入 dedup 状态；
- severity 只允许升级，不允许降级。

其 runtime 还实现 review 串行队列、epoch 防止 late callback、主 session compact/switch reset、advisor self-compaction、catch-up block、Escape 后抑制自动唤醒，以及 custom advisory renderer 和 `steer` delivery。

#### 值得采用

- 产品模型与本需求一致：持续 review，而非 executor 主动咨询；
- long-lived Agent 能积累审阅上下文，避免每 turn 重发完整 session；
- advisor 只读但可自行验证代码，比无工具 reviewer 更能发现事实错误；
- 私有 `advise` tool 是清晰的输出能力边界；
- 串行 drain、epoch、reset/dispose 是 session 安全的必要部分；
- `steer` 只在 turn boundary 注入，不 hard-abort 主 Agent；
- self-compaction 让长 session 不会静默停止 review。

#### 需要修正或简化

- 原实现默认启用且把 enabled 状态写入单独全局文件，不符合 Advisor extension 的 session-scoped 状态惯例；
- `modes.json` 和固定 OpenRouter fallback 应替换为统一 Settings；
- 自定义 `advisor.md`、`WATCHDOG.md` 和环境变量配置暂不引入；
- 原实现把主 Agent thinking 原样发送给 advisor，增加成本和潜在信息边界问题；V1 不应转发 thinking；
- 单个 delta 没有尺寸上限，fresh context 也可能装不下；应采用 BPX 的预算思想；
- “无 tool call 即 terminal”只能用于 `turn_end` 中的预判；该 hook 会被宿主 await，而最终 idle 必须以 `agent_settled` 为权威边界；
- “不会调用 abort”只适用于不 hard-abort 主 Agent；源码在 reset/dispose/self-compaction 时会 abort advisor Agent，新文档必须区分二者。

结论：OMPlike 是 **产品和 runtime 模型** 的主参考，RPIV/BPX 用来补强调用与上下文正确性。

## 4. 推荐产品边界

### 4.1 V1 必须提供

#### 公开入口

- `/advisor`
- `/advisor status`
- `/advisor on`
- `/advisor off`
- Settings 中一个 `Advisor` provider：`model`、`thinking`

#### 自动审阅

- 启用后观察每个主 Agent turn；
- 将主 turn 的 user input、assistant text、tool calls、tool results 和 edit diff 构造成 delta；
- 不转发 assistant thinking；
- delta 进入 session-scoped long-lived advisor Agent；
- 同一 session 的 reviews 严格串行；
- advisor 可以使用 `read`、`grep`、`find`、`ls` 和内部 `advise`；
- 不提供 `bash`、`edit`、`write`，也不加载项目 extension tools；
- advisor 普通文本永不直接进入主 transcript。

#### Feedback

- `advise` 参数：`severity` 和 `note`；
- severity：`nit | concern | blocker`；
- note 必须非空，并限制单条长度；
- note 在真实交付前按规范化文本去重；
- advice 通过 `pi.sendMessage({ customType: "advisor-advisory" })` 注入；
- delivery 使用 `deliverAs: "steer"`；
- 绝不调用主 Agent 的 `abort()`；
- 用户已 Escape 停止时，late advice 可以显示但不能 `triggerTurn` 自动恢复。

#### 生命周期

- 每个 Pi session 只有一个 AdvisorFeature runtime；
- `/advisor on` 懒创建 advisor Agent；
- `/advisor off` abort/dispose advisor Agent 并清空内存队列；
- `session_shutdown` cleanup 幂等；
- `/new` 创建无 advisor boundary 的新 branch，默认关闭；
- resume/fork/reload 从当前 branch 恢复 enabled boundary；`session_tree` 导航后重新 replay 当前 branch boundary 并 reset/rebuild runtime；
- advisor context 达到内部阈值时执行 proactive self-compaction，`length` overflow 时允许一次 fresh replay；单个 delta 在 fresh context 仍放不下则 fail closed；
- 主 session compaction 后 reset advisor transcript，保留 enabled 状态并从新 resolved context 重新 bootstrap；
- 每次 reset 增加 epoch，旧异步 callback 必须被丢弃。

#### 可观察性

`/advisor status` 至少显示：

- enabled/disabled；
- resolved `provider/model`；
- resolved thinking level；
- running/idle/failed；
- pending delta 数；
- 本 session 累计 usage/cost（宿主响应提供时）；
- 最近一次错误摘要。

### 4.2 V1 明确不提供

- executor 可调用的 `advisor()` 或 `consult()` tool；
- `/hepi advisor` alias；
- council、debate、gut-check；
- persona、stance、confidence、synthesizer；
- CLI backend；
- phrase trigger、when-stuck、on-done trigger；
- executor model/effort blocklist；
- 自定义 promptSnippet/promptGuidelines；
- `WATCHDOG.md` 或 advisor system prompt override；
- 自定义 timeout/context threshold setting；
- 跨 session 共用 advisor Agent/history；
- advisor 对文件的任何修改能力；
- advisor 普通 completion 文本直出给用户；
- 把主 Agent thinking 转发给 advisor；
- 完整 evidence ledger UI；
- 自动切换主 Agent 模型或 thinking level。

### 4.3 建议后置

1. 可配置的 mid-run/terminal catch-up timeout；
2. advisor-only 项目 guidance 文件；
3. context evidence ledger；
4. 按 executor model 禁用；
5. advisor prompt 自定义；
6. 自定义 context compact threshold；
7. 仅审阅 final turn 或仅审阅有 edit 的 turn 等采样策略。

high-severity hold/reconfirm 不后置：异步 shadow review 天然会产生 stale advice，concern/blocker 若未经复核就重启已经结束的 final turn，会破坏该模式最重要的时序保证。V1 可以固定 timeout 和 backoff，不需要同时公开这些策略的配置。

## 5. 状态与持久化

### 5.1 配置状态

模型配置是项目级设置，建议写入：

```json
{
  "advisor": {
    "advisor": {
      "model": "anthropic/claude-opus-4-7",
      "thinking": "high"
    }
  }
}
```

文件位置：`<cwd>/.pi/settings.json`。

契约：

- `model = ""` 表示未配置；
- `/advisor on` 在未配置模型时失败并提示打开 `/ext-settings`；
- model 必须能由 `ctx.modelRegistry.find(provider, id)` 解析；
- model 必须有 configured auth；
- 非 reasoning model 的 effective thinking 永远为 `off`；
- 不支持的 thinking level 推荐在保存时拒绝，避免静默变化；
- settings 保存成功后，enabled runtime 才重建；保存失败保留旧 runtime；
- settings 变化不得调用 `pi.setModel()` 或 `pi.setThinkingLevel()`，因为这两个 API 修改的是 executor。

### 5.2 运行状态

enabled/disabled 属于当前 session branch，不属于项目 setting。建议使用 versioned custom entry：

```ts
type AdvisorBoundary = {
  version: 1;
  enabled: boolean;
};
```

custom type：`advisor-mode`。

这与 Plan/Goal 的 branch-backed persistence 一致，并自然满足 reload/resume、fork、tree navigation 和新 session 默认关闭。它也避免跨项目、跨 session 的隐式模型费用。

持久化 decoder 必须：

- 只接受精确 version 和字段；
- 找到当前 branch 中最后一个 `advisor-mode` entry，再对它严格 decode；不能先过滤 malformed entry 后回退到更早状态；
- 最后一个 matching entry malformed 时 fail closed 为 disabled 并 warning；
- `/advisor off` 先 append disabled boundary，再 teardown；
- `/advisor on` 先验证配置和构造 runtime，再 append enabled boundary；构造失败不得留下 enabled boundary，append 失败必须 teardown 刚创建的 runtime。

Plan 的 versioned boundary 和严格 decode 可作为模式参考。

### 5.3 内存状态

建议每个 session runtime 维护：

```ts
interface AdvisorRuntimeState {
  enabled: boolean;
  epoch: number;
  phase: "disabled" | "idle" | "reviewing" | "failed";
  modelRef?: string;
  thinking: ThinkingLevel;
  pendingDeltas: TurnDelta[];
  pendingAdvice: Advice[];
  deliveredAdvice: Map<string, Severity>;
  usage: UsageTotals;
  lastError?: string;
}
```

这些状态默认不写盘。只有 `enabled` boundary 和 model/thinking settings 持久化。

## 6. 推荐数据流

### 6.1 启用

```text
/advisor on
  -> 等待主 Agent idle
  -> 读取 Advisor settings
  -> resolve model + auth + supported thinking
  -> 创建独立 in-memory Agent
  -> 注册私有 read-only tools + advise
  -> 从 Pi resolved branch 构造 bootstrap context
  -> append enabled boundary
  -> phase = idle
```

启用中途需要 bootstrap 当前已解析 branch，否则 advisor 只看到启用后的 delta，会缺失任务目标和既有决策。Bootstrap 必须通过公开的 `buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())` 和 `convertToLlm()` 构造 typed messages，并保留 Pi 已处理的 compaction/branch summary；不要遍历 raw entries 后自行拼 transcript。

### 6.2 每个 turn

```text
before_agent_start
  -> capture 本轮 user prompt（不含敏感 system prompt）

turn_end（宿主逐个 await）
  -> capture assistant text/tool calls/tool results/edit diff
  -> 构造有大小预算的文本 TurnDelta
  -> enqueue(delta, epoch)
  -> 单一 drain loop 串行 review
  -> 有 held high-severity 或疑似 terminal 时执行有上限的 catch-up block

advisor review
  -> 发送 delta 给长期 Agent
  -> advisor 可用 read/grep/find/ls 验证
  -> advisor 可调用 advise 0..N 次
  -> 普通 completion 文本丢弃
  -> nit 进入可交付队列；concern/blocker 进入 held queue

agent_settled（权威最终 idle 边界）
  -> 最后一次 terminal catch-up
  -> 交付重新确认的 high-severity advice
  -> idle 后需要主 Agent 响应时显式 triggerTurn
```

当前宿主会 await async `turn_end` handler，因此该 hook 可以有意阻塞下一步；但在 handler 内 `ctx.isIdle()` 仍不能作为 terminal 权威判断。tool-call/stopReason 只能预判，`agent_settled` 才表示自动 retry、compaction 和 follow-up 均已结束。不要从多个 hooks 各自启动 review：它们只驱动同一个 queue/drain loop，以保证 advisor transcript 顺序和 usage 统计一致。

### 6.3 关闭与 reset

```text
/advisor off | session_shutdown
  -> epoch++
  -> abort advisor Agent 当前请求
  -> 清空 pending delta/advice
  -> dispose Agent 和订阅
  -> phase = disabled
```

这里 abort 的是 **advisor Agent**，不是主 Agent。

主 session compact 时增加 epoch、abort advisor request、clear advisor transcript/queue/dedup、保持 enabled，并从 compact 后 resolved branch 重新 bootstrap。

## 7. Context 契约

Context 是本功能最容易产生 provider 错误、成本失控和错误审阅的部分。

### 7.1 输入内容

V1 有两种输入形态：

- **bootstrap**：由 `buildSessionContext()` + `convertToLlm()` 得到的 typed messages，用于启用、primary compact 或完整 reset 后重建基线；
- **turn delta**：序列化成单个 user evidence message 的受预算文本，不把主 Agent 的 tool calls/results 伪装成 advisor provider protocol。

内容包括：

- 当前任务所需的 resolved branch bootstrap；
- 每 turn 的 user text；
- assistant 对用户可见 text；
- tool call 名称与参数；
- tool result 文本；
- 成功 edit/write 的 point-in-time diff；
- 失败工具的错误文本；
- 当前 cwd 和 turn sequence id。

V1 不发送：

- 主 Agent thinking blocks；
- 主 Agent 完整 system prompt；
- API key、headers、env；
- settings 文件中的无关字段；
- advisor 自己产生的 custom advisory message（避免反馈回路）；
- 其他 session branch 的 entries。

### 7.2 大小预算

必须以 advisor model 的 `contextWindow` 为预算基准：

```text
inputBudget = contextWindow - responseReserve - safetyMargin
```

建议固定内部策略而不是新增用户 setting：

- response reserve 取模型 `maxTokens` 与内部上限的较小值；
- safety margin 为 context window 的 10%；
- 单个 user/assistant/tool result 各自有字符 cap；
- diff 优先保留文件路径和 changed hunks；
- 截断必须加显式 marker；
- 每次 review 前同时检查长期 Agent 的累计 context usage；达到内部阈值时 reset transcript，并从 fitted typed bootstrap 加当前 delta 重建；
- provider 返回 `length` 时只允许 reset 后 fresh replay 一次；
- fresh context 仍超限则 fail closed，并在 `/advisor status` 暴露错误。

### 7.3 Tool pairing

Tool pairing 只适用于 typed bootstrap 和 advisor Agent 自己的 private-tool history：

- typed bootstrap 裁剪时把主 Agent 的 tool call/result pair 视为原子单元；
- 不保留无对应 result 的历史 tool call；
- 不保留无对应 call 的 tool result；
- 不把正在执行中的不完整 pair 放入 bootstrap；
- 文本 turn delta 只把 tool activity 当成 evidence，不创建 provider toolCall/toolResult blocks，因此不需要 pair repair；
- advisor 私有 tools 只存在于 advisor transcript，不能混入主 transcript delta；
- compact/reset 后从完整 resolved message boundary 重建。

BPX 的 context engine 对 typed context 的这些 invariant 有系统测试，值得参考但不需要整体移植。[Context engine tests](https://github.com/gabelul/bpx-mono/blob/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult/tests/context-engine.test.ts)

## 8. Advisor Agent 契约

### 8.1 工具白名单

允许：`read`、`grep`、`find`、`ls`、`advise`。

禁止：`bash`、`edit`、`write`、`ask`、`todo`、`goal`、MCP tools 和项目/用户 extension tools。

`read/grep/find/ls` 必须绑定主 session 的 `cwd`，且 runtime 只在 trusted project 中创建。Advisor 只读并不等于无信息风险：它仍能读取项目内容并发送给所选 provider，因此 README 和 Settings description 必须明确这一点。

### 8.2 System prompt

V1 prompt 应固定在包内并进入代码审查，核心约束：

1. 你是主 Agent 的代码审阅者，不是 executor。
2. 只检查 correctness、遗漏、边界条件、回归、测试缺口和不安全操作。
3. 先用只读工具验证事实；不要对未知事实下结论。
4. 没有具体、可操作的问题时保持静默。
5. 不直接对用户讲话，不总结进度，不发 all-clear。
6. 每条问题必须通过 `advise` 提交；普通输出会被丢弃。
7. 引用具体文件和位置；避免重复已交付意见。
8. 不改变用户目标，不把个人偏好包装成 blocker。

V1 不允许项目覆盖 prompt，避免在建立基本安全边界前引入第二条 prompt injection 路径。

### 8.3 `advise` schema

```ts
{
  severity: "nit" | "concern" | "blocker";
  note: string;
}
```

不加入 `file`、`line` 等强制结构，因为一条意见可能跨多个文件，且模型容易伪造精确行号。文件位置应写入 note，renderer 只负责 severity 和正文。

## 9. Feedback 与时序

### 9.1 V1 交付策略

V1 保留 OMPlike 的 severity-aware 时序：

- 每条 advice 记录 `reviewedTurnId`；
- nit 在非 terminal turn boundary 交付，并明确标记“针对较早 turn 的审阅意见”；
- concern/blocker 首次 emission 只进入 held queue，不立即 steer；
- 下一次 review 的 preamble 要求 advisor 重新确认 held advice：重新 raise 表示仍成立，静默表示已解决；
- terminal/`agent_settled` 边界执行有上限的 catch-up review，只有重新确认的 concern/blocker 才能触发新的完整 final answer；
- 真正交付后才写入 dedup；相同规范化 note 只有 severity 提升才可再次交付；
- self-compaction 保留 held queue，primary compact/reset 清除 held queue；
- timeout 或 review failure 不交付 partial advice；terminal timeout 可显示“review incomplete”状态，但不能把未确认 blocker 当成事实注入。

### 9.2 为什么 reconfirm 属于 V1

Shadow review 的 provider 调用天然比主 Agent 慢。高严重意见到达时，主 Agent 可能已经在同一 run 的后续 turn 修复问题，或已经给出 final answer。未经复核直接 steer concern/blocker 会制造 stale interruption；这不是可选的产品优化，而是异步架构的正确性边界。

V1 不必复制 OMPlike 的所有动态 backoff 和 best-effort 分支，但必须保留 held、reconfirm、resolved-by-silence、deliver-after-confirm 这条最小状态机。

### 9.3 超时与取消

建议 V1 固定内部上限：

- 单次 review wall-clock timeout：60 秒；
- terminal catch-up 最多等待：60 秒；
- 普通非 terminal turn 仅在没有 held concern/blocker 时不阻塞；存在 held high-severity 时，`turn_end` 执行有上限的 catch-up；
- Escape/parent abort 结束等待，并 abort 当前 advisor request；
- timeout 后 drain 可以继续后续 delta，但当前 delta 标记 failed，held advice 保留到下一次成功 review；
- 同一 delta 不做无限重试；context-too-long 最多 fresh replay 一次。

固定值应先作为实现常量，不新增 setting。只有使用数据证明不同 provider 需要配置时再公开。

## 10. 最终 package 集成

### 10.1 未来文件布局

```text
future Advisor extension/
  extension.ts      package entry
  feature.ts        session lifecycle and command
  runtime.ts        review runtime
  settings.ts       settings provider
```

以下章节保留实现前的边界理由；当前没有 package 文件拆分可作为依据。

### 10.2 入口集成

在未来 Advisor extension entry 中：

1. 创建 AdvisorFeature factory；
2. 在 session `onStart` 中绑定当前 `pi`、`ctx` 和 session registry；
3. 注册 `/advisor`；
4. 注册所需 lifecycle hooks；
5. 把唯一 id 的 Advisor 模块 provider 交给现有 `combineSettingsProviders()` 聚合；
6. cleanup 时逆序 dispose；
7. 不注册旧 aggregate module；Advisor 只拥有独立 `/advisor` command。

当前没有 Advisor entry 或 feature 实现；未来入口应使用 ext-core lifecycle contract。

### 10.3 Settings 组合

Advisor 应创建唯一 id 的模块 provider，其中 group id 为 `advisor`。入口把它与 auto-title、RTK 等 provider 一起交给 settings host；不要复用旧 aggregate settings id。Advisor storage 自己只读写 `.pi/settings.json` 的 `advisor` section，settings host 只负责统一展示和分发 storage 生命周期。[Settings registry](../../packages/pi-ext-core/src/settings.ts)

| Field | Type | Default | 规则 |
| --- | --- | --- | --- |
| `model` | enum | `""` | provider 创建时由 authenticated available models 生成 options |
| `thinking` | enum | `"high"` | options 使用完整静态全集；结合整组 model 状态校验，非 reasoning effective=`off` |

`HePiSettingsProvider.onChange` 发生在 storage save 之前，因此不能在 `onChange` 中永久替换 active runtime。应像 auto-title 一样包装 storage：`onChange` 只做 parse/capability 预检，backing storage 成功保存后再调用 post-persist callback 重建 runtime；保存失败则 SettingsController 回滚 UI，旧 runtime 保持不变。

Settings UI 遵循 `DESIGN.md` 和现有 enum 交互，不为 Advisor 新建模型 picker。[DESIGN](../../DESIGN.md)

### 10.4 AI API 依赖

Advisor extension 当前没有显式 `@earendil-works/pi-ai` 或 `@earendil-works/pi-agent-core` peer dependency。OMPlike 直接使用 `pi-agent-core Agent`，RPIV/BPX 使用 `pi-ai` completion API；两条路都不能假定仅靠当前 package metadata 就能解析。

Phase 0 必须在实现前形成一个受测、不可含糊的依赖决策：

- **SDK route**：使用 `@earendil-works/pi-coding-agent` 公开的 `createAgentSession`、`SessionManager.inMemory()` 和 read-only tool allowlist，同时注入隔离的 ResourceLoader，确保不会递归加载主 session extensions。此路线还必须证明 advisor 能使用当前 host 的动态 provider/auth；新建 `ModelRuntime` 不天然等同于 `ctx.modelRegistry` 背后的 runtime。
- **Core route**：显式增加与仓库 Pi 版本匹配的 `pi-agent-core`/`pi-ai` 依赖，以 `ctx.modelRegistry.getApiKeyAndHeaders()` 驱动 stream/auth，并把 Agent 构造、thinking、abort、usage 和 stopReason 封装在 `runtime.ts`。

如果 SDK route 无法复用动态 provider/auth，V1 不得静默 fallback 到另一套模型目录；应选择 Core route，或明确限制 Advisor 只支持 SDK runtime 可解析的 provider。不要在 feature 文件中动态探测多个 import path。

### 10.5 `pi-subagents` 依赖评估

Auto-title 已经通过 event bus 使用外部 `@tintinweb/pi-subagents` RPC v2，因此复用它看起来比新增 Agent runtime 更轻。[Auto Title RPC client](../../packages/pi-auto-title/src/index.ts) 但现有 RPC 的公开实现只提供：

```text
subagents:rpc:ping
subagents:rpc:spawn
subagents:rpc:stop
```

`spawn` 接受 agent type、prompt、model、thinking、maxTurns、isolated、inheritContext 和 cwd 等选项，模型字符串会在 RPC 边界用当前 `ctx.modelRegistry` 解析；完成结果通过 `subagents:completed`/`subagents:failed` 生命周期事件返回。[RPC source](https://github.com/tintinweb/pi-subagents/blob/master/src/cross-extension-rpc.ts) [Agent manager](https://github.com/tintinweb/pi-subagents/blob/master/src/agent-manager.ts)

`pi-subagents` 内部已经具备 AgentSession、自动 compaction、usage、abort、`resume()` 和 `steer()`，但 RPC v2 的**公开契约没有暴露 resume、steer、status、reset、session handle 或 child callbacks**。公开 spawn 契约也不支持动态传入：

- inline system prompt/agent definition；
- 精确 builtin tool allowlist；
- extension/tool selectors；
- private `advise` tool schema 和 handler；
- suppress widget/transcript/notification 的完整策略；
- persistent child 的 follow-up request。

工具和 system prompt 主要来自 `.pi/agents/<name>.md` 或全局 custom-agent frontmatter；`isolated: true` 只关闭 extensions/skills，并不替调用方定义 builtin tool allowlist。[Custom agents](https://github.com/tintinweb/pi-subagents#custom-agents) 因此，除非额外要求用户安装一个固定 `advisor.md`，否则 RPC 无法保证 Advisor 只有 `read/grep/find/ls`。未知 type 的 fallback 也不能作为安全边界。

当前实现把 `options` 以 `any` 原样传给 manager，同进程 event bus 技术上可以偷渡 `onSessionCreated` 等函数 callback，拿到内部 `AgentSession` 后再直接调用或修改 `agent.state.tools`。这不是公开 RPC contract：类型未导出、capability handshake 不声明、版本升级可随时移除，而且绕过 manager 的 status/resume/usage/lifecycle。依赖这个实现漏洞比直接使用受测 SDK/Core API 更脆弱，也没有减少 Adapter 工作量，因此不作为可行复用方案。

#### 两种可行形态

| 形态 | 可复用能力 | 代价/缺失 | 判断 |
| --- | --- | --- | --- |
| 每 turn `spawn` 新 reviewer | model/auth、thinking、AgentSession、内建工具、compaction、stop、completion event | 无长期 context；每次重发历史；无 private `advise`；held/reconfirm 由 parent 模拟；依赖外部 extension 和 custom agent 文件 | 代码较少，但属于 stateless reviewer，不是本报告定义的 OMPlike V1 |
| 同一 child 多次 review | 理论上可复用内部 `resume()`/session/compaction | RPC 当前未暴露；无法 reset、精确隔离工具或捕获 private tool | 当前不可实现 |

#### 为什么不建议作为 V1 基线

1. **产品语义改变**：每 turn spawn 是 RPIV/BPX 式 stateless side-call，不是 long-lived shadow reviewer。
2. **只读边界不足**：RPC 不能动态下发准确的 builtin tool allowlist 和 private `advise`。
3. **状态机没有减少**：held advice、reconfirm、epoch、turn attribution 和 delivery 仍要由 Advisor extension 实现。
4. **context 成本更高**：child 不保留历史时，parent 必须重复发送 fitted bootstrap/history。
5. **多一个强运行时依赖**：未安装、未加载、被 child extension allowlist 排除或 RPC 版本不匹配时，`/advisor on` 必须 fail closed。
6. **协议不是 capability-based**：`ping` 只返回 version，不能区分 persistent/resume/private-tool 等能力。

因此推荐：**V1 继续选择 SDK route 或 Core route，不依赖现有 `pi-subagents` RPC。** Auto-title 仍可保留现有 one-shot RPC，因为它本来就是一次性、单结果、无私有工具的任务。

#### 何时可以改用 `pi-subagents`

如果上游未来提供 typed service 或新 RPC capability，至少包含以下契约，Advisor 才适合迁移：

```text
createPersistent(agentSpec) -> childId/sessionId
send(childId, delta, requestId)
interrupt(childId, requestId)
reset(childId, epoch)
dispose(childId)
status(childId)
```

`agentSpec` 还必须支持固定 system prompt、`read/grep/find/ls` allowlist、`extensions: false`、不落盘选项，以及 private structured-output tool 或等价的严格 schema result channel。Capability handshake 必须显式声明 `persistent`, `send`, `reset`, `private-tools`，不能只靠整数 version 推断。

若这些能力落地，复用 `pi-subagents` 会真正省掉 Agent 构造、auth、compaction、usage、abort 和 child lifecycle；在此之前，为了复用一次性 spawn 而降低产品契约，得不偿失。

## 11. 不变量

实现和测试应把以下条件当作硬契约：

1. Advisor 永远不能修改文件、执行 shell 或改变 session。
2. Advisor 的模型和 thinking 不改变 executor 的模型和 thinking。
3. 每个 session runtime 的 state、queue、Agent 和 callbacks 不泄漏到其他 session。
4. reset/off/shutdown 后的 late callback 不能交付 advice。
5. reviews 对同一 session 严格按 turn 顺序处理。
6. forwarded context 不包含 orphan tool call/result。
7. forwarded context 不超过 advisor model 的预算。
8. 主 Agent thinking 不转发。
9. advisor 普通文本不进入用户 transcript。
10. 只有 private `advise` tool 可以产生 feedback。
11. feedback 不 hard-abort 主 Agent。
12. Settings 写入失败时继续使用旧的有效 runtime/config。
13. 未配置、模型失效或缺少 auth 时 `/advisor on` fail closed。
14. `/advisor off` 和 cleanup 幂等。
15. non-TUI/RPC 模式不依赖 custom UI；`status/on/off` 仍有确定行为。

## 12. 错误语义

| 类别 | 行为 |
| --- | --- |
| 未配置模型 | `/advisor on` 拒绝；保持 disabled |
| 模型不存在/无 auth | 拒绝或停用；status 显示原因 |
| setting 保存失败 | 保留旧 config/runtime |
| runtime 创建失败 | 不写 enabled boundary |
| provider error | 当前 delta failed；记录 lastError；后续 delta 可重试 |
| timeout/abort | 当前 review cancelled；不交付 partial advice |
| context 无法拟合 | fail closed；不发 provider 请求 |
| advisor tool error | 当前 review failed；不污染主 session |
| malformed branch boundary | disabled + warning |
| stale callback | 静默丢弃，可 debug 记录 |

不要把正常 provider 故障抛出到主 Agent loop 使其失败；同时也不要完全吞掉。`/advisor status` 和一次非刷屏 notification 应提供可观察性。

## 13. 测试范围

### 13.1 单元测试

```text
test/modules/advisor/model.test.ts
test/modules/advisor/settings.test.ts
test/modules/advisor/persistence.test.ts
test/modules/advisor/context.test.ts
test/modules/advisor/feedback.test.ts
test/modules/advisor/runtime.test.ts
test/modules/advisor/feature.test.ts
test/modules/advisor/command.test.ts
```

重点：

- model ref 和 thinking capability；
- settings load/save/rollback；
- boundary strict decode 和 branch replay；
- bootstrap 使用 compact summary；
- thinking/custom advisory 排除；
- tool call/result pairing；
- context budget 和 oversized single delta；
- queue 串行顺序；
- epoch/stale callback；
- dedup 和 severity escalation；
- off/reset/dispose 幂等；
- provider success/error/abort/timeout/empty response；
- executor model/thinking 未变化；
- command 参数、状态输出和 non-TUI 行为。

### 13.2 集成测试

- session start -> on -> turn -> advice -> off；
- reload/resume/fork/new 的 branch 状态；
- primary compact 后 advisor bootstrap/reset；
- session tree navigation 后 replay branch boundary 并丢弃旧 epoch callback；
- `turn_end` catch-up 与 `agent_settled` final delivery；
- held concern/blocker 的 re-raise、silence-resolve、timeout 保留；
- proactive/reactive self-compaction 和 fresh replay 仍溢出；
- Escape 后 late advice 不 triggerTurn；
- enabled 时修改 model/thinking，保存成功后 runtime 重建；
- 保存失败时旧 runtime 保持；
- advisor 无写工具、无 extension tools；
- narrow/wide status 或 custom renderer 的 ANSI/cell-width 安全。

### 13.3 不以 live provider 为主要正确性测试

绝大多数测试应注入 fake AdvisorRuntime/Agent。Live smoke test 只验证目标 Pi 版本 API 可创建独立 Agent、auth/thinking/abort 能传递、private tool call 能被捕获、usage 能累计。

不能用真实模型的主观输出代替 queue、context 和 lifecycle 的确定性测试。

## 14. 实施分期

### Phase 0：API spike

- 在 SDK route 与 Core route 中做出明确依赖选择；现有 `pi-subagents` RPC 不作为 V1 runtime 候选；
- 验证 read-only tool factory、private tool、动态 provider/auth、thinking、abort、usage；
- 以当前宿主已确认的 async `turn_end` await 语义构造最小 catch-up harness；
- 验证 `agent_settled` 作为最终 idle 边界，以及 idle 后 `triggerTurn` 的行为；
- 产出一个不接入入口的最小测试 harness。

### Phase 1：配置与命令

- Advisor settings group；
- model/thinking validation；
- branch boundary persistence；
- `/advisor on|off|status`；
- runtime lifecycle skeleton。

### Phase 2：Shadow review

- typed bootstrap + text turn delta；
- long-lived read-only Agent；
- private `advise`；
- 串行 drain、epoch、timeout；
- nit delivery 与 held concern/blocker reconfirm；
- `turn_end` catch-up + `agent_settled` final boundary；
- context budget/tool pairing；
- proactive self-compaction、length fresh replay、oversized-single-delta fail-closed；
- primary compact reset/bootstrap。

### Phase 3：长会话与可观察性强化

- usage/status/last error；
- long-context、stale callback 和 repeated-compaction tests；
- timeout/backoff 调优；
- advisory renderer 的 narrow/wide 布局。

### Phase 4：根据数据决定

- advisor-only project guidance；
- context ledger 或采样策略；
- executor model policy；
- prompt/threshold 高级配置。

## 15. 需要在实现评审确认的决策

本报告给出推荐默认值，但以下项目应在 Phase 0 后最终确认：

1. 独立 Agent 使用 `createAgentSession` 还是显式依赖 `pi-agent-core Agent`，以及动态 provider/auth 的支持边界；
2. `getSupportedThinkingLevels` 或等价 capability API 的稳定导出；
3. primary compact 后 typed bootstrap 的最佳 public API；
4. advisor read-only tools 是否加入 `ls`（建议加入）；
5. catch-up 的固定 timeout/backoff 数值；
6. contextWindow 的 response reserve 和 safety margin 常量。

这些是实现机制选择，不改变上面的产品边界。

## 16. 最终建议

`Advisor /advisor` 应被定义为：

> 一个由 `/advisor` 控制、由统一 Settings 选择模型和思考强度、随当前 session branch 生命周期运行的只读 shadow reviewer。它自动审阅主 Agent 的 turn delta，只能通过结构化 advice 在 turn 边界向主 Agent 反馈，不拥有执行权限，也不向 executor 暴露咨询工具。

最重要的取舍是：

- 产品模式选 OMPlike；
- context/错误正确性借鉴 RPIV 与 BPX；
- 配置和生命周期遵循 ext-core contract；
- V1 只做单 advisor，不做咨询平台；
- 现有 `pi-subagents` 只适合 one-shot delegation，不作为 long-lived Advisor runtime；
- V1 先保证隔离、顺序、预算、取消和 reset，再讨论更多策略。

这条边界既保留持续审阅的价值，也避免把 RPIV 的主动工具策略、BPX 的多模型编排和 OMPlike 的全部成熟状态机一次性搬入 Advisor extension。
