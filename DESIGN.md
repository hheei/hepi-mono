---
version: "alpha"
name: "Pi Basics Terminal UI"
description: "A restrained, semantic terminal design system derived from the original pi interactive UI."
colors:
  primary: "#8ABEB7"
  text: "#D4D4D4"
  accent: "#8ABEB7"
  border: "#5F87FF"
  border-accent: "#00D7FF"
  border-muted: "#505050"
  muted: "#808080"
  dim: "#666666"
  success: "#B5BD68"
  warning: "#FFFF00"
  error: "#CC6666"
  selected-background: "#3A3A4A"
  user-message-background: "#343541"
  custom-message-background: "#2D2838"
  tool-pending-background: "#282832"
  tool-success-background: "#283228"
  tool-error-background: "#3C2828"
  code: "#00D7FF"
  code-block: "#B5BD68"
  heading: "#F0C674"
  link: "#81A2BE"
  quote: "#808080"
  diff-added: "#B5BD68"
  diff-removed: "#CC6666"
  bash-mode: "#B5BD68"
  thinking-off: "#505050"
  thinking-minimal: "#6E6E6E"
  thinking-low: "#5F87AF"
  thinking-medium: "#81A2BE"
  thinking-high: "#B294BB"
  thinking-xhigh: "#D183E8"
  thinking-max: "#FF5FFF"
typography:
  body:
    fontFamily: "terminal-default"
    fontSize: 1rem
    fontWeight: 400
  heading:
    fontFamily: "terminal-default"
    fontSize: 1rem
    fontWeight: 700
  label:
    fontFamily: "terminal-default"
    fontSize: 1rem
    fontWeight: 700
  thinking:
    fontFamily: "terminal-default"
    fontSize: 1rem
    fontWeight: 400
    fontStyle: italic
  hint:
    fontFamily: "terminal-default"
    fontSize: 1rem
    fontWeight: 400
rounded:
  none: 0px
spacing:
  none: 0
  xs: 1
  sm: 1
  md: 2
  lg: 2
components:
  user-message:
    backgroundColor: "{colors.user-message-background}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  assistant-message:
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  thinking-block:
    textColor: "{colors.muted}"
    typography: "{typography.thinking}"
    rounded: "{rounded.none}"
    padding: 1
  tool-pending:
    backgroundColor: "{colors.tool-pending-background}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  tool-success:
    backgroundColor: "{colors.tool-success-background}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  tool-error:
    backgroundColor: "{colors.tool-error-background}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  selector:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  selector-selected:
    textColor: "{colors.accent}"
    rounded: "{rounded.none}"
    padding: 0
  selector-description:
    textColor: "{colors.muted}"
    rounded: "{rounded.none}"
    padding: 0
  settings-selected:
    textColor: "{colors.accent}"
    rounded: "{rounded.none}"
    padding: 0
  settings-description:
    textColor: "{colors.dim}"
    rounded: "{rounded.none}"
    padding: 0
  editor:
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  editor-thinking-off:
    textColor: "{colors.thinking-off}"
    rounded: "{rounded.none}"
    padding: 1
  editor-bash-mode:
    textColor: "{colors.bash-mode}"
    rounded: "{rounded.none}"
    padding: 1
  footer:
    textColor: "{colors.dim}"
    rounded: "{rounded.none}"
    padding: 0
  status-success:
    textColor: "{colors.success}"
  status-warning:
    textColor: "{colors.warning}"
  status-error:
    textColor: "{colors.error}"
  structural-border:
    textColor: "{colors.border}"
    rounded: "{rounded.none}"
    padding: 0
  structural-border-accent:
    textColor: "{colors.border-accent}"
    rounded: "{rounded.none}"
    padding: 0
  structural-border-muted:
    textColor: "{colors.border-muted}"
    rounded: "{rounded.none}"
    padding: 0
  selected-row:
    backgroundColor: "{colors.selected-background}"
    textColor: "{colors.accent}"
    rounded: "{rounded.none}"
    padding: 0
  custom-message:
    backgroundColor: "{colors.custom-message-background}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: 1
  markdown-code:
    textColor: "{colors.code}"
    rounded: "{rounded.none}"
    padding: 0
  markdown-code-block:
    backgroundColor: "transparent"
    textColor: "{colors.code-block}"
    rounded: "{rounded.none}"
    padding: 0
  markdown-heading:
    textColor: "{colors.heading}"
    typography: "{typography.heading}"
    rounded: "{rounded.none}"
    padding: 0
  markdown-link:
    textColor: "{colors.link}"
    rounded: "{rounded.none}"
    padding: 0
  markdown-quote:
    textColor: "{colors.quote}"
    rounded: "{rounded.none}"
    padding: 0
  diff-added:
    textColor: "{colors.diff-added}"
  diff-removed:
    textColor: "{colors.diff-removed}"
  thinking-minimal:
    textColor: "{colors.thinking-minimal}"
  thinking-low:
    textColor: "{colors.thinking-low}"
  thinking-medium:
    textColor: "{colors.thinking-medium}"
  thinking-high:
    textColor: "{colors.thinking-high}"
  thinking-xhigh:
    textColor: "{colors.thinking-xhigh}"
  thinking-max:
    textColor: "{colors.thinking-max}"
