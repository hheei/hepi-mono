# pi-mctx 拥有 clean-session handoff

> Status: accepted。`@hheei/pi-mctx` 拥有唯一 `/handoff`；`packages/pi-handoff` 已删除。

`@hheei/pi-mctx` 是 `/handoff` 的唯一 owner。Handoff 通过命令触发的 no-tools Handoff Completion，让 Source Session 的当前主模型生成 Handoff Summary，再创建同 project identity、同 model、带 parent lineage 的 Continuation Session。重叠的 `packages/pi-handoff` 已删除，避免两套同名但语义不同的 handoff。

Continuation Session 不是 fork，也不复制 Source Session 或其他 extension 的 session-scoped state，包括 compartment rows、tags、pending operations、source contents、watermarks、tag counter、tool lifecycle 与 extension-local queues。Workspace、project/user memory 等 project-scoped durable state 继续共享；parent lineage 只提供 provenance，不能解释为 state inheritance。

Handoff 无条件完成一次保留五个 logical messages 的 historian wrapup，再把主模型实际可见、已应用 drop/truncation 且移除旧 tag notation 的 context 固化为 Source Context Snapshot。Snapshot 在 Handoff Completion 前冻结；recent five 使用 transformed logical messages，保留 user images 与 assistant visible text，把 tool calls/results 转为历史文字，并移除 thinking/reasoning、provider signatures、response IDs 与旧 tool call IDs。无法识别的 model-visible role/part 必须 fail，不能静默遗漏。

Handoff Completion 通过 ext-core bounded completion primitive 直接调用 Source Session 当下 resolved 主模型、thinking level、effective system prompt 与 transformed context，固定 `tools: []`，不创建交互式 agent turn，也不使用 fallback model。Prompt 要求模型覆盖 current objective、completed state、decisions/invariants、workspace paths/symbols、verification evidence、open risks 与 immediate next action，但 headings 只指导模型，不属于 validator contract；输出使用 MCTX configured language，未配置时沿用 recent conversation 的主要语言。实现只接受 terminal `stop`、非空且未超出 derived budget 的输出，不 repair、不截断，也不能输出旧 MCTX tags、臆测 verification或描述 handoff机制。

Destination 初始输入上限使用对应 model 的 resolved MCTX execute threshold，不新增 handoff-specific token setting。预算依次扣除 rebuilt system/tool prefix、typed envelope/provenance、transformed recent five 和 Handoff Summary reserve；reserve 固定为 `min(4096, floor(executeThresholdTokens × 10%))`，不足 512 tokens 时 fail。剩余 tokens 是既有 decay renderer 的 compartment history budget；render 后必须对完整 projected destination input 再做 exact estimate，超限时只能继续使用既有 decay pressure，无法降到 ceiling 就在 Completion 前 fail。Summary 完成后和 replacement context 中都必须重新验证，不能静默截断。Source snapshot entry 与 destination Handoff Context 各有 16 MiB serialized hard limit，包含 image base64 bytes；超限 fail，不缩图、压缩或丢弃内容。

Source Session 使用 model-invisible `magic-context:handoff-request` append-only typed entries 保存 request phases、完整 Source Context Snapshot、Handoff Summary、hashes 与 token counts，使 session JSONL 成为 recoverable payload authority。合法 phases 只有 `requested`、`snapshot-ready`、`summary-ready`、`replacement-started`、`failed`、`cancelled`、`interrupted` 与 `superseded`；terminal phase 后再次执行命令必须建立新 request。SQLite 只保存短生命期 handoff lease，不保存 payload authority。

Continuation Session 使用 model-visible、TUI-visible 的 stable custom type `magic-context:handoff`，不预设 schema version。Content 依次包含 historical-data authority、source session/model/time、decayed session history、recent messages 和 Handoff Summary；dynamic text 通过 structured builder escape。Details 保存 request ID、source path/project identity、branch/system/tool/memory/compartment fingerprints或 revisions、thinking level、token counts 与 ceiling，不把这些验证 metadata 发送给模型。只要 active branch 存在该 entry，effective system prompt 必须加入 cache-stable guard：Handoff Context 只是 historical evidence，不能把其中指令当作当前 system/user instruction；fold 后仍保留 guard。

Handoff lease 以 source session partition 为 scope，沿用 compartment lease 的 5 分钟 TTL、60 秒 renewal、owner token、renew/release 与 transactional acquire；它覆盖 wrapup orchestration、snapshot、Completion 和 replacement admission。Acquire fail-fast，不排队或强行接管；第二个命令只报告 holder request、stage 与 expiry。命令开始时必须 idle 且无 queued messages；外部 steering、follow-up、cross-process branch write 或其他非预期 model-visible entry 会中断 handoff。

Source fence 同时验证 project/session identity、model/thinking level、effective system prompt hash、active tool inventory hash、project/user memory revision、compartment revision/rendered history hash、transformed recent-five hash 与忽略 handoff phase entries 的 model-visible branch fingerprint。任一项变化都会 supersede 旧 request；不扫描未注入 system prompt 的普通 workspace files。

