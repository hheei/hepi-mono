# @hheei/pi-ext-tools

Canonical owner for Pi `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`,
`list_tasks`, `wait_tasks`, `stop_tasks`, strict Codex V4A `apply_patch`,
opt-in `eval`, and `todo`.
Todo includes `/todo`, task scheduling, reminders, and a left-side footer status.
`apply_patch` matches and rewrites text in pure
JavaScript with jsdiff; it never requires a user-managed executable or a package-owned
native addon. `@hheei/pi-ext-core` is a production dependency, not a separately loaded
Pi extension. Install `@hheei/pi-settings` separately for the Settings and Loadout UI.

FFF runtime, commands, autocomplete, and enhancement settings are included;
`fff_multi_grep` is not registered as a model tool. The command surface is
`/fff status` and `/fff reindex`. Tab completion after `/fff ` and `/todo ` offers the
available subcommands.

## Background results

Task/Bash notifications and subagent reports share completion-gated delivery. While the parent
is working, results enter its next model step. While it is idle, ordinary results wait for all
background work to finish and wake one shared turn. Subagent decision requests and blockers
wake an idle parent immediately. There is no fixed notification window; `wait_tasks` remains
an independent read path and does not consume automatic notifications.

## apply_patch

`createApplyPatchTool()` still owns `APPLY_PATCH_PARAMETERS`, `parseV4aPatch()`, and
streaming call preview. Input remains one Codex V4A envelope:

- first line `*** Begin Patch`, last line `*** End Patch`
- files are `*** Add File` / `*** Update File` / `*** Delete File` sections in that
  same string, with optional `*** Move to` and `*** End of File`
- extra Begin/End markers stay ignored; markdown fences around the envelope are stripped

The tool does not accept unified diff as a second model input, does not invent Git
patches from surrounding prose, and does not let jsdiff headers choose paths. Paths
come only from the parsed V4A operation. jsdiff consumes an internally compiled
single-file, single-hunk unified diff whose path is the fixed staging name
`__apply_patch_target__`.

Successful hunks in an Update may Publish; failed hunks are reported separately.
Confirmed paths are never rolled back. There is no request-wide dry-apply
transaction. Absolute paths, relative paths, and out-of-workspace write warnings
keep the existing `PatchFs` / `assertPatchPath()` / `resolvePatchPath()` / Publish
rules; this is not a workspace sandbox.

Matching is strict by default (`applyPatch.fuzzFactor: 0` in `ext_settings.json`). A global setting
may set `fuzzFactor` to the integer `2`. Project extension settings may only lower
that value, never raise it above global (missing global is 0). `fuzzFactor` is
jsdiff's line-edit context tolerance, not a similarity score and not a maximum
line offset. jsdiff still searches for an offset at `fuzzFactor: 0`; deleted lines
must match, and context immediately around insertions stays exact. Duplicate exact
candidates are always rejected, including when fuzzy is on. Fuzzy uses jsdiff
first-fit and does not promise fuzzy ambiguity detection.

Each Update runs in one short-lived worker thread for all of that file's hunks.
The worker is memory-only: no staging directory, no native process, no retry pool.
Cancellation `terminate()`s that worker. Files stay capped at 32 MiB.

SSH Targets still read bytes locally through `createSftpPatchFs()`, compute on
this host, and Publish through the existing transport. The remote host does not
need Node or jsdiff.

Old `minSimilarity`, `maxConcurrentWorkers`, and `maxQueueDepth` keys are
unsupported and must be removed; they are not mapped to `fuzzFactor`.

## bash

`bash` runs one shell command or short pipeline. It keeps ordinary foreground execution and the
existing local background path, selected with `blocking: false`. Local commands running without an
explicit timeout automatically transition to a background task (e.g. `bash-1`) after `autoAsyncSeconds`
(default 60s, configurable in `pi-ext-tools.bash`, 0 disables) to avoid blocking the session; an
explicit `blocking: true` always waits, and a refused conversion is reported in the result instead of
silently staying foreground.
Remote `target` is an authorized SSH host and always runs in the foreground; `blocking: false` is
rejected there. Working directory on SSH is the remote home.
`output` remains unsupported.

A multi-line command is the request body: one row per command line, wrapped to the terminal, so the
frame never grows a row per command line and the header keeps only the call facts (`non-blocking`,
`(timeout Ns)`, plus `(host)` on an SSH Target). The full command stays in the persisted tool call
and in the model-visible arguments.

## task control

`list_tasks`, `wait_tasks`, and `stop_tasks` are registered for every session but stay
inactive until that session starts its first background task, so a session that never uses
background work carries none of their schemas or guidelines. Activation is derived from Pi's
own `getActiveTools()`: the session start deactivates them (Pi activates every registered
extension tool), the first `tasks.create()` activates them, and they are removed again only at
`session_compact` or `session_tree` while nothing needs control — no active task and no result the
parent has not confirmed reading (`registry.requiresControl`). `do not poll` lives on
`wait_tasks` itself, so it reaches `<rules>` only while task control is active.

## Tool Output

`grep`, `read`, `write`, `edit`, `find`, `ls`, `bash`, and `eval` declare `longOutput: true`, so
the shared `ToolTui` frame may collapse them after completion. The `Tool Output`
settings group (`toolTui.collapseMode`) selects when:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Collapse 15 seconds after completion; prior-Trace collapse still applies. |
| `on` | Collapse on the first completed frame; a long tool's partial output is not streamed. |
| `pertrace` | Keep only the existing prior-Trace rule. |
| `off` | Never collapse a frame automatically. |

Every automatic collapse — the 15-second `auto` timer, the `on` first completed frame, and the
prior-Trace collapse at the next `agent_start` — waits while the user is scrolled up (not
following the end) and happens as soon as they return to the end, because collapsing shrinks the
transcript and would otherwise pull the viewport away from what the user is reading. That
protection exists only in fullscreen, whose viewport Pi owns and can read; regular mode cannot
detect a reader, so nothing there preserves a reading position and it is never faked with a
`pi-tui` patch or a monkey-patched `ScrollView`.

Saving the setting applies it immediately; reload or a new session re-reads the
stored value. A pending timer never crosses `agent_start`, a session reset, or
shutdown. Collapsing changes only the visible frame, never the model-visible
result, and Ctrl+O still expands everything.

Third-party native packages such as `@ff-labs/fff-node` are unrelated to this
patch/bash runtime.