---

## Overview

Pi Basics is a focused terminal interface for repeated coding work. Its visual language is **semantic, quiet, and state-aware**: the user should be able to scan messages, tools, selectors, and status without decoding a collection of decorative colors.

The system follows the original pi interactive UI. Content remains the dominant layer. Backgrounds identify a small number of meaningful blocks, while accent and status colors communicate focus and state. Structure comes from full-width single-line borders, one-line spacing, and stable terminal-width rendering.

This document is normative for new UI work in `packages/pi-basics`. When an existing component conflicts with it, preserve behavior first and migrate the visual treatment deliberately.

## Colors

The palette is organized by semantic role rather than by feature or module.

- **Text:** `{colors.text}` is the default reading color and the most frequent foreground.
- **Accent:** `{colors.accent}` is the single interaction color for selection, cursor, focused labels, and important titles.
- **Muted:** `{colors.muted}` is readable secondary information such as metadata, tool output, descriptions, and thinking content.
- **Dim:** `{colors.dim}` is low-priority information such as hints, footer data, and non-contextual status.
- **Border:** `{colors.border}` provides ordinary structural separation.
- **Border muted:** `{colors.border-muted}` is used for an unfocused editor border or low-emphasis structure.
- **Success, warning, error:** these colors communicate state only. They are not category colors or decorative accents.

### Backgrounds

Backgrounds are low-contrast surfaces, not generic cards:

- `{colors.user-message-background}` identifies user-authored input.
- `{colors.custom-message-background}` identifies extension-provided content.
- `{colors.tool-pending-background}`, `{colors.tool-success-background}`, and `{colors.tool-error-background}` identify tool lifecycle state.
- `{colors.selected-background}` may identify a selected row when an arrow and accent text are not sufficient.

Do not introduce a new background for a new feature until the feature has been classified as one of these semantic roles.

### Thresholds

Context usage is a progressive warning:

- Below 70%: normal dim footer treatment.
- Above 70%: `{colors.warning}`.
- Above 90%: `{colors.error}`.

Empty states are not errors by default. Use muted text unless the empty state represents a failed operation.

## Typography

Terminal typography uses the terminal's default font and does not rely on font substitution or viewport-scaled sizes.

- **Body:** normal weight, `{colors.text}`.
- **Heading/label:** bold, usually accent only when it represents focus or a component title.
- **Thinking:** italic and muted; it is supporting process information, not primary content.
- **Hint:** normal weight and dim; hints should remain discoverable without competing with the active control.
- **Code:** use the code and syntax roles for readability, not as general UI decoration.

Bold and italic establish hierarchy together with color and whitespace. Do not use large type, all-caps labels, or repeated bold text to compensate for weak layout.

