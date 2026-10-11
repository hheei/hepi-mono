# 统一 Grep 架构

> 状态：已实现。本文记录 `pi-ext-tools` 的 grep 合约；当前运行时边界见 [ext-tools README](../ext-tools/README.md)。术语以仓库根目录 [CONTEXT.md](../../CONTEXT.md) 为准。

## 目标

`grep` 对模型和 TUI 提供一份以 ripgrep match data 为基准的 Grep Result。统一采用 ripgrep (`rg --json`) 作为单一搜索引擎，消除双引擎分流、fallback 与状态分歧。

```text
Pi grep call
    |
    +-- local filesystem  -> local rg --json
    |
    +-- SSH target alias  -> remote rg --json
    |
    v
canonical Grep Result -> compact formatter -> content + details -> renderer
```

Search Engine 统一为 `rg`，记录为内部 `details.engine` provenance，不显示在 TUI 或模型 `content`。

## Engine 执行

- 非 local 的 authorized SSH target 使用 remote rg（经由 SSH/SFTP 控制通道）。
- local filesystem 搜索直接执行本地 `rg --json`。
- `grep` 严格保证单引擎原子性；不存在模糊回退或跨引擎切换。
- `grep` schema、模型 content 与 details 都不公开 cursor，也不维护外部 cursor store。

## Public input schema

`grep` 的公开参数为 `pattern`、`path`、`glob`、`ignoreCase`、`literal`、`context`、`limit` 与 `target`；`target` 选择 local 或 authorized SSH host。

## Canonical Grep Result

ripgrep NDJSON 输出在返回后立刻转为 canonical result；之后没有 backend-specific formatter 或 second normalization。

- 有序 `GrepEvent[]` 对齐 `rg --json`：`match` event 保留 path、lines、line number、absolute offset 和 `submatches[]`；`context` event 保留 rg context data。
- `details` 保存 canonical result、内部 `engine: "rg"` provenance、可用 metadata、cap 与 recovery metadata。模型 `content` 只保存 compact formatter 输出。
- `renderResult` 只读 structured details，不以 regex 重解析 `content`。它使用 `submatches` 做安全高亮；无效或跨 UTF-8 code point 的 range 跳过高亮，仍显示完整行。
- grep 不注册 `tool_result` handler。execute 的唯一 formatter 同时产生最终 `content` 与 `details`。

## Result 与显示上限

`limit` 保留 Pi native grep 的参数语义（默认 100）。canonical result 同时继承 Pi native grep 的 `50 KB / 2000 rows` 上限，但取消每行 500-character 截断。rg stdout 在 child exit 后一次解析完整 NDJSON rows；不会 streaming parse 或发出 partial result。

compact formatter 在 canonical result 之后执行，规则参考 rtk：

- 每个 file 最多显示 25 个 `match` events。
- 全局最多显示 200 个 `match` events。
- context event 不消耗 25/200；保留 match 相邻 context，并去重。
- 显示内容 trim whitespace，长行截到 80 characters，长 path compact。details 与 recovery 不丢失原始 canonical fields。
- rg 以 path 字典序分组展示。

## TUI

`renderCall` 显示 `grep /PATTERN/ in path`：`grep` 使用原工具的 accent、pattern 使用 `mdCode`、`in path` 与 body path 使用终端默认色（跨 Trace 为 `dim`），不套 theme `text`。find 与 bash 正文遵循同一套 tone。`renderResult` 显示 compact result、cap/recovery 状态；未展开时**整个 result 最多 15 行**，包括 expansion hint。每个文件块的 path 相对于 grep `path`；搜单个文件时省略 path heading。行号和 `│` 使用 `dim` 并按该文件最大行号宽度右对齐；`submatches` 使用 `success` highlight。Pi 的 `expanded` state 仍可展开已保存的 tool result。

当下一 Trace 的 `agent_start` 到来且 Pi 全局 tools 未展开时，已完成的 grep block 收起为 header、rule、`N matches · M files · duration`。展开时继续显示完整 block。

## Ownership 与验证

`pi-ext-tools` 拥有 engine admission、rg execution、canonical result、compact formatter 与 renderer；ext-core 不拥有 grep policy、limits 或 rendering。

聚焦测试至少覆盖：

- rg 生成 canonical match 与 context contract；range 映射正确。
- regex error、取消与 Pi cap 处理。
- 25/file、200/global、context 不计 cap、rg 字典序 ordering、80-character trimming 与 path compact。
- renderer 从 details 高亮 submatches，窄/宽 layout、无效 byte range、expanded state。
