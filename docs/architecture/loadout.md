# Loadout 架构

## 状态

本文记录 Loadout 重构目标与已落地的 engine/page。core registration contract、独立
`pi-settings` Loadout policy engine、skill capability 与 Settings router page 按 focused tests、用户确认、
行为实现的顺序落地。

Loadout 的服务对象是 **agent profile、skill 与（后续的）MCP**。tool 不属于 Loadout 管理面：tool 的
active 集合归各 tool owner，core 只提供注册传输。`tool:<name>` 历史配置键被保留为可读但无效的 legacy 输入。

## 目标与包边界

Loadout 管理主动登记的 **resource**：skill（由 `pi-settings` 从 Pi command 中发现）与 concrete
extension 声明的 agent profile。`@hheei/pi-ext-core` 公开跨 extension 的 resource registration contract 与
managed tool 注册传输；`pi-settings` 拥有 resource inventory、activation policy、持久化、Loadout tab 与
`/ext-settings [page-id]` command，并打开 core 的 global Extension page router。

concrete extension 不互相 import：tool contributor 只依赖 core，agent contributor 只依赖 core，`pi-settings`
从 core registry 消费 registration 并从 core router 打开页面。core 始终直接向 Pi 注册 managed executable
tool，消除 extension load order 依赖。

`pi-settings` 是 managed tool/resource contributor 的推荐 companion package，但不是硬依赖。缺少它时，
core 仍注册 executable tool 并保留 Pi 默认 activation；不应用 Loadout delta 或 persisted override。
agent profile 则保留其 contributor 声明的 default activation。`pi-settings` 不提供第二份 renderer；
`/ext-settings loadout` 只以 Loadout 为 initial page 打开 shared router。global/project extension JSON
使用顶层 `loadout` key；格式错误或旧 boolean map schema 直接拒绝，不做兼容迁移。

## Managed Tool Registration（不属于 Loadout 政策）

tool 的 Pi 注册由 core 传输，但**不由 Loadout 决定 activation**：

| API | 用途 |
| --- | --- |
| `registerManagedTool(pi, { id, owner }, tool)` | 在 extension initialization 注册 HEPI-owned non-native tool；稳定 owner 让同一 package 在完整 `/reload` 产生新 runner 时替换旧 registration |
| `setManagedToolsActive(context, registrations, active)` | owner 自己开关一组 runtime capability bundle（例如 pi-ext-tools 的 edit/apply_patch/eval catalog）；active 路径把 ids 加进 Pi active 集合，并注册 lifecycle cleanup 在退出时移除 |
| `isManagedTool(pi, id)` | 查询某个 Pi tool 是否经 core 注册 |

同一 runtime 中一个 tool ID 只能由一个 owner 登记；不同 owner 抢占或同一 Pi runner 内重复注册立即报错。
managed tool 只能在 extension initialization 登记，不能在 session 内动态新增；所有 HEPI-owned non-native
tool 必须使用 managed mode，feature package 不得直接调用 Pi tool registration API。

registration 不携带 policy metadata：没有 `defaultActive`、`priority`、`conflict set` 或 display group。
谁会 active 由且仅由 tool owner 决定（`setManagedToolsActive`、`pi.setActiveTools` 或 Host 的默认
activation）。Host 在 session start 会激活全部 extension tool，因此 owner 若需要“默认不激活”，必须在
`session_start` 显式 `setManagedToolsActive(..., false)`。

## Activation Policy

Loadout 在 session start 读取两个 JSON delta layer，并只对 skill 与 agent profile 求 resolved state：

- **skill**：`pi-settings` 把 resolved disabled 集合发布到 core 的 runtime-scoped disabled-skill capability；
  Pi 的 `before_agent_start` 系统提示按该集合过滤 skill entry。
- **agent profile**：`agent:<name>` 的 resolved state 由 Loadout 计算；profile owner 在接入时把自己的
  profile settings enabled state 与该 state 相交。core 不读取 profile 文件，也不解释 agent policy。

配置不是 project-wins object merge，而是两个独立的 JSON delta layer。每层仅有
`disabled: string[]` 与 `enabled: string[]`；key 为 canonical `skill:<bare-name>` 或 `agent:<name>`。
一个 resource 的 policy source 固定为
`project disabled > project enabled > global disabled > global enabled > discovered default`。
同层双写时 disabled 胜 enabled，写入 API 对被修改 key 清除另一侧条目。每层 array 最多 4096 个 key，
单个 key 最多 256 字符，避免 project settings 输入无限放大 session-start 资源。

global-visible resource 在 global 是 enabled/disabled 二态：选择等于 discovered default 时删除
global delta。它在 project 是 enabled/disabled/inherit 三态；inherit 删除 project delta 并回退
global effective state。project-private resource 不存在 global row，project 也没有 inherit；它选择
discovered default 时删除 project delta。

`tool:<name>` 是 **legacy key**：读取路径继续接受它（否则已有 settings 文件会让 Loadout 加载失败），但
它不参与任何 resolution，也不改变 Pi 的 active tool 集合；写入路径（UI selection、`assertCanonicalLoadoutKey`）
拒绝新写入 `tool:` key。合法但未发现的 key 保留但暂时不参与 runtime；未知 schema field、无效 key 与早期
boolean-map schema fail-fast。

`flush` 成功后页面调用 engine 的 `reload()`，重新读取磁盘 delta 并重新发布 skill state，因此用户在
Loadout 页面里的改动即时生效。engine 在 session 结束时清理发布的 skill state，并且**从不调用
`pi.setActiveTools`**。

MCP placeholder 不属于当前 Loadout inventory；没有经过 discovery 与 runtime activation 的资源不得登记为可切换项。

