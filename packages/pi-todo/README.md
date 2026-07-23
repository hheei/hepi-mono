# @hheei/pi-todo

Atomic ordered task list for Pi. Requires `@hheei/pi-basics`.

Use the `todo` tool with a batch of `create`, `update`, `list`, or `delete` operations. In TUI sessions `/todos` opens the same state and a read-only widget appears above the editor while work remains.

State is restored from the latest valid Todo tool-result snapshot in active branch history. No disk fallback or separate persistent store exists.
