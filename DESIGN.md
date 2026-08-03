# HEPI Terminal UI Design

## Scope

This is the living UI and UX specification for HEPI terminal surfaces. It
defines visible hierarchy, layout, interaction, and Pi theme-token usage. It
does not define feature architecture, persistence, lifecycle, metrics, or other
non-visual behavior.

Every agreed UI or UX decision that changes these rules updates this document in
the same commit. Implementations must use the active Pi theme through its token
names; never introduce hard-coded color values.

## Visual Language

HEPI is quiet, semantic, and terminal-native. Reading content is dominant.
Color, backgrounds, borders, and whitespace communicate state and hierarchy;
they are never decoration.

Use Pi theme tokens by their actual names:

| Role | Pi theme token |
| --- | --- |
| Primary reading text | `text` |
| Focus and selection | `accent` |
| Secondary and tertiary text | `muted`, `dim` |
| Status | `success`, `warning`, `error` |
| Structure | `border`, `borderAccent`, `borderMuted` |
| Thinking | `thinkingText` |
| Selection background | `selectedBg` |
| User message | `userMessageBg`, `userMessageText` |
| Extension message | `customMessageBg`, `customMessageText`, `customMessageLabel` |
| Tool states | `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput` |
| Markdown | `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` |
| Diffs | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| Editor mode | `thinkingOff` through `thinkingMax`, `bashMode` |

Use `accent` for the single active focus point. Use status tokens only for
status. Do not give modules their own accent colors or add a token when an
existing semantic token expresses the role.

## Typography And Layout

- Use the terminal default font and normal terminal cell size.
- Use bold for labels and headings; use italic `thinkingText` for thinking.
- Keep assistant prose on the terminal background.
- Use one terminal cell of padding inside user messages and tools. Inline
  content, metadata, and footer content normally use zero padding.
- Use one blank line between adjacent semantic blocks when separation is needed.
- Use full-width single-line borders for framed regions. A surface may explicitly
  choose a rounded, square, or absent outer frame; frame shape is independent
  from whether the surface has a background. Do not use shadows, gradients, or
  nested cards.
- Every rendered line must fit the available width. Wrap prose; ANSI-safely
  truncate metadata and status text.
- Keep control and row dimensions stable. Selection, status, and label changes
  must not shift adjacent content.

## Shared Interaction

- Reuse shared core UI primitives for panels, split layouts, selectable rows,
  key hints, wrapping, and clipping when they exist.
- A selected row begins with `→ ` and unselected rows reserve the same width.
- Use `↕`, `↔`, `↵`, and `⎋` for compact keyboard hints. Use `␣` or `⇥` only
  when Space or Tab is a distinct action.
- Shortcuts that are not self-evident remain visible near their control.
- Empty states use `muted` or `dim` unless they represent a failed operation.

### Mouse Selection

- Mouse text selection reuses `accent` and `selectedBg`; it does not introduce a
  mouse-specific token or rely on color as the only selection signal.
- A page owns the visible selection range and its cell-to-text mapping. Core
  dispatches input and capture but does not render a generic selection overlay.
- Enabling mouse tracking gives the active surface temporary terminal mouse
  ownership; native terminal selection may be suppressed or changed. With no
  active mouse region, Pi's default terminal input behavior remains unchanged.
- Mouse selection has no implicit hover, click, or clipboard affordance. Copying
  is an explicit page or command action.

## Surfaces

### Messages And Tools

- User messages use one `userMessageBg` block with `userMessageText` and
  one-cell padding. Do not add avatars, nested cards, or decorative labels.
- Assistant messages normally have no background. Separate content blocks with
  whitespace; show errors with `error` after available partial content.
- Thinking uses italic `thinkingText`. A collapsed state is one concise label,
  not a large placeholder panel.
- Tool execution uses one padded block with `toolPendingBg`, `toolSuccessBg`,
  or `toolErrorBg`. Use `toolTitle` for its title and `toolOutput` for output.
- Shell execution uses a full-width frame. Its command header uses `bashMode`;
  output uses `muted`.
- Extension messages use one `customMessageBg` block with
  `customMessageLabel` and `customMessageText`.

