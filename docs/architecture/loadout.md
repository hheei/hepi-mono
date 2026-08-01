# Loadout 架构

## 状态

本文记录 Loadout 重构目标与已落地的 engine/page。core registration contract、独立
`pi-loadout` policy engine、skill capability 与 Settings router page 按 focused tests、用户确认、行为实现的顺序落地；
当前 aggregate Loadout 仅是迁移参考，不是兼容目标。

## 目标与包边界

Loadout 只管理主动登记的 tool。`@hheei/pi-ext-core` 公开跨 extension 的 Loadout registration
contract；`pi-loadout` 拥有 tool inventory、activation policy、持久化与 Loadout tab 内容；
`pi-settings` 是唯一 Settings host，拥有 `/ext-settings [page-id]` command 并打开 core 的 global
Extension page router。

三个 package 不互相 import concrete extension：tool contributor 只依赖 core，`pi-loadout` 从 core
registry 消费 registration，`pi-settings` 从 core router 打开页面。core 始终直接向 Pi 注册 managed
executable tool，消除 extension load order 依赖。

`pi-loadout` 是 managed-tool contributor 的推荐 companion extension，但不是硬依赖。缺少它时，
core 仍注册 executable tool，保留 Pi 默认 activation；不应用 Loadout inventory、conflict、priority
或 persisted override。`pi-loadout` 不提供 standalone UI 或 `/loadout` command；安装 `pi-settings` 时它注册
Loadout router page，只读取新的
`pi-loadout` global/project JSON sections；旧 `pi-basics-loadout` state 与早期 `tools` / `skills`
boolean map schema 不迁移。

## Tool Registration

core 提供两种独立 registration mode：

| Mode | 用途 | Pi executable tool | Inventory item |
| --- | --- | --- | --- |
| Inventory registration | 管理已存在的 native 或 third-party tool | 不创建 | 创建一个 lifecycle-bound item |
| Managed tool registration | HEPI-owned non-native executable tool | core 在 extension initialization 创建 | 自动创建同 ID item |

每个 Tool inventory item 都有稳定 tool ID、单一 display group、小数值优先的 priority、零或多个
conflict set 与 default activation。两个 mode 使用同一 metadata；managed mode 仅额外带 Pi tool
definition 和 handler。

同一 runtime 中，一个 tool ID 只能由一个 owner 登记。inventory/managed 混用、不同 owner 抢占或
同一 Pi runner 内重复 registration 都立即报错；同一 managed owner 在完整 `/reload` 产生新 runner
时可以替换自己的旧 registration。managed tool 只能在 extension initialization 登记，不能在 session
内动态新增或单独移除；变更需要完整 `/reload`。所有 HEPI-owned non-native tool 必须使用 managed
mode，feature package 不得直接调用 Pi tool registration API。

`pi-loadout` 自动观察 Pi native 与 third-party tools；managed/native 是明确 inventory，未提供
metadata 的 observed tool 以 session start 的 Pi active list 作为默认状态。同名 source 合并为
一个 name-level item，Pi 仍决定实际 handler。

## Activation Policy

Loadout 在 session start 观察 Pi tools。每次更新时，它只计算 inventory items 的 effective state，
再一次性写入 Pi active-tool list；无法安全识别的第三方 tool 保留在 Pi baseline，不被关闭。

配置不是 project-wins object merge，而是两个独立的 JSON delta layer。每层仅有
`disabled: string[]` 与 `enabled: string[]`；key 为 canonical `tool:<name>` 或
`skill:<bare-name>`。一个 resource 的 policy source 固定为
`project disabled > project enabled > global disabled > global enabled > discovered default`。
同层双写时 disabled 胜 enabled，写入 API 对被修改 key 清除另一侧条目。合法未发现 key 保留但
暂时不参与 runtime；未知 schema field、无效 key 与早期 boolean-map schema fail-fast。每层 array
最多 4096 个 key，单个 key 最多 256 字符，避免 project settings 输入无限放大 session-start 资源。

