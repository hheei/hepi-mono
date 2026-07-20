# Pi Basics Statusbar — high level

## Goal
`pi-basics` renders one status rail by replacing Pi's editor top horizontal rail. Output order is:

```text
STATUS RAIL
PROMPT HERE
original bottom rail
```

It is not a global footer and never adds a row below the editor.

## Visible contract
The rail uses this grammar:

```text
─ π · <thinkingGlyph> <model> · ◫ <meter> <contextWindowLimit> · <statuses> ───── <session title> ─
```

Statuses remain in `footerData.getExtensionStatuses()` insertion order. Thinking levels only change glyph: off/minimal/low `○`, medium `◒`, high/xhigh `●`; all use muted semantic role. Title is right-aligned. `meter` is percent-derived; numeric value is the context-window upper limit (`ContextUsage.contextWindow`), not current used tokens.

## Ownership
On TUI sessions, statusbar captures Pi's `ReadonlyFooterDataProvider` through an empty `setFooter` factory whose `render()` returns `[]`. This suppresses Pi's built-in footer without showing a replacement footer row. It also provides extension statuses to the editor rail.

Statusbar captures `getEditorComponent()` and installs a public `setEditorComponent()` factory. Factory composes the previous editor or `new CustomEditor`, decorates only `render()` and replaces `lines[0]`. Input handling, autocomplete, content, focus, padding, bottom rail, and object identity remain unchanged. Cleanup restores previous editor factory and calls `setFooter(undefined)`. Cleanup is owner/session guarded, so stale sessions cannot clobber a newer installation.

No settings, timers, model calls, dependencies, or generic contribution registry are involved.
