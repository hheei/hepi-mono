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
- A tool frame has one body. Omit its paired rails when that body has no rendered lines:

  ```text
  ✓ tool summary · metadata
  ─────────────────────────  opening rail
  tool body                  tool-owned
  ─────────────────────────  closing rail
  typed footer               optional, tool-owned text
  ```

- Pi `renderCall` and `renderResult` are host lifecycle slots, not separate visible sections. Before a result exists, the call slot may carry the one body; once a result exists, the call slot retains only the header and the result slot owns the body.

- When the header fully represents a tool call, omit a duplicate pre-result body. `grep` and `find` use only the header until their result body exists.
- `ToolTui` 由 `pi-ext-core` 提供给独立 extension：它拥有 status header、跨 extension 的 Trace collapse/resume、body 的 paired rails、footer placement 与默认未展开 body 高度。每个 Pi host 只有一个共享 Trace controller，`agent_start` 推进一次 Trace；concrete extension 仅调用 `frame(tool, presentation)`，并继续拥有其 tool 语义、header summary、body、typed footer 与 warning 判定。
- A completed prior Trace collapses only while Pi global tool expansion is off. Current-Trace tools, including model-time `renderCall` previews that still have no execution result, keep their full frame and wrap their headers rather than truncating them; the next `agent_start` collapses prior Traces. A collapsed tool renders `status header -> blank line -> tool-owned metrics footer`; its non-status parameters, paths, and ranges use `dim`, and its header uses dim `…` truncation when necessary. Expanding tools restores its full frame. A Trace is `agent_start` through `agent_end`; resume treats every historical tool as prior. An unexpanded body keeps at most 20 rendered rows (tail plus a dim `… (N earlier lines, ctrl+o to expand)` row). Header, paired rails, and typed footer stay outside that limit. Paired rails use `success` when the tool invoked cleanly, including in-progress calls, and `error` when the result is an error or warning (including bash non-zero exit). A tool may override `maxBodyLines`; expanded results are not capped. Tool renderers retain their semantic colors, widths, collapse rules, model-visible `content`, and body component caches, but never add outer rails or typed footers. When the body has no rows, omit both rails and show only its typed footer when present.
- A collapsed footer uses only tool-owned typed details, a wrapper-captured execution duration, or a caught single-line error message. It never parses model-visible `content`.
- `grep` collapses to `N matches · M files · L lines · duration`, or FFF fallback `N fuzzies · M files · L lines · duration`. Its current-Trace header follows the shared wrapping rule; only a historical collapsed header is compacted. Match and context rows use the same ` XXX │ ` gutter and path-based cli-highlight as `read`; matching ranges overlay `success` on the full source line. Per-file omissions use a dim line-number-aligned `…` / `┊` skip whose body keeps the recovery hint. Every grep body row follows `read`'s single-line, ANSI- and cell-width-safe truncation rule, using a dim trailing `…` rather than wrapping.
- FFF-backed `find` fully represents its call in the shared header: `status find /pattern/ in path`; it has no duplicate pre-result body. `ToolTui` frames its result-phase body with paired rails and places the typed footer after the closing rail. The body groups typed candidates under `fuzzy files:` and `fuzzy paths:`, with direct-parent directory headings in `mdCode` followed by base-text paths. Its typed footer is `X fuzzy files · Y fuzzy paths · Z lines · duration`; `Z` counts body rows before collapse. Collapsed body omission uses dim `… (N more lines, ctrl+o to expand)`.
- `pi-ext-tools` has a static `Edit Mode` catalog setting. Default `auto` resolves once at the first `session_start`: `apply_patch` when the session model provider, id, or name contains `gpt` (case-insensitive), otherwise native `edit` and `write`. The extension statically registers its canonical `edit`, `write`, and `apply_patch` definitions so resumed tool calls always resolve to the same renderers; session startup separately activates and publishes only the selected execution catalog. `native` activates Pi-compatible `edit` and `write`; `apply_patch` activates only strict V4A `apply_patch`; `none` activates none of them. Inactive definitions are absent from the model tool list and Loadout inventory. The setting and `auto` resolution take effect only after `/reload` or a new session; they never change the active tool set mid-session or on later `model_select`. `apply_patch` requires Linux descriptor-relative workspace protection; unsupported platforms reject before coordinator startup and direct users to explicitly select `native`, never silently rerouting the request.
- In `native` Edit Mode, `edit` and `write` keep Pi's execution semantics but render through `ToolTui` like the other `pi-ext-tools` tools. They must not show a second built-in header inside the body, and they must not fall back to Pi `renderDiff` or the built-in edit/write body. `edit` shows only its diff or error body inside the shared rails. `write` shows a new-file highlight preview when creating a file, the same split/unified diff when overwriting a file small enough to snapshot, a `wrote (N lines)` preview when the existing file is too large to snapshot, or a `no changes` row; successful `write` results retain that body after completion rather than collapsing to a header-only success row. Persisted write views store only the visible parsed diff lines or a line count; they do not copy the full old and new files. New-file and large-replace previews reread `args.content` instead of duplicating the payload. Legacy views that still contain `oldContent`/`newContent`/`content` keep rendering through the same custom body. Call-phase `edit` is header-only; call-phase `write` may show the new-file preview before the result exists.
- Native `write` bodies use the pix-adapted split/unified renderer (wide terminals split, narrower terminals stack) with syntax highlighting. They own their own preview cap (`150` diff rows; new-file write shows `20` head lines plus a dim expand hint) and disable the shared `ToolTui` tail cap so the start of a diff is not cropped. Diffs normalize CRLF before comparison so line-ending-only changes do not explode the body. Typed `write` footer is `X bytes · Y lines · duration`.
- Native `edit` header is `edit <path>` with a space separator and no middle dot; current-Trace summaries are not dimmed, while historical collapsed headers still dim them. It captures the pre-edit file to render each requested replacement as a pix-adapted split/unified diff block: three context lines, absolute file-line gutters, syntax highlighting, and narrow-terminal unified fallback. Context rows are one cell-width-safe line clipped to the live TUI width with a dim trailing `…`; add/remove rows may still wrap. Multiple replacements render in request order with a dim `…` in the line-number column; skipped context inside a block uses the same omission. All blocks share the widest line-number column. Each diff block omits its own top/bottom rails so only the shared `ToolTui` rails wrap the body. `edit` disables the shared `ToolTui` tail cap so a diff is not cropped from its beginning; its own per-block `MAX_RENDER_LINES` cap remains. The body is only the diff blocks — no `+A -D`, `at line N`, or `N edits` heading. Typed footer is `N edits · +A -D lines · duration` (`4ms` or `1.0s`). Resumed Pi-native edits use their persisted unified patch; if that patch is absent or invalid, the persisted text remains visible instead of an empty body.
- Resumed native `edit` results prefer the persisted `pi-ext-tools` view captured at execution. Older Pi-native results may fall back to their persisted unified patch for the same gutter/diff renderer and for collapsed `N edits · +A -D lines`; they never read the current workspace to reconstruct history. Duration absent from persisted typed details stays absent rather than being inferred from model-visible text.
- An unexpanded successful text `read` uses the same gutter and highlighting as native `edit`: ` XXX │ ` plus cli-highlight from the file path, ten head lines, a dim line-number-aligned `…` / `┊` omission whose body is `(N hidden lines, ctrl+o to expand)`, then nine tail lines when more than nineteen lines were returned. Expanded text reads keep that renderer for the full returned range. Its full header is `status read path[:range]`; an explicit `limit` shows inclusive `start-end`, while no `limit` shows at most `:start`. TUI rows derive one-based source line numbers from the request only; model-visible content stays Pi-native and unnumbered. The footer is `Unicode-code-point chars · returned lines · duration`. Every preview row is one cell-width-safe line: it reserves the source-line prefix and a dim trailing `…` before truncating content, and never wraps. Error, partial, and image reads retain Pi native render behavior.
- All tool UI compaction and truncation markers use dim `…`; model `content` and Output recovery remain unmodified. Grep paths retain `mdCode`; match ranges use `success` over syntax-colored source.
- Streaming and completed states SHOULD share a visual grammar while remaining distinguishable.
- `apply_patch` 的 live block 使用 `◐ apply_patch N files`、一个 rule、operation rows、一个 rule 与 typed footer。模型生成 tool arguments 时，纯计算的 `renderCall` 从 partial `args.patch` 识别已换行的 operation header 与 hunk 行，显示 `○ create|modify|delete path +A -D`；`○` 只表示当前 prefix 已识别出该 operation，不表示路径已验证、已入队或会成功 apply。该阶段不读取 workspace、不启动 coordinator、不持久化 preview。Pi 在完整收到 tool 参数后才调用 `execute()`；coordinator 每解析完一个完整 V4A operation 即发布同一套 pending rows，随后才取得路径锁、进行全量路径验证、staging 与 apply。每个 parsed 或 committed progress snapshot 都会交还事件循环，以便 host 在 final outcome 前重绘。只有 commit progress 才能转为 `✓`/`!` 并计入 actual totals，rejection 转 `✗`。`create`、`modify`、`delete` 使用 `toolTitle`，路径一律使用 base theme；状态 glyph、delta、fuzzy score 与 partial diagnostics 保持各自的语义色彩。部分成功的 update 必须显示 `! modify path +A -D (A/T hunks applied; reason)`，并在模型结果中列出同一 hunk 比例与失败诊断；fuzzy update 也以 `!` 并在末尾用 `dim` 显示最低 hunk score。展开后的 applied hunk 用与 native edit/write 相同的 split/unified renderer（宽终端 split，窄终端 unified），而不是 Pi `renderDiff`；未展开仍只显示 operation rows。add/delete snapshot 只保留最多 150 行可见窗口，不把整份新文件或被删文件写进 persisted result。live progress 仅存 Trace session state，final Patch Outcome 持久化，resume 不伪造 live 或 model-time preview state。coordinator socket 包含协议 revision，因此 `/reload` 后的 extension 不会连接旧版本 detached coordinator。
- Bash body uses the shared `ToolTui` unexpanded height cap. Its header, paired rails, and typed footer remain outside that body limit.
- `todo` 使用共享 `ToolTui`：header 显示 request/outcome 摘要，mutation body 只显示该次 typed operation outcome，`list` body 按 active、pending、blocked、completed 显示 task rows；footer 显示 snapshot-derived task counts 与 wrapper-captured duration。未展开 Todo body 最多八条 task rows并保留 `… +N more`，展开后显示全部。Todo above-editor widget 仍是 session overview，不与每次 tool result 混合。
- `pi-mctx` 的 `ctx_search` / `ctx_memory` / `ctx_note` / `ctx_expand` / `ctx_reduce` 使用同一共享 `ToolTui`。Header 显示 tool label 与 request summary（query、action、range、drop）；call-phase 只有 header；result body 是 model-visible text，无独立 typed footer。
- NEVER fabricate counts, metrics, deltas, or success state absent from the underlying result.

### Lists and Forms

- Lists keep one focus point, stable selection/indentation slots, and stable columns while scrolling.
- Descriptions, providers, scroll metadata, and ordinary empty states use `muted` or `dim`.
- Current/confirmed values MAY use `success` with `✓`.
- Forms use aligned label/value rows; informational rows are not focusable and disabled values use `dim`.
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
- Rendering MUST remain ANSI-safe, Unicode-width-safe, and terminal-cell-width-safe.
- UI changes SHOULD be tested at representative narrow and wide sizes and verified in Pi or `tui-replay`.

## Feature Specs

[`DESIGN.md`](http://DESIGN.md) owns shared visual and interaction invariants. Exact dimensions, row counts, feature shortcuts, field layouts, command presentation, and other feature-specific behavior belong under `docs/design/`.

Promote a feature rule into this document only after it becomes a genuinely shared pattern.