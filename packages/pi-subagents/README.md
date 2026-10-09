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
| `spawn_agent({ task, agent, cwd?, title? })` | Start one child and return when its bridge is ready and the initial task was delivered. Runs in a new Herdr tab (or cmux surface) targeting the parent's workspace when a host is available, and headless in the background otherwise. **Prefer reusing existing subagents** via `send_agent` for related/follow-up work to maintain context and maximize prompt cache and memory efficiency. `title` (<= 60 chars) names the child's Pi session, shown as `🤖 <title>`. Deferred by default; discover via `tool_search({ query: "agent" })`. Do not poll `get`/`list` for completion; reports arrive automatically as `subagent-report` messages. Do not pause or freeze other subagents before spawning. |
| `send_agent({ id, message, mode? })` | Send `steer`, `follow_up`, or `auto` input to a specific child. **Primary tool for assigning follow-up or functionally related tasks** to existing subagents: idle or completed (`done`/`blocked`/`error`, including stopped children) children resume their existing session automatically with historical context intact, maximizing cache and memory efficiency. Do not wait for or ask workers to 'freeze': idle subagents are completely dormant and touch nothing. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `get_agent({ id })` | Inspect one child: state (`running` / `done` / `blocked` / `error`), presentation (`panel`/`background`), session, summary, usage, runtime freshness, and model/thinking. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `list_agents({})` | List available interactive agent definitions and running subagents owned by this parent session. |
| `stop_agent({ id })` | Persist a stopped intent, then end the runtime: a background child is killed, a panel child has its panel closed and verified gone. Deferred by default; discover via `tool_search({ query: "agent" })`. |

### Unified Task Management

Subagent execution tasks automatically register with ext-core's `TaskRegistry`, alongside background bash jobs. Child reports arrive automatically; do not use `wait_jobs` or poll status to detect child completion. Use `wait_jobs` for other background jobs only when the next step needs their results. Deferred subagent tools are loaded via `tool_search`; parent operation tools do not append snippets or guidelines to the system prompt.

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
- **`error`**: The turn failed or the runtime was stopped. You may retry with `send_agent` or create a new child via `spawn_agent`. Sending to a stopped child reactivates its existing session after the previous runtime is confirmed gone; retrying does not guarantee the underlying failure is resolved.

## Host Integration and Isolation

- **Herdr Workspace Affinity**: When spawning in Herdr, tabs are explicitly created in the parent process's current workspace (`--workspace <WORKSPACE_ID>`), preventing child tabs from jumping to whichever workspace happens to have user focus.
- **Hindsight Memory Isolation**: `PI_HINDSIGHT_DISABLE=1` is set in the child environment and memory auto-registration/recall/writeback are disabled. The child bridge blocks all `mcp__hindsight__*` calls (including nested codemode calls and future server tools), even if that server is configured in a file. Memory recall prompt blocks are stripped. This boundary applies to the reserved `hindsight` server name, not arbitrary external servers registered under other names.

## Agent definitions

Agent Markdown files are discovered in this order, most specific first, by `name`:

```text
<cwd>/.pi/agents/*.md
<cwd>/.agents/agents/*.md
~/.pi/agent/agents/*.md
```

Frontmatter is parsed with Pi's `parseFrontmatter` and validated against this package's schema. Supported fields: `name`, `display_name`, `description`, `hidden`, `model`, `thinking`, `tools`, `exclude_tools`, `extensions`, `skills`, `interactive`.

### Built-in Agents

- **`scout`**: Read-only reconnaissance agent. Disabled by default until the user explicitly configures a model in `~/.pi/agent/agents/scout.md`.
- **`worker`**: General implementation agent. Configured with `model: inherit` to inherit the parent session's model and thinking level.
- **`reviewer`**: Code review agent. Configured with `model: inherit` and leverages skill discovery to run review skills.
