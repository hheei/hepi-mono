# @hheei/pi-subagents

Run several independent Pi child sessions from one Pi session, each with its own Pi session
file, its own runtime, and its own durable identity.

The package is a single concrete extension with one `pi.extensions` entry
(`dist/extension.js`). The same entry runs on both sides: the parent branch registers the
model-facing tools, commands, and widget; the child branch registers only the reporting
bridge and session-leave reporting.

Current behavior is defined by [`docs/pi-subagents/spec.md`](../../docs/pi-subagents/spec.md).
[`docs/pi-subagents/PLAN.md`](../../docs/pi-subagents/PLAN.md) and
[`docs/pi-subagents/PLAN-delivery-presentation.md`](../../docs/pi-subagents/PLAN-delivery-presentation.md)
are design sources, not the live contract. The runtime handoff described by SUB-08 (attach,
pause handshake, `close_writer`/`start_rpc`) was replaced by the child bridge; the migration is
tracked in [`docs/pi-subagents/PLAN-panel-bridge.md`](../../docs/pi-subagents/PLAN-panel-bridge.md);
all four implementation stages are landed, and the remaining work is documentation and
ticket wrap-up.

## Parent tools

| Tool | Purpose |
| --- | --- |
| `subagent_enable({})` | Enable interactive agent tools (`spawn_agent`, `send_agent`, `get_agent`, `stop_agent`) on demand. Deactivated by default in new sessions to save tokens; appends available interactive agents if any are defined, and enabled tools become available on the next model request. |
| `spawn_agent({ task, agent, cwd?, title? })` | Start one child and return when its bridge is ready and the initial task was delivered. It runs in a new Herdr tab (or cmux surface) when this parent has one, and headless in the background otherwise; the result names the presentation it got and why. `title` (<= 60 chars) names the child's Pi session, shown as `🤖 <title>`; omit it or leave it blank to derive a name from the agent and child id. Requires `subagent_enable`. Do not poll `get`/`list` for the child's work; reports arrive as `pi-subagent-report` messages. |
| `send_agent({ id, message, mode? })` | Send `steer`, `follow_up`, or `auto` input to a specific child. Idle-reclaimed children resume the same session; manually closed panels and stopped children are terminal and return an explicit non-retryable failure. Unconfirmed runtime ownership also refuses a send instead of launching a second runtime. Requires `subagent_enable`. Do not poll afterwards. |
| `get_agent({ id })` | Inspect one child: state, presentation (`panel`/`background`), session, summary, usage, runtime freshness, and inherited model/thinking. Requires `subagent_enable`. |
| `list_agents({})` | List available interactive agent definitions and running subagents owned by this parent session. |
| `stop_agent({ id })` | Persist a stopped intent, then end the runtime: a background child is killed, a panel child has its panel closed and verified gone. Requires `subagent_enable`. |
| `task({ agent, task, cwd?, blocking?, outputSchema? })` | Run one delegated task as a dedicated execution that is terminated after its final result. Its child opens a Herdr tab or cmux surface when a host is available, and falls back to headless background execution otherwise. `blocking` only controls whether this call waits for the result. Requires `@hheei/pi-ext-tools` for the task registry. |

