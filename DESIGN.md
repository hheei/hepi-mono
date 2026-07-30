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
- Use full-width single-line borders for framed regions. Do not use shadows,
  gradients, rounded panels, or nested cards.
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
- Response telemetry, when present, is one dim output line after an assistant
  response. It is secondary to the response content.

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
