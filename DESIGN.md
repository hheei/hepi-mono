# Terminal UI/UX Design

## Scope

Shared UI/UX rules for HEPI terminal surfaces: visual hierarchy, theme usage, layout, interaction, responsive behavior, and accessibility.

Feature architecture, persistence, lifecycle, command semantics, and feature-specific UI contracts belong elsewhere.

Feature specs MAY specialize these rules but MUST NOT silently contradict them.

## Principles

HEPI is **quiet, semantic, content-first, and terminal-native**.

- Content dominates; color, borders, backgrounds, spacing, and typography communicate state or hierarchy, never decoration.
- Prefer whitespace, alignment, and familiar terminal interaction over extra containers or custom interaction.
- Keep one obvious active focus point and stable geometry as state changes.
- Regular-mode redraws for tool collapse or streaming changes above the visible viewport must not erase terminal scrollback (`CSI 3 J`). Native terminal scrollback is not a fullscreen `ScrollView`; a follow-end flag alone cannot protect it.
- Reuse existing UI primitives and semantic tokens before introducing new ones.
- NEVER use shadows, gradients, decorative cards, module-specific branding, or hard-coded colors.
- Add visual elements only when they improve readability, navigation, state recognition, or action discovery.

## Theme

Use Pi theme tokens by semantic role:

- Content: `text`, `muted`, `dim`
- Focus: `accent`, `selectedBg`
- Status: `success`, `warning`, `error`
- Structure: `border`, `borderAccent`, `borderMuted`
- Thinking/mode: `thinkingText`, `thinkingOff`…`thinkingMax`, `bashMode`
- Messages: `userMessage*`, `customMessage*`
- Tools: `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput`
- Markdown/diffs: existing `md*` and `toolDiff*` tokens

Rules:

- `accent` marks the active focus; status tokens represent status only.
- `muted` and `dim` represent hierarchy, not failure.
- NEVER invent feature-specific accent colors or new tokens when an existing semantic role fits.
- NEVER communicate selection or status by color alone.

## Layout

- Use terminal-native font and cell dimensions; measure layout by terminal cell width, ignoring ANSI sequences.
- Bold is for headings/labels; thinking uses italic `thinkingText`.
- Framed/background surfaces normally use one-cell padding; inline metadata, rails, and footers use none.
- Use at most one blank line between adjacent semantic blocks.
- Every rendered line MUST fit available width: wrap prose; ANSI-safely truncate compact metadata, status, and paths.
- Preserve useful path suffixes and semantic fragments when truncating.
- Keep rows, columns, controls, selection slots, and fixed-height surfaces geometrically stable while state changes.
- Prefer clipping or scrolling within an established region over resizing surrounding layout.
- Hide complete low-priority content before clipping or moving higher-priority content.
- Columns SHOULD remain stable while scrolling and keep at least one cell of separation.
- NEVER let one overflowing field shift or corrupt adjacent content.

## Interaction

- A surface SHOULD expose one primary focus point.
- Selected rows use `→` and `accent`; unselected rows reserve the same marker width.
- Disabled, inherited, read-only, and unavailable states remain distinguishable without replacing the focus signal.
- Use compact hints consistently: `↕` vertical, `↔` switch, `↵` activate, `⎋` cancel, `␣` Space, `⇥` Tab.
- Show non-obvious shortcuts near the relevant control; omit redundant hints.
- Nested interactions handle `Esc` inside-out: editor/transient interaction → detail/form → filter/mode → surface.
- Parent surfaces act only after the active child declines the key.

## Surface Patterns

### Messages

- User messages: one padded `userMessageBg` block with `userMessageText`.
- Assistant prose: terminal background with whitespace between semantic blocks.
- Thinking: italic `thinkingText`; collapsed thinking is one concise line.
- Extension messages: one `customMessageBg` block using `customMessageLabel` and `customMessageText`.
- NEVER add avatars, decorative labels, nested cards, or large collapsed placeholders.
- Preserve partial output before reporting a later error.

### Tools

