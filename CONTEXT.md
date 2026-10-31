# Pi Extensions

Pi concrete extensions and ext-core use this language to keep tool contracts and user-visible resource references consistent.

## Language

**Grep Result**:
The canonical representation of content-search matches, based on ripgrep match data.
_Avoid_: raw grep output, backend-specific search result

**Trace**:
One complete Pi agent loop from `agent_start` through `agent_end`. When the next Trace begins, completed tools from every prior Trace collapse in an unexpanded view. On session resume, all historical tools are collapsed until globally expanded.

**Subagent Run**:
A parent-owned unit of delegated agent work whose identity, policy, lifecycle, and terminal outcome remain stable for that parent session.
_Avoid_: Provider job

**Collapsed Tool Footer**:
A tool-owned, metrics-only completion summary rendered when a prior Trace is collapsed. It never parses model content. Failed or cancelled tools render only a concise reason plus duration.

**Search Engine**:
Ripgrep (`rg`), executed to satisfy grep requests on the local workspace. Recorded as internal result provenance. An Output is a search input source, never a Search Engine.
_Avoid_: Backend

**Path Outcome**:
Actual result of one path after Publish or refusal: Changed, Rejected, Unconfirmed, or NotApplied. `apply_patch` produces Path Outcomes; `write` and `edit` execute through Pi's native tools on the local workspace and persist their own diff view.
_Avoid_: coordinator commit, remote commit

**Patch Outcome**:
Path Outcome of one V4A operation. Model content, TUI, and collapsed summaries format this fact rather than inferring it from requested patch text or renderer-local state.
_Avoid_: Patch request, patch render state, coordinator commit

**Write**:
Replacing one path's entire contents: create if missing, overwrite if present, and create missing parent directories. `write` delegates to Pi's native write tool; it is not V4A Add or Update.
_Avoid_: Add, put, save

**Edit**:
Exact unique replacements in one existing file, executed by Pi's native edit tool. Zero matches or a non-unique match writes nothing. It is not V4A fuzzy Update.
_Avoid_: patch, search-replace

**Publish**:
Installing one path's prepared bytes or deletion through a sibling temporary file and replace. A path is published only when it is fully prepared: apply_patch has every hunk. Only the replace or remove acknowledgement is Changed. It is not a request-level transaction, and nothing is rolled back. V4A Add / Update / Delete existence, parent, and symlink rules remain apply_patch's dialect. apply_patch accepts absolute and relative paths; a relative path resolves from the workspace root, may leave it lexically, and a confirmed change outside the workspace is reported as a warning. No lock serializes the write tools.
_Avoid_: Patch Push, coordinator commit, request transaction, flock-as-contract

**Unconfirmed**:
A path whose Publish may have reached the filesystem without an observed acknowledgement. It is neither Changed nor Rejected, and must be read before another mutation.
_Avoid_: unknown, rolled back, partial

**NotApplied**:
A path that never began Publish, usually because a request-global stop (cancel or transport failure) occurred after earlier paths.
_Avoid_: Rejected, pending, rolled back

**Eval**:
The explicit opt-in pi-python-eval tool `python_eval`, which runs trusted local Python through a session-scoped Eval Kernel. `codemode` belongs to Pi host and is not this package.
_Avoid_: Sandbox, tool router, second runtime

**Eval Exposition**:
The policy that decides which tools the model sees versus which tools exist only as Nested Tools. The implemented Sibling Exposition keeps every canonical tool visible and adds `python_eval` beside them.
_Avoid_: Separate runtime, provider-specific eval

**Eval Kernel**:
The killable per-session Python subprocess that executes Eval Source, preserves completed-run scope, and performs Nested Tool invokes through an injected table. It uses `ext_settings.json`'s `pythonBin` when set, otherwise `python3`/`python` on PATH (3.9+). Reload, resume, and session cleanup dispose the kernel; Python memory is not restored.
_Avoid_: Shared VM, in-process eval, notebook kernel, inline host eval, Jupyter, vendored V8 isolate, Pi registry

**Eval Reset**:
An Eval Request that discards the Eval Kernel and its scope before running. It is not session dispose and not cancellation of a running cell.
_Avoid_: Reset all languages, timeout, reload

**Eval Cell**:
One kernel execution identified by cell_id. Eval waits until the cell completes or is terminated; it does not yield and no wait tool exists.
_Avoid_: Inline run, queued job

**Eval Runtime**:
The per-session owner of the Eval Kernel, the Eval Lease, and the Nested Catalog Policy. It does not execute source in the Pi host process.
_Avoid_: Host AsyncFunction, process-global runtime on pi.events
**Nested Tool**:
A tool invoked from Eval Source through the kernel's injected invoke table. It retains that tool's schema validation, authorization, cancellation, and normalized result contract. Eval and the task-control tools are never Nested Tools.
_Avoid_: Direct registry access, recursive eval

