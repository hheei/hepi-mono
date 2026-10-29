# Implementation Plans

Design records. They explain why a shape was chosen; they are not the source of current behaviour.
Source, tests, package READMEs, `docs/architecture/`, and the package specs own what the code does
today, and a plan never overrides an agreed contract.

Most of these were written before implementation and were not updated afterwards, so treat any status
line as the author's note at the time of writing rather than as a live tracker. They also quote the
tool names in force when they were written (`spawn_subagent`, `send_subagent`, `list_subagents`),
which have since become `agents_delegate`, `agents_get`, `agents_stop`, and `agents_dashboard`. A plan whose subject
is gone belongs in [`docs/archive/`](../archive/README.md); a plan that has been implemented keeps
its value as the rationale for the current shape and stays here.

## Tool execution

- [apply-patch-semantics-safety](apply-patch-semantics-safety.md): apply_patch semantics and publish safety.
- [extension-owned-bash-capabilities](extension-owned-bash-capabilities.md): extension-owned bash capabilities.
- [bash-foreground-auto-async](bash-foreground-auto-async.md): turning a long foreground bash call into a background job.
- [task-tools-on-demand-injection](task-tools-on-demand-injection.md): injecting async task tools on demand.
- [async-task-orchestration](async-task-orchestration.md): asynchronous task orchestration design.
- [task-concurrency-in-core](task-concurrency-in-core.md): moving task concurrency into ext-core (design draft, not implemented).
- [subagent-as-task-unification](subagent-as-task-unification.md): folding subagents into the unified task surface (design reviewed, not implemented).

## Rendering

- [pi-ext-ui-collapse-views](pi-ext-ui-collapse-views.md): activity grouping and layered expansion. Implemented; the contract is [pi-ext-ui-tool-groups](../architecture/pi-ext-ui-tool-groups.md).
- [pi-ext-tools-auto-collapse](pi-ext-tools-auto-collapse.md): collapsing long tool output.
- [tool-frame-request-section](tool-frame-request-section.md): a request section in the tool frame (draft; contract not frozen).
- [todo-ui-ux-optimization](todo-ui-ux-optimization.md): todo UI/UX through the native status path.

## Memory

- [pi-ext-memory-memory-budget](pi-ext-memory-memory-budget.md): memory budget. Decisions D1–D6 settled, phases 1–4 landed.
- [pi-ext-memory-idle-compaction](pi-ext-memory-idle-compaction.md): idle-time compaction.
- [pi-ext-memory-hindsight-integration](pi-ext-memory-hindsight-integration.md): opt-in Hindsight long-term memory.
- [pi-ext-memory-enhancements](pi-ext-memory-enhancements.md): experience and feature enhancements against then-current behaviour.