- `pi-ext-tools` renders every registered tool with `renderShell: "self"`: terminal background, no Pi `tool*Bg` box.
- A tool frame has a header and up to two bodies. A `request` body (the tool's input: command, code, task text) may sit between the header and the result body; a tool whose header already carries the whole call, and a tool whose input becomes the result, keeps one body. Omit a body's paired rails when it has no rendered lines:

  ```text
  ✓ tool summary · metadata
  ─────────────────────────  opening rail
  request                    tool-owned, optional, ≤10 head rows
  ─────────────────────────  shared rail
  tool body                  tool-owned result rows
  ─────────────────────────  closing rail
  typed footer               optional, tool-owned text
  ```

- A declared `request` renders in the call slot for the whole lifetime of the row: while arguments stream, while the tool runs, and after the result arrives. It replaces the tool's own call-phase `renderCall` body. A collapsed frame still renders the header and its one-line metrics summary only, and expanding the frame lifts the request and result caps together.
- Request rows preserve the input: they wrap instead of truncating, keep the head (at most 10 rows, then a dim `… (N later lines, ctrl+o to expand)` row), strip terminal escape sequences because the text is model-controlled input, and never exceed the terminal width. The result body keeps the tail instead.
- The result body omits its opening rail when the tool declares `request`, so exactly one rail separates the two sections; a tool that declares `request` renders at least one row for the arguments it receives.
- Pi `renderCall` and `renderResult` are host lifecycle slots, not separate visible sections: the call slot owns the header and the request body, the result slot owns the result body and the footer. Both slots stay mounted, so the call slot must not repeat what the result slot shows.

- When the header fully represents a tool call, omit a duplicate body. `grep` and `find` use only the header until their result body exists.
- `ToolTui` 由 `pi-ext-core` 提供给独立 extension：它拥有 status header、跨 extension 的 Trace collapse/resume、body 的 paired rails、footer placement 与默认未展开 body 高度。每个 Pi host 只有一个共享 Trace controller，`agent_start` 推进一次 Trace；concrete extension 仅调用 `frame(tool, presentation)`，并继续拥有其 tool 语义、header summary、body、typed footer 与 warning 判定。
- A completed prior Trace collapses only while Pi global tool expansion is off. Current-Trace tools, including a model-time request or `renderCall` preview that still has no execution result, keep their full frame, and the header declares whether it wraps or truncates; the next `agent_start` collapses prior Traces. A collapsed tool renders one status header row plus one dim metrics summary row; its non-status parameters, paths, and ranges use `dim`, and its header uses dim `…` truncation when necessary. Expanding tools restores its full frame. A Trace is `agent_start` through `agent_end`; resume treats every historical tool as prior. An unexpanded result body keeps at most 20 rendered rows (tail plus a dim `… (N earlier lines, ctrl+o to expand)` row), and an unexpanded request body keeps at most 10 head rows behind a `… (N later lines, ctrl+o to expand)` row. Header, paired rails, and typed footer stay outside that limit. Paired rails always use `muted` and do not encode success, warning, or error. A tool may override `maxBodyLines`; expanded results are not capped. Tool renderers retain their semantic colors, widths, collapse rules, model-visible `content`, and body component caches, but never add outer rails or typed footers. When the body has no rows, omit both rails and show only its typed footer when present.
- `Tool Output` settings own the automatic collapse policy for tools declared `longOutput` (`grep`, `read`, `write`, `edit`, `find`, `bash`): `auto` (default) collapses one such tool 15 seconds after it completes and keeps the prior-Trace rule, `on` collapses on the first completed frame and stops forwarding a long tool's partial output, `pertrace` keeps only the prior-Trace rule, and `off` disables automatic frame collapse entirely. Because one ToolTui is host-scoped, the policy applies to every frame on that host, including tools owned by other extensions; the default `auto` does not change them because only tools that declare `longOutput` get a timer. A saved change applies to the live ToolTui immediately and is re-read on reload; a pending 15-second timer never outlives `agent_start`, a session reset, or session shutdown. Collapsing changes only the visible frame: model-visible `content`, persisted details, and Ctrl+O expansion are unaffected.
- A collapsed footer uses only tool-owned typed details, a wrapper-captured execution duration, or a caught single-line error message. It never parses model-visible `content`. The summary row obeys the same rule as the header: it wraps by default and is cut to one dim `…` row when the tool declares `headerLine: "truncate"`; in the collapsed frame it is always one truncated row, so a collapsed frame is exactly two rows at every width. No frame row may exceed the terminal width, because the Pi renderer rejects an overlong row.
- `grep` collapses to `N match(es) · M file(s) · L line(s) · duration`, or FFF fallback `N fuzzy/fuzzies · M file(s) · L line(s) · duration`. Count nouns are singular when the number is 1. Its current-Trace header follows the shared wrapping rule; only a historical collapsed header is compacted. Match and context rows use the same ` XXX │ ` gutter and path-based cli-highlight as `read`. Matching ranges keep full-intensity syntax colors with a `success` overlay; the rest of the same line uses dim syntax colors. Per-file omissions use a dim line-number-aligned `…` / `┊` skip whose body keeps the recovery hint. Every grep body row follows `read`'s single-line, ANSI- and cell-width-safe truncation rule, using a dim trailing `…` rather than wrapping.
- FFF-backed `find` fully represents its call in the shared header: `status find /pattern/ in path`; it has no duplicate pre-result body. `ToolTui` frames its result-phase body with paired rails and places the typed footer after the closing rail. The body groups typed candidates under `fuzzy files:` and `fuzzy paths:`, with direct-parent directory headings and base-text paths in the terminal default. Its typed footer is `X fuzzy file(s) · Y fuzzy path(s) · Z line(s) · duration`; `Z` counts body rows before collapse. Count nouns are singular when the number is 1. Collapsed body omission uses dim `… (N more lines, ctrl+o to expand)`.
- `pi-ext-tools` has a static `Edit Mode` catalog setting. Default `auto` follows the current model: `apply_patch` when the provider, id, or name contains `gpt` (case-insensitive), otherwise native `edit` and `write`. It re-resolves on `session_start`, `/reload`, resume, `model_select`, and the next agent turn, rebuilding the active tool set and system prompt. The extension statically registers its canonical `edit`, `write`, and `apply_patch` definitions so resumed tool calls always resolve to the same renderers; only the selected execution catalog is active. `native` activates Pi-compatible `edit` and `write`; `apply_patch` activates only strict V4A `apply_patch`; `none` activates none of them. Inactive definitions are absent from the model tool list. Forced `native` / `apply_patch` / `none` ignore the model. `apply_patch` uses one Patch Core on local Linux, macOS, and Windows, and on Unix-like SSH Targets. It does not use a detached coordinator or request-level rollback; confirmed paths stay. It never silently reroutes to `native`.
- In `native` Edit Mode, `edit` and `write` keep Pi's execution semantics on a local Target but render through `ToolTui` like the other `pi-ext-tools` tools. On an SSH Target they keep that same dialect and install through Publish ([ADR-0019](docs/adr/0019-write-edit-ssh-use-publish.md)); they never silently switch the catalog to `apply_patch`. They must not show a second built-in header inside the body, and they must not fall back to Pi `renderDiff` or the built-in edit/write body. `edit` shows only its diff or error body inside the shared rails. `write` shows a new-file highlight preview when creating a file, the same split/unified diff when overwriting a file small enough to snapshot, a `wrote (N lines)` preview when the existing file is too large to snapshot, or a `no changes` row; successful `write` results retain that body after completion rather than collapsing to a header-only success row. Persisted write views store only the visible parsed diff lines or a line count; they do not copy the full old and new files. New-file and large-replace previews reread `args.content` instead of duplicating the payload. Legacy views that still contain `oldContent`/`newContent`/`content` keep rendering through the same custom body. Call-phase `edit` is header-only; call-phase `write` may show the new-file preview before the result exists.
- Native `write` header is `write <path>` with a space separator; an SSH Target prefixes warning-colored `host:` before the path, matching `read`. Collapsed and later-Trace headers dim the whole `host:path` and drop the warning color. Native `write` bodies use the pix-adapted split/unified renderer (wide terminals split, narrower terminals stack) with syntax highlighting. They own their own preview cap (`150` diff rows; new-file write shows `20` head lines plus a dim expand hint) and disable the shared `ToolTui` tail cap so the start of a diff is not cropped. Diffs normalize CRLF before comparison so line-ending-only changes do not explode the body. Each write diff omits its own top/bottom rails so only the shared `ToolTui` rails wrap the body. The body is the preview or diff only — no `+A -D` heading. Typed `write` footer is `X byte(s) · +A -D · Y line(s) · duration` when overwriting with a diff; otherwise `X byte(s) · Y line(s) · duration`. Count nouns are singular when the number is 1.
- Native `edit` header is `edit <path>` with a space separator and no middle dot; an SSH Target prefixes warning-colored `host:` before the path, matching `read`. Current-Trace summaries are not dimmed, while historical collapsed headers still dim them, including `host:path` without the warning color. It captures the pre-edit file to render each requested replacement as a pix-adapted split/unified diff block: three context lines, absolute file-line gutters, syntax highlighting, and narrow-terminal unified fallback. Context rows are one cell-width-safe line clipped to the live TUI width with a dim trailing `…`; add/remove rows may still wrap. Multiple replacements render in request order with a dim `…` in the line-number column; skipped context inside a block uses the same omission. All blocks share the widest line-number column. Each diff block omits its own top/bottom rails so only the shared `ToolTui` rails wrap the body. `edit` disables the shared `ToolTui` tail cap so a diff is not cropped from its beginning; its own per-block `MAX_RENDER_LINES` cap remains. The body is only the diff blocks — no `+A -D`, `at line N`, or `N edits` heading. Typed footer is `N edit(s) · +A -D line(s) · duration` (`4ms` or `1.0s`). `edit` and the `+A -D` unit are singular when that count is 1. Resumed Pi-native edits use their persisted unified patch; if that patch is absent or invalid, the persisted text remains visible instead of an empty body.
- A Write or Edit Unconfirmed Path Outcome uses warning-colored `?`, must not render its diff as applied, sets `isError: true`, and tells the model to `read` that path on that Target before another mutation. NotApplied is dim and is not a success diff. Resumed native `edit` results prefer the persisted `pi-ext-tools` view captured at execution. Older Pi-native results may fall back to their persisted unified patch for the same gutter/diff renderer and for collapsed `N edits · +A -D lines`; they never read the current workspace to reconstruct history. Duration absent from persisted typed details stays absent rather than being inferred from model-visible text.
- An unexpanded successful text `read` uses the same gutter and highlighting as native `edit`: ` XXX │ ` plus cli-highlight from the file path, ten head lines, a dim line-number-aligned `…` / `┊` omission whose body is `(N hidden lines, ctrl+o to expand)`, then nine tail lines when more than nineteen lines were returned. Expanded text reads keep that renderer for the full returned range. Its full header is `status read [host:]path[:range]`; a remote or output `target` prefixes warning-colored `host:` before the path. An explicit `limit` shows inclusive `start-end`, while no `limit` shows at most `:start`. Collapsed and later-Trace headers dim the whole `host:path[:range]` instead of keeping the warning prefix. TUI rows derive one-based source line numbers from the request only; model-visible content stays Pi-native and unnumbered. The footer is `Unicode-code-point char(s) · returned line(s) · duration`. Count nouns are singular when the number is 1. Every preview row is one cell-width-safe line: it reserves the source-line prefix and a dim trailing `…` before truncating content, and never wraps. Error, partial, and image reads retain Pi native render behavior.
- All tool UI compaction and truncation markers use dim `…`; model `content` and Output recovery remain unmodified. Grep and find `in [host:]path` use the same warning-colored `host:` prefix as `read` on the current Trace; later-Trace headers dim the whole `in host:path`. Their body paths, and bash body text share the terminal default on the current Trace and `dim` on a later Trace. They do not use the theme `text` token. Grep body file headings are relative to the search path and are omitted when that path is a single file. Truncated `…/tail` headings and path-like spans inside highlighted source follow that same tone and stay dim syntax on the match line; match ranges use `success` over full-intensity syntax-colored source.
- Streaming and completed states SHOULD share a visual grammar while remaining distinguishable.
- `apply_patch` 的 live block 使用 `◐ apply_patch N file(s)`、一个 rule、operation rows、一个 rule 与 typed footer。SSH Target 的 header 为 `◐ apply_patch (host) N file(s)`，`(host)` 含括号用与 read 相同的 warning 色；operation rows 的 path 为 warning 色 `host:path`。collapsed 与后续 Trace 将 `(host)` 与 `host:path` 一起 dim 并去掉 warning 色。任一 Target 的 live row 在该 path 的 Publish 确认之前不得变为 `✓`/`!`/`✗`。Unconfirmed 终态用 warning 色 `?`，不是 `✓` 或 `✗`（`✗` 表示确定未写入）。header 与 footer 的 count nouns 在 N=1 时用单数。模型生成 tool arguments 时，纯计算的 `renderCall` 从 partial `args.patch` 识别已换行的 operation header 与 hunk 行，显示 `○ create|modify|delete path +A -D`；`○` 只表示当前 prefix 已识别出该 operation，不表示路径已验证、已入队或会成功 apply。该阶段不读取 workspace、不持久化 preview。Pi 在完整收到 tool 参数后才调用 `execute()`；Patch Core 解析完整 envelope 后取得 mutation lock，再按 V4A 顺序 Publish。每个 progress snapshot 都会交还事件循环，以便 host 在 final outcome 前重绘。只有 Publish 确认才能转为 `✓`/`!` 并计入 actual totals；Rejected 转 `✗`，Unconfirmed 转 warning 色 `?`，NotApplied 转 dim `–`。同一 path 任一 hunk 失败则整档不 Publish，显示 `✗` 与 hunk 诊断，原档不动。`create`、`modify`、`delete` 使用 `toolTitle`，本地路径使用 base theme；状态 glyph、delta、fuzzy score 与 rejection diagnostics 保持各自的语义色彩。fuzzy Changed 以 `!` 并在末尾用 `dim` 显示最低 hunk score。仅 Changed+Rejected 时为 warning、`isError: false`；出现 Unconfirmed 或 NotApplied 时 `isError: true`。展开后的 applied hunk 用与 native edit/write 相同的 split/unified renderer（宽终端 split，窄终端 unified），而不是 Pi `renderDiff`；未展开仍只显示 operation rows。add/delete snapshot 只保留最多 150 行可见窗口，不把整份新文件或被删文件写进 persisted result。live progress 仅存 Trace session state，final Patch Outcome 持久化，resume 不伪造 live 或 model-time preview state。`/reload` 取消进行中的 execute，不重连 mutation。
- `bash` current-Trace header is `status bash <command>` with the command in `muted`; a multi-line command is joined into one logical line with `; ` (a trailing `\` continuation or `;` joins with a space), and the header declares `headerLine: "truncate"` so a wide command is cut with a dim `…` instead of wrapping, keeping the timeout suffix visible. A remote SSH Target inserts warning-colored `(host)` before the command: `status bash (host) <command>`. Collapsed and later-Trace headers dim `(host)` and the command together and drop the warning color. 如果 60 秒自动转后台被 admission 拒绝（例如任务容量已满或本 session 的 registry 已关闭），命令保持前台运行，结果文本与 typed detail (`transitionRefused`) 明确说明转换未发生，并同时给出一次 warning 通知；不能只让模型从缺失的 task id 去猜。 This parenthetical host is bash-only; `read` / `grep` / `find` keep warning-colored `host:` on paths. Timeout suffix stays `dim`.
- The command itself is a request body: one row per command line, wrapping instead of truncating, with terminal escapes stripped and the head kept behind a dim `… (N later lines, ctrl+o to expand)` hint. The header summary stays for scanning, so a wide multi-line command is shown twice: truncated once in the header and in full in the request body.
- Unexpanded bash output keeps at most 10 logical lines: a dim `… (N earlier lines, ctrl+o to expand)` hint plus the tail. `N` is total logical lines emitted minus the visible tail, not wrapped display rows and not the current byte-window line count. Each body row is one cell-width-safe logical line with a dim trailing `…`. Header, request body, paired rails, and typed footer stay outside that limit.
- `todo` 使用共享 `ToolTui`：header 是 `todo #1 #2 #3`（本次涉及的 task id，无中间点）；mutation body 只显示该次 typed operation outcome，`list` body 按 active、pending、blocked、completed 显示 task rows；footer 只显示 `active #X · N pending · duration`。未展开 Todo body 最多八条 task rows并保留 `… +N more`，展开后显示全部。Todo 取消 `above-editor` widget，改用 Pi 原生 Footer 状态行（`ctx.ui.setStatus` 靠左展示）显示轻量会话状态（未完成/进行中显示 `◐ #<id> <subject>`，刚完成在有后续进行中任务时显示 15 秒、否则保留展示 3 分钟，阻塞保留展示 15 秒，无内容或超时后清空状态并保持零纵向占位）。
- `pi-subagents` 仅在 interactive TUI parent 显示 ext-core-managed `aboveEditor` widget，投影 `list()` 中的活 child（`starting | running | idle`；`done | stopped | failed` 一律隐藏，与 mode 无关）。无边框；标题用 `accent`/`dim` 计数，名称优先 `display_name` 否则 `name`（`text`），id 用 `dim`，running 用 `accent`，interrupted 与 `last known` 用 `warning`，自 spawn 起的 elapsed 用 `dim · 12s`（有可见 child 时每秒刷新，不读文件）；有 summary 时用 `dim` 跟在状态后；`truncateToWidth` 保证窄/宽 cell-width safe。零可见 child 时隐藏；Headless/RPC 不挂载。TUI child 另挂一行无边框身份：`[agent] child · report via contact_parent · N tools`。Widget 不是 ownership 或 liveness 真源。
- `task` 使用共享 `ToolTui`：header 为 `status task <agent> <purpose>`（purpose 取任务首行，超长以 dim `…` 截断并声明 `headerLine: truncate`）。任务 id 在 UI 里用短 id（`agent-1`），工具参数、错误与 `wait_tasks` 一律用完整 id（`agent-<runtime>-1`）。footer 只显示 typed detail：短 id 与状态。后台结果通知沿用 registry 的完整 id 与 purpose，并在末尾标明结果是委派输出而非新的用户指令。共享 registry 未安装时 `task` 不激活：它不会出现在可用工具中，被调用时也只说明缺少集成服务，不静默转发到 `spawn_subagent`。
- opt-in `eval` 使用共享 `ToolTui`，label 为 `eval py`（唯一 kernel 是 Python）。call phase 显示一行 header `status eval py <flattened code> (reset)? (timeout Ns)?`：code 用 `; ` 合并、以 `muted` 呈现并声明 `headerLine: "truncate"`，`reset` 与 `timeout` 作为 dim 的 call facts 附在 summary 之后。code cell 本身是 request body：逐行原样显示、按宽度换行、剥离终端控制序列，保留头部最多 10 行（其后一行 dim `… (N later lines, ctrl+o to expand)`）。result phase 按 execution 顺序显示 printed text、bounded display values、nested tool traces 与 final value，未展开时最多 10 行，随后显示 `N output row(s) · N nested call(s) · duration` footer。nested trace 优先复用该 canonical tool 的 renderer；unavailable historical renderer 降级为 typed name、input summary 与 result/error summary。details 缺失时保留 persisted model-visible text，不重跑 code 或读取 workspace。current、partial、final、cross-trace 与 resumed rendering 都只有一套 ToolTui frame；宽度与 collapse 规则沿用本节通用 contract。Eval settings form presents `Enable Eval`, `Enable Code Mode`, and `Python interpreter`; Code Mode remains visibly inactive until its exposition is implemented, and all values apply after reload or a new session.
- NEVER fabricate counts, metrics, deltas, or success state absent from the underlying result.

### Lists and Forms

- Lists keep one focus point, stable selection/indentation slots, and stable columns while scrolling.
- Descriptions, providers, scroll metadata, and ordinary empty states use `muted` or `dim`.
- Current/confirmed values MAY use `success` with `✓`.
- Forms use aligned label/value rows; informational rows are not focusable and disabled values use `dim`.
- List-valued settings open a nested editor with one focus list. The editor exposes existing items and an add action, keeps selection geometry stable while add/edit/remove/reorder changes occur, and handles `Esc` before its parent form.
- Prefer compact in-place editing/cycling; use Pi native input/editor for free-form values.
- Forms SHOULD keep their geometry stable while editing.
- Long labels MAY marquee only while selected and non-editing.

### Overlays

- Use overlays for bounded tasks or compact information, not as a second application shell.
- Prefer one page and one focus region unless hierarchy is required.
- Clamp dimensions to the terminal and avoid horizontal overflow.
- A native Pi editor/prompt MUST NOT compete with an active overlay for focus.
- Closing or aborting MUST leave no stale surface.

### Frames and Backgrounds

- A component owns its frame, background, title, padding, dimensions, clipping, scrolling, and line filling as one visual unit.
- Frames are structural; rounded, square, or absent frames are all valid.
- Frame and background are independent choices and MUST use existing semantic tokens.
- Avoid generic wrappers until multiple components demonstrate genuinely identical behavior.
- NEVER nest frames/cards solely to create visual hierarchy.

### Editor-Adjacent UI

- Widgets and rails are status-oriented, normally unframed, and do not take editor focus.
- Use compact semantic formatting and stable left/right regions.
- Preserve usable editor height; temporary status SHOULD disappear when no longer useful.
- Editor text uses `text`; the hardware cursor remains host-owned.
- Editor borders use existing thinking/mode tokens or `borderMuted`.
- Response telemetry, when present, is secondary and low-emphasis.
- Completed response telemetry appears on the bottom rail after `message_end`, including normal responses and responses containing tool calls. It stays visible for the rest of the running request, is replaced by the next response, and is dismissed 15 seconds after the run ends, without adding vertical space.

## Responsive Design

Design the same interaction model for narrow and wide terminals.

- Wide layouts MAY place related regions side by side and expose secondary metadata.
- Narrow layouts SHOULD stack regions and hide optional legends/details while preserving content, focus, and required actions.
- Avoid horizontal scrolling unless the underlying content is inherently horizontal.
- Fixed regions clip or scroll internally rather than changing overall height.
- Cursor-bearing inputs SHOULD preserve one trailing visible cell where practical.
- NEVER create a separate interaction model solely for narrow layouts.

## Accessibility and Rendering

- NEVER rely on color alone; pair it with glyphs, text, structure, or position.
- Maintain semantic contrast across Pi themes.
- Re-render after visible state changes and rebuild cached theme-dependent output after theme changes.
- Pi re-renders every mounted component on every frame: a component MUST derive its rows once per width instead of repeating cell-width truncation each time, and MUST keep that cache inside one component instance, because the host re-running a renderer is what rebuilds theme-dependent and collapsed output. A cache keyed by rendered text and width (as `pi-settings` fits its rows) is exempt: the key already contains the theme-dependent string, so a theme change produces a different key instead of a stale hit.
- `truncateToWidth` costs ~4-6us on any row carrying ANSI styling or non-ASCII glyphs, against ~0.1us for plain ASCII, because it falls back to `Intl.Segmenter`; any per-frame row fitting must therefore be cached by `(text, width)` rather than recomputed.
- Rendering MUST remain ANSI-safe, Unicode-width-safe, and terminal-cell-width-safe.
- UI changes SHOULD be tested at representative narrow and wide sizes and verified in Pi or `tui-replay`.

## Feature Specs

[`DESIGN.md`](http://DESIGN.md) owns shared visual and interaction invariants. Exact dimensions, row counts, feature shortcuts, field layouts, command presentation, and other feature-specific behavior belong in the owning feature's design or architecture document.

Promote a feature rule into this document only after it becomes a genuinely shared pattern.

[`pi-optimizer`](docs/optimizer/README.md) 的 `/optimizer` 使用 Pi 原生选择与输入对话框；四项功能与 RTK 路径共享同一 Settings provider。Esc 取消当前层，不写入未确认值；会话关闭时通过 signal 关闭对话框。T2S、Prompt、RTK 的实际注入与设置结果通过原生 custom entry 即时显示为对话 info：默认 dim 摘要，展开完整 payload，错误以 warning 语义标明。记录支持 resume，Headless 消费 `entry_appended`；不进入模型上下文、不触发额外 turn。