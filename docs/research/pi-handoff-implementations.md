# Pi Handoff 三种实现对比研究

> 状态：历史研究记录，不是实现规格；其中的实现建议已由 [ADR-0016](../adr/0016-pi-mctx-clean-session-handoff.md) 与 [Magic Context Handoff 规格](../handoff/README.md) 取代。旧 `@hheei/pi-handoff` 已删除。
> 日期：2026-08-08
> 范围：比较当前仓库的 `@hheei/pi-handoff`、`/home/chlo/Downloads/pi-session-handoff`，以及 `arichiardi/ar-llm` 的 `@ar-llm/pi-handoff`。

## 结论先行

三者并不是同一种 handoff：

| 实现 | 主要语义 | 最值得学习的部分 | 不应直接复制的部分 |
| --- | --- | --- | --- |
| 当前 `@hheei/pi-handoff` | 压缩当前 session，创建带 parent link 的 replacement session | 使用 Pi native compaction；等待 idle；隐藏 custom message；失败后保留 source 可 resume；公共 API 和 focused tests | 只复制 `CompactionResult.summary`，会遗漏 native compaction 刻意保留且未摘要的 recent context（当前 host 由 `firstKeptEntryId` 指定；新格式可内嵌 `retainedTail`）；当前命令也没有 continuation goal |
| `pi-session-handoff` | 从任意旧 session 选择来源，把摘要注入当前 session | 来源选择/autocomplete；短中长分层；cache hit/miss 和成本反馈；长 session 的增量摘要；显式历史数据安全提示 | raw branch 解析不支持新版 compaction checkpoint；LLM 路径在输出后才遮罩 secrets；cache key 没有包含 model/prompt 版本；测试和路径绑定 Windows 环境 |
| `@ar-llm/pi-handoff` | 当前 session 加一个明确 goal，生成 continuation prompt，创建 replacement session | goal 驱动；生成后可人工编辑；使用 replacement context；可取消的 loader；compaction-aware 的意图 | 手动重建 branch；调用私有 `modelRegistry.runtime`；配置模型时静默 fallback；创建后自动 `sendUserMessage`，没有显式提交边界 |

推荐的最小下一步是：**保留当前 native handoff 主体，先把 Pi compact 后的完整 resolved context（summary + kept recent context）投影到 replacement，再增加可选 goal 和 replacement editor prefill；暂时不把任意旧 session import、独立 summarizer、chunk cache 合并进主命令。**

## 1. 当前实现的基线

当前实现的控制流是：

```text
/handoff [必须为空]
  -> waitForIdle()
  -> ctx.compact()
  -> 取得 Pi native summary
  -> newSession({ parentSession })
  -> setup: 写入隐藏 hepi-handoff custom message
  -> withSession: 只使用 replacement ctx 显示完成通知
```

这个边界是稳的：