### Selectors And Settings

- A selector has one focus point. Selected text uses `accent`; the current
  value may use `success` with `✓`.
- Descriptions, provider names, scroll information, and no-match messages use
  `muted` or `dim`.
- Settings use `accent` for the selected label and value, `muted` for normal
  values, and `dim` for descriptions and hints.
- Group headers start at column zero. Field rows retain the selection slot and
  child indentation.
- Long selected setting keys may marquee only while non-editing and selected;
  all other content remains static.
- `pi-settings` owns the generic Settings page and exposes `pi-loadout` as a router page. Settings
  owns generic field rendering and editing; `pi-loadout` owns activation policy and state; the core
  Extension page router owns only tab navigation and shared page framing.
- An Extension page router uses `←`/`→` to switch tabs only after the active page does not handle
  the key; `Esc` closes the router. Show the compact `↔` hint near the tabs. Do not add a separate
  tab-strip focus region.
- The Settings host hides core-managed editor-adjacent widgets for the lifetime of its custom
  surface, then restores them when it closes. This applies only to widgets registered through the
  core contract; do not claim control over unknown direct Pi widgets.
- Loadout uses one unframed selector page: Tools and Skills share its grouped resource list; the
  selected resource has one Description block, rather than inline descriptions on every row. A wide
  layout is list, conditional scrollbar, then Description; a narrow layout stacks list then
  Description. Within each resource kind, Built-in resources come first; registered resources then
  sort by display group and name.
- Loadout status is textual and glyph-backed, and shows the raw selection, not just the effective
  state: `●` is explicitly enabled, `○` is explicitly disabled, `◌` is inherited (no local decision;
  the effective state follows the default or the other scope), and `⊘` is conflict-locked/inactive.
  The Description block's Status line mirrors the row glyph with a text label. The selected row
  retains the standard `→` slot. Display group is secondary metadata; the Description block shows
  name and kind first, then the wrapped resource description (like any tool row), origin, status,
  and — for an open detail — a read-only `Path:` line. It adds a lock winner only for a
  conflict-locked resource.
- Loadout uses `Ctrl+P` to switch Global and Project scope, `Space` to cycle only the selected
  resource's reachable scope choices, and direct text input to filter resource name and display
  group. Global and Project-private rows remain binary; only global-visible Project rows include
  `inherit`. `Esc` clears a filter before closing. Do not overload `←` or `→`, which remain router
  navigation.
- A resource detail (nested settings surface) may reuse the Settings model cycler: `Enter` opens a
  single selector on the field, `↑`/`↓` wrap through that field's options modulo the list (same as
  the Settings enum editor), `Tab`/`Shift+Tab` cycle the related `tabCycle` field's value forward
  and backward in place (no second focus), `Enter` applies both and saves, `Esc` cancels. The
  detail keeps a fixed row count while selecting: the field row shows the current option in place
  and no option list is expanded. While a detail is open, `Esc` is offered to the detail first; the
  detail only exits to the list when the detail declines it.
- A detail form renders like the Settings field list: one aligned label/value pair per row, the
  focused row in accent (with the standard `→` slot), and no key-hint row (its navigation matches
  the list, so the hint would be noise). Pure informational rows are not focusable. In an agent
  detail, `Description` and `Body` are external-editor actions: each value is exactly `edit`, with
  `↵` pinned to the right edge of the value column; `Enter` opens Pi's native editor with the
  current field value.
- A contributor detail buffers edits until the Loadout page closes: nothing is written while the
  panel is open, and `close()` flushes every registered detail (not just the currently open one),
  each scope writing all its dirty snapshots before one catalog reload. The Description and Body
  actions delegate editing to the Pi host: every command that opens the shared router mounts it as
  an overlay; ext-core temporarily hides it while `ui.editor()` owns focus, then shows and refocuses
  the same overlay without closing or rebuilding its page state. Editor cancel leaves the draft
  unchanged; session abort or surface close never refocuses a disposed overlay. A per-scope target
  lets the same contributor serve Global and Project scope. A backingless built-in materializes in
  the selected scope: Global writes the Pi agent directory, while Project writes `.pi/agents/`;
  Project edits never rewrite the global backing. The `Status:` header line is followed by a read-only `Path:` line showing the current
  scope's target, truncated from the head at directory boundaries (one leading `…`, then whole
  segments only) so the file name and the longest complete suffix survive narrow widths.
