# FFF 搜索

`pi-ext-tools` 保持 Pi host 的 `grep`、`find` 工具名和参数契约，并在 FFF runtime 可用时选择兼容的索引查询。

- `grep`：FFF 可表达的请求使用索引内容搜索；`ignoreCase: true` 等不兼容请求回退 Pi host 的 `rg` 实现。
- `find`：当 `findEnhancement` 开启、未传入 `path`、且 `pattern` 不是 glob 时，使用 FFF fuzzy 路径索引。带搜索目录或 glob 的请求回退 Pi host 的 `fd` 实现，以保留 glob 与相对路径语义。
- FFF 初始化或查询失败时，两个工具都回退 Pi host 实现。FFF runtime 的生命周期由 `pi-ext-tools` 持有；Pi host 仍拥有工具调用和取消信号。

此边界不新增工具参数。`find` 的 FFF 搜索只增强概念和路径片段查找；需要精确文件集时继续传 glob。
