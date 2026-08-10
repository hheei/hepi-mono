# 统一 Grep 架构（目标）

> 状态：已同意、待实现。本文定义 `pi-ext-tools` 的目标 grep 合约；现有运行时行为见 [ext-tools README](../ext-tools/README.md)。术语以仓库根目录 [CONTEXT.md](../../CONTEXT.md) 为准。

## 目标

`grep` 对模型和 TUI 提供一份以 ripgrep match data 为基准的 Grep Result。FFF 是可选 Search Engine，提供同一 match 含义及额外索引 metadata；它不再拥有独立的文本格式、renderer 或分页合约。

```text
Pi grep call
    |
    +-- output:// source --------------------------> rg stdin
    |
    +-- Git worktree root, no path/glob/ignoreCase -> FFF
    |                                                    |
    |                                      operational failure
    |                                                    v
    +----------------------------------------------> rg
                                                         |
FFF / rg result -> canonical Grep Result -> Output -> compact formatter -> content + details -> renderer
```

Search Engine 选择只记录为内部 `details` provenance，不显示在 TUI 或模型 `content`。

## Engine admission 与失败

- `output://` 是 processed Output 的输入来源，使用 rg stdin，不是 Search Engine。
- 只有 session `cwd` 等于 Git worktree root，且请求没有 `path`、`glob` 或 `ignoreCase: true` 时，才可以使用 FFF。
- FFF 保留自身的排序。rg 的 file groups 按 canonical path 字典序排列。
- FFF exact search 返回 `0 matches` 后，只能在同一 FFF runtime 内执行 fuzzy fallback；fuzzy matches 必须标记为 approximate，并在模型 summary 中写为 `N fuzzy matches in M files`。不能因此降级 rg。
- FFF regex 编译失败时，grep 返回错误和 `regexFallbackError`；不使用 FFF 的 literal fallback 结果，也不降级 rg。
- FFF runtime、index 或查询的 operational failure 时，丢弃此前 FFF pages，从头以 rg 重跑同一请求。不可混合 partial FFF 与 rg results。
- 取消必须终止 rg child；FFF 在每个 page 边界检查取消并停止后续查询。两者都不发送 partial tool result。

FFF 的 page cursor 仅用于一次 grep execute 内部取完结果。`grep` schema、模型 content 与 details 都不公开 cursor，也不维护 cursor store。

## Public input schema

`grep` 完整采用 Pi `0.84.1` 的 `pattern`、`path`、`glob`、`ignoreCase`、`literal`、`context` 与 `limit` schema。`path: "output://N"` 是合法的只读 source。删除 extension-only `exclude`、`caseSensitive` 与 `cursor`；不再维护参数翻译层。

## Canonical Grep Result

每个 engine adapter 在返回后立刻转为 canonical result；之后没有 backend-specific formatter 或 second normalization。

- 有序 `GrepEvent[]` 对齐 `rg --json`：`match` event 保留 path、lines、line number、absolute offset 和 `submatches[]`；`context` event 保留 rg context data。
- FFF 将 `matchRanges` 映射为同语义 `submatches[]`，并把 before/after context 映射为有序、去重的 context events。
- FFF 可用的 frecency、git status、`col`、`byteOffset` 等仅放在明确命名的 FFF metadata；不能替换 common fields。
- `details` 保存 canonical result、内部 `engine` provenance、可用 metadata、cap 与 recovery metadata。模型 `content` 只保存 compact formatter 输出。
- `renderResult` 只读 structured details，不以 regex 重解析 `content`。它使用 `submatches` 做安全高亮；无效或跨 UTF-8 code point 的 range 跳过高亮，仍显示完整行。
- grep 不注册 `tool_result` handler。execute 的唯一 formatter 同时产生最终 `content` 与 `details`。

## Result 与显示上限

`limit` 保留 Pi native grep 的参数语义。canonical result 同时继承 Pi native grep 的 `50 KB / 2000 rows` 上限，但取消每行 500-character 截断。rg stdout 在 child exit 后一次解析完整 NDJSON rows；不会 streaming parse 或发出 partial result。FFF 内部取 page 直到请求完成或上述 canonical cap。

compact formatter 在 canonical result 之后执行，规则参考 rtk：

- 每个 file 最多显示 25 个 `match` events。
- 全局最多显示 200 个 `match` events。
- context event 不消耗 25/200；保留 match 相邻 context，并去重。
- 显示内容 trim whitespace，长行截到 80 characters，长 path compact。details 与 recovery 不丢失原始 canonical fields。
- FFF 维持 FFF item/file 顺序；rg 以 path 字典序 group。

## Output recovery

每次 grep 将 cap 后、compact 前的完整人类可读 result 保存为 process-lifetime、read-only Output。compact formatter 的每个 omission 都指向该 Output 中的行范围：

```text
+42 matches omitted -> output://7:120-196
+36 files omitted -> output://7:197-548
```

`output://7:120-196` 是显示标记，不是 read path。恢复时模型调用：

```ts
read({ path: "output://7", offset: 120, limit: 77 })
```

每个 file 的 25-match overflow 各有一个 marker；200-match global cap 后的所有剩余 files 合为一个连续 marker。`read` 必须将 native `offset` 和 `limit` 传给 Output resolver。写入工具拒绝 `output://`；旧 `artifact://` URI 一律拒绝，不保留 alias。

## TUI

`renderCall` 显示 `grep /PATTERN/ in path`：`grep` 使用原工具的 accent、pattern 使用 `mdCode`、` in ` 使用基础 text、path 使用 `dim`。`renderResult` 显示 compact result、cap/recovery 状态；未展开时**整个 result 最多 15 行**，包括 expansion hint。每个文件块的 path 使用 `mdCode`；行号和 `│` 使用 `dim` 并按该文件最大行号宽度右对齐；普通文本使用基础 text，`submatches` 使用 `success` highlight。Pi 的 `expanded` state 仍可展开已保存的 tool result。颜色不是唯一的信息载体；path、match/context 结构和 omission marker 必须在无颜色时可读。

当下一 Trace 的 `agent_start` 到来且 Pi 全局 tools 未展开时，已完成的 grep block 收起为 header、rule、`N matches · M files · duration`；FFF fuzzy fallback 使用 `N fuzzies · M files · duration`。展开时继续显示完整 block。

## Ownership 与验证

`pi-ext-tools` 拥有 engine admission、rg execution、FFF adapter、canonical result、compact formatter、renderer 及 Output resolver 接入。ext-core 只拥有 process-lifetime Output registry 和 URI/resource 生命周期，不拥有 grep policy、limits 或 rendering。

聚焦测试至少覆盖：

- FFF / rg / Output source 都生成同一 canonical match 与 context contract；FFF range 映射正确。
- admission、exact `0 matches` 后的 FFF fuzzy fallback、regex error、FFF page failure 后完整 rg retry、取消与 Pi cap。
- 25/file、200/global、context 不计 cap、FFF ordering、rg ordering、80-character trimming、path compact 与 Output line-range mapping。
- `read` 对 `output://` 的 offset/limit、写入工具拒绝 Output、旧 `artifact://` rejection。
- renderer 从 details 高亮 submatches，窄/宽 layout、无效 byte range、expanded state。
