# pi-subagents

`@hheei/pi-subagents` is the concrete extension for independent, reconnectable Pi
child sessions. Live contract: [`docs/pi-subagents/spec.md`](../pi-subagents/spec.md).
Design sources: `PLAN.md` and `PLAN-delivery-presentation.md` in the same folder.

Ownership:

- Parent branch: agent policy, registry, SubagentManager, model-facing tools, UX.
- Independent runner: child stdio, IPC, single controller, RPC/TUI writer replacement.
- Child branch: `contact_parent` and session-leave reporting only.
- HostAdapter: Herdr/cmux pane create/observe/cleanup. Not identity.

This package does **not** use ext-core `startSubagent`. That contract cancels children
when the parent shuts down, which cannot provide surviving, reconnectable runtimes.
Parent reload only drops local connectors, watches, widgets, and status; live runners
stay up.

Idle handoff is landed. Running-child pause waits for the current Pi turn then holds `turn_end`/`finishTurn` (Pi >= 0.87.0); implementation is SUB-08.
Native `/resume` of the same session outside the managed attach path is not
intercepted.