## Layout

The default composition is linear and terminal-native:

1. Optional one-line spacer.
2. Full-width single-line border when a framed region is needed.
3. Content with zero or one cell of horizontal padding.
4. Optional one-line spacer.
5. Closing border when the region is framed.

Use one-cell horizontal and vertical padding for user messages and tools. Use zero padding for inline assistant content, metadata, and footer content where possible. Use one line of vertical spacing to separate adjacent semantic blocks.

Every rendered line must respect the available terminal width. Wrap prose and truncate metadata or status strings with an ANSI-safe operation. Layout must remain usable on narrow terminals without horizontal overflow.

## Elevation & Depth

This is a flat terminal system. There are no shadows, gradients, floating surfaces, or multi-level elevation scales.

Depth is communicated through:

- a single background surface for a semantic block;
- a full-width border for structure;
- whitespace between blocks;
- muted and dim text for lower information priority.

A component should have at most one background container. Do not place a card inside another card.

## Shapes

The default shape is square: `{rounded.none}`. Do not add rounded corners to terminal panels, selectors, messages, tools, or editor shells.

Use stable dimensions for controls, rows, borders, and tool previews. A change in selection, status, or label length must not cause adjacent controls to jump or resize unexpectedly.

## Components

### Shared TUI primitives

Pi Basics uses pi's semantic and terminal-native foundation, while HEPI owns a small set of shared structural primitives:

- `PanelShell`-style composition keeps tabs, content, errors, hints, and the bottom rule in a predictable order. Individual surfaces may omit parts when their interaction model needs it.
- `renderDetailPanel` is the shared description/detail panel. It owns the title frame, one-cell inner padding, fixed-height padding, wrapping, and safe clipping. Settings, Loadout, and Plan should not hand-write another Description frame.
- `createSplitLayout` is the shared responsive rule. A split begins at 75 columns, with a three-cell gap and bounded left/right content widths. Below that threshold, the detail panel stacks or disappears according to the surface's purpose.
- `renderSelectableRow` owns the two-cell cursor slot. A selected row begins with `→ ` and an unselected row reserves the same space, so selection never shifts the label or value column.
- `keyGlyph` standardizes compact hints as `↕`, `↔`, `↵`, and `⎋`; `␣` and `⇥` are used only when Space or Tab is an actual distinct action. Labels should be short verbs: `navigate`, `switch`, `select`, `save`, `toggle`, `cancel`.

These primitives unify structure, not product identity. Ask can remain a questionnaire with tabs and a sticky footer; Plan can remain a decision surface; Loadout can retain its grouped inventory. They should share framing, spacing, selection slots, responsive behavior, and interaction vocabulary without becoming visually identical.

### User message

Use one background block with `{colors.user-message-background}`, `{colors.text}`, and one-cell padding. Do not add avatars, decorative labels, multiple borders, or a nested card.

### Assistant message

Assistant content is the primary reading flow and normally has no background. Keep markdown on the terminal background, use one-cell output padding where needed, and separate adjacent blocks with whitespace. Errors appear after partial content in `{colors.error}`.

### Thinking block

Thinking is secondary information. Render it in italic and `{colors.muted}`. When collapsed, show one concise label instead of a large placeholder panel.

### Tool execution

Use one padded block whose background changes with lifecycle state: pending, success, or error. Tool titles are bold and may use `{colors.text}` or `{colors.accent}` when focused. Tool output is `{colors.muted}`. Do not create separate colored badges for every tool state.

### Bash execution

Frame shell execution with full-width borders. Use `{colors.bash-mode}` for the command header and spinner while running, and `{colors.muted}` for output. A command excluded from context may use `{colors.dim}` for its border. The command itself remains the primary label, for example `$ command`.

### Selector

Use a simple framed list with a single focus point. The selected row uses an accent arrow (`→ `) and `{colors.accent}` text. Provider names, descriptions, scroll information, and no-match messages use `{colors.muted}`. The current item may use `{colors.success}` with `✓`.

