# Gemini Responses：推理式文字为何显示为正文

## 当前结论

已抓到绕过 gpt-load 的 Google Antigravity 原始返回：同一个 medium + includeThoughts:true 工具回复，先有 `thought:true` 的内部思考，再有无 thought 标记的参数解释正文，随后 functionCall。模型将内部思考和向用户解释分为两组；解释可以同样具有推理语气。

真实事件逐条回放 CPA 后，内部思考完整进入 reasoning summary，可见解释完整进入 output_text，交叉断言无混入。Pi 再按事件类型生成 thinking/text block。屏幕上那类工具前自述源自 Google 输出的普通 text，不是 gpt-load 将 marked thought 搬到正文，也不是请求漏了 medium。

`reasoning.effort=medium` 控制思考等级；includeThoughts 请求思考摘要。两者都不保证模型不另外生成可见自述。无长历史也能复现，历史污染不是必要条件。原历史轮次的伪工具调用字符串属于另一项生成异常，本次未复现它。

## 部署与直连 Google 证据

用户指定实例 oracle-kr。SSH 只读确认运行进程 `/proc/1/exe` 与 `/app/gpt-load` SHA256 均为 `4a71c83e3e265bd0778c19af2583c2711a402a468e225eded8042b90c84091cb`；Go build info revision 为 `f346cc22db14560e75cd6c4fb16065c9bd55175e`、vcs.modified=false，CPA v8.0.8、Bifrost v1.11.0。容器镜像标签不是运行版本的依据，因为二进制是 bind mount。

SQLite 以 mode=ro 读取：实际走 group 7 的 Antigravity subscription，`gemini-3.8-flash` 映射 `gemini-3.8-flash-high`；解密后的分组 params/overrides 均为空，代理为 direct。原异常 f00623a0 对应时间窗只有请求 `d0838b26-8e64-406a-a52b-d8e8c083fe79`，完成于 2026-10-09 10:03:52.069 UTC，记录最终 applied effort=medium。新探测通过 x-gptload-request-id 与数据库精确匹配，确认同一路由。

在服务器内使用现有未过期认证，直接请求 `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`，model=gemini-3.8-flash-high，thinkingConfig={thinkingLevel:medium,includeThoughts:true}。认证、project/account 留在服务器内，未更新数据库、配置或重启服务。

Google 原始回复的 modelVersion 是 gemini-3.8-flash-n；该后缀不能解释为没有思考，因为同一回复实际包含 thought:true。分组/日志的 high 名称也不能用来推断思考等级被变成 high。原始事件与部署元数据见 [直连证据](gemini-responses-thinking-upstream.json)。

第一次手写直连使用旧测试 UA 2.2.1，返回 404；按当前 CPA 的 fallback UA 2.9.1 重试成功。CPA 源码说明新模型要求客户端版本至少 2.9.0。因此旧 UA 得到的 tiered-only 模型目录不用于判断生产映射错误。当前 UA 的 Google 目录包含 3.8-flash 的 low/medium/high/tiered 变体。

## 在线独立请求证据

接口：`https://api.hheei.cc`；模型：`gemini-3.8-flash`。五次合成请求，无项目内容、无会话历史，每次 `max_output_tokens` 或 `maxOutputTokens` 为 1024。请求与原始 JSON 事件见 [脱敏探测记录](gemini-responses-thinking-probes.json)，不含 Authorization，签名字段已脱敏。

| 请求 | 配置 | 结果 |
| --- | --- | --- |
| Responses，要求调用 lookup 前推敲参数 | medium、summary:auto、include encrypted_content | `output_text.delta`：`I need to call the lookup tool… query=strawberry`；空 summary 的 CPA 签名载体；真正的 function_call |
| native，同样工具与提示 | medium、includeThoughts:true | 同类自述出现在没有 thought 标记的 text part；随后 functionCall 带签名 |
| Responses，数 strawberry 的 r | medium、summary:auto | 正常 `reasoning_summary_text.delta`，随后独立 output_text |
| native，同样计数提示 | medium、includeThoughts:true | 普通答案 text，未返回 thought part，末尾带签名 |
| Responses，直接要求 lookup 查询 strawberry | medium、summary:auto | 只有空 summary 的签名载体与 function_call，无正文 |

最后一项与第一项仅更换用户提示、保持工具与配置一致。它证明“有工具 + medium”并不必然出现正文，也不能把工具前自述一概当成被泄漏的内部 thinking。五次请求是观测样本，不构成模型输出的确定性保证。

