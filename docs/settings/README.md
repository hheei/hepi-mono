# Settings

## 用户意图

`pi-settings` 是 `/ext-settings [page-id]` 宿主。它让安装的 HEPI extension 在同一 Pi custom
surface 中提供规范的双栏设置页面（`DualPaneListView`）；它不拥有其他 concrete extension 的 schema 或业务状态。

## 包与宿主边界

- `pi-settings` 打开 core Extension page router、拥有 `/ext-settings [page-id]`、surface 生命周期、
  Settings page 挂载与退出通知；
- `pi-ext-core` 只拥有 router tabs、page close coordination、page minimum height，以及 core-managed editor
  widget 的注册和 suspension；
- concrete extension 不互相 import。page 通过 core runtime registry 动态加入 router。

任一 Settings router surface 打开期间，command host 获取 core widget suspension lease。core 卸载所有已注册的
above-editor/below-editor widget；surface close、abort、reload 与 session shutdown 都释放 lease，最后
一个 lease 释放后才恢复仍有效的 widget。Pi 没有枚举或恢复其它 extension 直接 `setWidget()` 内容的公开
API，所以这个保证只覆盖 core-managed widget。

## 设置页面（DualPaneListView）

宽终端（≥76列）采用左侧设置项列表与右侧上下文详情的两栏响应式布局；窄终端（<76列）采用原生 Pi 的上下堆叠布局。
单行值（布尔、枚举、短文本）支持就地切换或挂载 SubPane 编辑，避免复杂的弹窗层级。