## Agent Profile Resource 与详情页

Agent contributor 为每个已发现 profile 登记 `agent:<name>` resource。没有任何 agent resource 时，Loadout
不显示 agent 分组；profile discovery/reload 必须原子更新 registration，卸载 extension 或 session abort
必须释放它们。

Loadout list 的 group heading 固定为：

```text
✦ Skills
𖠌 Agents
```

`Agents` 仅在有 agent resource 时出现。glyph 只是分组标签，不能承担 activation 或 selection 的唯一语义；
state 仍使用文字与 `●` / `○`。实现必须以 Pi TUI 的 cell-width 工具计算、截断 heading，保证窄终端不破坏
`DESIGN.md` 要求的稳定行宽。

`𖠌 Agents` 内每行固定为 activation、agent name 与 effective model metadata 三列：

```text
● Explore        ◔ cx/gpt-5.6-luna
○ Plan           ○ anthropic/claude-haiku-4-5
```

首 glyph 是 resolved activation：`●` 为 enabled，`○` 为 disabled，`◌` 为 inherit。第二列是 contributor 提供的
summary（例如 thinking level 与 resolved model）：thinking off/minimal=`○`、low=`◔`、medium=`◑`、
high=`◕`、xhigh/max=`●`；未知值显示 `?`。未指定 model 时显示 `inherit`，不得猜测 provider。agent-name 与
metadata column 按完整 filtered Agents list 的 visible width 固定计算；窄布局必须优先 ANSI/cell-width-safe
truncate metadata，不能挤压 activation 或 name column。

Loadout 的 `Enter` 可以进入 resource contributor 提供的 detail controller，并仍留在同一 shared router
surface。Loadout 拥有 tab、焦点、scope、Enter/Esc 路由、component mounting 与 cleanup；contributor 拥有
detail fields、runtime validation、配置读写与描述。该 detail capability 由 core 注册表传输，禁止 agent
contributor import concrete `pi-settings`。

Agent contributor 拥有 profile 的 model、thinking、tools、memory、isolation、turn budget 与 profile-file
mutation。运行中的 child record、live transcript、steer 和 stop 不属于配置；它们应由独立 Runtime surface
实现，而不塞入 Loadout settings page。

## Extension Page Router

core 提供一个 global Extension page router。它维护 dynamic page registry，并负责 tabs、theme、
layout、focus、key routing、render host 和 page lifecycle；page contributor 只提供 page metadata、
controller 和 visible content。router 不拥有 page data、actions、persistence 或 feature policy。

`pi-settings` 只注册 `/ext-settings [page-id]`，可选 page ID 决定 initial page（`/ext-settings loadout`
即选中 Loadout）。command 调用同一 router；没有第二份 command 或第二套 entry。core 不持久化 selected tab，找不到 requested page 时选择稳定 fallback。
`pi-settings` 不复制 Settings renderer 或创建第二个 surface host。

page registration 是 lifecycle-bound：tab 可在 router 已打开时动态加入或移除。移除 active tab 时，
router 原子选择下一个 tab；没有剩余 tab 时关闭 router。page ID 在 runtime 内唯一，重复 registration
立即报错。tabs 按较小 non-negative order 排序，再以 page ID 字典序打破 tie。

page view 在首次选择 tab 时 lazy 创建，router open 期间缓存；router close 或 registration 移除时
清理。factory 接收 active Pi theme；theme 改变时，router 通知 cached view 重建其 theme-dependent
content。factory failure 不关闭 router，保留当前可用 tab，并在用户下次选择失败页时重试。page 可在完成
自己的异步 flush 后请求 router close，router 不解释 page save policy。

router 的 `Esc` 关闭 surface。active page 先处理 Left/Right；只有它未消费时，router 才使用
Left/Right 切换 tabs。page view 必须以 boolean 或 `Promise<boolean>` 表示是否消费 input。Loadout page
消费 `Ctrl+P`、Space 与其 dirty-state 的 page-leave key：Space 只在 resource/scope 的可达选择集合中循环，
不为 global 或 project-private resource 伪造 inherit；`Ctrl+P` 先 flush 当前 JSON root 再切 scope；
离开 Loadout tab 或 close 时也 flush 当前 scope。flush 成功后页面调用 engine 的 `reload()` 让改动立即生效；
flush failure 丢弃该 draft、允许正常离开并由 Pi warning 报告。页面在 shared tab strip
下声明至少 20 行 content height，且只提示自身 `Ctrl+P`/toggle/close 操作；router tab strip 本身提供 active-page
signal。页面遵守 `DESIGN.md` 的 token、稳定尺寸、narrow/wide 验证和单一 focus 规则。

## 开发要求

- 新 HEPI-owned non-native tool 必须在 extension composition root 通过 `registerManagedTool` 登记，并在
  package README 标明推荐安装 `pi-settings`。
- tool owner 自己负责 activation：需要“默认不激活”时在 `session_start` 显式关闭；不要假设 Loadout 会替
  自己决定 active 集合。
- contributor 在代码注释中写明 tool 的 ownership 与 handler cancellation；高频 handler 另记录 allocation、
  dispatch 与 reference cost。
- agent contributor 在注册 resource 时声明 `defaultActive`、project-private 与可选 detail；detail 的 I/O、
  cleanup、key consumption 与 retry behavior 也写在代码注释里。
- 每项后续行为实现都有 focused tests：duplicate registration、absent Loadout fallback、baseline
  preservation、scope persistence、dynamic tab add/remove、lazy factory、retry、key routing 和 close cleanup。

The irreversible boundary is the current contract above: ext-core owns registration and routing
mechanisms, while `pi-settings` owns activation policy, persistence, and page content.
