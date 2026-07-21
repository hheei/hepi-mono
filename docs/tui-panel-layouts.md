# TUI Panel Layout Helpers

> Legacy-compatible reference for packages that already use `@hheei/pi-extcore`. New Pi Basics TUI work should follow [`DESIGN.md`](../DESIGN.md) and use `packages/pi-basics/src/ui/`.

`@hheei/pi-extcore` exports small layout helpers for extension TUI surfaces that need dense rows within terminal width.

## Wrapped Three-Column Table

Use `renderWrappedTableRows()` for rows shaped like:

```text
A    | B     | C-1
             | C-2
D    | E     | F-1
G    | H     | I
```

Example:

```ts
import { renderWrappedTableRows } from "@hheei/pi-extcore";

const lines = renderWrappedTableRows({
	width: 48,
	firstColumnWidth: 10,
	secondColumnWidth: 8,
	rows: [
		{ columns: ["ssh_exec", "enabled", "Run a non-interactive command on a remote host"] },
		{ columns: ["ssh_mount", "enabled", "Mount a remote host locally through sshfs"] },
	],
});
```

Guidelines:

- Pass explicit `firstColumnWidth` and `secondColumnWidth` when the table is part of a stable UI.
- Let the third column wrap long descriptions; continuation lines align under the third column.
- Every returned line is truncated to `width`.

## Two-Column List With Side Panel

Use `renderTwoColumnListWithSidePanel()` for rows shaped like:

```text
> A    | B     | Title C
  D    | E     | content of C
  ...
```

Example:

```ts
import { renderTwoColumnListWithSidePanel } from "@hheei/pi-extcore";

const lines = renderTwoColumnListWithSidePanel({
	width: 72,
	firstColumnWidth: 18,
	secondColumnWidth: 10,
	rows: [
		{ prefix: "> ", first: "pi-loadout", second: "enabled" },
		{ prefix: "  ", first: "pi-ssh", second: "disabled" },
	],
	title: "Details",
	content: "Toggle extensions for the current session without leaving the picker.",
	theme: { title: (text) => text.toUpperCase() },
});
```

Guidelines:

- Use `prefix` for cursor markers or tree glyphs.
- Use the right-side panel for details about the selected row, not for another editable list.
- If the left side is already rendered by another component, call `renderRowsWithSidePanel()` directly.

## Existing Rows With Side Panel

Use `renderRowsWithSidePanel()` when another component already produced left-side rows and you only need to merge in a detail panel.

```ts
import { renderRowsWithSidePanel } from "@hheei/pi-extcore";

const lines = renderRowsWithSidePanel({
	width: 80,
	rows: ["> deploy-plan     enabled", "  librarian       enabled"],
	title: "Description",
	content: "Prepare deployment plans.",
});
```

See [docs/examples/tui-panels.ts](examples/tui-panels.ts) for runnable-style examples.