## 转换链源码

本地版本：gpt-load HEAD `f346cc22db14560e75cd6c4fb16065c9bd55175e`；Bifrost `v1.11.0`；CLIProxyAPI（CPA）`v8.0.8`；Pi AI `1.0.2`。已通过运行二进制的 build info 核实这些版本与部署一致。

- CPA `internal/translator/gemini/openai/responses/gemini_openai-responses_response.go:775/884-951`：读取 `part.thought`；true 进入独立 reasoning 分支，缓冲或发 `reasoning_summary_text.delta`，随后返回。可见 text 分支从 `955` 开始。
- CPA `internal/translator/antigravity/openai/responses/antigravity_openai-responses_response.go:10-16`：解出上游 response，交给同一 Gemini→Responses 转换。
- CPA `internal/translator/gemini/gemini/gemini_gemini_response.go:11-20`：native stream 原样转发 JSON。
- CPA `internal/translator/antigravity/gemini/antigravity_gemini_response.go:174-179`：native stream 提取 response.Raw，只恢复 usage 与工具名；不删除 thought。
- CPA `internal/runtime/executor/gemini_executor.go:277-279`、`antigravity_executor_stream.go:87-89`：translator 后调用 `helps.ApplyRequestThinking`，不能仅凭 gpt-load wrapper 没有直接调用 ApplyThinking 就推断配置遗漏。
- CPA `internal/runtime/executor/helps/model_capabilities.go:18-33`：提取源请求 summary，调用带 Summary 的 thinking 配置处理。`internal/thinking/summary.go:57-62/213` 支持 Responses reasoning.summary，并映射到 Gemini includeThoughts。
- Bifrost `providers/gemini/responses.go:3981-3984`：支持思考的 Responses 请求设置 IncludeThoughts:true。当前 gpt-load 官方 Gemini 转换走 Bifrost；历史 carrier 前缀指向 CPA，两条路径不能混为一个证据链。
- Pi `dist/api/openai-responses-shared.js`：reasoning delta 写入 thinking，output_text delta 写入 text。显示层依据 block 类型，hideThinkingBlock 只影响 thinking。

## 签名与历史污染

`cpa-gemini-responses-carrier-v1:next:function:` 来自 CPA `signature_carrier.go:12-27`，表示签名绑定到后续 function call。它可合法使用空 `summary:[]`，本身不代表有 thought 文本被丢弃或移到正文。

Pi `dist/api/transform-messages.js` 在 provider/API/model 改变时，会把有文字的旧 thinking 转为 text 再发送。本地回放验证通过。此行为可能加强长会话中的自述风格，但五次独立请求表明历史污染并非复现所需条件，不能定为唯一根因。

原 session 全 JSONL（未按分支过滤）：1430 条 magpie/Gemini Chat assistant，171 条 or/Gemini Responses assistant；后者全部 medium，14 条有非空 thinking，160 条有非空 text（可重叠）。这些计数不能把所有 text 自动解释成 thinking 泄漏。

`f00623a0` 存为正文的 `call:default_api:python_eval{code:...}` 是文字，未被解析为真正的 toolCall。该轮究竟为何生成伪工具调用，仍不能用本次简短探测确定；不可把它直接归因到网关转换。

## 原长对话异常：后续调查与结论范围

以上直连与回放解释普通工具前自述，不解释原长对话中 `call:default_api:python_eval{...}` 的伪工具调用文本，也不能排除请求历史转换或 replay 问题。原分支先从 magpie/openai-completions 切换到 or/openai-responses；伪调用发生在 compaction ae44393b 后首个 assistant 回复 f00623a0。该回复只有 text，stopReason=stop，无结构化 toolCall。

后续源码核对确认以下行为，但尚未将它们与原异常同轮绑定：