There is no batch-spawn tool: parallel children come from Pi's own parallel tool calls.
`agent` is required and never defaulted: discovery (project `.pi/agents`, project
`.agents/agents`, user `~/.pi/agent/agents`, then the built-in definitions) must resolve the name,
so an unresolved or missing agent name fails before any process starts. The built-ins are `scout`
(read-only reconnaissance), `worker` (implementation) and `reviewer` (review, which relies on the
child's own skill discovery to see the review skills); all three inherit the parent model and
thinking, and a definition on disk with the same name always wins.

The child branch registers exactly one tool, `contact_parent({ reason, message })`, with
reasons `success` and `blocked`. Busy parents receive reports in the next model step. Idle parents
wait until all background work finishes, then Task/Bash results and ordinary child reports wake one
shared turn; `blocked` bypasses that wait. There is no fixed notification timer. If a child ends a turn without reporting, it may receive a follow-up
nudge to call `contact_parent`; the child session is never auto-exited. Delay defaults to
5s (`PI_SUBAGENTS_NUDGE_DELAY_MS`); set `PI_SUBAGENTS_NUDGE_DISABLE=1` to turn it off.

`get_agent` / `list_agents` include `interactive`, `freshness`, `updatedAt`, and the
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

`skills` is a whitelist: omitted/`true`/`all` inherits every discovered skill, `false`/`none` loads
none, and a list loads exactly those entries. An entry that looks like a path (`./`, `~/`, `/`, a
drive letter, or anything containing `:` or `/`) keeps its old meaning; anything else is a skill
*name*, resolved against the skills Pi loaded for this session, so a definition stays
machine-independent. A name that is not loaded is dropped with a warning — narrowing never widens
back to everything.
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
assembled prompt, and the non-secret bridge environment, then reports the `presentation`
(`panel` or `background`) and `stdio` separately. Values that contain spaces stay single argv atoms, and no shell is involved.

Session identity is always explicit: a session that has never been flushed is created with
`--session-id <id> --session-dir <dir>`, and a flushed session is opened by path. No path
opens an absent file, so a child can never silently acquire a random session id.
`extensions: false` keeps this package's absolute `-e <entry>` bridge argument while
disabling discovery, so a child never loses `contact_parent` and never gains a manager.

## Control plane and presentation

Every child runs a bridge client that dials the parent process's own Unix socket
(`<runtimeDir>/parent-<parentSessionId>.sock`, 0700 directory, 0600 socket, authenticated with a
per-runtime token kept outside the registry, in a per-parent-session file so two parent sessions
sharing the runtime directory cannot overwrite each other's credentials). One connection per child
carries both directions:

- parent → child: `prompt`, `steer`, `follow_up`, `get_state`, `get_entries`, `abort`, `shutdown`;
- child → parent: `contact_parent` and `task_result` as acknowledged requests, plus the forwarded
  Pi events, `child_lifecycle` (`left_session` / `tui_quit` / `user_interrupt`) and `child_input`
  (source only, never the text) as events.

The bridge connection is the liveness basis: a connected bridge means the child is running, and a
child that reconnects after a parent restart is adopted by reading its session, never rebuilt. A
child that is idle for 60s (`SUBAGENT_IDLE_TIMEOUT_MS`) is reclaimed — a `shutdown` request over the bridge,
then SIGTERM — and its record lands `done` with identity and session intact, so a later
`send_agent` starts the same session again without replaying the interrupted turn. A running child
is never closed automatically; only `stop_agent` (or a human closing its panel) ends it.

Presentations are chosen once per parent session and never switch afterwards, so `/subagents` has
no `attach` verb and there is no attach shortcut.

- **panel** (`spawn_agent`'s default where a host exists): the parent mints the runtime identity
  and token, builds the one LaunchSpec (no `--mode rpc`, `stdio: inherit`), and the host runs it —
  herdr `tab create --cwd <cwd> --label <subagentId> --no-focus --env …` followed by
  `pane run <root pane> <argv>`, cleanup `tab close <tab id>`; cmux `new-surface --command` with
  `close-surface` as cleanup. Focus is read from `tab list` plus `workspace list` (both must be
  focused) and pauses the idle countdown; cmux cannot report focus, so it fails open and its
  children are only closed by `stop_agent` (`TODO(cmux-focus)`).
- **background** (no host available): the parent spawns the child itself with
  `--mode rpc`, holds its stdin (so it ends with the parent process), and drains stdio without
  parsing it. Pi's `rpc` mode handles `ctx.shutdown()` as a flag checked after a command or a
  settled run, so ending an idle background child is done with SIGTERM (which Pi handles
  gracefully and answers with exit code 143 — expected, not a failure).

A confirmed external panel exit is terminal: the parent releases the panel (best effort, logged),
keeps the session for inspection, and records the child as stopped. A later `send_agent` fails
explicitly instead of opening a fresh panel; only automatic idle reclaim is resumable. A disconnected
bridge alone is not proof of exit. A panel child adopted after a parent restart has no attachment
in this process, so its focus/reclaim degrades and `stop_agent` only asks it to shut down over the
bridge — a known, documented limitation.

## Persistence

Each parent session gets its own registry file under
`<agent-dir>/pi-subagents/registry/<parentSessionId>.json`, written through ext-core's
atomic, cross-process-locked JSON root update. Nothing is written to `settings.json`.

A record holds the child id, parent session id, session id/path, cwd, initial task, active
or stopped intent, the non-secret launch configuration, state and presentation, last-known summary
and usage, and the last launch's `runtimeIdentity` and endpoint.
Revisions are monotonic; stale writers and updates aimed at a replaced runtime are
rejected. Corruption, unsupported versions, parent mismatch, and identity mismatch fail
closed instead of returning partial state. API keys and controller tokens are never
persisted.

Presentation is frozen at spawn and is never read compatibly: a record written by the
attach-era package carries `mode` instead of `presentation`, and parsing it fails with the file
path and a "delete this record" instruction rather than guessing the new meaning.

Spawn order is fixed: resolve, persist intent, then start the child. If the registry write
fails, no child process is started, and a session that has already flushed must still prove
its id on disk before anything opens it. The initial task is delivered over the bridge only
after the child connected, so a launch that never connects is ended here and reported.

A parent session owns exactly one socket path, so a second Pi process pointing at the same
parent session fails to bind instead of taking over. Parent reload and restart only drop local
state (timers, projectors, subscriptions): a child that is still running reconnects its bridge and
is adopted, and a background child is held by its stdin pipe, so it ends with the parent process
rather than being killed by a reload. A background child therefore ends with its parent (recorded
interrupted), while a panel child whose runtime never reconnected is reported as unconfirmed and
refuses `send_agent` until it is stopped. A child disposes its own bridge client on `quit` and on
`reload`, so the newly loaded instance dials instead of racing the old socket. Pending input is
marked interrupted and never replayed; a flushed session whose file is missing fails closed.

## Observation and commands

An interactive TUI parent shows an above-editor widget of live children (`starting`,
`running`, `idle`). It is a projection of `list()`:
no second running set, no border, no file polling. Rows use the agent display name when
present, mark `last known` when the runner is not connected, and show elapsed time since
spawn. Headless/RPC parents do not mount it.

`setStatus` shows a compact `running` / `idle` / `panel` / `failed` line, including
`interrupted` when that diagnostic is set. `/subagents` lists, inspects, sends,
or stops through `ctx.ui.select`. Tab completion after `/subagents ` offers its subcommands.
`/subagents stop <id>` skips the picker and acts on that child directly. The only shortcut is
`ctrl+shift+s` (stop), which calls the same manager operation. Spawn/send/get/list/stop results render through ext-core ToolTui so collapsed
output still keeps the full details.

A TUI child shows one borderless identity line (agent, `contact_parent`, tool count). It
is not a control surface.

## Notes

- `@hheei/pi-ext-core` is a production dependency, not a separately loaded extension.
- A background child ends with the parent process (it is held by the stdin pipe this parent
  keeps open); a panel child is held by its host. Parent cleanup releases local connections,
  timers and subscriptions only.
- The bridge connection is opened in the child's `session_start`, so a connected bridge always means
  a live child session: the parent's first request can never land in a process that has not finished
  setting up its session.
- This package does not use ext-core's in-process `startSubagent`: that contract cancels the
  child when the parent shuts down, which is incompatible with surviving, reconnectable
  children.
