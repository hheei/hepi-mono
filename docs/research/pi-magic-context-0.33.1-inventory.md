# pi-magic-context 0.33.1 public surface inventory

## 范围与证据

本记录盘点 `@hheei/pi-magic-context@0.33.1-hepi.0` 已发布 npm tarball 的 Pi 注册 surface，作为
`pi-mctx` 全量行为迁移的输入。检查对象是编译 bundle，不是 upstream source；因此只记录可由注册点和调用参数
确认的事实，不把 private helper、SQLite schema 或配置字段当成新实现 contract。

证据文件为 tarball 内的 `dist/index.js` 与 `dist/index-3452y8q2.js`。下列行号对应该版本 artifact：

- `dist/index-3452y8q2.js:183196-183232` 注册 MCTX tools。
- `dist/index.js:28754-28771` 注册 commands；各 command factory 位于下列列出的行附近。
- artifact 未发现 `__hepiMagicContextHandoffByRuntime`、`MagicContextHandoffBridge` 或 equivalent runtime bridge。

## 已确认 tools

- `ctx_expand`：读取当前 Pi session 的 raw message provider，并以 ordinal 或 range 展开历史；注册和 session ID
  access 见 `index-3452y8q2.js:177874-177902`。
- `ctx_reduce`：读取 per-session tags，解析 drop ranges，并保护最新 active tags；见
  `index-3452y8q2.js:180033-180062`。
- `ctx_memory`：使用 resolved project identity、project registration 与 workspace identity set；见
  `index-3452y8q2.js:179358-179388`。支持的 action/category 完整语义仍须在独立 feature 前重新验证。
- `ctx_note`：使用 session ID、anchor ordinal 与可选 Dreamer smart-condition；见
  `index-3452y8q2.js:179751-179782`。
- `ctx_search`：接受 `memory`、`message`、`git_commit`、`primer`、`note` source filter，并解析 session/project
  identity；见 `index-3452y8q2.js:183046-183078`。
- `todowrite`：注册名来自 `TODO_TOOL_NAME`，只在 execute 内回显 params 的 todo JSON；见
  `index-3452y8q2.js:183161-183192`。是否另有 session persistence 不能由这段注册点证明。

## 已确认 commands

- `/ctx-aug`：sidekick-based project context augmentation，见 `index.js:2889-2905`。
- `/ctx-dream`：按 project 运行 Dreamer task，见 `index.js:10915-10942`。
- `/ctx-embed`：查询、启动或暂停 history compartment embedding，见 `index.js:11178-11202`。
- `/ctx-flush`：registered factory `index.js:24654`；详细 lifecycle 需单独确认。
- `/ctx-recomp`：registered factory `index.js:26321`；详细 recompression input/output 需单独确认。
- `/ctx-session-upgrade`：registered factory `index.js:26788`；它看似 legacy session migration，但不可据此
  推导 new-store import policy。
- `/ctx-status`：registered factory `index.js:27659`；command 可写 custom status entry 的证据位于
  `index.js:10903-10911`。
- `/ctx-wrapup`：registered factory `index.js:27770`；未从 artifact 确认其与 Pi compact/handoff 的语义。
- `/todos`：注册点 `index-3452y8q2.js:173166`；它与 `todowrite` 共同属于 legacy Todo surface，不证明应由
  `pi-mctx` 继续拥有。

## 持久化边界结论

已确认 bundle 依赖 SQLite，并在 tool handlers 使用 session ID、project identity、workspace identity、raw session
history 与 tags。可安全得出的分类是：session history/tag state、project/workspace durable memory、session-anchored
notes、search/index state，以及 Dreamer/embedding state。每类未来实现必须独立指定 owner、partition、read/write
capability、retention、privacy、cancel 与 concurrent writer policy。

未确认：旧数据库的 exact tables/schema、`todowrite` 的完整 persistence、`ctx-flush`/`ctx-recomp`/`ctx-wrapup`
的 complete behavior、任何 Handoff bridge，以及 private helpers 是否具有用户可见承诺。它们不能作为兼容性目标。
