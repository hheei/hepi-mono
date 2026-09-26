# billion-context 调研

调研对象：[ranxianglei/billion-context](https://github.com/ranxianglei/billion-context)（默认分支 `master` @ `3fda5c0`，Merge PR #905）。证据来自 2026-09-17 浅克隆 `/tmp/billion-context`、raw GitHub 文件、npm registry、以及 sibling 仓库 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 的 README。

本笔记区分 **产品声称** 与 **仓库里能直接看到的实现**。生产规模数字只来自作者预印本，未经本仓库独立复现。

## 一句话

`billion-context` 是一个插在 **任意 coding agent 与模型 API 之间** 的上下文压缩代理（CLI 名 `bili`）。它不扩窗口、不做向量库；而是让模型自己把已经用过的对话折成可逆、分层、对前缀缓存友好的摘要块，目标是「一个 100K–200K 窗口撑住超长会话」。

Slogan（GitHub description）：「基本稳定可用 100K tokens is enough. Universal context-compression proxy for ALL AI coding agents,10w上下文足矣」。

## 身份与发布面

| 项 | 值 | 来源 |
|---|---|---|
| npm | `billion-context@0.1.117`，周下载约 26K | [npm](https://www.npmjs.com/package/billion-context)；克隆 `package.json` 同版本 |
| CLI | `bili`（别名 `bili-proxy`） | `package.json` `bin` |
| License | MIT，Copyright 2026 ranxianglei | `LICENSE` |
| Runtime | Node ≥ 20；`acp-kernel` **build-time 精确 pin 并打进 bundle**（`package.json`：`0.0.74`）。发布物零 runtime 依赖 | `package.json`；`AGENTS.md` 有一处过时 pin 见下文漂移 |
| 仓库规模 | ~1507 commits；GitHub 页面约 188★ / 22 forks（当日 HTML） | [repo](https://github.com/ranxianglei/billion-context) |
| 姊妹项目 | [`acp-kernel`](https://github.com/ranxianglei/acp-kernel)（压缩引擎）、[`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)（Pi 进程内扩展）、[`opencode-acp`](https://github.com/ranxianglei/opencode-acp)（OpenCode 1.x 扩展） | README「Which do I need?」 |

`ACP` 在这里是 **Active Context Pruning**，与 Zed Agent Client Protocol、Linux Foundation Agent Communication Protocol **无关**。论文编辑注明确要求保留 kernel 仓库名 `acp-kernel` 仅作历史命名。

## 它解决什么

长 coding session 会把工具输出堆满窗口。主流 harness 的对策是滑动截断或阈值 `/compact`：一次性、不可逆、常打坏前缀缓存。作者主张：

1. **模型已经会判断**该压什么；缺的是可执行、可部署的脚手架。
2. 只压 **已消耗增量**（growth-gated），不重写整段历史。
3. 摘要块本身再进压缩（tier-1 → 2 → 3），结构像「散文上的 LSM tree」。
4. 压缩可 `decompress` / `search_context` 找回，而不是扔掉。

论文标题与核心论题：[*Model-Driven Incremental Hierarchical Compression…*](https://github.com/ranxianglei/billion-context/blob/master/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md)（v0.2，2026-09-07）。中文版在 `paper/模型驱动的分层增量压缩-免训练多代上下文管理.md`。论文与代码同仓 MIT，自称 living document。

**作者在论文里明确不声称：** 模型发起压缩不是他们发明的（MemGPT 等已有）；search/decompress 工具界面也是 prior art；训练侧 compressor 正交可叠加；审计/合规/ verbatim 历史任务超出有损 fold 的支持范围。

## 家族分工（四个公开项目）

论文 §3.1 把系统拆成：

```
acp-kernel          无 host 依赖的压缩内核（processTurn 九段管线）
billion-context     通用代理：三种主流模型 API wire + launcher + MITM
billion-context-pi  Pi 进程内扩展（agent 自己跑 compress）
opencode-acp        OpenCode 1.x 进程内扩展
```

选哪个客户端：

| 客户端 | 推荐路径 |
|---|---|
| pi | 独立包 `billion-context-pi`，或 `bili pi` |
| OpenCode 1.x | `opencode-acp` 或 `bili opencode` |
| OpenCode 2.0+ | **只用** `bili opencode`（内置 V2 plugin；独立 `opencode-acp` 是 V1-only） |
| omp | `bili omp`（内置 thin plugin） |
| 其余（Claude Code / Codex / Cursor / Aider / Hermes / dsh / CodeBuddy / Qoder / Trae / jcode / Kimi …） | `bili <client>` 或把 baseURL 改成 `/bili/<upstream>` |

「零 per-agent adapter」指的是 **纯代理模式**：只要客户端能改 base URL（或走 HTTP CONNECT MITM），不必为每个 agent 写压缩逻辑。Launcher / plugin 路径则是为了更好的 session 身份、原生工具 UI、以及避免 wire 层伪造 tool call。

## 架构：代理干什么、kernel 干什么

### 数据流

```
Agent ──baseURL/MITM──► billion-context proxy
                           1. 解析 Anthropic / OpenAI chat / Responses
                           2. acp-kernel.processTurn（打 ref、折块、nudge）
                           3. 注入 compress 工具 + 压缩哲学（proxy 模式）
                           4. 转发真实上游
                           5. 改写 SSE；若模型调了 proxy 工具则服务端执行并可能再请求
                        ▼
                   真实模型 API
```

来源：README「How it works」；实现落在 `src/server.ts`（~242KB，请求管线）、`src/loop/`（统一 compress loop）、`src/preflight.ts`（窗口溢出时的硬压缩）。

### Kernel 每轮九段管线

`acp-kernel` README 与论文 §3.1 一致：

`assign-refs` → `sync-blocks` → `merge-blocks` → `prune` → `filter` → `hide-compress-calls` → `nudge-inject` → `emergency-truncate` → `render-refs`

原则：**模型写摘要；库编排其余一切**。kernel 从不自己调模型。`applyCompression` 吃的是模型产出的 `{startRef, endRef, summary}`。

消息被打上稳定 `mNNNNN` ref（`<acp tokens="…" type="text">m00001</acp>`）。`AGENTS.md` 强调：**同一 session 内 raw content-hash id 与 ref 永不复用**，否则 decompress 会指错对象。

### 两种压缩模式（summary 载体不同）

这是 README 花最多篇幅讲的不变量，也是 issue #377（SGLang 单 system message）的根因：

| | **Plugin / launcher 模式** | **纯 Proxy 模式** |
|---|---|---|
| 谁执行 `compress` | Agent 本地（pi/omp 扩展或 MCP shim） | Proxy 服务端 loop |
| 工具从哪来 | 原生注册；proxy **不再** wire 注入 | Proxy 注入 4 个 ACP 工具 |
| 摘要在线上的载体 | `compress` tool call + result（进 agent 自己的历史） | kernel 的 `acp_summary`，再被 `systemToUser`（`src/util.ts`）改成 **user** 消息 |
| 为何不用 mid-stream system | SGLang 要求恰好 1 条 system 且在 index 0；插一条会 400，并打坏 prefix cache | 同上 |
| Preflight | 仍作为硬窗口兜底（#470） | 主要的强制压缩路径 |
| 模式判定 | 请求头 `x-bili-plugin`；粘在 `session.metadata.pluginAgent` | 无该头 |

同一 proxy 实例可同时服务两种客户端；**同一 session 模式粘滞**，只允许 plain→plugin 升级且实际上几乎不会发生（conversation id 对不上）。

协议文档：[PLUGIN.md](https://github.com/ranxianglei/billion-context/blob/master/PLUGIN.md)。核心端点：

- `GET /__bili/plugin/manifest` — 工具 schema 的单一真相源
- `POST /__bili/plugin/tool` — 在 session lock 下执行 compress/decompress/search/status
- `GET /__bili/plugin/status`
- `POST /__bili/plugin/compact` — 通知宿主做了原生 `/compact`，下一轮归档不再锚到缩短历史里的块

Thin plugin 实现：`src/agent/pi.ts`（pi + omp 共用 ExtensionFactory）、`src/agent/opencode.ts`、`src/mcp.ts`（stdio MCP，给 Claude Code / Codex launcher 注入）。

## 工具面

默认四个（kernel 导出，proxy 再包一层）：

| 工具 | 作用 |
|---|---|
| `compress` | 模型给出 `startId`/`endId` + summary（可多段）；proxy/agent 调用 kernel `applyCompression` |
| `decompress` | **无状态取回**：把块的缓存原文（或 `collectBlockContent`）贴进 tool result；块仍 active，转发视图继续 fold。正文 >10k 字符则写临时文件（decompress-to-file）。原生 `/compact` 归档块直接 FAILED |
| `search_context` | 在 block 摘要 + 近期消息上关键词检索；bili 额外加了 `conversation_id`（#841/#760，给共享 MCP shim 路由） |
| `acp_status` | 块数、用量、可压缩区间、盲隧道警告 |

可选第五个 **`absorb`**（`compress.absorb.enabled: true`，#605）：大工具结果一到就强制蒸馏，原 tool pair 从下一轮 wire 上藏掉。实现：`src/absorb.ts`，kernel 的 `ACP_TOOL_NAMES` **故意不含** absorb，host 必须 opt-in 注册。

文本协议备胎：`compressProtocol: "marker"`，用 `<acp_compress>…</acp_compress>` 触发（上游不能共存 `tools` 字段时）。源码里这些 XML 必须写成 hex escape，避免 agent 的 Write/Edit 工具把标签剥掉（`AGENTS.md`）。

**不要相信 transcript 里的 `📦 [ACP] Compressed …`。** #717：模型在压力下会**自己写出**这个确认格式（观测到约 2 小时 17 次假压缩，真实用量爬到 89%）。代理会剥掉自发 marker 并打 `[marker-echo]`。真伪用 `acp_status`（块数 +1、可压缩起点前移）。

## 触发与保护

论文 §3.4 / kernel nudge：

- 用量过地板（默认约窗口的 45%）**并且**
- 自上次压缩以来增长超过门槛（默认叙事：50K，有效地板约 22.5K = 0.45×50K）
- tier-1 块堆多了会 nudge 做 tier-2/3 蒸馏
- 压缩成功会重置 growth baseline，避免刚压完立刻再 nudge

硬保护：compress 工具调用自身（摘要载体）。软保护：recent zone、最后一条 user、第一条 user（任务意图）。overflow 时 preflight 会把软保护松到 0（#330），硬保护仍在。

Preflight（`src/preflight.ts`）：当上一轮 input 已经超过当前模型窗口（例如从 1M 切到 260k）时，nudge 永远看不到——请求会被上游拒。于是 proxy **在转发前**自己打最多 16 轮、每轮最多 16 次摘要调用，把最老的可压区间折进去。这是「模型驱动」的例外：紧急情况下引擎代劳。

统一 compress loop（`src/loop/core.ts`，`UNIFIED_LOOP_SPEC.md`）：

- 最多 `MAX_LOOP_ROUNDS = 10`
- proxy 工具在服务端执行，marker 发给客户端，然后 **再请求** 上游把结果喂回模型
- 哲学 prompt **每轮临时**塞进 system，不进 message 历史（避免「炸锅」：哲学 + 工具记录跨 round 累积，模型循环 `acp_status`）
- 触顶时 graceful completion，不再发 degenerate 空 completion

## 接入方式

### 1. Launcher（优先）

`bili pi|codex|claude|omp|opencode|hermes|dsh|codebuddy|qoder|trae|jcode|kimi`

`src/launcher.ts` `LAUNCH_CLIENTS` 与 CLI help 一致。行为要点：

- 每次 launch **新端口**，不复用旧 proxy（后来 #707 又修了启动窗口双 spawn）。
- **尽量不改真实 home**：env / CLI / 扩展 API 优先；生成文件只留给 opencode 临时 `opencode.json` 和 dsh 回环 overlay（#535）。
- HTTPS 走证书 MITM（自签根 CA，`src/ca.ts` / `src/mitm.ts`）；HTTP 或不能 MITM 的走 `/bili/` 改写。
- 只 TLS 终结从客户端配置 **读出来的** 模型域名，其余 CONNECT 盲透传。
- 常把宿主自带 auto-compact 预算对齐或关掉，避免和 bili 双重压缩（OpenCode V2：`compaction.auto: false`；Claude/CodeBuddy/Qoder 有 window env）。

### 2. 纯 URL 前缀

```
原 baseURL:  https://api.openai.com/v1
改成:        http://localhost:8787/bili/https://api.openai.com/v1
```

上游嵌在 path 里，proxy 无需再配。默认听 `127.0.0.1:8787`。

### 3. 只有 `http.proxy`、没有 baseURL 的 IDE

Cursor / Windsurf / 部分 VS Code Copilot：发的是 `CONNECT host:443`。域名不在 MITM 白名单 → **永远看不到、永远不压缩**（#897）。现在会打 `BLIND TUNNEL WARNING`，`/__bili/health` 带 `blindTunnels`。修复：加 `mitm.domains` 并让客户端信任 bili 根 CA。

安全边界（README `--host`）：

- 默认只 loopback。
- `--host 0.0.0.0` **没有鉴权**。
- `/__bili/` 管理面仍仅本机。
- `/bili/` 隧道拒绝 link-local/metadata；远程客户端默认不能打进内网（#409，`BILI_TUNNEL_ALLOWED_HOSTS` 例外）。
- 盲隧道对任意主机仍仅 loopback，避免开放中继。

## Session、持久化、窗口

**实现（以源码为准，README「How sessions work」已过时）：**

`src/session-id.ts` 的注释写得很硬：压缩状态的 session id 就是客户端给的 conversation 值 **verbatim**——不 hash、不掺协议/origin/API key。那些维度会在会话中途变（OAuth 轮换、换中继、跨协议），用它们分区会把状态孤儿化（#280/#286）。id 只在 proxy 内部用，**从不**发给上游。

客户端信号优先级（header 路径，`clientConversationHeader`）：

1. `x-bili-plugin-conversation`（**仅当**同时有 `x-bili-plugin`，防 LAN 伪造）
2. `x-claude-code-session-id`
3. `x-session-affinity` / `x-acp-session` / `x-session-id` / `x-opencode-session` / `session-id` / `session_id`
4. 另有 body：`session_id`、`metadata.session_id`、`previous_response_id`、`prompt_cache_key`（后者只替换 content-fingerprint，不能压过显式 header）

Codex ≥0.147 的 `x-codex-turn-metadata`：subagent / guardian 等非 `"user"` 线程 **复用** 根 `session-id`，所以改按 `thread-id` 分区（#150/#316），避免 guardian 读到压缩摘要。

没有客户端 id 时：

- 旧政策（#286，README 仍在讲）：hash 首条 user → 碰撞；或直接 400。
- 现政策（#309，`src/prefix-affinity.ts`）：对「每轮重放全历史」的无状态客户端，把 message list 做成 append-only chain hash，匹配 **最长严格前缀**。两个会话共享开头时只短暂合并，分叉后自愈。协议/凭据**故意不**参与分区。链过短（`< 24` 字节）仍 400。跟踪上限 256 条、TTL 7 天；快照落盘以免重启后 458K 历史被当新会话原样转发（#351/#499）。

内存池默认 `BILI_MAX_SESSIONS=256`，LRU 淘汰（in-flight 不赶）。磁盘：`~/.local/share/billion-context/sessions/`（kernel `StateStore`）。持久化内容：压缩状态、`blockContents`（`bili export --full` 用）、最近 `BILI_PERSIST_TAIL_TOKENS`（默认 16k）的 folded view——**不**把完整 raw 历史再存一份（#401）。可选 `BILI_ENCRYPTION_KEY` → AES-256-GCM + zstd（#708）。

上下文窗口解析顺序（CONFIGURATION.md）：请求侧（anthropic-beta / plugin 上报 / launcher）→ 配置里 `models.<name>.context` → **warm** models.dev 缓存（`src/registry.ts` + 打进包的 `registry-snapshot.json`）→ 内置表。`/models` 端点经验上不返回 window，所以必须这套。

## 配置与运维

- 配置：`~/.config/billion-context/billion-context.json`（XDG），全字段 optional。
- 日志：`~/.local/state/billion-context/bili.log`，10MB 轮转。
- 压缩调参三层 merge：global → provider → model（#124）。
- 出站可再套一层 HTTP 代理（GFW）；SOCKS5 未支持。MITM 查找键用 `mitm://host`，`/bili/` 用真实 `https://`，同一域名两套路由。
- `compat.roles`：把 `developer` 等改成上游能吃的 role；未配置时 400 Invalid role 会 session 级自学一次。
- 启动及每 3 分钟 npm 自更新（`npm install -g`）；装完需重启才生效。可用 `autoUpdate: false` / `ACP_AUTO_UPDATE=0`。
- `bili --passthrough`：完全不压缩，对照基线。
- Web UI：听口上的引导页（`src/web/`）。

完整字段：克隆里的 `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md`（很长，~70KB）。

## 论文里的生产数字（声称，[V] 标记）

口径：单专家用户、三宿主（OpenCode + Pi + ework 常驻服务），观察窗约 2026-04-23 → 2026-09-07。

| 指标 | 数字 |
|---|---|
| 主宿主（OpenCode）调用 | 174,327 |
| 累计 input | 18.76B（1.75B fresh + 17.01B cache read） |
| 三宿主合计 | ~24.7B |
| 204,800 窗口（GLM-5.1） | 42,986 次调用，**零窗口违规**，峰值 198,628 |
| 最长会话 | OpenCode 12,049 calls / 1.52B tokens；Pi 8,584 calls / 1.01B |
| 单次压缩输出 | median 185 tokens，97.5% ≤ 2K |
| 站立宏观折比 | 重载会话 ~70×（摘要占 204k 窗口个位数百分比） |
| cache read : fresh | ≈ 9.7 : 1 |

外推「1M 窗口 → ~28.6B tokens / 106 天」标了 **[A] simulation**，约为已观测最长会话的 19×，不是测量值。

受控实验（论文 §8，摘要层）：「只留 doctrine + 标签、完全不执行压缩」的静默对照几乎复现了全部 re-fetch 下降——作者据此说 **判断文本本身贡献了大部分行为**；模型很少自发用 recover 工具，要显式指令。

## 成熟度与文档漂移

README「Status」仍写 **Early** + mock 测试 500+ +「真实模型集成是下一里程碑」。对照源码：

- 克隆 `tests/` 远超 `AGENTS.md` 模块图里的「66 test files」（子代理清点约 199 个文件）。
- CHANGELOG 大量真实上游修复（SGLang #377、DeepSeek #684、GLM 3007 #189、Codex ChatGPT-login #663）。
- 另有 gated e2e：`tests/e2e/e2e-codex.test.ts`（`ACP_TEST_E2E=1`，默认 skip）。

所以更准确的说法是：**单元/协议测试很密，live 集成有，但是可选/人工；README 的 Early 段落没跟上。**

核对过的 **文档 vs 代码** 漂移（master `3fda5c0`）：

| 文档说 | 代码实际 |
|---|---|
| README：session = 协议 × origin × key × 会话；pi 无 id 时 hash 首条 user | `session-id.ts`：verbatim 客户端 id；匿名走 `prefix-affinity.ts` 前缀链（#309），不再用首条 user 当永久锚 |
| 论文 §3.2：decompress 重新激活源、deactivate 该块 | `decompress-shared.ts`：**STATELESS RETRIEVAL**，块保持 active，只把原文贴进 tool result / 临时文件 |
| `AGENTS.md`：「master pins 0.0.56」 | `package.json`：`acp-kernel` **0.0.74**（AGENTS 那句是历史残留，紧挨着「0.0.48/0.0.49 曾回收 ref slot」的注释） |
| README/AGENTS 测试数量 | 以 `tests/` 目录为准，不要信 500+/66 files |

反复出现的工程主题（CHANGELOG / issue 号）：

- 模型模仿 ACP 标签或确认 marker（#717/#870/#872）
- thinking/reasoning 与 tool_call 拆对导致 DeepSeek 400（#133/#684）
- Codex ChatGPT-login 对 `max_output_tokens` / stream / 专用 header 的挑剔（#626/#663）
- Windows Defender 锁 session 目录 EPERM（#362）；cmd.exe 空格路径 / MCP TOML 引号（#679/#681）
- 前缀缓存 vs 一次折太大触发风控（GLM 3007，#189 staged shrink）
- OpenCode 2.x plugin API 相邻 dev build 形状不同，V2 plugin 必须 defensive，失败则静默退回纯 proxy（#754）

## 主要源文件地图（克隆 `src/`）

| 路径 | 职责 |
|---|---|
| `cli.ts` / `index.ts` | `bili` 分发 |
| `server.ts` | HTTP 代理主循环 |
| `loop/core.ts` + `adapter-*` | 统一 compress 再请求 loop |
| `preflight.ts` | 硬窗口溢出压缩 |
| `plugin.ts` / `plugin-install.ts` / `mcp.ts` | 合作协议 + MCP shim |
| `launcher.ts` / `client-config.ts` / `mitm.ts` / `ca.ts` | 启动器与证书 |
| `session.ts` / `session-id.ts` / `prefix-affinity.ts` / `persist.ts` | 会话身份、匿名前缀亲和、落盘 |
| `agent/{pi,omp,opencode}.ts` | 打进 dist 的 thin plugin |
| `web/` | 本地配置 UI |
| `compress-tool.ts` | kernel 工具 re-export + bili 扩展（conversation_id、marker integrity） |

## 来源

- README：[en](https://raw.githubusercontent.com/ranxianglei/billion-context/master/README.md) / [zh](https://raw.githubusercontent.com/ranxianglei/billion-context/master/README.zh-CN.md)
- 论文：仓库 `paper/*.md` v0.2（2026-09-07）
- PLUGIN.md、UNIFIED_LOOP_SPEC.md、CONFIGURATION.md、AGENTS.md、CHANGELOG.md、LICENSE
- 实现：`/tmp/billion-context/src/**`（浅克隆 master `3fda5c0` / PR #905，与 `package.json` 0.1.117 对齐）
- Kernel：[acp-kernel README](https://raw.githubusercontent.com/ranxianglei/acp-kernel/master/README.md)
- 发布：[npm billion-context](https://www.npmjs.com/package/billion-context)
