# 统一文件与内容搜索（grep & find）

`pi-ext-tools` 拥有 Pi `grep` 与 `find` 的规范实现，底层统一使用 ripgrep 与原生文件系统遍历。

## grep

### 公共调用

- 公开参数为 `pattern`、`path`、`glob`、`ignoreCase`、`literal`、`context`、`limit`、`target`。默认 `limit` 为 100、`context` 为 0，`ignoreCase` 与 `literal` 均默认 false。`pattern` 是 JSON 解码后的 rg regex；精确文本使用 `literal: true`。

### Engine 与执行

- local filesystem grep 直接调用本地 `rg --json`。
- 搜索结果统一收敛为规范的 `GrepEvent[]` 事件流，提供字符级精确高亮、行列号映射与上下文捕获。

### 限制与恢复

- `grep` 不公开 cursor；结果受 canonical cap（50KB / 2000 行）与 compact display limits（单文件 25 match，全局 200 match）约束。
- 遇超时或权限拒绝时，输出明确的结构化恢复提示或可用的部分结果。

## find

- 公开参数为 `pattern`、`path`、`exclude`、`limit`、`cursor`、`target`。默认 `limit` 为 30；匹配 repo-relative path，支持 glob 与路径过滤。
- `find` 的 cursor 是工具层不透明分页令牌；固定原查询和 limit，失效或属于另一 target 时返回错误。
- 过滤与排除支持 string 或 string array 形式的 `exclude` 规则。

模型应直接调用 `grep` / `find`；不要通过 `bash` 调用 `ripgrep`、`find`、`fd`。