- replay accumulator 超过 4096 items 或 16MB 时 Commit 条件删除缓存 entry。缓存丢失不等于客户端历史中所有签名丢失：ledger miss 分支直接返回当前 payload。不能据此断言持续错误根因。原压缩保留区间（firstKeptEntryId=48260695 至异常轮）只有 26 toolCall、26 thinking、28 text blocks；全分支有 1536 toolCall、560 thinking、208 text。该统计不是转换后的 replay item 数，也不验证 16MB 上限，但不支持以会话总长直接认定 4096 阈值触发。
- gpt-load continuity key 包含 credential、model、target；换凭据会切 replay lane。这可能是隔离策略，不能未验证签名的跨凭据可移植性就删除 credential 隔离。
- continuity base 源于 bounded system+first user 前缀，而非稳定客户端会话 ID。压缩改变 first user 时可能换 lane；相同前缀也可能共 lane。CPA 还验证上下文指纹和工具身份，共 lane 不自动证明误配。该方向与压缩节点最值得继续核对。
- 合成的重复 functionCall chunks 会产生两个调用 item；这不等于生成普通文本中的 `call:default_api:...`，且尚无真实上游分片重发证据。
- 缺失 call_id 的合成 function output 可降级为用户正文；必须先确认原异常请求存在缺失或孤立 ID，才能判定为成因。

CPA stream converter 的 param 在每次请求的 goroutine 内声明，未见跨请求共享。修复应基于异常请求实际输入、最终 Google payload 和原始上游 SSE 的同轮对照，不应先隐藏正文或无依据修改签名隔离。

## 实际历史还原与本地修复

通过安装的 Pi `buildSessionContext`、`convertToLlm`、Responses `onPayload` 离线还原压缩前与异常前上下文，再用 CPA v8.0.8 转成 Google request。该过程没有重放 extension context hooks，不是原轮 wire capture；但原始 JSONL 中 26 条 context_edit 可逐条验证：replacement 正好是原 content 删除 thinking 后的结果，text/toolCall 均未改变。

删除路径来自 pi-ext-memory 的 `sanitizeRetainedAssistantMessages`：它把包含 encrypted_content 的 thinkingSignature 当作可删除的密文，移除无文字的 CPA carrier。压缩保留尾部需要这些 provider replay 数据；它们的语义由 provider 转换器负责，memory 不应清洗。

| 历史版本 | Calls / results | Reasoning items | Google 原生签名调用 |
| --- | --- | --- | --- |
| 压缩前 | 137 / 137 | 133（其中 3 个没有 encrypted_content） | 130 |
| 压缩后原历史 | 26 / 26 | 0 | 0（均为 skip_thought_signature_validator 占位） |
| 同一压缩后历史，仅恢复 26 条签名编辑 | 26 / 26 | 26 | 26 |

压缩前后 bounded system 与 first user 前 4096 字节各自相同。生产只读日志确认异常请求与最近主轮均 credential 26、medium、一次 attempt。原请求 call_id 配对完整，不支持用阈值、凭据切换、前缀变化或孤立 output 直接解释该轮。

已修复本地 memory：取消保留尾部的 signature 清洗，删除无其他调用方的 sanitizer 与对应旧测试；新增 OpenAI reasoning、空 Gemini carrier 的压缩保留回归，带配对工具调用与结果。预算继续使用 Pi host 的完整消息估算，不以删除签名腾空间。原 session 不改；恢复副本 `/tmp/gemini-signature-recovery.jsonl` 保留至异常前用户消息，只恢复已验证的 26 条签名编辑，设为新 session ID。

子代理对真实 after fixture 离线运行 CPA prepareAntigravityGeminiReasoningReplayPayload：冷缓存 0/26 原生签名；包含同一当前历史 carrier 的热缓存 26/26；同 lane 但缓存来自压缩前历史时 0/26。contextHash 按完整内容前缀校验，改动前缀后只恢复改动之前的调用，阻止错误签名回填。因此 bounded affinity 前缀不变不代表 replay 上下文指纹不变，压缩前 ledger 不能代替客户端保留尾部的签名。

热/冷结果除 26 个签名外还有两个 args.code 中 `>=` 的 JSON HTML 转义差异（变为 `\u003e=`），解析后语义一致；没有证据表明它导致上游生成异常。不能放宽 contextHash 或删除凭据隔离以强行恢复缓存。`TestZZParent(ColdHotReplay|ContextHashCollision|MutationProbe|FinalFieldDiff)` 聚焦离线测试全部通过，工作目录 /tmp/cpa-copy；未改真实网关仓库。

在线对照仍未复现伪工具语法：oracle-kr、同 credential 26、同原历史、medium+includeThoughts:true、maxOutputTokens=1500，清洗与恢复两版都返回 thought:true 与结构化 python_eval，无可见 text。先用随机 sessionId；再在服务器根据原 accessKeyID、前缀 HMAC、credential/model/target scope 重构 CPA 派生 sessionId，删除 safetySettings 与 executor 对齐，重测两版仍正常。直接探测不经过 gateway replay，也未执行生成的工具调用。

