# @hheei/pi-subagents

Run several independent Pi child sessions from one Pi session, each with its own Pi session
file, its own runtime, and its own durable identity.

The package is a single concrete extension with one `pi.extensions` entry
(`dist/extension.js`). The same entry runs on both sides: the parent branch registers the
model-facing tools, commands, compact footer status, and info entries; the child branch registers only the reporting
bridge and session-leave reporting.

## Parent tools

The extension registers no global keyboard shortcuts. Use `/subagents` to manage
children and `/subagents stop [id]` to stop one without conflicting with other extensions.

| Tool | Purpose |
| --- | --- |
| `agent_spawn({ task, agent, cwd?, title? })` | Spawn an independent background subagent task. Runs in a new Herdr tab (or cmux surface) targeting the parent's workspace when a host is available, and headless in the background otherwise. **Prefer reusing existing subagents** via `agent_send` for related/follow-up work to maintain context and maximize prompt cache and memory efficiency. Tool description lists available agent names and roles, excluding disabled or hidden definitions. Deferred by default; discover via `tool_search({ query: "agent" })`. Do not poll for completion; results return automatically. |
| `agent_send({ id, message, mode? })` | Send `steer`, `follow_up`, or `auto` input to a specific child. **Primary tool for assigning follow-up or functionally related tasks** to existing subagents: idle, blocked, done, or errored children resume their existing session automatically with historical context intact. A child whose runtime has ended is resumed the same way; spawn a new child only for new work. Stop first only when send says the previous process is still running. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `agent_get({ id, keys? })` | Inspect one subagent by id. `keys` is a comma-separated selection of `status` (default), `progress` (default), and `diagnostic`; unknown keys fail. The view never returns the child's task parameters or terminal result, which arrive automatically as reports. From the second successful inspection of the same child in this parent runtime, the result adds a short reminder that results return automatically and must not be polled. Deferred by default; discover via `tool_search({ query: "agent" })`. |
| `agent_stop({ id })` | Stop one subagent's runtime by id. The child keeps its session, so a later `agent_send` can resume it. Deferred by default; discover via `tool_search({ query: "agent" })`. |

### Unified Task Management

`agent_spawn` returns JSON `{ id, path }` on success. `path` is the absolute child session file path
assigned by Pi; its first write may still be pending. `agent_get` exposes the same `progress.path`.
`agent_send` and `agent_stop` return one confirmation
sentence. Failures return only their reason. Operation results omit session IDs, presentation, and
state snapshots; use `agent_get` for runtime inspection.

SubagentManager and its SQLite ledger own child conversation state, runtime leases, recovery, and reports. No pi-ext-tools task service is required. Only delivery batching is shared through ext-core BackgroundDelivery. Child reports arrive automatically; do not poll status to detect completion. Bash uses separate `bg_bash_*` tools. Deferred subagent tools are loaded via `tool_search`; `before_agent_start` writes the `subagents` bullet into the structured prompt's `optional_tools` section. Both get tools return the same `status`, `progress`, and optional `diagnostic` envelope. Diagnostics describe blockers, failed turns, or uncertain runtime state.

## Child execution and reporting

Subagents communicate with the parent through the `commands` table in `state.sqlite`, with each child holding a SQLite process lock that proves its writer is alive:

- **Completion by Direct Output**: Subagents do **not** need to call any reporting tool upon successful completion. The subagent simply outputs its final answer as normal assistant text.
- **Settlement Batching**: When a subagent settles, the harness captures the trailing assistant text and delivers it to the parent conversation as a `subagent-report`. Reports flush within 500ms when no other child is working, and are batched for up to 10 seconds while another child is still running.
- **Blockers & Decisions**: The child registers `contact_parent({ message, reason? })` strictly for reporting when it is blocked or urgently requires a parent decision midway (`reason` defaults to `'blocked'`). Blocked reports wake the parent immediately.
- **Automatic Retry**: Pi's own auto-retry is observed, not invented: reports are suppressed while a retry is in flight, and a retry that succeeds clears the previous error instead of reporting it.
- **Panel Failure Auto-Close**: When a subagent running in a panel encounters a fatal error or reports a blocker, the manager starts a 15-second countdown after notifying the parent, automatically closing the panel tab to avoid workspace clutter unless new instructions are dispatched.
## Compact status and reports

Running children use the native Pi status line: `🤖 󰪠#21 #22 #23`. With pi-status installed, this appears at the bottom right before the existing TODO segment, separated by ` ‧ `. Display shorthand `#21` refers to tool ID `agent-21`. No running children means no agent segment; no multi-line parent widget is mounted.

Confirmed done, error, and blocked reports appear once as `subagent-info` transcript entries. Collapsed entries show the outcome, child ID, and agent name; expand to read the complete report. They survive resume and do not enter model context. The original automatic `subagent-report` still reaches the model, with its duplicate transcript display hidden. Transient errors remain subject to settlement and retry checks before reporting.

Use `/subagents` for complete status and management. `agent_send` can resume a done, blocked, errored, or stopped child with its session context intact; retrying does not guarantee the underlying failure is resolved.

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

Frontmatter is parsed with Pi's `parseFrontmatter` and validated against this package's schema. Supported fields: `name`, `display_name`, `description`, `hidden`, `model`, `thinking`, `tools`, `exclude_tools`, `extensions`, `skills`, `mcp`, `codemode`.

### Unified Resource Selection (Pi Semantics)

`tools`, `skills`, and `mcp` follow Pi's unified selection semantics:

- **`boolean` toggle**:
  - `true` (or omitted): Full inheritance from host defaults.
  - `false`: Completely disabled (passes `--no-mcp`, `--no-skills`, `--no-tools` respectively; `--no-mcp` physically shuts down the MCP subsystem so no server processes or network connections start).
  - MCP selection (`mcp: [server1]`) acts at the tool exposure and execution boundary via `--tools` / `--exclude-tools` patterns and child-bridge tool call gating. Non-whitelisted or excluded server tools cannot be viewed or called.
- **Exact list (Whitelist / Replace)**:
  - `[item1, item2]`: Activates only the named entries.
- **Incremental modifiers (`+` / `-`)**:
  - `["+itemA", "-itemB"]`: Adds or excludes entries relative to base defaults. Exact names and modifiers cannot be mixed.

### Built-in Agents

- **`scout`**: Read-only reconnaissance agent. Disabled by default until the user explicitly configures a model in `~/.pi/agent/agents/scout.md`.
- **`worker`**: General implementation agent. Configured with `model: inherit` to inherit the parent session's model and thinking level.
- **`reviewer`**: Code review agent. Configured with `model: inherit` and leverages skill discovery to run review skills.
