# @hheei/pi-python-eval

Persistent, session-scoped Python for Pi. One `python_eval` tool runs trusted local Python in a
kernel that keeps its namespace across cells, and lets a cell call other installed tools through the
Pi host.

Install `@hheei/pi-settings` separately for the Settings UI. `@hheei/pi-ext-core` is a production
dependency, not a separately loaded Pi extension.

## Tool

`python_eval({ code, reset?, timeout_ms? })`

- `code` is non-empty trusted source, at most 1 MiB. This is not a sandbox.
- `reset: true` discards the kernel and its scope before the cell runs.
- `timeout_ms` is a hard wall-clock deadline for the whole cell, unset by default. Nested tool calls
  count toward it.
- `exposure: "model-only"`, `defaultActive: false`: enable it with `--tools` or `defaultTools`.

Each cell reports its namespace, so names that survived are visible instead of assumed. `print`
and `console` go to the transcript, `display()` keeps a JSON-safe value, and the last expression is
the cell result. A restart is reported explicitly, because a kernel that died lost its names.

## Nested tools

A cell reaches exactly `read`, `grep`, `find`, `bash`, `edit`, `write`, and `apply_patch`, and only
while that tool is active in the session. Every call goes through the Pi host's
`context.executeTool()`, so the host's own validation, hooks, and permission checks apply and the
host's reported outcome decides whether the call failed. The package holds no tool definitions and
no fallback dispatch, so a missing tool or a blocked call surfaces as a tool failure.

Nested calls return the tool's text, or its `structuredContent` when it declares one (for example
`bash`). Each call is recorded as a trace row with its arguments, text, duration, and error.

## Kernel lifecycle

One kernel per extension instance, at most one cell at a time: a concurrent cell fails immediately
rather than queueing. Cancellation interrupts the cell (`SIGINT`) and escalates to `SIGKILL` after
about 5 seconds; session shutdown kills the kernel. Names never survive into another session.

The kernel runs `src/kernel/child.py` (packed beside the built host) over NDJSON on a private pipe,
so the child's stdout reaches the transcript instead of the protocol. Environment variables that
look like credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) are not inherited.
Python 3.9+ is required.

## Settings

Group `eval` in the global `ext_settings.json`, provider `pi-python-eval.eval`:

| Field | Default | Meaning |
| --- | --- | --- |
| `pythonBin` | (auto) | Interpreter for the kernel. Empty uses `python3` or `python` on `PATH`. |

Changes apply on reload or in a new session.

## Details

Results carry `format: "pi-ext-tools-python-eval"` and bounded rows (200 rows, 4,000 characters per
row, 12,000 characters of model-visible transcript). The format name stays as it is so historical
sessions keep rendering.

## Rendering

`createPythonEvalPresentation` in this package owns the cell's rendering facts: container status,
summary (`(reset)`, `(timeout 2s)`, call stats, duration), the highlighted Python input section,
transcript sections (muted namespace report, `display:`/`result:` prefixes, one header row per nested
call), collapsed nested rows, and copy text. `registerPythonEvalTool` publishes it through
ext-core's optional renderer point, so an installed UI package draws the frame and this package's
native renderer shows the plain transcript when none is installed. No UI package is a dependency.

## Migration

`@hheei/pi-python-eval` replaces the Python eval half of `@hheei/pi-ext-tools`. Add this package
explicitly to keep `python_eval`; the combined extension no longer registers it. The `eval` settings
group, tool schema, details format, and kernel protocol are unchanged.
