# FFF 搜索

`pi-ext-tools` 用 FFF 为符合条件的 local search 提供增强；工具始终暴露 Pi 的 `grep`、`find` 名称。FFF 不是另一套公开 grep 语法，也不拥有独立 renderer 或 grep pagination 合约。

## grep

### 公共调用

- 公开参数为 `pattern`、`path`、`glob`、`ignoreCase`、`literal`、`context`、`limit`、`target`。默认 `limit` 为 100、`context` 为 0，`ignoreCase` 与 `literal` 均默认 false。`pattern` 是 JSON 解码后的 rg regex；精确文本使用 `literal: true`。
- `output://` 可作为 `path` 搜索 session Output，使用 rg stdin；`target: "output"` 也要求在 `path` 中提供 output id。

### Engine 选择

- local filesystem grep 仅在启用 grep enhancement、cwd 为 Git worktree root，且未传 `path`、`glob`、`ignoreCase: true` 时尝试 FFF；remote target 和其余请求使用 rg。

### 限制与恢复

- `grep` 不公开 cursor。完整、cap 后且 compact 前的结果保存在只读 Output；省略标记指向该 Output 的行范围，恢复时调用 `read`，而不是续页 grep。
- FFF exact 0-match 只可在同一 runtime 内尝试 fuzzy fallback。regex compile error 直接返回错误；FFF operational failure 才丢弃已取 page 并从头改用 rg。

## find

- 公开参数为 `pattern`、`path`、`exclude`、`limit`、`cursor`、`target`。默认 `limit` 为 30；它匹配 repo-relative path，并支持 fuzzy 与 glob query。FFF 结果按 frecency、git-aware ordering 返回。
- `find` 的 cursor 是工具层不透明分页令牌；它固定原查询和 limit，失效或属于另一 target 时返回错误。find 不支持 `output://` 或 `target: "output"`。
- local FFF find 仅在启用 find enhancement、runtime 可用且 `path` 受 FFF 支持时使用；否则使用 Pi native find，并在本地 fallback 后应用 `exclude`。authorized SSH target 使用 target runtime 返回候选并分页。

模型应直接调用 `grep`/`find`；不要通过 `bash` 调用 `ripgrep`、`find`、`fd`。
