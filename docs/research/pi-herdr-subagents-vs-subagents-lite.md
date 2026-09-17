# pi-herdr-subagents 与 pi-subagents-lite 对照研究

> **状态**：历史研究。`packages/pi-subagents-herdr` 已从仓库移除；文中“本地实现 / 当前工作树”路径不再存在。研究证据与取舍仍可参考，但不能覆盖 [Subagent 执行架构](../architecture/subagents.md)。
>
> **研究边界**：外部事实只取自两个上游仓库的源码、测试、文档与 npm 元数据，以及当时本仓库已安装的 `@earendil-works/pi-coding-agent@0.85.1` 导出声明。以下“上游”指固定 commit 的快照；“本地”指当时工作树的 `packages/pi-subagents-herdr`、`packages/pi-ext-core` 与 `docs/`。本文只记录研究与取舍，不是 TypeScript API 变更。
>
> **引用约定**（所有材料性断言都可按此展开为稳定 URL）：
>
> - `[M:<path>:<line>]` = `https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/<path>#L<line>`（HEAD `b6987324`，2026-09-01）
> - `[L:<path>:<line>]` = `https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/<path>#L<line>`（v1.13.1，HEAD `a5a4f994`，2026-09-15）
> - `[本地:<path>:<line>]` = 本仓库相对路径与行号

## 1. 结论先行

[事实] 两个上游解决的是同一个问题的两个不同侧面。`modem-dev/pi-herdr-subagents`（下称 M）是 **Herdr 原生** 的交互式编排器：它把“子进程的存活判定”从屏幕猜测变成 Herdr 的 argv pane 启动 + socket 事件，并把每个失败路径写成一句诚实的话。[M:README.md:1-8,226-256] `AlexParamonov/pi-subagents-lite`（下称 L）是 **in-process session 管理** 的成熟产品：按决策记录（ADR）收敛出分层配置、按模型分池的并发、两个独立 watchdog 检查、settled record 保留策略与 trust 门禁。[L:docs/adr/0002-per-model-concurrency.md:1-20] [L:docs/adr/0006-settled-agent-retention.md:1-60]

[事实] 本地 `packages/pi-subagents-herdr` 已经在上游最弱的地方做得更严：它把 admission、取消、terminalization、retention 全部交给 `@hheei/pi-ext-core` 的单一 root coordinator，而不是像 M 那样完全不设并发上限，也不像 L 那样自持一套 manager/queue。[本地:packages/pi-subagents-herdr/src/feature.ts:444] [本地:packages/pi-ext-core/src/subagents.ts:45-49] [M:index.ts:189]

[事实] 本地真正的差距集中在 **Herdr provider 自身的运行时质量**：Run 没有时间上界，只能靠用户 `stop` 解开；存活判定靠每 500 ms 一次 `herdr agent get` 加每 2 s 一次 `herdr pane read` 的 CLI 轮询；失败只留下自由文本，pane 被无限期保留；child 只继承 manifest 一个环境变量。[本地:packages/pi-subagents-herdr/src/herdr-backend.ts:285] [本地:packages/pi-subagents-herdr/src/herdr-backend.ts:14] [本地:packages/pi-subagents-herdr/src/herdr-backend.ts:231]

[建议] 优先级顺序是：**(P1) 有界存活判定 → (P2) 事件/长等待取代轮询 → (P3) 失败分类与有界证据 → (P4) child 环境契约 → (P5) project trust 门禁 → (P6) discovery 失败作用域 → (P7) retention 单一化 → (P8) delivery 失败可见性**。全部落在 concrete extension 内，不需要扩大 ext-core 的 public contract；唯一涉及 core 的是 P1 需要确认“external operation 自身上限”这一既有边界被文档化。

[明确拒绝] 不采用 L 的 per-model 并发池、stealth（无 description）tool、foreground blocking spawn + completion gate、agent 名称 enum 注入；不采用 M 的“无并发上限”“屏幕/文本作为终态证据”“把 launch 责任交给必须额外 link 的 Herdr 插件”。理由与 no-hidden-routing、可见 contract、低常驻上下文三条既有政策冲突，逐条见 §6。

## 2. 第一方来源表

