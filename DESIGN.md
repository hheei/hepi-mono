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
- `ToolTui` owns status headers, Trace collapse/resume, the body's paired rails, and footer placement. Tool renderers retain their semantic colors, widths, collapse rules, model-visible `content`, and body component caches, but never add outer rails or typed footers. When the body has no rows, omit both rails and show only its typed footer when present.
- A completed prior Trace collapses only while Pi global tool expansion is off. Current-Trace tools keep their full frame and wrap their headers rather than truncating them; the next `agent_start` collapses prior Traces. A collapsed tool renders `status header -> blank line -> tool-owned metrics footer`; its non-status parameters, paths, and ranges use `dim`, and its header uses dim `…` truncation when necessary. Expanding tools restores its full frame. A Trace is `agent_start` through `agent_end`; resume treats every historical tool as prior.
- A collapsed footer uses only tool-owned typed details, a wrapper-captured execution duration, or a caught single-line error message. It never parses model-visible `content`.
- `grep` collapses to `N matches · M files · L lines · duration`, or FFF fallback `N fuzzies · M files · L lines · duration`. Its current-Trace header follows the shared wrapping rule; only a historical collapsed header is compacted. Every grep body row follows `read`'s single-line, ANSI- and cell-width-safe truncation rule, using a dim trailing `…` rather than wrapping. When any match in one file is left-truncated, every match row for that file reserves one dim cell immediately after its `│`: the truncated row shows `…`, while other match rows show a blank gutter so matched body text aligns.
- FFF-backed `find` fully represents its call in the shared header: `status find /pattern/ in path`; it has no duplicate pre-result body. `ToolTui` frames its result-phase body with paired rails and places the typed footer after the closing rail. The body groups typed candidates under `fuzzy files:` and `fuzzy paths:`, with direct-parent directory headings in `mdCode` followed by base-text paths. Its typed footer is `X fuzzy files · Y fuzzy paths · Z lines · duration`; `Z` counts body rows before collapse. Collapsed body omission uses dim `… (N more lines, ctrl+o to expand)`.
- `pi-ext-tools` has a static `Edit Mode` catalog setting. `native` registers Pi `edit` and `write`; `apply_patch` registers only strict V4A `apply_patch`; `none` registers neither. The setting is read during extension initialization and takes effect only after `/reload` or a new session; it never silently changes the active tool set mid-session. `apply_patch` requires Linux descriptor-relative workspace protection; unsupported platforms reject before coordinator startup and direct users to explicitly select `native`, never silently rerouting the request.
- An unexpanded successful text `read` shows an independent preview: three head lines, then a dim `… (N hidden lines, ctrl+o to expand)` omission row, then two tail lines when more than five lines were returned. Its full header is `status read path[:range]`; an explicit `limit` shows inclusive `start-end`, while no `limit` shows at most `:start`. TUI rows derive one-based source line numbers from the request only; model-visible content stays Pi-native and unnumbered. The footer is `Unicode-code-point chars · returned lines · duration`. Every preview row is one cell-width-safe line: it reserves the source-line prefix and a dim trailing `…` before truncating content, and never wraps. Expanded, error, partial, and image reads retain Pi native render behavior.
- All tool UI compaction and truncation markers use dim `…`; model `content` and Output recovery remain unmodified. Grep paths retain `mdCode`; its line-number prefixes and non-matching body text use `dim`, while matching ranges use `success`.
- Streaming and completed states SHOULD share a visual grammar while remaining distinguishable.
- `apply_patch` 的 live block 使用 `◐ apply_patch N files`、一个 rule、operation rows、一个 rule 与 typed footer。Pi 在完整收到 tool 参数后才调用工具；工具每解析完一个完整 V4A operation 即发布 `○ create|modify|delete path +A -D`，该状态只表示语法已解析，不表示路径已验证或会成功 apply。解析完成后才取得路径锁、进行全量路径验证、staging 与 apply；每个 parsed 或 committed progress snapshot 都会交还事件循环，以便 host 在 final outcome 前重绘。只有 commit progress 才能转为 `✓`/`!` 并计入 actual totals，rejection 转 `✗`。`create`、`modify`、`delete` 使用 `toolTitle`，以对齐工具名称。部分成功的 update 必须显示 `! modify path +A -D (A/T hunks applied; reason)`，并在模型结果中列出同一 hunk 比例与失败诊断；fuzzy update 也以 `!` 并在末尾用 `dim` 显示最低 hunk score。live progress 仅存 Trace session state，final Patch Outcome 持久化，resume 不伪造 live state。coordinator socket 包含协议 revision，因此 `/reload` 后的 extension 不会连接旧版本 detached coordinator。
- Bash body independently keeps at most 12 rendered rows in both streaming and completed states. Its header, paired rails, and typed footer remain outside that body limit.
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