# @hheei/pi-bg-bash

Background Bash for Pi. Owns one `BashJobRegistry`, the session execution ledger, job logs and
terminal report delivery. The foreground `bash` tool and the `bash` settings group belong to
`@hheei/pi-ext-tools`; this package only reads that group.

Install `@hheei/pi-settings` separately for the Settings UI. `@hheei/pi-ext-core` is a production
dependency, not a separately loaded Pi extension.

## Tools

- `bg_bash_spawn({ command, timeout? })` — starts a local command and returns JSON `{ id, path }`,
  where `path` is the absolute log file path, on success, or the reason on failure. It does not
  accept a caller ID.
- `bg_bash_get({ id, keys? })` — queries `status`, `progress`, or `diagnostic` using a comma-separated
  keys string; default is `status,progress`. Unknown keys fail.
- `bg_bash_stop({ id })` — stops that Bash process tree and returns one confirmation sentence or a
  failure reason.

All three tools use deferred exposure, are inactive by default, and can be discovered with
`tool_search` query `bg_bash`. There are no list or wait tools. Progress is bounded runtime context;
completed output returns through automatic `bg-bash-report` delivery. Progress and automatic notices
provide the same path (`progress.path` in get); read or grep that file for full output.

## Execution records

Background execution records persist in `tasks/<sessionId>/bash.sqlite` beside the logs. Reload and
session shutdown still stop owned processes. Resume restores records and missing reports only; it
never adopts an old PID, resumes execution, or reruns a command. Missing reliable terminal evidence
becomes `unknown`, with a warning that side effects may remain and logs may be incomplete. The agent
must inspect evidence before deciding its next action. `bg_bash_stop` cannot stop an unknown
historical execution. Reports are reconciled against the current raw session branch, including
compacted ancestors. Forks use their own execution ledger. Legacy logs without ledger records remain
untouched.

BashJobRegistry owns a single idle notice after 180s without stdout/stderr and periodic 1800s
heartbeats, with timers cleared on stop, terminal state, or disposal. PTY work is deferred.
Subagents use their separate `agent_*` tools and own execution state; only delivery batching is
shared through ext-core BackgroundDelivery.

## Settings

The `bash` group in the global `ext_settings.json` is registered by `@hheei/pi-ext-tools`. This
package reads the same values at session start:

| Field | Default | Effect here |
| --- | --- | --- |
| `shellPath` | `$SHELL` | Shell that runs background commands. |
| `outputTailKiB` | `10` | Output tail retained per job record. |

## Migration

`@hheei/pi-bg-bash` replaces the background half of `@hheei/pi-ext-tools`. Add this package
explicitly to keep `bg_bash_spawn`, `bg_bash_get` and `bg_bash_stop`; the combined extension no
longer registers them. Tool names, ledger and log paths, the `bash` settings keys and the
`bg-bash-report` delivery channel are unchanged.
