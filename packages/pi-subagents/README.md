# @hheei/pi-subagents

Run several independent Pi child sessions from one Pi session, each with its own Pi session
file, its own runtime, and its own durable identity.

The package is a single concrete extension with one `pi.extensions` entry
(`dist/extension.js`). The same entry runs on both sides: the parent branch registers the
model-facing tools, commands, and widget; the child branch registers only the reporting
bridge and session-leave reporting.

## Parent tools

The extension registers no global keyboard shortcuts. Use `/subagents` to manage
children and `/subagents stop [id]` to stop one without conflicting with other extensions.

| Tool | Purpose |
| --- | --- |
| `agent_spawn({ task, agent, cwd?, title? })` | Spawn an independent background subagent task. Runs in a new Herdr tab (or cmux surface) targeting the parent's workspace when a host is available, and headless in the background otherwise. **Prefer reusing existing subagents** via `agent_send` for related/follow-up work to maintain context and maximize prompt cache and memory efficiency. Tool description lists available agent names and roles, excluding disabled or hidden definitions. Deferred by default; discover via `tool_search({ query: "agent" })`. Do not poll for completion; results return automatically. |
| `agent_send({ id, message, mode? })` | Send `steer`, `follow_up`, or `auto` input to a specific child. **Primary tool for assigning follow-up or functionally related tasks** to existing subagents: idle, blocked, done, or errored children resume their existing session automatically with historical context intact. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `agent_get({ id, keys? })` | Inspect one subagent by id. `keys` is a comma-separated selection of `status` (default), `progress` (default), and `diagnostic`; unknown keys fail. The view never returns the child's task parameters or terminal result, which arrive automatically as reports. From the second successful inspection of the same child in this parent runtime, the result adds a short reminder that results return automatically and must not be polled. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `agent_stop({ id })` | Stop one subagent's runtime by id. The child keeps its session, so a later `agent_send` can resume it. Deferred by default; discover via `tool_search({ query: "agent" })`. |

### Unified Task Management

`agent_spawn` returns JSON `{ id, path }` on success. `path` is the absolute child session file path
assigned by Pi; its first write may still be pending. `agent_get` exposes the same `progress.path`.
`agent_send` and `agent_stop` return one confirmation
sentence. Failures return only their reason. Operation results omit session IDs, presentation, and
state snapshots; use `agent_get` for runtime inspection.

Subagent execution tasks register with ext-core's `TaskRegistry` when pi-ext-tools provides it, alongside background Bash jobs. Child reports arrive automatically; do not poll status to detect completion. Bash uses separate `bg_bash_*` tools. Deferred subagent tools are loaded via `tool_search`; activation supplies `subagent_guidance`. Both get tools return the same `status`, `progress`, and optional `diagnostic` envelope. Diagnostics describe blockers, failed turns, or uncertain runtime state.

## Child execution and reporting

Subagents communicate with the parent over a dedicated Unix domain socket bridge:

- **Completion by Direct Output**: Subagents do **not** need to call any reporting tool upon successful completion. The subagent simply outputs its final answer as normal assistant text.
- **Settlement Debounce**: When a subagent finishes a turn and remains idle for 5 seconds (to prevent false idles), the harness automatically captures the trailing assistant text and delivers it to the parent conversation dialog as a completed `subagent-report`.
- **Blockers & Decisions**: The child registers `contact_parent({ message, reason? })` strictly for reporting when it is blocked or urgently requires a parent decision midway (`reason` defaults to `'blocked'`). Blocked reports wake the parent immediately.
- **Automatic Retry**: If a subagent encounters a transient error, the harness allows one automatic retry before marking the task failed or delivering a blocked notification.
- **Panel Failure Auto-Close**: When a subagent running in a panel encounters a fatal error or reports a blocker, the manager starts a 15-second countdown after notifying the parent, automatically closing the panel tab to avoid workspace clutter unless new instructions are dispatched.
## Three visual states

Subagent lifecycle is shown in the TUI widget above the editor; subagent status is omitted from the footer:

- **`running`** (blue/amber): Starting, executing turns, auto-retrying, or waiting out the 5-second settlement debounce.
- **`done`** (green checkmark `✓`): Succeeded and automatically reported final assistant text back to the parent.
- **`blocked`**: Interrupted or waiting for input/guidance.
- **`error`**: The turn failed or the runtime was stopped. You may retry with `agent_send` or create a new child via `agent_spawn`. Sending to a stopped child reactivates its existing session after the previous runtime is confirmed gone; retrying does not guarantee the underlying failure is resolved.

## Host Integration and Isolation

- **Herdr Workspace Affinity**: When spawning in Herdr, tabs are explicitly created in the parent process's current workspace (`--workspace <WORKSPACE_ID>`), preventing child tabs from jumping to whichever workspace happens to have user focus.
- **Hindsight Memory Isolation**: `PI_HINDSIGHT_DISABLE=1` is set in the child environment and memory auto-registration/recall/writeback are disabled. The child bridge blocks all `mcp__hindsight__*` calls (including nested codemode calls and future server tools), even if that server is configured in a file. Memory recall prompt blocks are stripped. This boundary applies to the reserved `hindsight` server name, not arbitrary external servers registered under other names.

## Agent definitions

Agent Markdown files are discovered in this order, most specific first, by `name`:

```text
<cwd>/.pi/agents/*.md
<cwd>/.pi/agents/*.md
~/.pi/agent/agents/*.md
```

Frontmatter is parsed with Pi's `parseFrontmatter` and validated against this package's schema. Supported fields: `name`, `display_name`, `description`, `hidden`, `model`, `thinking`, `tools`, `exclude_tools`, `extensions`, `skills`, `interactive`.

### Built-in Agents

- **`scout`**: Read-only reconnaissance agent. Disabled by default until the user explicitly configures a model in `~/.pi/agent/agents/scout.md`.
- **`worker`**: General implementation agent. Configured with `model: inherit` to inherit the parent session's model and thinking level.
- **`reviewer`**: Code review agent. Configured with `model: inherit` and leverages skill discovery to run review skills.