- `ctx.waitForIdle()` 把 streaming、tool execution、自动 retry 和 queued continuation 排除在 session mutation 之外。[`packages/pi-handoff/src/handoff.ts:44-53`](../../packages/pi-handoff/src/handoff.ts#L44)
- summary 由 Pi native compaction 生成，而不是 extension 自己重复实现另一套 transcript parser。[`packages/pi-handoff/src/handoff.ts:13-19`](../../packages/pi-handoff/src/handoff.ts#L13)
- **当前有一个关键完整性缺口：** `CompactionResult.summary` 只概括 `messagesToSummarize`；Pi 会保留一段未摘要的最近上下文。当前安装的 host 用 `firstKeptEntryId` 指定这段 entries，更新的 session format 也允许把它直接存成 `retainedTail`。当前 `createHandoffSession()` 只写入 summary，没有把 compact 后的 resolved kept context 投影到 replacement，因此最近的 user/assistant/tool context 可能丢失。[`packages/pi-handoff/src/handoff.ts:22-31`](../../packages/pi-handoff/src/handoff.ts#L22)
- replacement session 保留 `parentSession`，handoff context 作为不可见的 `custom_message` 进入新 session 的 LLM context。[`packages/pi-handoff/src/handoff.ts:22-35`](../../packages/pi-handoff/src/handoff.ts#L22)
- `withSession` 使用 Pi 提供的新 context，没有在 session replacement 后继续使用旧的 session-bound context。[`packages/pi-handoff/src/handoff.ts:33-35`](../../packages/pi-handoff/src/handoff.ts#L33)
- compact、new session 和 setup failure 都明确告诉用户 source session 仍可 resume；Pi 在 setup 之前切换 replacement、且 public API 没有 rollback，这个限制也已经写入设计文档。[`docs/handoff/README.md:15-22`](../../docs/handoff/README.md#L15)
- focused test 覆盖 duplicate registration、idle ordering、native compact、parent link、hidden entry、argument rejection、cancel 和 failure；本地执行结果为 `4 pass, 0 fail`，但 mock compaction 只有 summary，未验证 kept-context 完整性。[`packages/pi-handoff/test/handoff.test.ts:102-147`](../../packages/pi-handoff/test/handoff.test.ts#L102)

Pi 本身已经提供了适合 handoff 的能力：`ctx.compact({ customInstructions })`、`ctx.newSession({ parentSession, setup, withSession })`，以及 `withSession` 中的 `setEditorText`/`sendUserMessage`。[Pi extensions API](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#ctxcompact)

Pi native compaction 也已经有结构化 summary、文件追踪、tool result 截断、重复 compaction 的 previous summary 处理，以及“summary + kept recent context”的恢复语义。[Pi compaction docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) [Pi session format](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)

这里必须区分安装版本和较新格式：当前安装的 Pi 0.84.1 `dist` 在 `CompactionEntry` 写入 `firstKeptEntryId`；同包 session-format 文档还描述了较新的 self-contained `retainedTail`。handoff 应依赖 Pi 的 resolved context projection，不应绑定其中任一 storage representation。

因此，当前实现的首要缺口是**只转交 summary 而遗漏 Pi 保留的 recent context**；修复完整性后，第二个缺口才是 **handoff 没有表达下一 session 要继续做什么**。这两个问题都不要求引入另一套 summarizer。

## 2. `pi-session-handoff`：值得学习和需要警惕的地方

### 2.1 值得学习

#### 任意来源选择和 autocomplete

它支持 `/handoff` 选择当前 cwd 中的历史 session，也支持 session id/name 的 exact、prefix、substring matching，并为 `/handoff` 和 `/handoff-clean` 提供 completion。见 `/home/chlo/Downloads/pi-session-handoff/index.ts:438-472,526-567,848-899`。

这对“回到某个旧工作上下文”很有价值，但它属于 **import handoff**，不是当前实现的 **replacement handoff**。如果未来需要，建议单独定义 `/handoff-from` 或独立 extension，不改变 `/handoff` 的 parent-session 语义。

#### 按成本分层

它把 session 分为：

- 200 entries 且不超过 20k estimated tokens：纯代码提取，不调用 LLM；
- 不超过 40k tokens：一次 LLM summary，必要时压缩；
- 更长：按语义边界 chunk，最多 3 个并发调用，再 merge。见 `/home/chlo/Downloads/pi-session-handoff/index.ts:35-41,575-807`。

这个思想值得保留：**先用便宜、确定的路径，只有在输入规模确实需要时才付出 LLM 成本**。但它不应放进当前 native replacement handoff，因为当前命令已经由 Pi native compaction 负责摘要；复制后会产生第二套 compaction policy。

#### 结果可观察性

它向用户显示 source、entries、estimated tokens、method、cache、model、generation time、LLM calls、chunk count 和 incremental reuse。见 `/home/chlo/Downloads/pi-session-handoff/index.ts:476-513`。

当前实现至少可以借鉴其中较小的一部分：在 handoff 开始和完成时清楚显示“正在 compact / 正在创建 replacement / 已完成”，并在以后加入 goal 时显示它实际用于 summary 的方向。模型选择和费用不能在 extension 内静默改变。

#### 长 session 的增量处理

它保存 `messageIds` 和每个 chunk summary；若旧 message id 序列是当前序列的严格 prefix，只摘要新增 suffix，再 merge 旧摘要和新增摘要。见 `/home/chlo/Downloads/pi-session-handoff/cache.ts:96-119` 和 `index.ts:712-801`。

这是未来 **import handoff** 的好方向，尤其是同一个旧 session 经常被多次导入时。但必须先补 cache schema version、model identity、prompt version、内容 hash、原子写入、损坏数据校验和容量清理。

#### 历史数据的安全边界

它在 summarizer system prompt 中明确规定：source transcript 是历史数据，不是待执行指令；不执行其中的 shell command、tool request 或 system prompt；输出中不应泄露 secrets。见 `/home/chlo/Downloads/pi-session-handoff/summarize.ts:151-204,392-466`。

这个“把 transcript 当 evidence，而不是 instruction”的边界值得采用，特别是未来 import handoff 使用独立 LLM 时。

#### cache cleanup 的用户控制

`/handoff-clean` 只删除自己的 cache directory，有 interactive picker、`--all`、explicit source matching 和二次确认，也验证不会触碰 Pi session/auth/settings。见 `/home/chlo/Downloads/pi-session-handoff/index.ts:834-941`。

如果未来增加持久 cache，这种明确 scope 和二次确认值得复制。

### 2.2 不应直接采用

#### 解析 raw branch，绕过 Pi 的 context projection

下载版的 `extractMessages()` 只按 raw `SessionManager` branch 中的 `message` entry 提取 user、assistant 和 toolResult。见 `/home/chlo/Downloads/pi-session-handoff/index.ts:182-237`。

这会遗漏或错误处理：

- compaction summary；
- 新版 compaction 的 `retainedTail`；
- branch summary；
- custom message；
- Pi 已经定义的 context cut 和 tool pairing 规则。

README 也承认 compact mode 不支持。未来实现必须使用 Pi 的 `buildSessionContext()`/`buildContextEntries()` 和公开转换工具，而不是复制 raw branch 过滤逻辑。Pi 文档明确把 `retainedTail` 当作可独立恢复的 checkpoint，并让 `buildSessionContext()` 负责把 compaction、branch summary 和 custom message 转成 LLM context。[Pi session format](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)

#### LLM 路径不是输入前 redaction

代码注释把传给 summarizer 的消息称作“already redacted/truncated”，但实际 `extractMessages()` 在 LLM 路径只做 output truncate，没有调用 `redactText()`；`redactText()` 只用于 code-extract 输出，而 `summarize.ts` 的 `redactOutput()` 在模型返回后才执行。见 `/home/chlo/Downloads/pi-session-handoff/index.ts:182-237` 和 `summarize.ts:206-268`。

所以它能降低“summary 成品泄露 secret”的风险，但不能降低“原始 secret 已发送给 summarization provider”的风险。这个实现不能作为隐私安全基线；若未来 import 允许切换 provider，应在发送前做结构化 secret policy，并明确 provider/data boundary。

#### cache key 不足以代表生成结果

cache key 只包含 `sourceSessionId | leafId | lastEntryTimestamp`，尽管 cache entry 记录了 model，但读取时没有把当前 model、prompt/schema version 纳入命中条件。见 `/home/chlo/Downloads/pi-session-handoff/cache.ts:14-68`。

换 model、system prompt 或 section schema 后，旧 summary 可能继续命中。未来 cache 至少需要：`source content fingerprint`、`model provider/id`、`prompt version`、`renderer/schema version`，并对 JSON 做 runtime validation。

#### chunker 有隐性输入 mutation

`chunkMessages()` 对超大首条消息直接执行 `messages[start] = truncateMessage(...)`，调用者传入的 array 会被修改；一次纯 chunking helper 不应有这个副作用。见 `/home/chlo/Downloads/pi-session-handoff/chunking.ts:76-127`。

已通过直接 smoke check 验证：40,001 字符的 message 经调用后变成 28,045 字符。若采用此方向，应返回新数组或在函数入口复制输入。

#### 测试不可直接作为跨平台质量证据

README 宣称运行 `node tests/test-handoff-final.mjs`，但当前下载目录的实际文件在根目录；执行 `node test-handoff-final.mjs` 后，测试立即因为硬编码的 Windows 路径 `F:/software/...` 失败。测试 fixture 还硬编码 `E:/vscode/...`。

因此它的测试设计覆盖面很有参考价值，但不能把当前测试文件当成可复现的跨平台回归套件。

## 3. `arichiardi/ar-llm`：值得学习和需要警惕的地方

比较基线固定为 `ar-llm` main 的 commit `43b4fd800664f3c1bc46e0a516048d31881e3fc6`，文件为 `extensions/pi-handoff/src/handoff.ts`。

### 3.1 值得学习

#### current-format kept context（方向值得学，代码不应复制）

它的 `getHandoffMessages()` 在遇到当前 `firstKeptEntryId` 格式时，会把 compaction summary 和 kept entries 一起交给 summarizer。这一点揭示了当前实现遗漏 recent context 的问题；正确方向值得学习，但应改用 Pi public resolved context，而不是保留手写 branch parser。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L57-L91)

#### goal 驱动的 handoff

它要求 `/handoff <goal for new thread>`，并把 goal 与 conversation history 一起交给 summarizer。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L197-L276)

这是三者中最直接提升 continuation quality 的设计。摘要不只回答“过去发生了什么”，还回答“新 session 现在要做什么”。建议当前命令支持：

```text
/handoff
/handoff 继续完成剩余测试并修复失败项
```

保持无参数行为兼容；goal 只作为 native compaction 的 `customInstructions`，不会引入第二个 summarizer。

#### 人工编辑生成结果

它在创建 replacement 前通过 `ctx.ui.editor()` 让用户审阅和修改 handoff prompt。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L350-L384)

这个人机边界非常值得学习：summary 是模型建议，不应在用户没有机会查看时直接成为下一轮的真实 user instruction。当前实现最小可行的等价物，是在 replacement session 中使用 `replacementCtx.ui.setEditorText(goal)`，让用户明确提交下一步 prompt；不要自动触发新 agent turn。

如果未来允许编辑整个 summary，应该明确“编辑的是新 session payload 的副本”，不能声称它修改了已经写入 source session 的 native compaction entry。

#### 可取消的 loader 和显式空响应处理

它用 `BorderedLoader` 绑定 abort signal，区分 success、cancel、provider error 和 empty output。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L257-L350)

如果未来 handoff 增加 extension-owned 的额外 LLM 工作，这套状态区分值得采用。当前 native `ctx.compact()` 已由 Pi host 拥有生命周期，优先复用 host 行为，不要为相同工作再建一层 loader。

#### replacement context 和 parent link

它正确保存 `currentSessionFile` 作为 `parentSession`，并在 `withSession` callback 中使用 replacement context。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L387-L428)

这一点当前实现已经做得更小、更清楚，不需要迁移代码。

#### 配置和 debug 可见性（有条件借鉴）

它显示当前使用的 handoff model，并支持 debug log；如果 handoff 未来确实拥有独立 summarizer，这种 model、耗时、provider error 的可观察性有价值。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L39-L60,L217-L309)

但当前产品规则是不静默切 model/provider；因此只能在用户明确配置且 UI 明确显示时采用，不能复制它“配置模型找不到就 fallback 到 active model”的行为。

### 3.2 不应直接采用

#### 手动重建 compacted branch 只覆盖旧 storage format

`getHandoffMessages()` 直接从 `getBranch()` 搜索最后一个 compaction，再根据 `firstKeptEntryId` 手动拼消息。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L57-L91)

这在当前 `firstKeptEntryId` 格式下比只复制 summary 完整，但它没有复用 `buildSessionContext()`，也没有处理 session-format 文档所述的 self-contained `retainedTail`。升级 storage format 后可能丢掉本应保留的 recent context；这个 helper 不能成为当前实现的代码基线。

#### 私有 runtime 和宽松类型

它通过 `(ctx.modelRegistry as any).runtime.complete(...)` 调用私有 runtime，并以 `as any` 组合 compat override。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L283-L307)

