# Loadout 架构

## 状态

本文记录 Loadout 重构目标与当前 headless engine 阶段。core registration contract、独立
`pi-loadout` policy engine 和 skill capability 按 focused tests、用户确认、行为实现的顺序落地；
Settings UI 仍未实现。当前 aggregate Loadout 仅是迁移参考，不是兼容目标。

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
或 persisted override。当前 `pi-loadout` 阶段无 UI 与 `/loadout` command，只读取新的
`pi-loadout` global/project JSON sections；旧 `pi-basics-loadout` state 不迁移。

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

display group 只影响展示。一个 item 恰好属于一个 display group；group 移动不改变 activation。
conflict set 是独立的命名集合，一个 item 可加入多个 set，任何 set 内至多一个 item active。

priority 是 non-negative rank，较小值更主：它决定 group 内展示顺序，也只在没有 explicit selection
时决定自动 policy 胜者。若同一 conflict set 内有多个 default-active candidate，它们不得有相同
priority；registration 必须 fail-fast，不能依赖 extension load order。

user explicit selection 优先于 priority。选择一个 item 是原子 Activation update：启用目标，并在
同一次更新中停用目标所有 conflict set 的成员。用户选择写入当前 global 或 project scope；project
override 优先于 global。新 `pi-loadout` state 从空开始，不迁移 legacy `pi-basics-loadout` entries。

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
content。factory failure 不关闭 router，保留当前可用 tab，并在用户下次选择失败页时重试。

router 的 `Esc` 关闭 surface。active page 先处理 Left/Right；只有它未消费时，router 才使用
Left/Right 切换 tabs。page view 必须以 boolean 或 `Promise<boolean>` 表示是否消费 input。页面需在
tabs 附近显示 `↔` hint，并遵守 `DESIGN.md` 的 token、稳定尺寸、narrow/wide 验证和单一 focus
规则。

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