| 来源 | 实际核对的内容 | 第一方链接 |
| --- | --- | --- |
| M 编排器入口 | tool schema、注册守卫（`PI_DENY_TOOLS`、registry race 警告、无 Herdr 时的 setup stub）、`/reload` 用 `globalThis` symbol 收敛旧连接 | [index.ts](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/index.ts) · [index.ts:197](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/index.ts#L197) · [index.ts:1179-1207](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/index.ts#L1179-L1207) |
| M launch 计划 | curated env、`direnv exec` 包装、argv 组装、exit-code sidecar、15 s hold-open、`trap '' TSTP` | [src/launch.ts:116](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/src/launch.ts#L116) · [src/launch.ts:233-288](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/src/launch.ts#L233-L288) · [src/launch.ts:414](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/src/launch.ts#L414) |
| M watcher / 事件 | 8 值 outcome union、三路信号（socket 事件 / sidecar / reconcile）、5 s 慢轮询、stale-sidecar 守卫 | [src/watcher.ts:76-78](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/src/watcher.ts#L76-L78) · [src/watcher.ts:322-363](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/src/watcher.ts#L322-L363) · [src/herdr/events.ts:12-37](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/src/herdr/events.ts#L12-L37) |
| M 终态措辞 | `completed` / `completed-user-exit` / `ping` / `launch-failed` / `crashed` / `pane-killed` / `gap-exit` / `cancelled` | [src/messages.ts:114-228](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/src/messages.ts#L114-L228) |
| M 设计取舍 | 启动竞态、stalled 状态机、单 workspace、混合 CLI+socket 客户端、exit code sidecar 与上游 FR 草案 | [README.md:244-303](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/README.md#L244-L303) · [docs/PROJECT-BRIEF.md](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/docs/PROJECT-BRIEF.md) · [docs/full-socket-client.md](https://github.com/modem-dev/pi-herdr-subagents/blob/b6987324284b1fa22b2eb9f0effaf956ada27333/docs/full-socket-client.md) |
| L tool 注册 | 无 description 的 stealth schema、`agent` 名称注入、`constrainedSampling`、`/agents` briefing | [src/registration.ts:26-32](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/src/registration.ts#L26-L32) · [docs/adr/0001-stealth-tool-registration.md](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/docs/adr/0001-stealth-tool-registration.md) |
| L 并发与生命周期 | 分池 slot、FIFO queue、slot 释放 drain、queued 取消、continuation 不再排队、parent interrupt binding、completion gate、settled retention | [src/agents/agent-manager.ts:184-220](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/src/agents/agent-manager.ts#L184-L220) · [src/agents/agent-manager.ts:519-622](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/src/agents/agent-manager.ts#L519-L622) · [docs/adr/0005-parent-interrupt-binding.md](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/docs/adr/0005-parent-interrupt-binding.md) |
| L watchdog | 5 s tick、tool/idle 双检查、默认 45 min、`0` 关闭、stop note 与 widget 呈现 | [src/agents/agent-manager.ts:27](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/src/agents/agent-manager.ts#L27) · [src/config/config-io.ts:31](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/src/config/config-io.ts#L31) · [src/status-note.ts:12-31](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/src/status-note.ts#L12-L31) |
| L trust / worktree / 配置层 | Pi 官方 trust 原语、cross-repo 目标降级、project config 作为 override layer 且仅在 trusted 项目生效 | [src/spawn/project-trust.ts:16-67](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/src/spawn/project-trust.ts#L16-L67) · [docs/adr/0003-worktree-path-naming.md](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/docs/adr/0003-worktree-path-naming.md) · [docs/adr/0008-project-config-as-override-layer.md](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/docs/adr/0008-project-config-as-override-layer.md) |
| L 工程规则 | `deliverAs` 在 parent idle 时会被静默丢弃、extension factory 重入、dispose 不触发 `session_shutdown`、gate 一次性、项目 trust 必须跟随 settings 读取 | [AGENTS.md:58-73](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/AGENTS.md#L58-L73) · [tasks/lessons.md:82-94](https://github.com/AlexParamonov/pi-subagents-lite/blob/a5a4f99439facaca239216a34bf6152f454c8aca/tasks/lessons.md#L82-L94) |
| Pi host 能力 | 本仓库已安装的 `@earendil-works/pi-coding-agent@0.85.1` 导出 `hasTrustRequiringProjectResources`、`ProjectTrustStore`、`SettingsManager` | [本地:packages/pi-subagents-herdr/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:20-25] |
| 本地实现 | tool schema、provider policy、Herdr backend 循环与清理、agent discovery、RunSnapshot、widget/surface、ext-core 边界 | [本地:packages/pi-subagents-herdr/src/feature.ts] · [本地:packages/pi-subagents-herdr/src/herdr-backend.ts] · [本地:packages/pi-subagents-herdr/src/agents.ts] · [本地:packages/pi-ext-core/src/subagents.ts] · [本地:docs/architecture/pi-subagents-herdr.md] |

## 3. 上游实现核对

### 3.1 M：把 Herdr 的原生原语当作唯一事实来源

[事实] **启动路径不是“往 shell 里敲命令”**。M 的 pane 由 Herdr 插件入口启动：Herdr 侧固定 dispatcher，扩展生成 launch script，pane 环境只多一个变量指向脚本；`dispatch.sh` 校验变量存在且可读后 `exec bash "$launch_script"`。[M:herdr-plugin/dispatch.sh:1-16] [M:herdr-plugin/herdr-plugin.toml:9-21] 作者在 `docs/PROJECT-BRIEF.md` 里记录了动机：被打字启动的命令会被 direnv/devenv 的 shell init 吞掉，于是一整套 delay/verify/retry 都是补丁。[M:docs/PROJECT-BRIEF.md:14-25]

[事实] **launch script 是单一事实来源**。它包含 curated exports（`PATH`、`PI_CODING_AGENT_DIR`、`PI_DENY_TOOLS`、`PI_SUBAGENT_*`，绝不 dump 整个 env）、可选 `direnv exec` 包装、`trap '' TSTP`、pi argv、exit code sidecar、以及启动崩溃时的 hold-open。[M:src/launch.ts:250-288] [M:src/launch.ts:414] 环境包装策略：`PI_HERDR_LAUNCH_PREFIX` 一旦定义（哪怕为空）完全取代自动探测，`PI_HERDR_DIRENV=0` 关闭自动包装。[M:src/launch.ts:233-245] 因此“按行重跑 `bash <launch script>`”即可复现 child 环境，README 把这写成调试手法。[M:README.md:257-285]

[事实] **终态是 8 个互斥分类**，每一类都有固定措辞与证据：`completed`、`completed-user-exit`（用户直接退出子会话、没有 `subagent_done`）、`ping`（child 主动求助）、`launch-failed`（启动窗口内非零退出且没有 session entry）、`crashed`（启动窗口外退出）、`pane-killed`（pane 被外部关闭）、`gap-exit`（事件流断开期间消失）、`cancelled`（watcher abort，且刻意不发 steer）。[M:src/messages.ts:114-228] [M:src/watcher.ts:48-55,199-250] 注意 README 声称“每条路径都会发 steer”，而源码对 `cancelled` 返回 `null`——这是文档与实现的已知偏差。[M:src/messages.ts:85-87]

[事实] **存活判定是三路信号先到先得**：socket `pane.exited`/`pane.closed` 事件、`fs.watch` + 5 s 慢轮询 sidecar、以及 socket 重连后的 reconcile（`pane list` 比对，缺 pane 即判定已退出）。因为 `events.subscribe` 没有 replay，重连必须自己补齐。[M:src/watcher.ts:76-78] [M:src/watcher.ts:322-363] [M:src/herdr/events.ts:12-37] pane 文本只在失败分类后用于抓取有界诊断（20 行、100 ms 预算），从不参与终态判定。[M:src/watcher.ts:160]

[事实] **resume 的两个竞态守卫**：生成脚本把 exit code 与 run id 一起写入 sidecar，watcher 遇到 id 不匹配就删除外来 sidecar 继续观察；对未打戳的 exit 0，先在 `pane get` 确认自己的 pane 仍存活再采信。resume 前显式清理 `.exit`、`.exitcode`、context-usage，并且只总结 baseline 之后新增的 entry，避免上一轮输出冒充本轮结果。[M:src/watcher.ts:220-223] [M:index.ts:775-777] [M:index.ts:695-722]

[事实] **取消的层次**：`subagent_interrupt` 只向 pane 发送 `esc`，中断当前 turn，pane、session、watcher、running map 全部保留；扩展 shutdown 则 abort 所有 watcher 并关闭 socket。模型侧没有任何关闭 pane 的 tool。[M:index.ts:915,941] [M:index.ts:1222] 同时 M **完全没有并发上限**：`runningSubagents` 是无界 `Map`，`globalThis` 上的 active id 集合也是无界 `Set`。[M:index.ts:189] [M:src/runtime-state.ts:6-16]

[事实] **注册守卫是显式且会止损的**：不在 Herdr 内则在 load 时不注册任何 tool，`session_start` 时若没有别的扩展提供 `subagent` 才注册 setup-hint stub；在 Herdr 内若发现 registry 被人抢走（Pi 是 first-loaded-wins、静默覆盖），会用 warning 明确提示包顺序。[M:index.ts:1158] [M:index.ts:1179-1207] [M:index.ts:459]

#### 值得学习

1. **原语优先**：能用 socket 事件就不要屏幕 scraping，能用 argv 就不要打字；并把“为什么不”写成设计文档与上游 FR 草案。[M:docs/full-socket-client.md]
2. **诚实终态词汇表**：把“用户手动关掉”“pane 被外部杀掉”“事件流断开期间消失”当成彼此不同的结果，而不是统一成 completed/failed。[M:src/messages.ts:143-228]
3. **可复现的 launch 产物**：把 child 的完整调用与环境写成可手工重跑的脚本，失败诊断不依赖现场。[M:README.md:257-285]
4. **stale-sidecar 守卫**：任何“按文件判定终态”的设计都需要 run id 打戳与存活复核，resume 场景尤其致命。[M:src/watcher.ts:220-223]

### 3.2 L：把每个决策写成 ADR，再把决策落到状态机

[事实] **所有权切分清楚**：`SpawnCoordinator` 负责 live view、nudge 批处理与 foreground 的 completion gate；`AgentManager` 拥有 slot、queue、state machine、watchdog 与 dispose。[L:src/spawn/spawn-coordinator.ts:1-47] 运行时状态不再放模块级导出，而是 composition root 闭包持有（ADR-0004），以避免 ESM live binding 造成的陈旧引用与 15 个模块的 mock。[L:docs/adr/0004-composition-root-over-shared-state.md] 这一点本地已经做对：`runs`、`managedHerdrPanes`、`deliveryTimer` 都是 `createSubagentsFeature` 的闭包状态。[本地:packages/pi-subagents-herdr/src/feature.ts:180-190]

[事实] **并发是分池的**：`getSlot(modelKey)` 依次尝试 `provider/modelId`、`provider`、default，返回共享 slot 对象；slot 满则入 FIFO `queue` 并把 record 置为 `queued`，start 时不创建 runner。[L:src/agents/agent-manager.ts:184-220] slot 释放在 settlement chain 的 `finally` 里 `running--` 后 `drainQueue()`；drain 期间 start 抛错也会把 record 置 `error` 并开 gate，避免卡死。[L:src/agents/agent-manager.ts:413] [L:src/agents/agent-manager.ts:519] 关键取舍：**settled agent 的 continuation 不排队**，slot 满就直接拒绝。[L:src/agents/agent-manager.ts:580-594]

[事实] **watchdog 是两条独立检查**：5 s tick；`toolTimeoutMinutes` 跟踪进行中的 tool call（按 `toolCallId`），`idleTimeoutMinutes` 跟踪最后活动（tool 事件或流式文本），默认都是 45 分钟，`0` 关闭；tool 超时优先于 idle。命中后调用 `abort(id, "watchdog")`，把 `stoppedBy`/`stopDetail` 写进 record。[L:src/agents/agent-manager.ts:27] [L:src/config/config-io.ts:31] 通知是可见的：foreground 在 tool result 里附 `(STOPPED BY WATCHDOG — tool <name> exceeded <elapsed>)`，background 走 nudge，widget 显示 `watchdog: bash >45m`。[L:src/status-note.ts:12-45]

[事实] **settled retention 只保留一个机制**：ADR-0006 取消了 manager 侧定时淘汰与 widget 侧按 turn 淘汰，改成“record 直到用户 clear 或 dispose 才消失 + widget 单一 wall-clock 窗口”。理由是“完成一分钟后结果不可达”与两种单位/两个配置的心智负担。[L:docs/adr/0006-settled-agent-retention.md]

[事实] **parent interrupt 只绑定 foreground**：foreground spawn 传入 parent run 的 signal，abort 时 `abort(id, "user")`，partial output 保留；background 永不绑定。绑定在 settle/stop/remove/dispose 时 detach，以免后续 abort 命中已结算记录。completion gate 在 spawn 时创建、terminal 时恰好开启一次，保证 foreground tool call 不会早返回空结果。[L:docs/adr/0005-parent-interrupt-binding.md] [L:src/agents/agent-manager.ts:255] [L:src/agents/agent-manager.ts:443]

[事实] **project trust 用 Pi 自己的原语**，不重新实现 trust.json：same-repo 直接信任；跨 repo 且目标带 trust-requiring 资源（`.pi` 或 `.agents/skills`）时查 `ProjectTrustStore.get`，未决则回落 `defaultProjectTrust === "always"`；不受信目标照常 spawn，但忽略其项目资源并显式告警。[L:src/spawn/project-trust.ts:16-67] 同一原则写进了工程规则：“任何新的 settings 读取都必须继承其所服务代码路径的 project-trust 决策”。[L:tasks/lessons.md:82-84]

[事实] **配置是分层 override，而不是整文件替换**：ADR-0007 的“project 文件整体替换 global”被 ADR-0008 取代，project 文件只允许 model 与 concurrency 家族键，缺键继承 global，删除键即取消覆盖；未受信项目直接拒绝加载/写入 project config。[L:docs/adr/0008-project-config-as-override-layer.md] [L:src/config/config-io.ts:89,160-172]

[事实] **交付细节**：background 完成用 200 ms 批处理凑成一条 nudge；`deliverAs` 视 parent 是否 idle 在 `followUp`/`steer` 之间选择，并且 **`sendMessage` 抛错时回落到 `ui.notify`**；工程规则明确“`deliverAs: "steer"` 只在 parent 运行时排队，idle 会静默丢弃”。[L:src/spawn/spawn-coordinator.ts:120-135,200-232] [L:AGENTS.md:58]

[事实] **tool 是 stealth 的**：注册时无 description、无 promptSnippet、无参数描述，`model`/`thinking`/`max_turns`/`max_tokens` 不在 schema 里，而是在 `tool_call` 监听器或 execute 阶段按“session per-type → session default → config per-type → config default → frontmatter → parent”链注入。[L:src/registration.ts:100-141] [L:src/models/model-precedence.ts:46-63] 原因是本地推理引擎（如 llama.cpp）把 tool 定义渲染进 prompt 文本，会话中途改 tool 会破坏 KV cache 前缀；agent 类型只以 `Type.String({description: types.join(",")})` 列出候选名，而不展开成字面量 union。[L:docs/adr/0001-stealth-tool-registration.md:15-36] [L:src/registration.ts:26-32]

#### 值得学习

1. **每条实现决策配一份含 trade-off 的 ADR**，以及在仓库内沉淀“下次怎么做”的 lessons：这类记录让“为什么不是另一种方案”不必靠考古。[L:docs/adr] [L:tasks/lessons.md]
2. **watchdog 是独立于 turn 上限的时间正确性机制**：`max_turns` 管 token 预算，watchdog 管“卡住”，两者不可互相替代。[L:src/agents/agent-manager.ts:694-697]
3. **保留策略只允许一个机制、一个单位**：多套淘汰规则必然产生“记录消失但结果还在别处”的错位。[L:docs/adr/0006-settled-agent-retention.md]
4. **trust 用官方原语且不阻断 spawn，只降级资源加载**，并把降级结果显式告知用户。[L:src/spawn/project-trust.ts:59-67]
5. **delivery 失败必须有第二条可见路径**，否则 terminal result 会静默消失。[L:src/spawn/spawn-coordinator.ts:200-232]

### 3.3 两个上游的共同结论

[事实] M 与 L 在以下三点独立收敛，说明这些不是风格偏好：**(a)** 子进程/子会话的终态必须由结构化证据判定，而不是 UI 或文本；**(b)** 每次 spawn 都要有一个明确的 owner 负责取消与清理，且清理幂等；**(c)** 模型可见结果与“用户可观察状态”是两件事，后者需要单独的、有界的证据面。[M:src/watcher.ts:48-55,199-250] [L:src/agents/tool-execution.ts:246] [L:src/ui/agent-widget.ts]

[事实] 两者也各自留下了一个本仓库不该照搬的洞：M 没有并发上限、也没有任何“卡住的 child”检测（作者在 README 里列为已知限制）；L 的 in-process `AgentSession` 假设与 Herdr 的独立进程模型不兼容，且 record 无限保留到用户 clear。[M:README.md:286-303] [L:docs/adr/0006-settled-agent-retention.md:26-36]

## 4. 与本仓库当前实现的对照

### 4.1 能力矩阵

符号：`✓` 源码确认；`~` 语义不同或仅有局部；`—` 未发现。

| 能力 | M | L | 本地当前实现 | 取舍 |
| --- | --- | --- | --- | --- |
| 非阻塞 spawn + 自动回送 | ✓ 立即返回，watcher 完成后 `sendMessage` steer | ✓ `run_in_background` + 200 ms nudge 批处理 | ✓ `spawn` 立即返回；terminal 走 200 ms batch `deliverAs: "followUp"` [本地:src/feature.ts:197-217,364-400] | 保持；本地与 L 的批处理窗口一致 |
| 并发 admission | — 无界 Map | ✓ 分池 slot + FIFO queue | ✓ core 单一 coordinator：active 8 / pending 16 / retained 32 [本地:packages/pi-ext-core/src/subagents.ts:45-49] | 继续用 core；拒绝自建第二队列 |
| 时间正确性（watchdog） | ~ 只有 15 s 启动窗口 | ✓ tool/idle 双检查，默认 45 min | — Herdr Run 无任何时间上界 [本地:src/herdr-backend.ts:285] | **本次最高优先级**（P1） |
| 存活观测 | ✓ socket 事件 + reconcile + 5 s 慢轮询 | n/a（同进程 session 事件） | ~ 500 ms `agent get` + 2 s `pane read` CLI 轮询 [本地:src/herdr-backend.ts:14,299-300] | 改事件/长等待（P2） |
| 终态分类 | ✓ 8 值 union + 固定措辞 | ✓ status enum + stop note | ~ core status enum + 自由文本 `failure` [本地:src/types.ts:25-32] | 增加 extension 自己的分类（P3） |
| 失败诊断证据 | ✓ pane tail + 退出码 + launch script 路径 | ✓ stop note + transcript 文件 | ~ 仅 `failure` 字符串；pane 无限期保留 [本地:src/herdr-backend.ts:216,348] | 抓取有界 tail 后关闭 pane（P3） |
| child 环境正确性 | ✓ curated PATH + direnv wrap | ~ in-process，继承父进程 | ~ 只传 manifest 一个 env [本地:src/herdr-backend.ts:231] | 补 PATH/前缀策略（P4） |
| project trust | ~ 只按 `PI_DENY_TOOLS` 与 CLI 过滤 | ✓ Pi 官方 trust 原语 | — 项目 agent 定义无条件加载 [本地:src/agents.ts:114-131] | 加 trust 门禁（P5） |
| discovery 失败作用域 | ~ 单文件抛错即失败 | ✓ 逐文件 try/catch 跳过 | ~ 任一坏文件使整个工具不可用 [本地:src/agents.ts:114-131] | 收窄作用域（P6） |
| retention 机制数 | ~ 无上限 | ✓ 单一机制（ADR-0006） | ~ core 32 + extension 32 + widget 8 s 三处数字 [本地:src/feature.ts:30] [本地:src/widget.ts:6] | 去重与文档化（P7） |
| delivery 失败可见性 | ~ `cancelled` 静默 | ✓ `ui.notify` 兜底 | — `pi.sendMessage` 无 try/catch [本地:src/feature.ts:201] | 补兜底（P8） |
| resume / interrupt | ✓ `subagent_resume` + `subagent_interrupt`（esc） | ✓ settle 后 continuation | — 明确排除 | 延后；先补 P1-P3 |
| worktree / 跨 repo cwd | ~ 仅 `cwd` 参数 | ✓ 校验 + trust 门禁 | — 仅 `context.cwd` | 延后（需 trust 与策略） |
| 模型/thinking 注入 | ✓ 允许模型传 model/tools | ~ 注入 + 解释器链 | ✓ consumer-owned resolution，模型不能传 [本地:src/feature.ts:36-56] | 保持；L 的链式优先级可借鉴为文档 |
| stealth schema | — 有 description | ✓ 无 description | ~ 有 description 的极小 schema | 拒绝（与可见 contract 冲突） |

### 4.2 本地已经达到或优于上游的部分

[事实]

- **单一 root coordinator**：core 用一个 budget 管 completion/task/conversation 的 active turn，pending 满即拒绝而不是无界排队；第一个 live consumer 安装 budget，后续 consumer 值不同即为 collision error。[本地:packages/pi-ext-core/src/subagents.ts:403-409,621-645] 这正好补上 M 的无界 Map 与 L 的多池 queue。
- **completion root 闭包状态**：`runs`/`managedHerdrPanes`/timers 都在 `createSubagentsFeature` 内，避免模块级可变导出（与 L 的 ADR-0004 同结论）。[本地:src/feature.ts:180-190]
- **Herdr 成功以 nonce-bound `result.json` 为唯一真相对照**，pane 文本只作进度；child entry 用 temp-file+rename 原子写、`wx` 独占标志、0600 权限。[本地:src/child-entry.ts:151-157] [本地:src/herdr-backend.ts:146-183]
- **模型不可选择 provider/model/tools**，spawn result 明确回显 resolved policy；`auto` 只在副作用前探测失败时回落 local，显式 `herdr` fail closed。[本地:src/feature.ts:283-310] [本地:docs/architecture/pi-subagents-herdr.md]
- **model 注入语义**：本地已在 frontmatter 解析 model/thinking/tools/extensions/skills 并严格校验 unknown config field（拼写错误直接报错，不静默回落 auto）。[本地:src/agents.ts:133-168]

### 4.3 明确差距（按风险）

[事实]

1. **Herdr Run 没有时间上界**。backend 是 `for (;;)`，唯一退出条件是拿到 `result.json`、抛错、或 `context.signal` abort；core 对 external operation 只传 `maxTurns`、不设 deadline，因此一个 `agent get` 永远报 `working` 的 child 会永久占用 8 个 admission 槽之一。[本地:src/herdr-backend.ts:285] [本地:packages/pi-ext-core/src/subagents.ts:1049-1075]
2. **观测成本随 Run 数线性增长**：每个 active Run 每 500 ms 一次 `herdr agent get`，每 2 s 一次 `herdr pane read`；8 个 Run 即约 20 次 CLI fork/exec 每秒。[本地:src/herdr-backend.ts:14,299-300]
3. **失败证据不足且 pane 无界保留**：失败时 `closeManagedPane` 仍为 false，pane 一直开着直到 session dispose；`failure` 是 CLI/错误文本，没有分类，也没有 pane tail；manifest/result 目录在 `outputTranscript=false` 时被删除。[本地:src/herdr-backend.ts:216,348,353]
4. **child 环境只有一个 manifest 变量**：direnv/devenv 仓库里 child 的 `bash` tool 可能拿不到 node/pnpm；作者在 M 中记录该场景会“秒退”。[本地:src/herdr-backend.ts:231] [M:docs/PROJECT-BRIEF.md:79-83]
5. **项目 agent 定义不经过 trust 判定**：`<cwd>/.agents` 与 `<cwd>/.pi/agents` 无条件加载，而定义可以声明 `tools: …, bash, edit, write`。[本地:src/agents.ts:114-131] [本地:packages/pi-subagents-herdr/agents/builder.md:4]
6. **一个坏 definition 会废掉整个工具**：`parseAgentDocument` 抛错沿 `discoverAgents` 冒泡，`spawn`、`status`、`/subagents` 三条路径同时失败；同时 unknown agent 错误只回 `Unknown agent: X`，不含可用目录。[本地:src/agents.ts:59-100] [本地:src/feature.ts:293]
7. **retention 数字三处独立**：core `maxRetainedTerminal: 32`、feature `MAX_RETAINED_RUNS = 32`、widget `TERMINAL_RETENTION_MS = 8_000`；此外架构文档写的 canonical budget 是 `active: 2`，代码是 `maxActiveTurns: 8`。[本地:packages/pi-ext-core/src/subagents.ts:46] [本地:src/feature.ts:30] [本地:src/widget.ts:6] [本地:docs/architecture/subagents.md:160-161]
8. **delivery 无兜底**：`pi.sendMessage` 抛错时该批 terminal result 静默消失（core 对 sink 的 `deliveryFailed` 语义在这条 inline 路径上没有生效）。[本地:src/feature.ts:197-217]

## 5. 改进建议（按优先级）

每项都给出：依据 → 最小方案 → 影响（所有权 / 生命周期 / 取消 / 并发 / 回退）→ 验收方式。全部实现都在 concrete extension 内；不新增 ext-core public API。

### P1 为 Herdr Run 增加有界存活判定（idle + 绝对上限）

- **依据**：本地无时间上界（§4.3-1）；L 证明 `max_turns` 与“卡住”是两件事，需要独立的 tool/idle 检查。[L:src/agents/agent-manager.ts:694-697]
- **最小方案**：在 `createHerdrExecution` 的轮询循环内自持两个单调计时器——`idle`（自上次“有进展”起算：新的 pane 文本、`agent_status` 变化、或 result 出现）与 `absolute`（自 spawn 起算）。到期后先抓一次有界 pane tail，再抛出一个带稳定前缀的 `Error`，让 core 走既有 `failed` 路径。`maxTurns` 仍由 child entry 自己执行软/硬上限，两者不互相替代。[本地:src/child-entry.ts:133-146]
- **所有权**：concrete（Herdr provider policy）；core 只继续提供 `context.signal` 与 `maxTurns`，语义不变。建议在 `docs/architecture/subagents.md` 中把“external operation 自身上限由 consumer 负责”写成既有边界的一部分。
- **生命周期**：计时器必须在 `finally` 中清理；成功、失败、abort 三条路径都只结算一次。
- **取消**：到期是失败而非取消，保留 `cancelled` 语义只属于 `handle.cancel()`/parent abort；到期后仍走同一 `finally` 的 pane 处理（见 P3）。
- **并发**：到期立即释放 admission slot，避免一个 hung pane 长期占住 8 槽之一；不与 core 的 pending FIFO 交互。
- **回退**：到期绝不触发 local 重跑；failure 文本必须说明是 idle deadline 而不是 child 报错。
- **验收**：fake-herdr 测试让 `agent get` 永远返回 `working` 且不写 result，断言在 idle 上限内结算为 `failed`、slot 释放、pane 处理符合策略。

### P2 用事件/长等待取代高频 CLI 轮询

- **依据**：本地 500 ms/2 s 双轮询（§4.3-2）；M 的 `events.subscribe`（ndJSON over `HERDR_SOCKET_PATH`，退避 `[500,1000,2000,5000]`，重连后 reconcile）已验证可用，且 `pane.exited` 明确不带 exit code。[M:src/herdr/events.ts:12-37] M 的 brief 另记录了 `herdr wait agent-status <pane> --status done|idle|blocked` 与 `herdr wait output --match` 这类一次性阻塞等待。[M:docs/PROJECT-BRIEF.md:36-46]
- **最小方案（分两步）**：**第一步**把 500 ms 轮询换成“每 Run 一个可 abort 的 `herdr wait agent-status` 子进程 + 更慢的兜底轮询”，改动只在 `herdr-backend.ts`。**第二步**在扩展内加一个懒创建的共享 socket 订阅（只订 `pane.exited`/`pane.closed`，per-pane 分发），第一版只用于“pane 消失”的即时分类与日志，`result.json` 仍是唯一成功真相。每步都保留慢轮询兜底，并在 status 中显示观测通道是否降级。
- **所有权**：concrete。Herdr 协议细节不得进入 ext-core；ext-core 的 event subscription 只服务 child 事件，不承担 provider 协议。
- **生命周期**：socket 在首个 Herdr Run 时创建，`dispose`/lifecycle abort 时关闭；每个 Run 在 `finally` 里 unwatch。注意 race：split 返回 pane id 后要立即注册 watcher，再做 `agent start`，否则会漏掉“启动即崩溃”。
- **取消**：`stop`/parent abort 仍通过 `context.signal`；等待子进程沿用 `runCommand` 已有的 SIGTERM→SIGKILL 升级路径。[本地:src/process.ts:39-51]
- **并发**：一个进程一条连接、N 个 pane watcher；只对已注册 pane id 分发，队列有界；事件流断开只降级观测，不改变任何 Run 状态。
- **回退**：socket 不可用、版本过旧或 wait 子进程不支持时自动回到轮询，并在 status 明示；“事件流断开期间消失”应有独立分类（对齐 M 的 `gap-exit`），不得伪装成 crashed 或 completed。
- **验收**：fake-herdr 断言 wait/订阅路径在 pane 消失时即时结算；真实 Herdr 冒烟（若环境可用）确认无 result 时不误判成功。

### P3 失败分类 + 有界诊断证据 + pane 回收

- **依据**：本地失败只有自由文本且 pane 无界保留（§4.3-3）；M 的 8 值分类与“抓到 pane tail 再给出结论”的做法。[M:src/messages.ts:143-228] [M:src/watcher.ts:160]
- **最小方案**：在 `RunSnapshot` 上加一个 extension-owned 的 `providerFailure` 枚举（`launch_failed` / `pane_closed` / `result_timeout` / `result_invalid` / `herdr_error`），并在结算为 failed 时抓取一次有界 pane tail（ANSI strip、≤20 行、≤2 KB）存入 snapshot。同时把“失败即保留 pane”改为“先捕获证据、再按显式策略处置 pane”，避免 N 次失败留下 N 个永久 pane。成功路径的模型可见证据仍然只有 `result.json`；pane 文本永不进入 success 证据。
- **所有权**：concrete。`TaskTerminalResult.failure` 在 core 里继续是字符串，不新增 core 字段（避免为单一 consumer 扩容 core contract）。
- **生命周期**：捕获只能发生一次，且在 pane close 之前；分类字段参与同一 200 ms delivery batch，不额外发消息。
- **取消**：cancelled 不写入 `providerFailure`，保持三种终态互不混淆（这也是 M 文档与实现出现偏差的地方，需刻意保持一致性）。
- **并发**：每个失败 Run 只多一次 `pane read`，不引入持续轮询。
- **回退**：分类不触发任何 retry 或 provider 切换；未知形态一律 `herdr_error` 并保留原始错误文本。
- **验收**：单测覆盖 nonce 不匹配、result 缺字段、pane 消失、启动即失败四类，断言分类与 tail 有界。

### P4 child 环境契约（PATH 与前缀），并记录可复现的调用

- **依据**：本地只传 manifest（§4.3-4）；M 用 curated exports + `direnv exec`，并明确“绝不 dump 整个 env”。[M:src/launch.ts:233-245,414]
- **最小方案**：`pane split` 时额外传 `--env PATH=<orchestrator PATH>`（只加 PATH 这类无秘密变量，不导出 env 全量）；对 `.envrc` 目录提供显式可选的前缀策略（项目配置字段或环境变量），默认关闭并在文档中说明 Herdr pane 不加载 shell rc；把 resolved child argv（不含 env 值）与 pane id 记入 Run snapshot/失败证据，使失败可复核。
- **所有权**：concrete；若走项目配置，必须沿用现有严格校验（unknown field 直接报错）。[本地:src/agents.ts:133-168]
- **生命周期**：纯 per-run 策略，无持久状态。
- **取消**：无影响。
- **并发**：无影响。
- **回退**：无法解析 `pi` 或环境不完整时必须走 P3 的 `launch_failed` 分类并给出可读原因，绝不允许“空 pane + 永远 running”。
- **验收**：fake-herdr 断言 split argv 含 PATH 且不含其它环境变量；单测断言失败证据包含 argv/pane id 且有界。

### P5 项目 agent 定义的 trust 门禁

- **依据**：本地无条件加载项目定义（§4.3-5）；L 用 Pi 官方原语做 trust 判定，未受信目标仍可 spawn 但忽略项目资源。[L:src/spawn/project-trust.ts:16-67] 本仓库已安装的 Pi 导出 `hasTrustRequiringProjectResources`、`ProjectTrustStore`、`SettingsManager.getDefaultProjectTrust`。[本地:packages/pi-subagents-herdr/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:20-25] ext-core 也已在别处提醒 consumer：要限制 project trust 就必须读 `global` 与 `project` 两层而非 merged。[本地:packages/pi-ext-core/src/json-settings.ts:148-150]
- **最小方案**：discovery 前对 `cwd` 求 trust 决策；不受信时跳过 `.agents` 与 `.pi/agents` 两个项目根（builtin 与 user 根不受影响），并把该决策与原因显示在 spawn result 与 `/subagents`。若被请求的 agent 只存在于不受信项目，明确失败而不是换用同名其它来源。
- **所有权**：concrete policy，使用 Pi 官方 API；不把 trust 逻辑放进 ext-core（core 不解析路径来源）。
- **生命周期**：每次 discovery 现算，不跨 spawn 缓存，避免用户在会话中改变 trust 后继续用陈旧结论。
- **取消 / 并发**：无影响。
- **回退**：绝不“因为找不到就回退到不受信定义”；也不静默忽略——降级必须可见。
- **验收**：单测用临时 `PI_CODING_AGENT_DIR` 与 fake trust store 覆盖受信/未受信两分支，断言目录被排除且原因可见。

### P6 discovery 失败作用域与 unknown agent 提示

- **依据**：本地单文件坏即全工具不可用（§4.3-6），而 `docs/architecture/pi-subagents-herdr.md` 把“明确失败、不静默跳过”写成了有意决策；L 的做法是逐文件 try/catch、无 `name` 不入目录。[L:src/agents/agent-discovery.ts:270-290]
- **最小方案（保守版，兼容既有决策）**：保留严格校验与失败，但把失败变成 **带路径的可诊断错误**，并让与该文件无关的路径继续可用（例如 `status` 能返回 catalog 错误摘要而不是整体抛错）；`Unknown agent` 错误额外附上有界的可用名称列表，使模型一次就能纠正。[本地:src/feature.ts:293]
- **所有权**：concrete。
- **生命周期 / 取消 / 并发 / 回退**：无影响；不引入部分成功缓存。
- **验收**：单测写入一个坏文件，断言错误信息含路径与原因、`status` 仍可用、unknown agent 提示包含可用名称。
- **注意**：这是对既有文档决策的收窄，实施时必须同步更新 `docs/architecture/pi-subagents-herdr.md`，否则会形成第二套约定。

### P7 retention 单一化与 budget 事实一致性

- **依据**：三处独立数字与一处文档/代码不一致（§4.3-7）；L 的 ADR-0006 明确“一个机制、一个单位”。[L:docs/adr/0006-settled-agent-retention.md]
- **最小方案**：把 feature 的 `MAX_RETAINED_RUNS` 改为从 core 的 coordinator budget 派生（或明确声明它只是 display history，不承诺 handle 仍可 lookup/redeliver），widget 窗口保持唯一的时间维度；顺手修正 `docs/architecture/subagents.md` 中 `active: 2` 与代码 `maxActiveTurns: 8` 的不一致。[本地:packages/pi-ext-core/src/subagents.ts:46] [本地:docs/architecture/subagents.md:160-161]
- **所有权**：widget/window 属 concrete；若要读取 live budget 需要 ext-core 增加一个只读访问器，属于可选的 core 扩容，默认先做文档与注释澄清。
- **生命周期**：prune 只在 terminal 时发生，且不得删除仍可能被 `redeliverTask` 需要的 handle 记录语义（本地目前不使用 redelivery，需在注释中写明这一前提）。
- **取消 / 并发 / 回退**：无影响。
- **验收**：单测断言 retention 上界与 budget 常量一致（或断言注释所述的不变量）。

### P8 delivery 失败可见性

- **依据**：本地 `pi.sendMessage` 无兜底（§4.3-8）；L 在 `sendMessage` 失败时回落 `ui.notify`，并记录 `deliverAs: "steer"` 在 parent idle 时会静默丢弃。[L:src/spawn/spawn-coordinator.ts:200-232] [L:AGENTS.md:58]
- **最小方案**：`flushDeliveries` 包一层 try/catch；失败时把该批 Run 标记 `deliveryFailed`（snapshot 可见），并用 `command/UI` 通道给出一条可读提示；结果仍可通过 `status` 读取。保持只使用 `followUp`（本地从不使用 steer，因此不受 L 记录的那条 trap 影响）。
- **所有权**：concrete（core 的 sink 契约保持不变；这里走的是 inline adapter）。
- **生命周期**：失败不再重试同一批；显式重投只能由用户动作触发（与 core 的 “automatic delivery 最多一次” 一致）。
- **取消 / 并发**：无影响。
- **回退**：提示是兜底，不得用它替代 delivery 本身。
- **验收**：单测让 `sendMessage` 抛错，断言 run 标记、提示出现、且不产生未处理 rejection。

### 补充：暂不建议实现的候选（保留为参考）

[延后] **resume / interrupt / conversation**：M 的 `subagent_interrupt` 只发 esc 且依赖 child session 存活，`subagent_resume` 依赖 child 保留 `.jsonl` session 与两个 stale-sidecar 守卫；本地 child 使用 `--no-session` 且删除私有目录，因此先要决定“是否保留 child session”这一更大的契约问题。[M:index.ts:915,941] [本地:src/herdr-backend.ts:239-258]
[延后] **worktree / 跨 repo cwd**：两个 provider 都支持（`createAgentSession({cwd})`、`herdr pane split --cwd`），但必须同时落地 trust 门禁、策略字段与 prompt/context 影响说明。[本地:src/local-backend.ts:43-52] [L:src/spawn/worktree-validator.ts]
[延后] **真实 Herdr 集成测试**：M 的 harness 给出了可复用配方——独立 tmux session + 私有 XDG 根 + socket 互锁（拒绝默认 socket）+ 预置 trust.json + 零残留 teardown。[M:test/integration/harness.ts] 只有在 P2 落地（引入 socket/wait 代码）后才有必要引入这一层基础设施。

## 6. 决策表

| 候选能力 | 上游依据 | 本仓库现状 | 判定 | 最小改动 / 理由 |
| --- | --- | --- | --- | --- |
| external Run 的 idle/绝对时间上限 | [L:src/agents/agent-manager.ts:694] [M:README.md:286-303] | 无任何上限 | **Adopt** | P1；纯 provider 内部计时器，修正确性与并发占用 |
| 事件/长等待驱动存活观测 | [M:src/herdr/events.ts:12-37] [M:docs/PROJECT-BRIEF.md:36-46] | 500 ms + 2 s CLI 轮询 | **Adopt（分两步）** | P2；先换 wait 子进程，再共享 socket 订阅，始终保留慢轮询 |
| 失败分类枚举 + 有界 pane tail | [M:src/messages.ts:143-228] | 自由文本 failure | **Adopt** | P3；extension-owned 字段，不动 core contract |
| 失败后 pane 的显式处置 | [M:src/launch.ts:250-288] | 失败 pane 无限期保留 | **Adapt** | P3；保留“供诊断”意图，但先取证据再回收 |
| child 环境 PATH / direnv 前缀 | [M:src/launch.ts:233-245,414] | 仅传 manifest | **Adapt** | P4；只加 PATH 类变量 + 可选前缀，不 dump env |
| 可复现的 resolved 调用记录 | [M:README.md:257-285] | 无（manifest 目录默认删除） | **Adapt** | P4；记 argv/pane id 到失败证据，不写完整 env |
| project trust 门禁 | [L:src/spawn/project-trust.ts:16-67] | 无条件加载项目定义 | **Adapt** | P5；用 Pi 官方原语，未受信只降级不阻断 |
| discovery 失败作用域收窄 | [L:src/agents/agent-discovery.ts:270-290] | 一个坏文件废掉整个工具 | **Adapt（需同步文档）** | P6；保留严格校验，仅收窄影响面 |
| retention 单一机制 | [L:docs/adr/0006-settled-agent-retention.md] | core/feature/widget 三处数字 | **Adapt** | P7；派生或显式声明，并修文档不一致 |
| prompt-order KV-cache 前缀 | [L:src/prompt/prompts.ts:150] | Local 用 Pi 默认装配 | **Defer** | 需要先证明跨 spawn 前缀复用收益；Herdr 侧是独立进程，收益更小 |
| delivery 失败可见性 | [L:src/spawn/spawn-coordinator.ts:200-232] | 无兜底 | **Adopt** | P8；小改动，防静默丢结果 |
| 分池 per-model/per-provider 并发 | [L:docs/adr/0002-per-model-concurrency.md] | core 单一 root 上限 | **Reject** | 会复制第二套队列，违反单一 coordinator；如确有需求，先提 core 级 proposal |
| 无 description 的 stealth tool | [L:docs/adr/0001-stealth-tool-registration.md] | 有 description 的极小 schema | **Reject** | 与“可见 contract / 无隐藏意图”冲突；本地 schema 已足够小 [本地:AGENTS.md:11] |
| agent 名称 enum 注入 schema | [L:src/registration.ts:26-32] | `Type.String` | **Defer** | 会话中途重注册会触发 system prompt 重建（L 自己的 ADR-0001 即反例）；先用 P6 的错误提示替代 |
| foreground blocking spawn + completion gate | [L:docs/adr/0005-parent-interrupt-binding.md] | 无 wait/poll tool | **Reject** | 本地明确不提供 model-facing wait，保持非阻塞 + follow-up |
| per-frame/nudge 之外的持续轮询 status | [L:src/agents/agent-status.ts] | `status` 工具 + live widget | **Reject** | 已有等价观测面，避免额外常驻成本 |
| resume / continuation | [M:index.ts:695-760] | 明确排除 | **Defer** | 需要先决定 child session 是否持久化（当前 `--no-session` + 删除私有目录） |
| interrupt（esc）与 terminal stop 分离 | [M:index.ts:915,941] | 只有 terminal stop | **Defer** | 依赖 conversation 语义；当前 stage 不做 |
| worktree / 跨 repo cwd | [L:docs/adr/0003-worktree-path-naming.md] [L:src/spawn/worktree-validator.ts] | 固定 `context.cwd` | **Defer** | 需 trust 门禁（P5）先落地，且要声明 provider capability |
| 无界 spawn 上限 | [M:index.ts:189] | core active 8/pending 16 | **Reject** | 本地已严格优于上游；作为反例记录 |
| 依赖 Herdr 插件 link 的 pane 启动 | [M:herdr-plugin/herdr-plugin.toml] | `herdr pane split` + `agent start` | **Reject** | 本地已用原生 CLI 消除启动竞态，无需额外安装步骤 |
| Watchdog → parent 的 stop note 文案 | [L:src/status-note.ts:12-45] | failure 文本 | **Adapt** | 借 P3 的分类字段落地同等可读性，不新增通知通道 |
| 项目 config 作为 override layer | [L:docs/adr/0008-project-config-as-override-layer.md] | 仅项目级单文件、严格校验 | **Defer** | 与 P5 trust 绑定评估；现在没有 global 层需求 |
| ADR/lessons 记录习惯 | [L:docs/adr] [L:tasks/lessons.md] | 已有 `docs/adr` 与架构文档 | **Adopt（流程）** | P1/P3/P6 落地时各补一条决策记录与 trade-off |

## 7. 结论

两个上游的有效经验各不相同：M 教的是“把 provider 的原生原语用到极限，并让每个终态都可解释”；L 教的是“把运行时正确性拆成独立机制（admission、watchdog、retention、trust）并逐条记录取舍”。本仓库的 ownership 边界已经比两者都干净，缺的不是架构，而是 Herdr provider 内部的运行时质量——时间上界、观测通道、失败证据、child 环境与 trust 门禁。按 P1→P3 的顺序落地即可用最小改动消除“一个卡住的 child 永久占用 admission 槽”“失败只剩一句 CLI 报错”“N 个失败留下 N 个 pane”这三类真实缺陷，且不触碰 ext-core 的 public contract，也不引入任何隐式路由。

## 8. 已核实的 Herdr 0.9.0 事实（本轮实现输入）

以下全部来自本机已安装运行时（`herdr --version` → `herdr 0.9.0`；`herdr status server` → `private_protocol: 22`、`schema_version: 1`；`herdr api schema --json`；`herdr agent wait --help`；`herdr agent start --help`；`herdr pane split --help`），不引用任何上游仓库或推测。

- **socket 发现**：受管 pane 内通过 `HERDR_SOCKET_PATH` 暴露 socket 路径（本机 `/home/chlo/.config/herdr/herdr.sock`），并伴随 `HERDR_ENV=1`、`HERDR_PANE_ID`、`HERDR_WORKSPACE_ID`、`HERDR_TAB_ID`。
- **`agent wait` 语义**：`herdr agent wait <TARGET> [--until <STATUS>]... [--timeout <MS>]`，STATUS ∈ `idle|working|blocked|done|unknown`；省略 `--until` 时匹配 `idle|done|blocked`；省略 `--timeout` 时无限等待；超时以 exit 1 + `{"error":{"code":"timeout",...}}` 结束，命中条件以 exit 0 + `result.type: "agent_info"` 结束。因此**当前已满足的状态会让 wait 立即返回**，调用方必须显式排除当前状态并设定最小重挂间隔。
- **socket 订阅**：请求统一为 `{id, method, params}`；`events.subscribe` 的 `params.subscriptions` 使用**点号**名字（`pane.exited`、`pane.closed`、`pane.agent_status_changed`、`pane.output_matched`、`pane.scroll_changed` 等）；ACK 形如 `{"id":"...","result":{"type":"subscription_started"}}`；事件流信封形如 `{"event":"...","data":{...}}`（无 id）。
- **无 replay**：schema 中不存在 subscription id、cursor、sequence、resume 或 replay 字段。断线后只能新建连接并重新 `events.subscribe`，缺口必须由调用方自己 reconcile。
- **生命周期事件不在流式 schema 内**：已安装的 `subscription_event` 只定义 `pane.output_matched`、`pane.agent_status_changed`、`pane.scroll_changed` 三种信封；`pane.exited`/`pane.closed` 只是**请求**侧合法订阅名（`event` schema 里另有 `pane_exited`/`pane_closed` 的 `{type,pane_id,workspace_id}` 数据形状，不含退出码）。因此把 `pane.exited`/`pane.closed` 订阅当作**咨询信号**（不是终态判据）使用是当前唯一诚实的做法。
- **启动 argv 模型**：`herdr agent start <NAME> --kind <KIND> --pane <ID> [-- [AGENT_ARG]...]`，`--kind` 的含义是“supported agent kind and **canonical executable**”，`[AGENT_ARG]...` 只能追加在该可执行文件之后；API 侧 `AgentStartParams = {args, kind, name, pane_id, timeout_ms}`。`pane split` 的参数为 `{cwd, direction, env, focus, ratio, right_click, target_pane_id, workspace_id}`，**没有** command/argv 参数。⇒ 一个**替换可执行文件**的 launch prefix（例如 `["direnv","exec","."]`）在不做 shell 拼接、也不写全局/会话级 override 的前提下无法交给 Herdr（0.9.0）。

对 P2/P4 的直接结论：P2 的 wait 步骤可实现（排除当前状态 + 有界 slice + 保留独立低频探针），P2 的 socket 步骤只能作为咨询通道并始终保留 polling 与 reconcile，且不得声称已交付生命周期事件；P4 的 `launchPrefix` 除 trust 前置（P5/#8）之外还另有一层**已核实的 Herdr 能力缺口**，二者必须分开记录。