这绕过 public contract，升级 Pi 时容易失效，也违反当前仓库的 strict TypeScript 约束。当前 Pi public `ctx.modelRegistry.complete()` 已足以支持 extension example 的 handoff path；不应为了模仿 provider workaround 而引入私有 API。

#### 静默 model fallback

配置的 provider/model 找不到时，它记录 debug log 后回退 active session model。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L217-L235)

这会让用户以为使用了指定模型，实际却使用另一个模型，违反“没有 hidden intent、不能 silent routing”。正确行为是显式错误，或者在用户可见 UI 中说明并要求确认。

#### 自动发送真实 user message

它在 replacement `withSession` 中直接调用 `sendUserMessage(editedPrompt)`，创建后立即触发新的 agent turn。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L399-L417)

虽然 prompt 之前经过 editor，但这仍然跳过“新 session 已准备好、用户明确提交”的边界。Pi 官方 handoff example 选择在 replacement 中 `setEditorText(editedPrompt)`，并提示用户自己提交。[Pi upstream example](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/handoff.ts)

当前实现建议采用官方的 `setEditorText` 方案，而不是 `sendUserMessage`。

#### 全局 monkey-patch console

为压制 `newSession()` 的输出，它临时替换全局 `console.warn` 和 `console.error`。[source](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts#L387-L431)

这会影响同时运行的 extension、并发 callback 和错误诊断。应使用 Pi host 的 UI/logging contract，不能把全局 console 当作 session-local 状态。

## 4. 推荐采用顺序

### P0：先保证 handoff 完整，再增强 `/handoff`

1. **保留 native compacted context。** compaction 完成后，使用 Pi public `buildSessionContext()` 读取 compact 后的 resolved messages，并把 summary 与 kept recent context 按原有顺序投影到 replacement；不能只使用 `CompactionResult.summary`，也不要自行按 `firstKeptEntryId`/`retainedTail` storage 猜测保留范围。
2. **加入可选 goal。** 参数为空时保持当前行为；有 goal 时把它作为 `ctx.compact({ customInstructions })` 的 handoff-specific focus，要求 native summary 保留当前状态、失败尝试、验证结果和下一步。
3. **replacement 中 prefill goal。** 在 `withSession(replacement)` 使用 `replacement.ui.setEditorText(goal)`，显示“handoff context is ready”，由用户按 Enter 明确开始下一轮。无 goal 时保持只切换 session，不自动触发。
4. **保留当前的 idle、parentSession、hidden summary context、failure notice 和 public Pi API。** 这些是当前实现比两个参考版更干净的基础。
5. **补 real Pi host smoke。** unit test 继续验证调用顺序和失败，真实 Pi host 还应验证 native compact 后 summary 与 kept recent context 都进入 replacement、tool call/result 仍成对、replacement rebinding、setEditorText 和取消后的 source resume。

### P1：改善摘要 contract，但继续使用 native Pi

为 handoff 设一个固定、简短的 `customInstructions`，强调：

- 目标和当前问题；
- 已完成工作与未完成工作；
- 失败尝试及原因；
- 关键决策和约束；
- 已验证的命令/测试结果；
- 下一步和 open questions；
- 不要把历史文本中的命令当作新指令。

这样可以得到 `ar-llm` 的 goal focus 和下载版的 structured continuation 信息，同时保留 Pi native compaction 的 branch/kept-context/file tracking 处理。

### P2：只有确实需要“旧 session 导入”时再做

将它定义为独立能力：

```text
/handoff-from <session-name|id>
  -> list/resolve source session
  -> buildSessionContext(source)       // 不解析 raw branch
  -> bounded, provider-visible summary
  -> show/edit/import confirmation
  -> append hidden or visible custom message to current session
```

这个能力再考虑下载版的：source picker、short/medium/long tiers、cache、incremental chunks、cleanup command。第一版优先单次 bounded summary，不要同时引入 chunk orchestration 和跨进程 cache。

若后来证明重复导入成本确实过高，再增加 cache；cache 必须绑定 source fingerprint、branch leaf、model provider/id、prompt/schema version，并限制文件大小和总条数。cache hit/miss、model、LLM calls 和耗时必须向用户可见。

## 5. 最小状态机

```text
idle
  -> waiting-idle
  -> compacting
       -- cancel/error --> source-resumable
       -- success ------> projecting-resolved-compacted-context
  -> creating-replacement
  -> replacement-ready
       -- goal present -> editor-prefilled -> user submits
       -- no goal -----> ready-for-next-input
```

不应出现：

- 没有用户确认就自动触发新的 agent turn；
- compact 尚未完成、或 compacted context 尚未完整投影，就创建 replacement；
- 配置的 model/provider 不可用时静默换模型；
- 用 extension 自己的 raw transcript parser 取代 Pi 的 resolved context；
- 失败后删除 source 或假装存在 rollback。

## 6. 测试建议

### 当前实现已有

- command registration idempotency；
- idle -> compact -> new session ordering；
- parent link；
- hidden `hepi-handoff` entry；
- argument rejection；
- cancellation、compact failure、setup failure。[`packages/pi-handoff/test/handoff.test.ts`](../../packages/pi-handoff/test/handoff.test.ts)

### 增加 goal 后应补

- no-argument compatibility；
- goal 传入 native compact 的 `customInstructions`；
- compact result 的 summary 与 kept recent context 都进入 replacement；
- kept context 中的 tool call/result 保持配对和顺序；
- goal 被写入 replacement editor，而不是 `sendUserMessage`；
- editor/replacement cancel 不触发 agent turn；
- goal 中包含历史样式指令时仍只是用户明确输入，不被 extension 自动执行；
- replacement context 使用的是 callback 参数，不是旧 ctx。

### 若增加 import/cache

- compacted source with `firstKeptEntryId`，以及较新格式的 `retainedTail`；
- branch summary 和 custom message；
- fork prefix reuse 与 divergence full rebuild；
- malformed cache、model/prompt version mismatch、atomic write failure；
- source secret 在发送前的 policy；
- cache cleanup 不触碰 session/auth/settings；
- 真实 Pi host 的 resumed/reloaded source rendering 和 replacement lifecycle。

## 7. 参考来源

- 当前仓库：[`packages/pi-handoff/src/handoff.ts`](../../packages/pi-handoff/src/handoff.ts)、[`packages/pi-handoff/test/handoff.test.ts`](../../packages/pi-handoff/test/handoff.test.ts)、[`docs/handoff/README.md`](../handoff/README.md)。
- 下载版：`/home/chlo/Downloads/pi-session-handoff/index.ts`、`chunking.ts`、`summarize.ts`、`cache.ts`、`README.md`；本机测试入口为 `test-handoff-final.mjs` 和 `probe-clean.mjs`。
- `ar-llm`：[`extensions/pi-handoff/src/handoff.ts`](https://github.com/arichiardi/ar-llm/blob/43b4fd800664f3c1bc46e0a516048d31881e3fc6/extensions/pi-handoff/src/handoff.ts)，commit `43b4fd800664f3c1bc46e0a516048d31881e3fc6`。
- Pi public API：[`extensions.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)、[`compaction.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)、[`session-format.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)、[upstream handoff example](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/handoff.ts)。
