# @hheei/pi-plan

Plan-mode command and confirmation TUI for Pi. Requires `@hheei/pi-basics`.

Use `/plan <prompt>` to enter the planning workflow. The confirmation surface supports the package's plan actions and preserves branch-local plan state in session history.

Runtime state is session-scoped. Shared framing, key hints, split layout, wrapping, and selectable rows come from `pi-basics`.