**Eval Activation**:
The explicit static pi-python-eval setting that admits `python_eval` to a session's active catalog. The tool is `defaultActive: false` with `model-only` exposure, and it only changes after reload or a new session; it is never inferred from a model or provider.
_Avoid_: Automatic routing, model detection, runtime toggle

**Eval Source**:
Trusted local Python executed by an Eval Kernel. There is no Jupyter, notebook, or implicit pip contract; language builtins and already-installed packages stay available inside the kernel process.
_Avoid_: Sandboxed script, TypeScript cell, notebook

**Eval Cancellation**:
Terminating the active Eval Cell and aborting its Nested Tool calls. Python first receives SIGINT and keeps the kernel if the cell stops; a cell that ignores interrupt is SIGKILL'd after about 5 seconds and its scope is discarded. The request's `timeout_ms` deadline uses this same path. Session dispose still kills the kernel.
_Avoid_: Immediate kill on every cancel, cooperative-only inline abort, execution timeout

**Eval Transcript**:
The ordered model-visible execution record for one Eval: printed text, Nested Tool summaries, the kernel's namespace report, and final serialized result. It is distinct from persisted structured details and from the tool's rendered body.
_Avoid_: TUI trace, details payload

**Eval Kernel State Report**:
The namespace report the kernel sends with every cell's `done`: the current top-level name count, the names this cell bound for the first time, and the names it imported again. It is the model's only direct evidence that names survived, so a cell reports it on success, failure, and cancellation alike. Distinct from the host's own observations, which are the restart notice and the unattributed output captured between cells.
_Avoid_: Snapshot, persistence, dump

**Eval Nested Catalog Policy**:
The invoke table injected into an Eval Kernel: read, grep, find, foreground bash, edit, write, and apply_patch, each re-checked for active status on every call. It excludes the task-control tools, `python_eval` itself, and every tool owned outside pi-ext-tools. The kernel never reads the Pi registry.
_Avoid_: Pi registry, all active tools, hardcoded kernel catalog

**Eval Tool Error**:
The structured, serializable error thrown by a Nested Tool bridge call after validation, authorization, or execution failure. Its persisted trace preserves the underlying normalized tool result and diagnostic.
_Avoid_: TUI error text, swallowed tool failure

**Eval Display Value**:
A bounded, inspectable value emitted through display() separately from an Eval Transcript's final result. It admits JSON-safe data and text, not binary, images, HTML, or interactive output.
_Avoid_: Arbitrary object serialization, UI trace

**Eval Lease**:
The exclusive ownership of one active Eval Cell by an Eval Runtime. A concurrent request is refused as busy and does not queue, cancel, or share the active cell.
_Avoid_: Run queue, concurrent cell

**Eval Final Value**:
The awaited value of an Eval Source's final expression. It is emitted separately from printed text and Display Values; undefined has no final-result row.
_Avoid_: Console output, display output

**Detached Eval Work**:
Async work started by Eval Source but not awaited by the Eval Cell. After the cell completes or is terminated, later output or rejection is outside the Eval Transcript. Kernel shutdown drops that work.
_Avoid_: Managed background run, recoverable floating promise

**Eval Result Detail**:
The bounded persisted representation of an Eval Transcript, Display Values, and Nested Tool traces. It references full text through Output when available and never copies Eval Source or raw nested tool details.
_Avoid_: Raw result dump, TUI cache

**Eval Script API**:
The supported host bindings in Eval Source: injected `tool` methods, `console`/`print`, `display()`, and read-only `cwd()`. Language builtins remain available inside the kernel process. Host APIs outside this set have no Eval compatibility contract.
_Avoid_: Helper bag, Bun API contract, OMP prelude

**Eval Request**:
The public `python_eval` input: non-empty `code` (at most 1 MiB) plus optional `reset` and `timeout_ms`. `reset` wipes the kernel and scope before running. `timeout_ms` is a hard wall-clock deadline for the whole cell, default 180000 ms, so nested tool calls count toward it. It has no title, cwd, or model-routing parameter.
_Avoid_: Execution profile, target selector, code mode request, title

**Caught Eval Tool Error**:
An Eval Tool Error handled by Eval Source. Its Nested Tool trace remains failed, but it does not make the enclosing Eval fail; an uncaught error does.
_Avoid_: Automatic outer failure, suppressed trace

**Foreground Nested Bash**:
The only Bash execution admitted by the Eval Nested Catalog. It preserves normal foreground local behavior but rejects an explicit background request (`blocking: false`).
_Avoid_: Nested background job