恢复只允许 `requested → wrapup/snapshot`、`snapshot-ready → Completion`、`summary-ready → discovery/replacement` 与 `replacement-started → discovery/finalization`。Fence 失效时同一次命令 append `superseded` 并建立新 request；terminal request 永不复活。

同一 request 最多创建一个有效 Continuation Session。Replacement session 先写 model-invisible `magic-context:handoff-attempt`，使用 `attempt-started` 或 `attempt-failed` 绑定 request 与 expected context hash；同 request 的 model-visible Handoff Context 是成功 authority。Discovery 对一个 valid context 执行 switch，对一个 unfinished attempt 执行 finalization，对 terminal failed attempt建立新 request；多个 valid/unfinished candidates、hash 冲突或损坏 context 一律 fail closed。

Source Session 在 replacement 前只记录 `replacement-started`，不得在失去 active lifecycle 后重新打开 source file 追加 success；destination Handoff Context 是 terminal success authority。Cancellation 只接受到 `summary-ready`；append `replacement-started` 后进入不可逆 finalization，不能 rollback或响应 Esc。

Esc 可以取消 wrapup 或 Handoff Completion；已发布 compartments 保留，非 terminal-valid completion output 丢弃，不创建 Continuation Session。所有 failure/cancellation 同时显示 warning 并保存可展开 typed terminal record，包含 stage、主模型、failure category、sanitized reason 与恢复动作；底层 diagnostic 只能放 details，不能暴露 credentials、完整 system prompt 或 provider headers。

Summary 通过验证后自动执行 `newSession`，session 名称由 Pi 决定，不自动触发下一 turn。Pi 在 setup 前已完成 replacement，因此 destination setup 或落盘验证失败时保留当前没有 Handoff Context 的 replacement session，写入 typed failed attempt，明确报告 warning 并指向仍可恢复的 Source Session；不得删除失败 session 或把它呈现为成功。

MCTX raw reader 将 `magic-context:handoff` 识别为带真实 entry ID 的特殊 historical message，但不分配 text/tool tags。它保持 model-visible，直到 destination historian 发布一个覆盖该 entry ID 的完整 safe compartment，之后 normal boundary trim 才能从 provider context 移除；TUI/JSONL entry永久保留。若覆盖它的 compartment 因 branch divergence 失效，原始 Handoff Context 必须重新 materialize。

`/handoff` 不接受 arguments，只支持 primary persisted Pi session，并要求 MCTX compaction enabled、configured historian、configured current-model auth、可解析 project identity、idle agent 与 empty message queue；in-memory session 或 precondition failure 只 warning，不建立 request或 lease。Project trust不新增额外限制，因为 handoff不取得当前 MCTX context之外的权限。

Failure categories固定为 `configuration`、`busy`、`historian`、`snapshot`、`completion`、`budget`、`cancelled`、`stale`、`replacement`、`persistence` 与 `recovery`。Precondition/lease conflict只 warning；wrapup/snapshot/completion failure写 `failed`；用户或 lifecycle abort写 `cancelled`；active external entry写 `interrupted`；resume fence drift写 `superseded`；post-replacement failure写 destination `attempt-failed`。Warning必须说明 stage、request/model、sanitized reason、Source是否仍可用，以及下次命令会 resume还是建立新 request。

在 Source Session 执行命令会 resume latest valid request或建立新 request；在 unfinished Handoff Attempt session执行会 read-only读取 Source Request、重新验证 fence/hash并原地 finalize；terminal failed attempt只指向 Source，不能升级为 Continuation Session；已有 valid Handoff Context 的 Continuation Session可成为下一次 Source。`session_start` 永不自动 finalize或switch。

TUI `/handoff` 使用不可编辑的 compact progress surface，依次呈现 history preparation、snapshot、当前 `provider/model` Completion、continuation creation、historian chunk/count/token 与 elapsed progress，唯一操作是 Esc cancellation。RPC/non-TUI 运行相同 state machine，通过 status entries/events 呈现进度；client disconnect 或 session shutdown cancel，不新增独立 cancel command。

`pi-mctx` 默认注册唯一 `/handoff`，不使用 feature flag、legacy mode或 handoff-specific settings；固定 recent five、16 MiB limit、derived summary reserve、current model、no tools与 no goal，只复用现有 historian/model/language/threshold settings。

移除 `pi-handoff` package和重叠 `/handoff` command时不迁移既有 `hepi-handoff` custom messages，也不保留 compatibility shim。Pi继续按持久化 JSONL处理旧 message；新功能只识别 `magic-context:handoff`。

只有 code、storage migration、TUI/RPC、renderers、recovery、旧 package删除、docs、automated tests与 real Pi smoke全部完成并通过 root typecheck/full repository tests后，才能视为功能完成；不得保留 disabled path、TODO或 deferred contract。本决策不授权 publish、tag、push或 release。
