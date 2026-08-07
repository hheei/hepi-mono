# Settings

## 用户意图

`pi-settings` 是 `/ext-settings [page-id]` 宿主。它让安装的 HEPI extension 在同一 Pi custom
surface 中提供设置页面；它不拥有任何具体 extension 的 schema、业务状态或运行时 policy。`pi-loadout`
额外提供 `/loadout` 直接入口，打开同一 router 并初始选中 Loadout。

第一份页面是 `pi-loadout` 提供的 `Loadout`。它编辑工具与技能的 activation delta，但不会在当前
session hot-apply；用户在关闭 Settings 后自行 `/reload`。

## 包与宿主边界

- `pi-settings` 打开 core Extension page router、拥有 `/ext-settings`、surface 生命周期和退出通知；
- `pi-loadout` 的 `/loadout` 也打开该 router，但只决定 initial page，绝不复制 Settings/Loadout renderer；
- `pi-loadout` 注册 Loadout page，拥有 inventory projection、scope draft、conflict explanation 与 JSON
  delta writer；
- `pi-ext-core` 只拥有 router tabs、page close coordination、page minimum height，以及 core-managed editor
  widget 的注册和 suspension；
- concrete extension 不互相 import。page 通过 core runtime registry 动态加入 router。

任一 Settings router surface 打开期间，command host 获取 core widget suspension lease。core 卸载所有已注册的
above-editor/below-editor HEPI widget；surface close、abort、reload 与 session shutdown 都释放 lease，最后
一个 lease 释放后才恢复仍有效的 widget。Pi 没有枚举或恢复其它 extension 直接 `setWidget()` 内容的公开
API，所以这个保证只覆盖 core-managed widget。

## Loadout 页面

Loadout 是单页 selector，不是二级 tab：Tools 与 Skills 共享同一个可滚动资源列表，以 group header 分段。
顶层 router tab strip 只 highlight active page，`Left`/`Right` 只在页面没有消费输入时切换页面。

宽终端由左侧资源列表、仅溢出时显示的中间 scrollbar、以及右侧单一 Description block 组成。Description
随 selected row 更新，绝不为每个 row 渲染一块内联说明。窄终端改为列表后接 selected Description，不能把
三栏挤压到不可读。Loadout 页面没有自己的外框。

列表 row 的 `display group` 是第二列；它不是不稳定的 extension source ID。`●` 表示 effective enabled，
`○` 表示 effective disabled，`⊘` 表示 conflict locked/inactive，`→` 表示 selected row。所有 locked row
在 Description 中说明 winner 与解除方式。

页面顶部显示当前 scope 与实际文件路径：Global 为 `<agentDir>/settings.json`，Project 为
`<cwd>/.pi/settings.json`。`Ctrl+P` 在 scope 之间切换，并在切换前 flush 正在离开的 scope；因此不会发生
global/project 两个 JSON root 的部分提交。直接文字输入过滤 name 与 display group；有 filter 时第一次
`Esc` 清 filter，第二次才关闭页面。

`Space` 只在当前 resource/scope 实际可达的选择集合中循环，绝不补出不存在的 inherit 状态：Global resource
循环 `enabled <-> disabled`；Project global-visible resource 循环
`inherit -> enabled -> disabled -> inherit`；Project-private resource 循环 `enabled <-> disabled`。左侧圆点永远
显示 effective state。Description 沿用原 Loadout 的 selected-resource 内容：名称与类型、description、origin、status；
只有 conflict locked 时追加 winner 与解除方式，不显示 raw delta、inherited/default 或 policy 调试信息。

页面把修改保存在当前 scope draft 中，只有 `Ctrl+P`、离开 Loadout tab 或关闭 Settings 时才 flush。flush
失败时丢弃未写 draft、允许正常离开并输出 Pi warning。任何一次成功 flush 都使 host 在整个 Settings surface
实际关闭后只输出一次：`※ Reload to apply Loadout changes.`；无 change 不输出，成功保存不 hot-apply。

## Settings 页面

Settings page 使用单棵组合树，而不是为每个 provider 创建 router page。
`pi-settings` 将 core registry 的 provider groups 映射到一个 display tree：每个 extension/module 只显示一次
header，之后列出其 group 和 field；发生 group ID collision 时只在 display tree 使用 namespaced ID，保存和
callback 始终映射回 provider 原始 group ID。

宽终端布局与 Loadout 一致：左侧可滚动的 group/field list、中间仅溢出时显示的 scrollbar、右侧单一 selected
field Description block。窄终端将 Description 放在列表之后。router 继续拥有 top tab strip 与 structural
borders；Settings page 不绘制旧 shell tabs 或自己的外框。

Settings 与 Loadout 都在 tab strip 下保留至少 20 行 page content。router 补的是 surface 空白，而不是
field/resource 假行；短列表仍只显示真实项目。

field row 维持原 Settings 的稳定 label/value columns、selected slot、disabled dim state、group header、以及仅在
非编辑 selected field 上启用的 long-label marquee。Description 只显示 field description、Origin、Value、正在编辑
的 value 或 validation error；它不显示 provider storage path、JSON raw state 或 feature policy。

Settings 使用原 Settings transaction：load 时 merge default 并保留 provider-owned unknown fields；field edit 只
修改内存 draft；provider callback 接收当前 Pi session ID，而不是 Settings host 的固定标识。关闭或 router tab
handoff 时，按 provider 顺序执行 `validate -> onChange -> storage.save`。此顺序
使 callback 与保存可预测，但不同 provider 不构成可回滚 transaction。保存失败保留 draft、显示 error 并阻止离开，
以便用户重试；不会套用 Loadout JSON delta 的 discard-and-warning 行为。

`Space` toggle boolean；enum、text、number 和 path 使用原 Pi `Input` editor。`Tab` 只服务 field 的 `tabCycle`；
它不会切换 router page。编辑时 `Esc` cancel editor，非编辑时首个 `Esc` clear filter，随后才 close。

## 验证

实现必须覆盖 draft scope switch、flush failure、reload-notice aggregation、router key fallback、widget
suspension reference count 与 reload cleanup。可见行为必须在 Pi 或 `tui-replay` 的 narrow/wide 尺寸验证。
