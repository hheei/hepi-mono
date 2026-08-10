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
- A tool frame has this order; omit result rule/body until a result exists:

  ```text
  ✓ tool summary · metadata
  ─────────────────────────
  tool-call render
  ─────────────────────────
  tool-result render
  ```

- When header fully represents a tool call, omit a duplicate call body and its empty rule; `grep` does this, so its final result follows the header's single rule directly.
- Frame rules use a structural theme token. Call/result renderers retain their existing semantic colors, widths, collapse rules, and model-visible `content`.
- A completed prior Trace collapses only while Pi global tool expansion is off. Current-Trace tools keep their full block; the next `agent_start` collapses prior Traces. A collapsed tool renders `status header -> blank line -> tool-owned metrics footer`; expanding tools restores its full call/result block. A Trace is `agent_start` through `agent_end`; resume treats every historical tool as prior.
- A collapsed footer uses only tool-owned typed details, a wrapper-captured execution duration, or a caught single-line error message. It never parses model-visible `content`.
- `grep` collapses to `N matches · M files · duration`, or FFF fallback `N fuzzies · M files · duration`.
- An unexpanded successful text `read` shows an independent preview: three head lines, then a dim blank-number `│...` omission row, then two tail lines when more than five lines were returned. Its full header is `status read path[:range]`; an explicit `limit` shows inclusive `start-end`, while no `limit` shows at most `:start`. TUI rows derive one-based source line numbers from the request only; model-visible content stays Pi-native and unnumbered. The footer is `Unicode-code-point chars · returned lines · duration`. Each over-width displayed line ends with dim `>` after the cell-width-safe retained suffix. Expanded, error, partial, and image reads retain Pi native render behavior.
- Grep line compaction marks TUI-only discarded left/right text with dim `<` / `>`; model `content` and Output recovery remain unmodified.
- Streaming and completed states SHOULD share a visual grammar while remaining distinguishable.
- `apply_patch` 的 live block 使用 `◐ apply_patch · N files · +A -D lines`、一个 rule、operation rows、一个 rule 与 typed footer。每个 row 为 `○|✓|!|✗ create|modify|delete path +A -D`；`!` 的 fuzzy update 在末尾用 `dim` 显示最低 hunk score。pending 可显示 parser/preflight 的 planned delta，但只有 commit progress 才能转为 `✓`/`!` 并计入 actual totals；rejection 转 `✗`。live progress 仅存 Trace session state，final Patch Outcome 持久化，resume 不伪造 live state。
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