### Settings list

Settings follow this hierarchy:

- selected label and value: accent;
- normal value: muted;
- description and hint: dim;
- cursor: accent `→ `.

The setting name should remain easier to scan than its description. Avoid a different color for every setting type.

### Editor

The editor text remains `{colors.text}`. Cursor rendering uses Pi's hardware cursor marker so the cursor sits on the terminal cell boundary without replacing the underlying character. Pi Basics exposes `bar`, `block`, `hollow`, and `underline` shapes plus a blink toggle; the default is a steady block. Shape support follows the active terminal's DECSCUSR implementation, with unsupported hollow cursors falling back to the matching block style. Its border communicates mode:

- `thinking-off` through `thinking-max` indicate reasoning level;
- `{colors.bash-mode}` indicates shell mode;
- `{colors.border-muted}` is the ordinary low-emphasis border.

Changing model mode should not recolor the entire screen or the text being edited.

### Footer and status

Footer content is deliberately quiet. Working directory, branch, token statistics, model metadata, and extension statuses use `{colors.dim}`. Promote only actionable thresholds or failures to warning/error. Keep left-side statistics and right-side model information aligned and truncate safely when space is limited. Extension text registered through `ui.setStatus()` belongs on one dedicated footer row after the editor's closing rail; it must not be appended to the editor's top status rail. The Advisor machine status is the single exception: while enabled, render `✦` immediately after the model using accent for a review with no concern or blocker, warning for concern, and error for blocker; omit it from the footer. Use the compact footer grammar `spinner · ⛁ connected/total · PLAN · GOAL`; omit ambient Magic Context telemetry.

### Response telemetry

Append one dim output line after every successful assistant response using `↱ input  ↳ output  ⚇ cache-read  ⏱ duration  ⚡ rate/s`. Metrics are per provider response, not aggregated across an agent run. Duration spans `turn_start` through assistant `message_end`, excluding subsequent tool execution. Rate is non-reasoning output divided by that whole-response duration. Telemetry remains transient UI output and must not enter session or LLM context.

### Custom message

Extension content uses one `{colors.custom-message-background}` block, a bold type label using a dedicated label color if available, and normal custom message text. A custom renderer may own its internal styling, but it must still follow the same semantic hierarchy and spacing rules.

## Do's and Don'ts

### Do

- Use semantic tokens instead of hard-coded colors inside components.
- Reuse `accent`, `muted`, `dim`, `success`, `warning`, and `error` consistently across modules.
- Use `→ ` plus accent for selection and `✓` plus success for the current value.
- Reserve backgrounds for user/custom/tool/selection semantics.
- Keep assistant prose on the terminal background.
- Use borders and whitespace as the primary layout structure.
- Make every component wrap, truncate, and render safely at the available width.
- Rebuild theme-dependent content when the theme changes or the component invalidates.
- Add a new token only when an existing semantic role cannot express the behavior clearly.

### Don't

- Do not use a different accent color for each module.
- Do not use success, warning, or error as decorative category colors.
- Do not turn every message, selector, or status line into a card.
- Do not nest cards or add shadows, gradients, rounded panels, or floating dashboards.
- Do not use color as the only selection signal.
- Do not color ordinary empty states as errors.
- Do not recolor editor text when only the editor mode changed.
- Do not bake stale ANSI styles into cached components.
- Do not let long labels or terminal resizing break line width constraints.
- Do not create a second Description panel, split breakpoint, selection slot, or interaction glyph vocabulary in a feature module.

## Implementation Notes

The original pi theme exposes more detailed tokens than this document's compact design token set, including Markdown, syntax, diff, thinking-level, and tool-specific roles. Map those detailed roles to the semantic groups above rather than creating ad hoc project colors.

When implementing a component, classify it first as a message, tool, selector, editor, footer, or status element. Then select its foreground, background, border, typography, and spacing from this document. A component should not invent a second visual language because it belongs to a different module.