- A detail form keeps the resource description visible: it wraps after the title at full length
  while browsing, and is clamped to three lines only while the detail is actually open so the
  form below keeps its rows. There is no `↵ Edit config` footer hint — row activation is already
  visible from the glyph and the `↵` slot on detail-bearing rows.
- A resource detail is reachable only while its row is explicitly `enabled`: inherited and
  disabled rows show no `↵` slot and `Enter` does not open the detail. Row activation
  (inherit/enabled/disabled) stays under the Loadout policy key (`agent:<name>` for agents), never
  in the contributor's own file format, so a contributor-owned editor cannot silently toggle what
  the policy owns. The focused row is always accent; a read-only row is only dimmed while
  unfocused.
- Settings uses the legacy combined provider tree, not one page per provider. Its wide layout is
  grouped field list, conditional scrollbar, then one unframed field Description block; narrow
  layout stacks those regions. Field label/value columns remain stable, disabled fields use `dim`,
  and only a selected non-editing long label may marquee. `Space` toggles booleans; Pi Input edits
  other fields; `Tab` only cycles a field's related `tabCycle` value.
- `pi-mctx` contributes Historian enablement and model selection to the combined Settings tree, not
  a separate page or Loadout resource. Disabling Historian dims and locks its model row; persisted
  changes apply on the next Pi reload or session rather than replacing a running historian.
- Settings and Loadout each reserve at least 20 page-content rows below the shared router tab strip.
  Their lists may remain shorter than that minimum; router-owned blank rows retain a stable custom
  surface height instead of inventing empty list entries.
- Settings and Loadout render exactly 20 content rows in their wide layouts. Their list metadata
  occupies the first rows, key hints occupy the last row, and a conditional scrollbar occupies its
  own vertical column between the list and Description. It is never appended to list values.
  Selected rows remain near the center of the list viewport until either scroll boundary is reached;
  Description content clips within the fixed panel instead of changing its height.
- Settings and Loadout filter inputs retain one trailing cell after their visible query so the cursor
  does not visually touch the list boundary.
- Settings label/value columns and Loadout name/group columns size from the complete filtered list,
  remain stable while scrolling, and align from the left with at least one cell between them. Do not
  spend surplus list width to right-align a value or group.

### Frames And Backgrounds

- Each TUI component owns its outer frame, optional rectangular background,
  title, padding, height, scrolling, and ANSI line filling together. Do not
  extract those details into a shared wrapper without demonstrated common
  behavior.
- A background uses an existing Pi semantic token chosen by that component; do
  not introduce a new theme token. Framed or background-filled surfaces keep
  their rendered rectangle cell-width stable. A frame is structural, not
  decorative; absent frame and absent background leave content visually
  unframed.

### Editor And Status

- Editor text uses `text`. The cursor remains Pi's hardware cursor marker.
- The editor border uses `thinkingOff` through `thinkingMax` for thinking level,
  `bashMode` for shell mode, and `borderMuted` otherwise.
- The top rail wraps the first editor line. Its left side shows model, Advisor,
  thinking level, and context state; its right side holds session-title state
  only when it fits without truncation.
- The tail rail is one fixed row below the editor. It begins with the working
  directory in `dim`, followed by compact extension status in registration
  order.
- Persistent content above and below the editor uses unframed widget bands. A
  band may split into left and right content, but must reserve the editor's
  readable height and hide lower-priority complete blocks before clipping a
  block. Content is status-oriented, uses `text`, `muted`, `dim`, or semantic
  status tokens, and does not take editor keyboard focus.
- Todo shows a newly blocked task as temporary retired work: glyph and subject
  use `dim` and the subject is struck through. After two later assistant turns
  without a Todo update, it hides the blocked row rather than reserving an
  editor-adjacent line indefinitely.
- The top and tail rails share one priority order for width pressure. Keep their
  rows stable; truncate or hide lower-priority fragments before changing a
  higher-priority fragment's position.
