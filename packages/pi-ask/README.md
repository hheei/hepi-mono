# @hheei/pi-ask

Interactive `ask` tool for Pi. Requires `@hheei/pi-basics` to be loaded in the same Pi process.

In TUI sessions it presents questions, then submits answers only from the Review screen. Dialog UI is used when available. Non-interactive sessions fail closed.

No persistent state. Load with `pi-basics` and this package; do not load a second Ask implementation that registers the same `ask` tool.
