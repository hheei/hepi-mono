# Loadout Agent Resource Contract

## 决定

`@hheei/pi-ext-core` 的 Loadout registration contract 从 tool inventory 扩展为 lifecycle-bound resource
inventory。第一个非-tool resource kind 是 `agent`，canonical ID 为 `agent:<name>`。

`pi-subagents` 在 agent profile discovery 后向 core 登记 agent resource；`pi-loadout` 消费该 inventory，
仅在至少一个 item 存在时显示 `𖠌 Agents` group；同一列表使用 `⚒ Tools` 与 `✦ Skills` headings。Loadout 继续独占 Global/Project activation resolution、JSON
delta persistence、scope UI 与 Enter/Esc routing。profile owner 观察 runtime-scoped resolved activation snapshot，
将其与自己的 enabled configuration 相交。

Agents row 的格式为 `● <agent-name>  <thinking glyph> provider/model-name`；`○` 表示 effective disabled。
thinking glyph 是独立 metadata，不能与 activation 混用；model 未指定时显示 `inherit`。实现必须按 visible
cell width 固定 agent-name/model columns，并在窄布局只截断末列。

Loadout resource registration 可以携带 detail-controller factory。Loadout 在同一 shared router surface 内宿主
该 controller；contributor 拥有 field model、validation、profile-file I/O 与 action semantics。这个 capability
只经 core transport，`pi-subagents` 不 import concrete `pi-loadout`。

`/agents` 不再是 profile、schedule 或 extension preference 的 configuration GUI。运行中的 child list、live
transcript、steer 与 stop 是独立 Runtime popup 的未来工作，不属于 Loadout resource detail。

## 后果

- `agent:<name>` 不是 Pi tool，不能传给 `pi.setActiveTools()`。Loadout 必须分别应用 tool activation 与
  publish non-tool resource activation snapshot。
- profile discovery/reload、extension unload 与 session abort 必须更新/释放 exact resource registrations，避免
  stale `Agents` entries。
- core 只拥有 registry、lifecycle 与 capability transport；不得拥有 resource persistence、group rendering、
  profile schema 或 custom detail policy。
- 这是第二个真实 Loadout inventory consumer shape；它授权 resource-level generalization，但不授权 generic
  arbitrary settings framework、runtime dashboard 或 cross-extension state/RPC framework。

## 验证

后续实现至少覆盖：Loadout 缺席时 profile 保持 default activation；agent resource 动态增删；Global/Project
enabled/disabled/inherit precedence；effective activation 与 profile-local disabled 的交集；无 agent 时隐藏
`Agents` group；Enter detail 的 input、save、validation、Esc cleanup；narrow/wide 20-row rendering。Runtime popup
另行设计并验证，不作为本 ADR 的交付内容。
