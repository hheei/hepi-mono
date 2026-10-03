# @hheei/pi-subagents

Run several independent Pi child sessions from one Pi session, each with its own Pi session
file, its own runtime, and its own durable identity.

The package is a single concrete extension with one `pi.extensions` entry
(`dist/extension.js`). The same entry runs on both sides: the parent branch registers the
model-facing tools, commands, and widget; the child branch registers only the reporting
bridge and session-leave reporting.

## Parent tools

| Tool | Purpose |
| --- | --- |
| `subagent_enable({})` | Enable interactive agent tools (`spawn_agent`, `send_agent`, `get_agent`, `stop_agent`) on demand. Deactivated by default in new sessions to save tokens; appends available interactive agents if any are defined, and enabled tools become available on the next model request. |
| `spawn_agent({ task, agent, cwd?, title? })` | Start one child and return when its bridge is ready and the initial task was delivered. Runs in a new Herdr tab (or cmux surface) targeting the parent's workspace when a host is available, and headless in the background otherwise. `title` (<= 60 chars) names the child's Pi session, shown as `🤖 <title>`. Requires `subagent_enable`. Do not poll `get`/`list` for completion; reports arrive automatically as `pi-subagent-report` messages. Do not pause or freeze other subagents before spawning. |
| `send_agent({ id, message, mode? })` | Send `steer`, `follow_up`, or `auto` input to a specific child. Idle-reclaimed or finished children resume the same session automatically. Do not wait for or ask workers to 'freeze': idle subagents are completely dormant and touch nothing. Requires `subagent_enable`. |
| `get_agent({ id })` | Inspect one child: state (`running` / `done` / `blocked`), presentation (`panel`/`background`), session, summary, usage, runtime freshness, and model/thinking. Requires `subagent_enable`. |
| `list_agents({})` | List available interactive agent definitions and running subagents owned by this parent session. |
| `stop_agent({ id })` | Persist a stopped intent, then end the runtime: a background child is killed, a panel child has its panel closed and verified gone. Requires `subagent_enable`. |

### Unified Task Management

Subagent execution tasks automatically register with ext-core's `TaskRegistry`. Background bash jobs and subagents are uniformly tracked and waited upon using `wait_tasks`, eliminating fragmented or redundant task tools.

## Child execution and reporting

Subagents communicate with the parent over a dedicated Unix domain socket bridge:

- **Completion by Direct Output**: Subagents do **not** need to call any reporting tool upon successful completion. The subagent simply outputs its final answer as normal assistant text.
- **Settlement Debounce**: When a subagent finishes a turn and remains idle for 5 seconds (to prevent false idles), the harness automatically captures the trailing assistant text and delivers it to the parent conversation dialog as a completed `pi-subagent-report`.
- **Blockers & Decisions**: The child registers `contact_parent({ message, reason? })` strictly for reporting when it is blocked or urgently requires a parent decision midway (`reason` defaults to `'blocked'`). Blocked reports wake the parent immediately.
- **Automatic Retry**: If a subagent encounters a transient error, the harness allows one automatic retry before marking the task failed or delivering a blocked notification.

## Three visual states

Subagent lifecycle is streamlined into three visual states in the TUI widget and status line:

- **`running`** (blue/amber): Starting, executing turns, auto-retrying, or waiting out the 5-second settlement debounce.
- **`done`** (green checkmark `✓`): Succeeded and automatically reported final assistant text back to the parent.
- **`blocked`** (red/dim `!`): Failed, interrupted, stopped, or explicitly blocked via `contact_parent`.

## Host Integration and Isolation

- **Herdr Workspace Affinity**: When spawning in Herdr, tabs are explicitly created in the parent process's current workspace (`--workspace <WORKSPACE_ID>`), preventing child tabs from jumping to whichever workspace happens to have user focus.
- **Hindsight Memory Isolation**: Subagents are completely isolated from the parent's long-term Hindsight memory. `PI_HINDSIGHT_DISABLE=1` is set in the child environment, hindsight tools are excluded via `--exclude-tools`, and any memory recall prompt blocks are stripped to protect memory banks from subagent noise.

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
