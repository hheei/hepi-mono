# FFF 搜索

`pi-ext-tools` 对 Pi host 暴露上游 FFF 的 `grep`、`find` 契约。Pi native 工具只在 FFF runtime 不可用、项目外路径无法索引、或请求不被本地 FFF bridge 支持时作为降级后端。

- `grep`：公开参数为 `pattern`、`path`、`exclude`、`caseSensitive`、`limit`、`cursor`。默认 `20`，默认 smart-case，并自动选择 literal 或有效 regex。FFF 固定读取前 1 行、后 3 行；formatter 在命中过多时自动隐藏 context。
- `find`：公开参数为 `pattern`、`path`、`exclude`、`limit`、`cursor`。默认 `30`，全路径 fuzzy 与 glob 查询均使用 FFF，结果按 frecency 与 git 状态排序。
- FFF cursor 是工具层的不透明分页令牌。工具层持有其查询与页码；同一 cursor 不得改变查询或限制。cursor 保留在 tool result 供模型继续调用，TUI renderer 不显示。
- FFF 失败时，adapter 将可表达部分转换为 Pi native `rg`/`fd` 参数，并对返回路径应用 `exclude` 后处理。native 无法忠实表示 fuzzy 语义；cursor 在 native fallback 中被忽略。

Pi host 拥有 tool call、取消信号和 native fallback 执行。`pi-ext-tools` 拥有 FFF runtime、cursor、查询转换和 session cleanup。