- Response telemetry, when present, is one dim output line after an assistant
  response. It is secondary to the response content.

### Context Status Overlay

- `/mctx status` (and bare `/mctx`) is one centered, single-page read-only overlay, not a page-router
  page or a widget. Its outer frame is rounded and uses `borderMuted`; content
  uses only existing Pi semantic theme tokens, never hard-coded colors or
  module-specific accents. The frame width is 78 columns when available and is
  clamped to the terminal at narrower widths.
- Keep a fixed 20-row frame: outer top, 17 content rows, one footer row, and
  outer bottom. All runtime states (`active`, `inactive`, `failed`, and `stale`)
  keep these rows, including when a snapshot does not own a value; reserve that
  slot rather than inventing zero, healthy, or legacy metrics.
- Content rows follow this legacy-like hierarchy and never move:
  1. `⚡ Magic Context Status` plus semantic runtime state;
  2. blank separator;
  3. muted `Context` section label;
  4. `Context  pct · used / limit tokens` when snapshot usage exists;
  5. full-width usage bar;
  6. blank separator;
  7. `Counts:`;
  8. compartment detail (`m0`, `m1`, `total`);
  9. muted `Tags` section label;
  10. tag counts (`active`, `pending`, `dropped`) and protected tags;
  11. blank separator;
  12. `Historian:`;
  13. historian state and last failure class;
  14. effective trigger thresholds;
  15. partition revision and pending sidekick augmentation;
  16–17. wide-only `Project` and `Session` identity rows.
  On narrow layouts rows 16–17 remain blank, rather than being repurposed.
- Usage bar is one full-width, single-color semantic bar: `success` below 65%,
  `warning` from 65% up to (but not including) 80%, and `error` at or above
  80%. It must not
  reproduce legacy hard-coded category colors. Missing usage keeps its row but
  shows no fabricated value or bar state. Every line fits available width;
  truncate lower-priority values within their cells without shifting rows.
- Do not render unavailable legacy-only fact, memory, note, Dreamer, embedding,
  upgrade, cache, work-token, or category-breakdown metrics. The overlay does
  not reactivate parked systems or claim metrics absent from the current
  snapshot.
- Footer reads `Press Escape to close · Enter / Ctrl+C also close`; these keys
  close overlay. It has no page-router navigation or editing focus.
- Refresh once per second only after surface admission. Refresh must not cause
  row displacement; reserve stable rows for changing values and truncate within
  their existing cells.
- Validate layout at 48x20 and 100x24. Pi host owns usage/theme/custom UI;
  ext-core owns `openTuiSurface` admission, FIFO, abort, and cleanup; status
  rendering consumes the MCTX snapshot and does not define another lifecycle
  abstraction.

### MCTX Command Suggestions

- MCTX registers one `/mctx` slash command. First-argument autocomplete lists only active lowercase
  subcommands and gives each item a concise description; parked behavior is neither suggested nor executable.
- Bare `/mctx` opens the read-only status overlay. `/mctx status` is the explicit equivalent; `/mctx aug
  <query>` owns free-form query text, so autocomplete stops after the `aug` token instead of inventing query
  suggestions.
- Unknown subcommands and invalid arguments show canonical syntax without opening a surface or starting work.
  Deprecated `/ctx-*` aliases are not registered.

### Patch Presentation

- A collapsed `apply_patch` call uses a compact semantic summary, not a diff
  card.
- Action labels use `accent`; paths use `dim`; additions use `toolDiffAdded`;
  removals use `toolDiffRemoved`.
- Failure labels use `error`; partial failure uses `warning`. Failed paths do
  not display fabricated line deltas.
- A streaming patch preview uses the same visual grammar while remaining visibly
  distinct from a completed result.

## Accessibility And Resilience

- Never use color as the only selection or status signal.
- Keep contrast and semantic token choice meaningful across the active Pi theme.
- Re-render after visible state changes and rebuild cached theme-dependent
  content when the theme changes.
- Verify changed UI at affected narrow and wide terminal dimensions. Validate
  visible behavior in Pi or `tui-replay` when the change affects rendering or
  interaction.
