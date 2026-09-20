# @hheei/pi-subagents

> Pre-release workspace: this package remains private until the recovery, native TUI handoff,
> user-facing controls, and release-gate work tracked in
> [`docs/pi-subagents/tickets.md`](../../docs/pi-subagents/tickets.md) is complete.

Run several independent Pi child sessions from one Pi session, each with its own Pi session
file, its own RPC runtime, and its own durable identity.

The package is a single concrete extension with one `pi.extensions` entry
(`dist/extension.js`). The same entry runs on both sides: the parent branch registers the
model-facing tools, the child branch registers only the reporting bridge.

## Parent tools

| Tool | Purpose |
| --- | --- |
| `spawn_subagent({ task, agent, cwd? })` | Resolve an agent definition and start one background RPC child. |
| `send_subagent({ id, message, mode? })` | Send `steer`, `follow_up`, or `auto` input to a specific child. |
| `get_subagent({ id })` | Inspect one child: state, mode, session, summary, usage, runtime freshness. |
| `list_subagents({})` | List children owned by this parent session. |
| `stop_subagent({ id })` | Persist a stopped intent, then end the runtime. |

There is no batch-spawn tool: parallel children come from Pi's own parallel tool calls.
`agent` is required; this package ships no built-in default agent, so an unresolved or
missing agent name fails before any process starts.

The child branch registers exactly one tool, `contact_parent({ reason, message })`, with
reasons `progress_update`, `important_finding`, `need_decision`, and `blocked`.

## Agent definitions

Agent Markdown files are discovered in this order, most specific first, by `name`:

```text
<cwd>/.pi/agents/*.md
<cwd>/.agents/agents/*.md
~/.pi/agent/agents/*.md
```

Frontmatter is parsed with Pi's `parseFrontmatter` and then validated against this
package's schema. Supported fields: `name`, `display_name`, `description`, `hidden`,
`model`, `thinking`, `tools`, `exclude_tools`, `extensions`, `skills`. The Markdown body
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

## Notes

- `@hheei/pi-ext-core` is a production dependency, not a separately loaded extension.
- Child processes are deliberately independent of the parent process lifetime; parent
  cleanup releases local connections only.
- This package does not use ext-core's in-process `startSubagent`: that contract cancels the
  child when the parent shuts down, which is incompatible with surviving, reconnectable
  children.
