# FFF 搜索

`pi-ext-tools` 对 Pi host 暴露上游 FFF 的 `grep`、`find` 契约。Pi native 工具只在 FFF runtime 不可用、项目外路径无法索引、或请求不被本地 FFF bridge 支持时作为降级后端。

- `grep`：公开参数为 `pattern`、`path`、`exclude`、`caseSensitive`、`context`、`limit`、`cursor`。默认 `20`，默认 smart-case，并自动选择 literal 或有效 regex。未传 `context` 时 FFF 读取前 1 行、后 3 行；传 `N` 时读取前后各 `N` 行。formatter 在命中过多时自动隐藏 context。
- `find`：公开参数为 `pattern`、`path`、`exclude`、`limit`、`cursor`。默认 `30`，全路径 fuzzy 与 glob 查询均使用 FFF，结果按 frecency 与 git 状态排序。
- 模型应直接调用 `grep`/`find`；不要通过 `bash` 调用 `ripgrep`、`find` 或 `fd`。
- FFF cursor 是工具层的不透明分页令牌。工具层持有其查询与页码；同一 cursor 不得改变查询或限制。cursor 保留在 tool result 供模型继续调用，TUI renderer 不显示。
- FFF 失败时，adapter 将可表达部分转换为 Pi native `rg`/`fd` 参数，并对返回路径应用 `exclude` 后处理。native 无法忠实表示 fuzzy 语义；cursor 在 native fallback 中被忽略。

Pi host 拥有 tool call、取消信号和 native fallback 执行。`pi-ext-tools` 拥有 FFF runtime、cursor、查询转换和 session cleanup。

`grep` 在内存中搜索 session output URL；`find` 拒绝该 URL，因为 output 不是可遍历文件树。

FFF 索引 root 固定为 Pi session 的 cwd。runtime 在首次 FFF 查询、自动补全或状态命令时创建；session start 不触发扫描。runtime disposal 销毁 finder；任何显式 scan wait 都必须带 timeout，超时不阻塞 Pi host。创建 native finder 前，admission 顺序检查 cwd，超过 500ms 或 20,000 个文件则拒绝 FFF 并回退 Pi native。admission 不跟随 symlink，跳过 `.git` 与 `node_modules`。FFF 禁用 mmap 预热、内容索引和文件 watcher，只保留一次文件索引与 live grep。
