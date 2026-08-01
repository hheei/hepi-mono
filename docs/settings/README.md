# Settings

## 用户意图

`pi-settings` 是唯一的 `/ext-settings [page-id]` 宿主。它让安装的 HEPI extension 在同一 Pi custom
surface 中提供设置页面；它不拥有任何具体 extension 的 schema、业务状态或运行时 policy。

第一份页面是 `pi-loadout` 提供的 `Loadout`。它编辑工具与技能的 activation delta，但不会在当前
session hot-apply；用户在关闭 Settings 后自行 `/reload`。

## 包与宿主边界

- `pi-settings` 打开 core Extension page router、拥有 `/ext-settings`、surface 生命周期和退出通知；
- `pi-loadout` 注册 Loadout page，拥有 inventory projection、scope draft、conflict explanation 与 JSON
  delta writer；
- `pi-ext-core` 只拥有 router tabs、page close coordination，以及 core-managed editor widget 的注册和
  suspension；
- concrete extension 不互相 import。page 通过 core runtime registry 动态加入 router。

Settings surface 打开期间，host 获取 core widget suspension lease。core 卸载所有已注册的
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
在 Description 中说明 winner、来源和解除方式。

页面顶部显示当前 scope 与实际文件路径：Global 为 `<agentDir>/settings.json`，Project 为
`<cwd>/.pi/settings.json`。`Ctrl+P` 在 scope 之间切换，并在切换前 flush 正在离开的 scope；因此不会发生
global/project 两个 JSON root 的部分提交。直接文字输入过滤 name 与 display group；有 filter 时第一次
`Esc` 清 filter，第二次才关闭页面。

`Space` 只在当前 resource/scope 实际可达的选择集合中循环，绝不补出不存在的 inherit 状态：Global resource
循环 `enabled <-> disabled`；Project global-visible resource 循环
`inherit -> enabled -> disabled -> inherit`；Project-private resource 循环 `enabled <-> disabled`。左侧圆点永远
显示 effective state，scope raw delta、inherited/default source 与 conflict policy 属于 Description。

页面把修改保存在当前 scope draft 中，只有 `Ctrl+P`、离开 Loadout tab 或关闭 Settings 时才 flush。flush
失败时丢弃未写 draft、允许正常离开并输出 Pi warning。任何一次成功 flush 都使 host 在整个 Settings surface
实际关闭后只输出一次：`※ Reload to apply Loadout changes.`；无 change 不输出，成功保存不 hot-apply。

## 验证

实现必须覆盖 draft scope switch、flush failure、reload-notice aggregation、router key fallback、widget
suspension reference count 与 reload cleanup。可见行为必须在 Pi 或 `tui-replay` 的 narrow/wide 尺寸验证。
