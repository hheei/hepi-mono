# FFF

`@hheei/pi-fff` 为 Pi 提供 fff 文件索引、模糊路径解析、内容搜索与 `@path`
autocomplete。它独立安装，不依赖 `@hheei/hepi-tools`。

## 用户接口

- 覆盖 Pi `read` 与 `grep`，用 fff 解析近似路径和内容检索；不能安全使用 fff 时回退 Pi
  原始实现。
- 注册 `find_files` 与 `fff_multi_grep`。
- 保留 `/reindex-fff` 与 `/fff-status`。
- 编辑器 `@path` autocomplete 在 session 中可用，并与已有 provider 组合。

## 激活与配置

四个工具 `read`、`grep`、`find_files`、`fff_multi_grep` 都通过
`@hheei/pi-ext-core` managed registration 加入 `pi-loadout`。Pi 只按 tool name 选择
active handler，因此关闭 `tool:read` 或 `tool:grep` 会关闭对应 Pi name，不存在“只关闭 FFF
wrapper”的独立状态。

本阶段没有 `/fff-features`，也不读取或写入旧 `pi-fff.json`。FFF 通过 `pi-ext-core` 注册 `pi-fff`
settings provider，提供路径解析、grep 增强、autocomplete 与 startup status 四个 boolean 设置；core
只提供 registry 与 JSON storage，不拥有 FFF policy 或 TUI。设置在 session start 或 `/reload` 时读取并应用，
保存设置不会直接改变当前 runtime；它不能绕过 Loadout 改写 tool activation。

## 边界

- `pi-fff` owns runtime、查询、格式化、autocomplete 与 fff commands。
- `pi-loadout` owns tool effective activation and JSON policy；core only transports registration
  and resolved activation snapshots.
- FFF 不接管 editor component，避免干扰 statusbar 与 dollar-skill editor wrapper。
- 本次与 `hepi-tools` 删除 FFF registration 必须同 release 发布；混用新 `pi-fff` 与旧
  aggregate 会产生同名 tool/command 冲突，明确不支持。

## 已确认迁移

`pi-ext-tools` 将成为 `read`、`edit`、`write` 和 `bash` 的 Canonical tool owner。第一阶段 `pi-fff`
移除 `read` registration，继续提供 `grep`、`find_files`、`fff_multi_grep`、FFF runtime/settings 与 autocomplete；
此阶段 `pi-ext-tools/read` 不提供 FFF approximate-path resolution。仍注册 `read` 的旧 `pi-fff` release 不能与
`pi-ext-tools` 同装。完整 migration contract 见 [pi-ext-tools 基础工具替换](../ext-tools/README.md)。
