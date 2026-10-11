# @hheei/pi-ext-tools

Canonical owner for Pi `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`,
`bg_bash_spawn`, `bg_bash_get`, `bg_bash_stop`, strict Codex V4A `apply_patch`,
opt-in `eval`, and opt-in `todo`.
Todo includes `/todo`, task scheduling, reminders, and a left-side footer status (disabled by default, opt-in via settings).
`apply_patch` matches and rewrites text in pure
JavaScript with jsdiff; it never requires a user-managed executable or a package-owned
native addon. `@hheei/pi-ext-core` is a production dependency, not a separately loaded
Pi extension. Install `@hheei/pi-settings` separately for the Settings and Loadout UI.


## Python eval and codemode

In addition to canonical filesystem and execution tools, `pi-ext-tools` provides advanced batch execution runtimes:

- **`eval`**: Persistent local Python execution kernel with support for multi-step data wrangling and direct nested tool calls (e.g. `tools.read(...)`, `tools.bash(...)`). State and variable bindings survive across calls until explicitly reset. Every cell reports its namespace — the current name count, the names it added, and any import it repeated — so the model can see that state survived instead of re-importing defensively. `names()` returns the current top-level names. Output with no owning cell (a detached task, thread, or raw fd write) is reported to the next cell rather than dropped, and a kernel that is not the one the previous cell used reports `kernel restarted — earlier names are gone`.
- **`codemode`**: JavaScript sandbox orchestration tool that compiles and evaluates top-level async scripts calling nested tools in parallel or loops via `await Promise.all(...)`, drastically reducing conversational turns. Features budget-aware truncation, image signature verification, and execution metric badges matching Pi 1.0.

## Background results

Task/Bash notifications and subagent reports share completion-gated delivery. While the parent
is working, results enter its next model step. While it is idle, ordinary results wait for all
background work to finish and wake one shared turn. Subagent decision requests and blockers
wake an idle parent immediately. Bash idle notices (once after 180s without stdout/stderr) and
1800s heartbeats use the same BackgroundDelivery channel while ordinary terminal results remain gated.

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

`bash` runs one shell command or short pipeline in the foreground with an invocation timeout
(default 180s, or 25s for pure search commands). Remote `target` is an authorized SSH host;
working directory on SSH is the remote home. `blocking`, `async`, and `output` are unsupported.

A multi-line command stays in the persisted tool call and model-visible arguments. The renderer
shows command input separately from output, with timeout and SSH target facts in its header.

A provider forwards only a tool result's text parts, so a failed call states its reason and elapsed
time there: a cancellation keeps the partial output and appends `Bash aborted after <duration>`, and
a timeout appends `Command timed out after <timeout>s`. `structuredContent` serves programmatic
callers such as codemode and python_eval and carries no model-visible meaning.

## Background Bash

`bg_bash_spawn({ command, timeout? })` starts a local command and returns JSON `{ id, path }`,
where `path` is the absolute log file path, on success, or the reason on failure.
It does not accept a caller ID.
`bg_bash_get({ id, keys? })` queries `status`, `progress`, or `diagnostic` using a comma-separated
keys string; default is `status,progress`. Unknown keys fail. Progress is bounded runtime context;
completed output returns through automatic `<task-notice>` delivery. Progress and automatic notices
provide the same path (`progress.path` in get); read/grep that file for full output.
`bg_bash_stop({ id })` stops that Bash process tree and returns one confirmation sentence or a failure
reason. These tools reject agent IDs.

All three tools use deferred exposure and can be discovered with `tool_search` query `bg_bash`.
There are no list or wait tools. BashJobRegistry owns a single idle notice after 180s without
stdout/stderr and periodic 1800s heartbeats, with timers cleared on stop, terminal state, or disposal.
PTY work is deferred. Subagents use their separate `agent_*` tools and share TaskRegistry coordination.

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

patch/bash runtime.
