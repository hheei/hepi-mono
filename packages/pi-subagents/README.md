# @hheei/pi-subagents

Run several independent Pi child sessions from one Pi session, each with its own Pi session
file, its own RPC runtime, and its own durable identity.

The package is a single concrete extension with one `pi.extensions` entry
(`dist/extension.js`). The same entry runs on both sides: the parent branch registers the
model-facing tools, commands, and widget; the child branch registers only the reporting
bridge and session-leave reporting.

Current behavior is defined by [`docs/pi-subagents/spec.md`](../../docs/pi-subagents/spec.md).
[`docs/pi-subagents/PLAN.md`](../../docs/pi-subagents/PLAN.md) and
[`docs/pi-subagents/PLAN-delivery-presentation.md`](../../docs/pi-subagents/PLAN-delivery-presentation.md)
are design sources, not the live contract. Remaining pause-handshake work is tracked in
[`docs/pi-subagents/tickets.md`](../../docs/pi-subagents/tickets.md) SUB-08.

## Parent tools

| Tool | Purpose |
| --- | --- |
| `spawn_subagent({ task, agent, cwd? })` | Start one background RPC child and return when the runtime is ready. Do not poll `get`/`list` for the child's work; reports arrive as `pi-subagent-report` messages. |
| `send_subagent({ id, message, mode? })` | Send `steer`, `follow_up`, or `auto` input to a specific child. Do not poll afterwards. |
| `get_subagent({ id })` | Inspect one child: state, mode, session, summary, usage, runtime freshness, and inherited model/thinking. Use this for identity or state, not to wait. |
| `list_subagents({})` | List children owned by this parent session. Use this for ids or current state, not to wait. |
| `stop_subagent({ id })` | Persist a stopped intent, then end the runtime. |
| `task({ agent, task, cwd?, blocking?, outputSchema? })` | Run one delegated task as a dedicated execution that is terminated after its final result. Waits for that result in the call unless `blocking: false` starts it as a shared background task. Requires `@hheei/pi-ext-tools` for the task registry. |