因此：已证明并修复实际发生的客户端历史损坏，但尚未证明它单独造成原伪调用。不能把本地修复或一次正常在线回复当作原生成异常彻底修好的证明。详细脱敏数据见 [session 对照](gemini-responses-thinking-session.json)。

修复验证：新增回归先失败（确实生成删除签名的 context_edit），移除 sanitizer 后 75 项聚焦测试通过；memory build 通过；改动 TS 文件 Biome 与 git diff --check 通过。`TestZZOriginalSessionCompaction` 在临时 CPA 副本验证上述三种历史转换，全部通过。首次把 133 个 reasoning 项误计为 133 个签名，核对后确认 3 个无 encrypted_content，修正测试样本计数为 130，不涉及产品约束变更。未运行全仓 typecheck/test/check，未发布或修改部署。

## 独立疑点

Bifrost 非流式带签名 thought 的 `Summary` 可为非 nil 空切片（`responses.go:3456`），gpt-load `fillReasoningSummary`（`internal/execution/bifrost/converted.go:802-830`）会提前返回。这是 summary 补齐疑点，未证明会将 reasoning 改成 message/output_text，也与本次流式 CPA 载体证据不同。

## 验证与修复判断

- `node /tmp/pi-gemini-reasoning-probe.mjs`：历史 reasoning SSE 回放、medium payload 无网络断言、跨 provider 历史转换三项通过。
- 五次独立在线探测：已保存脱敏请求与 JSON 事件。Python 断言工具正文存在、native 正文无 thought 标记、非工具 reasoning 存在、中性工具请求无正文；JSON 可解析且不含调用凭据，全部通过。
- CPA 离线测试：在 `/tmp/cpa-copy` 的 v8.0.8 源码副本加入临时 `TestZZProbe`（请求 fixture 为 gemini-3-pro，线上模型为 gemini-3.8-flash），工具请求映射为 `thinkingLevel:medium,includeThoughts:true`；thought:true 输入输出 reasoning；无标记输入输出 message，随后 function carrier；非流式类型序列同样正确。五个测试加入明确断言后全部通过，覆盖以上四类行为。命令：`GOFLAGS=-mod=mod GOPROXY=file:///home/chlo/go/pkg/mod/cache/download GOSUMDB=off go test -count=1 -v -run 'TestZZProbe' ./internal/translator/antigravity/openai/responses/`（工作目录 `/tmp/cpa-copy`）。
- 离线测试首次因依赖缓存缺少 x/net 0.57.0、x/crypto 0.54.0、x/text 0.40.0 失败；仅在临时副本改用已有缓存版本 0.58.0、0.55.0、0.41.0 后通过，未修改被审仓库。该测试验证转换行为，不等于部署环境完整构建。
- `git diff --check -- docs/README.md docs/research/gemini-responses-thinking.md docs/research/gemini-responses-thinking-probes.json`：通过。Biome 对证据 JSON 报告路径被配置忽略、未处理文件；JSON 已单独解析校验。
- `GOFLAGS=-mod=mod GOPROXY=file:///home/chlo/go/pkg/mod/cache/download GOSUMDB=off go test -count=1 -v -run TestZZUpstreamCaptureReplay ./internal/translator/antigravity/openai/responses/`（`/tmp/cpa-copy`）：真实 Google 事件回放通过，内部思考与正文文本完整保留且互不混入。只替换脱敏签名为占位，不验证 Google 签名校验。
- 父代理加强真实回放测试为完整文本相等断言，并保存 23 条转换后事件到 `/tmp/cpa-upstream-normalized-events.json`；再次运行 TestZZUpstreamCaptureReplay 通过。
- `node /tmp/google-cpa-pi-replay.mjs`：将同一组 Google 原始事件经 CPA 转换后交给安装的 Pi processResponsesStream；184 字符内部 thought 与 249 字符可见 text 分别完整保留，block 序列为 thinking/text/thinking（空签名载体）/toolCall，lookup 工具调用保留，全部断言通过。
- 线上数据库读取均 mode=ro；未修改运行时代码、部署配置或重启服务，未执行全仓检查。

不应按 `Wait!`、`Let's` 等语气把正文强行移到 thinking，否则会隐藏正常说明。本次已经从 Google 直连原始返回与实际 CPA 转换回放确认：可见自述由 Google 生成普通 text，思考等级与转换分类均正确。将全部自述隐藏需要另一个明确产品行为，不能以修复思考通道分类错误为名实现。