global-visible resource 在 global 是 enabled/disabled 二态：选择等于 discovered default 时删除
global delta。它在 project 是 enabled/disabled/inherit 三态；inherit 删除 project delta 并回退
global effective state。project-private resource 不存在 global row，project 也没有 inherit；它选择
discovered default 时删除 project delta。

display group 只影响展示。一个 item 恰好属于一个 display group；group 移动不改变 activation。
conflict set 是独立的命名集合，一个 item 可加入多个 set，任何 set 内至多一个 item active。

priority 是 non-negative rank，较小值更主：它决定 group 内展示顺序，也只在没有 explicit selection
时决定自动 policy 胜者。若同一 conflict set 内有多个 default-active candidate，它们不得有相同
priority；registration 必须 fail-fast，不能依赖 extension load order。

conflict set 内多个 enabled item 的 winner 先按 delta source rank，再按 priority 和 name。resolver
只锁定较低 item，不自动改写其 raw delta；Settings UI 禁止直接交换 locked item。用户先把 winner
设为 inherit，或让 global winner 回到 discovered default，才可操作其它 conflict member。新
`pi-loadout` state 从空开始，不迁移 legacy entries。

skill enable/disable 由 `pi-loadout` 自己管理；core 只提供 runtime-scoped disabled-skill capability
供 Loadout 发布、dollar-skill 读取。不得为 skills 预建 generic resource registration API。

MCP placeholder 不属于新 Loadout inventory。旧实现没有 MCP discovery 或 runtime activation，
因此不迁移其无效状态。

## Extension Page Router

core 提供一个 global Extension page router。它维护 dynamic page registry，并负责 tabs、theme、
layout、focus、key routing、render host 和 page lifecycle；page contributor 只提供 page metadata、
controller 和 visible content。router 不拥有 page data、actions、persistence 或 feature policy。

`pi-settings` 是唯一 router host，注册 `/ext-settings [page-id]`。host 每次打开时传入 initial page
ID；core 不持久化 selected tab，找不到 requested page 时选择稳定 fallback。`pi-loadout` 只贡献
Loadout Settings tab，不注册 `/loadout` 或竞争的 Settings command。

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
离开 Loadout tab 或 close 时也 flush 当前 scope。flush failure 丢弃该 draft、允许正常离开并由 Pi warning
报告；success 不 hot-apply，Settings host 只在整个 surface close 后聚合一次 reload info。页面在 shared tab strip
下声明至少 20 行 content height，且只提示自身 `Ctrl+P`/toggle/close 操作；router tab strip 本身提供 active-page
signal。页面遵守 `DESIGN.md` 的 token、稳定尺寸、narrow/wide 验证和单一 focus 规则。

## 开发要求

- 新 HEPI-owned non-native tool 必须在 extension composition root 通过 managed registration 登记，
  并在 package README 标明推荐安装 `pi-loadout`。
- inventory-only registration 只用于已存在 tool；生命周期 cleanup 必须移除其 exact registration。
- contributor 在代码注释中写明 tool 的 ownership、default activation、priority、conflict set 和
  handler cancellation；高频 handler 另记录 allocation、dispatch 与 reference cost。
- page contributor 在代码注释中写明 page view 的 I/O、cleanup、key consumption 和 retry behavior。
- 每项后续行为实现都有 focused tests：duplicate registration、absent Loadout fallback、baseline
  preservation、conflict atomicity、scope persistence、dynamic tab add/remove、lazy factory、retry、
  key routing 和 close cleanup。

详细术语见根目录 [CONTEXT.md](../../CONTEXT.md)。不可逆边界的原因见
[ADR 0001](../adr/0001-core-extension-page-shell.md)、
[ADR 0002](../adr/0002-core-loadout-contract.md) 与
[ADR 0003](../adr/0003-independent-settings-host.md)。