There is no batch-spawn tool: parallel children come from Pi's own parallel tool calls.
`agent` is required and never defaulted: discovery (project `.pi/agents`, project
`.agents/agents`, user `~/.pi/agent/agents`, then the built-in definitions) must resolve the name,
so an unresolved or missing agent name fails before any process starts. The built-ins are `scout`
(read-only reconnaissance), `worker` (implementation) and `reviewer` (review, which relies on the
child's own skill discovery to see the review skills); all three inherit the parent model and
thinking, and a definition on disk with the same name always wins.

The child branch registers exactly one tool, `contact_parent({ reason, message })`, with
reasons `progress_update`, `important_finding`, `need_decision`, and `blocked`. Calling it
wakes the parent. If a child ends a turn without reporting, it may receive a follow-up
nudge to call `contact_parent`; the child session is never auto-exited. Delay defaults to
5s (`PI_SUBAGENTS_NUDGE_DELAY_MS`); set `PI_SUBAGENTS_NUDGE_DISABLE=1` to turn it off.

`get_subagent` / `list_subagents` include `interactive`, `freshness`, `updatedAt`, and the
resolved `model` / `thinking` with whether each came from the agent or the parent.
Reports delivered to the parent are titled with the agent display name and child id.

## Agent definitions

Agent Markdown files are discovered in this order, most specific first, by `name`:

```text
<cwd>/.pi/agents/*.md
<cwd>/.agents/agents/*.md
~/.pi/agent/agents/*.md
```

Frontmatter is parsed with Pi's `parseFrontmatter` and then validated against this
package's schema. Supported fields: `name`, `display_name`, `description`, `hidden`,
`model`, `thinking`, `tools`, `exclude_tools`, `extensions`, `skills`, `interactive`.
`interactive` defaults to `false` and is frozen into the launch snapshot. The Markdown body
becomes the child's agent instructions.

Validation happens before launch and fails closed:

- unknown fields, and the recognized-but-unimplemented `exclude_extensions`,
  `preload_skills`, `max_turns`, `max_tokens` fields;
- `model` that is not an exact `provider/model-id` present in Pi's `ModelRegistry`;
- invalid `thinking` levels, conflicting `tools`/`exclude_tools`, missing resource paths;
- any policy that would remove the `contact_parent` bridge.

`model` and `thinking` fall back to the parent session's current values, and the resolved
result records whether each value came from the agent (`agent`) or the parent (`parent`).
Models are never chosen by fuzzy match.

## Launch configuration

One builder produces every child process description. It resolves the Pi invocation, the
full argv, cwd, session placement, model/thinking, tool/extension/skill selection, the
assembled prompt, and the non-secret bridge environment, then reports `mode` and `stdio`
separately. Values that contain spaces stay single argv atoms, and no shell is involved.

Session identity is always explicit: a session that has never been flushed is created with
`--session-id <id> --session-dir <dir>`, and a flushed session is opened by path. No path
opens an absent file, so a child can never silently acquire a random session id.
`extensions: false` keeps this package's absolute `-e <entry>` bridge argument while
disabling discovery, so a child never loses `contact_parent` and never gains a manager.

## Presentation hosts

A HostAdapter only carries a native TUI. It receives the same LaunchSpec the RPC runner
uses, probes real host capability, and never re-resolves agent, model, or Pi flags.

`/subagents attach <id>` opens an RPC child as native Pi in Herdr or cmux. With no
id, `/subagents attach` or the attach shortcut uses `ctx.ui.select`. An idle child switches
immediately. A busy child waits for the current turn's `turn_end`, then closes the
RPC writer. Timeout or cancel keeps the RPC writer and fails visibly. Session files
that have never flushed refuse attach. There is no model-facing attach tool.

- Default selection is Herdr, then cmux. An explicit unavailable host fails visibly and
  does not fall back.
- Probe talks to the live session (`herdr pane current` inside `HERDR_ENV=1`, `cmux ping`
  plus `capabilities`). A binary on PATH is not enough.
- Herdr attach splits with `--cwd` / `--env` and runs the quoted command+argv. cmux attach
  uses `new-split --command`. Neither path invents a second argv.
- Observation uses host process APIs where they exist. A pane still being open is not
  evidence that the Pi process is alive. Command timeout is not rollback: the attachment
  is returned so the caller can inspect it, and nothing is closed automatically.
- Cleanup closes only the pane or surface this transition created and still owns.
- After a confirmed TUI process exit (`/quit`, pane close, crash), the same runner restores
  RPC on session A and waits for input. Crash adds an extra diagnostic. A pane event with a
  still-live process does not detach.
- `/new`, `/resume` other, and `/fork` unbind A only after the TUI is confirmed on session
  B. A returns to RPC; B is a native Pi session, not a subagent, and cannot `contact_parent`
  as A. `/reload` and `/resume` of A do not detach. This package does not intercept a
  user opening the same session with native `/resume` outside the managed path.
- A confirmed user interrupt (Pi `stopReason: aborted`) notifies the parent and stays on
  the TUI. Nothing is auto-resumed.

## Persistence

Each parent session gets its own registry file under
`<agent-dir>/pi-subagents/registry/<parentSessionId>.json`, written through ext-core's
atomic, cross-process-locked JSON root update. Nothing is written to `settings.json`.

A record holds the child id, parent session id, session id/path, cwd, initial task, active
or stopped intent, the non-secret launch configuration, state and mode, last-known summary
and usage, and the reconnect metadata (`runtimeIdentity`, `endpoint`, optional `pid`).
Revisions are monotonic; stale writers and updates aimed at a replaced runtime are
rejected. Corruption, unsupported versions, parent mismatch, and identity mismatch fail
closed instead of returning partial state. API keys and controller tokens are never
persisted.

Spawn order is fixed: resolve, persist intent, then start the runner. If the registry write
fails, no child process is started, and a session that has already flushed must still prove
its id on disk before anything opens it.

Parent reload reconnects a surviving runner by `runtimeIdentity` and endpoint. Replacement
starts only after the old runner PID is confirmed dead (a reused PID is not treated as
ours). Pending input is marked interrupted and never replayed. A flushed session whose
file is missing fails closed; a never-flushed child keeps its original session id.

## Observation and commands

An interactive TUI parent shows an above-editor widget of live children (`starting`,
`running`, `idle`). It is a projection of `list()`:
no second running set, no border, no file polling. Rows use the agent display name when
present, mark `last known` when the runner is not connected, and show elapsed time since
spawn. Headless/RPC parents do not mount it.

`setStatus` shows a compact `running` / `idle` / `tui` / `failed` line, including
`interrupted` when that diagnostic is set. `/subagents` lists, inspects, attaches, sends,
or stops through `ctx.ui.select`. Tab completion after `/subagents ` offers its subcommands.
`/subagents attach <id>` and `/subagents stop <id>`
skip the picker and act on that child directly. Shortcuts `ctrl+shift+a` and `ctrl+shift+s`
call the same manager
operations. Spawn/send/get/list/stop results render through ext-core ToolTui so collapsed
output still keeps the full details.

A TUI child shows one borderless identity line (agent, `contact_parent`, tool count). It
is not a control surface.

## Notes

- `@hheei/pi-ext-core` is a production dependency, not a separately loaded extension.
- Child processes are deliberately independent of the parent process lifetime; parent
  cleanup releases local connections only.
- This package does not use ext-core's in-process `startSubagent`: that contract cancels the
  child when the parent shuts down, which is incompatible with surviving, reconnectable
  children.
