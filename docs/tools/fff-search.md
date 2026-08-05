# FFF 搜索

`pi-ext-tools` 对 Pi host 暴露上游 FFF 的 `grep`、`find` 契约。Pi native 工具只在 FFF runtime 不可用、项目外路径无法索引、或请求不被本地 FFF bridge 支持时作为降级后端。

- `grep`：公开参数为 `pattern`、`path`、`exclude`、`caseSensitive`、`context`、`limit`、`cursor`。默认 `20`，默认 smart-case，并自动选择 literal 或有效 regex。
- `find`：公开参数为 `pattern`、`path`、`exclude`、`limit`、`cursor`。默认 `30`，全路径 fuzzy 与 glob 查询均使用 FFF，结果按 frecency 与 git 状态排序。
- FFF cursor 是工具层的不透明分页令牌。工具层持有其查询与页码；同一 cursor 不得改变查询或限制。
- FFF 失败时，adapter 将可表达部分转换为 Pi native `rg`/`fd` 参数。native 无法忠实表示的 `exclude`、分页或 fuzzy 语义不会静默丢弃，而是返回说明性错误。

Pi host 拥有 tool call、取消信号和 native fallback 执行。`pi-ext-tools` 拥有 FFF runtime、cursor、查询转换和 session cleanup。
