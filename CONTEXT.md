# HEPI Extensions

Pi concrete extensions and ext-core use this language to keep tool contracts and user-visible resource references consistent.

## Language

**Output**:
Processed text produced by a tool and retained behind an opaque, read-only identifier for inspection. Legacy `output://` URIs are process-lifetime internal resources; the planned Output Target uses a session-qualified opaque id and a session-bound sidecar, subject to its declared persistence status. An Output is not a workspace path or reusable search-result data model. In displayed legacy text, `output://N:START-END` denotes inclusive, one-based Output lines.
_Avoid_: Artifact, artifact URL

**Target**:
An explicit tool execution destination. Omitted or `local` means the current local filesystem; `output` means a read-only Output resource; an SSH Target means an authorized OpenSSH Host alias. An internal URL in `path` remains a legacy resource identifier and takes precedence over Target.
_Avoid_: Backend, route

**SSH Target**:
A literal OpenSSH `Host` alias admitted by pi-ext-tools' user-controlled whitelist. It identifies an authorized remote destination, not an arbitrary hostname, credential, SSH option, or generic URL.
_Avoid_: Remote URL, SSH command

**Remote Path**:
A path interpreted on an SSH Target. A relative path is remote-home-relative; an absolute path is remote-filesystem-absolute. It is not a local workspace path, does not expand `~` or accept `..` segments, and does not include a Target alias prefix. TUI may render `host:path`; V4A and tool arguments still use the unprefixed Remote Path.
_Avoid_: Remote URL, workspace path, `host:path`

**Grep Result**:
The canonical representation of content-search matches, based on ripgrep match data. FFF results add available indexed-search metadata without replacing the common match meaning.
_Avoid_: FFF result, rg result

**Trace**:
One complete Pi agent loop from `agent_start` through `agent_end`. When the next Trace begins, completed tools from every prior Trace collapse in an unexpanded view. On session resume, all historical tools are collapsed until globally expanded.

**Handoff**:
A user-initiated transition from a Source Session to a clean Continuation Session that carries Handoff Context without inheriting source execution state.
_Avoid_: Session clone, fork

**Handoff Context**:
The immutable, model-visible record of knowledge carried by a Handoff. It contains historical context and the Handoff Summary, not mutable compression or tool state from the Source Session.
_Avoid_: Handoff artifact, handoff payload

**Source Session**:
The active primary Pi session in which a Handoff is requested and its Handoff Summary is produced.
_Avoid_: Parent session, handoff source

**Continuation Session**:
The clean Pi session created by a Handoff under the Source Session's project identity and model, linked to that session only for provenance.
_Avoid_: Destination session, child session

**Handoff Summary**:
The continuation-focused summary produced by the Source Session's active primary model through a Handoff Completion.
_Avoid_: Historian summary, compaction summary

**Source Context Snapshot**:
The immutable historical view fixed after handoff wrapup and before the Handoff Completion. It is the source evidence carried into the Continuation Session alongside the Handoff Summary.
_Avoid_: Session clone, live source context

**Handoff Completion**:
The command-triggered, no-tools model completion that produces a Handoff Summary without creating an interactive conversation turn.
_Avoid_: Handoff Trace, agent turn, subagent conversation

**Handoff Request**:
The durable Source Session record of an initiated Handoff and its recoverable progress. It belongs only to the Source Session and is never inherited by the Continuation Session.
_Avoid_: Pending operation, handoff job

**Handoff Attempt**:
The durable record that binds a replacement session to one Handoff Request while Handoff Context installation is unfinished or failed. A replacement session is not a Continuation Session until it contains the valid Handoff Context for that request.
_Avoid_: Continuation Session, retry

**Collapsed Tool Footer**:
A tool-owned, metrics-only completion summary rendered when a prior Trace is collapsed. It never parses model content. Failed or cancelled tools render only a concise reason plus duration.

**Search Engine**:
FFF or ripgrep, selected to execute a grep request and recorded only as internal result provenance. It is never shown to the model or TUI. An Output is a search input source, never a Search Engine.
_Avoid_: Backend

**Path Outcome**:
Actual result of one path after Publish or refusal: Changed, Rejected, Unconfirmed, or NotApplied. `apply_patch`, `write`, and `edit` all produce Path Outcomes.
_Avoid_: coordinator commit, remote commit

**Patch Outcome**:
Path Outcome of one V4A operation. Model content, TUI, and collapsed summaries format this fact rather than inferring it from requested patch text or renderer-local state.
_Avoid_: Patch request, patch render state, coordinator commit

**Write**:
Replacing one path's entire contents: create if missing, overwrite if present, and create missing parent directories. On an SSH Target the path is a Remote Path and the install is one Publish; identical bytes already on the Target are a successful no-change and do not Publish. It is not V4A Add or Update.
_Avoid_: Add, put, save

**Edit**:
Exact unique replacements in one existing file. Zero matches or a non-unique match does not Publish. On an SSH Target the path is a Remote Path. It is not V4A fuzzy Update.
_Avoid_: patch, search-replace

**Publish**:
Installing one path's prepared bytes or deletion onto the Target through a sibling temporary file and replace. A path is published only when it is fully prepared: Write has the new file, Edit has every exact replacement, apply_patch has every hunk. Only the replace or remove acknowledgement is Changed. It is not a request-level transaction. An exclusive mutation lock serializes apply_patch, Write, and Edit on one local workspace or one SSH Target alias, with a platform-native primitive; it does not detect or block external writers. V4A Add / Update / Delete existence, parent, and symlink rules remain apply_patch's dialect. apply_patch workspace membership is lexical: relative paths only, no `..`, no absolute, no alias prefix.
_Avoid_: Patch Push, remote commit, coordinator commit, sshfs commit, symlink jail, flock-as-contract

**Unconfirmed**:
A path whose Publish may have reached the Target without an observed acknowledgement. It is neither Changed nor Rejected, and must be read before another mutation.
_Avoid_: unknown, rolled back, partial

**NotApplied**:
A path that never began Publish, usually because a request-global stop (cancel or transport failure) occurred after earlier paths.
_Avoid_: Rejected, pending, rolled back

**Eval**:
An explicit opt-in pi-ext-tools tool that runs trusted local JavaScript in a session-scoped Eval Runtime. It is additive to the canonical tool catalog and is not a sandbox or a replacement tool mode.
_Avoid_: Code Mode, sandbox, tool router

**Eval Runtime**:
The per-extension-instance JavaScript execution scope used by Eval. It preserves completed-run state within that instance and is disposed on reload, resume, handoff, or session cleanup.
_Avoid_: Worker, sandbox, persistent session state

**Nested Tool**:
A pi-ext-tools canonical tool invoked from Eval through its explicitly admitted bridge. It retains the tool's schema validation, authorization, cancellation, and normalized result contract; Eval itself is never a Nested Tool.
_Avoid_: Direct registry access, recursive eval

**Eval Activation**:
The explicit static pi-ext-tools setting that admits Eval to a session's active catalog and Loadout. It is disabled by default and only changes after reload or a new session; it is never inferred from a model or provider.
_Avoid_: Automatic routing, model detection, runtime toggle

**Eval Source**:
Trusted local JavaScript executed by Eval. It supports top-level await but has no module-loading contract: static import, dynamic import, require, and TypeScript syntax are unavailable.
_Avoid_: Sandboxed script, TypeScript cell, module

**Cooperative Cancellation**:
Eval cancellation at awaited boundaries, including a Nested Tool call. It cannot stop a synchronous CPU-bound Eval Source run.
_Avoid_: Forced termination, execution timeout

**Eval Transcript**:
The ordered model-visible execution record for one Eval: printed text, Nested Tool summaries, and final serialized result. It is distinct from persisted structured details and from the tool's rendered body.
_Avoid_: TUI trace, details payload

**Eval Nested Catalog**:
The fixed set of Nested Tools: read, grep, find, bash, plus only the active Edit Mode tools. It excludes bash_job, Eval, Magic Context, and every tool owned outside pi-ext-tools.
_Avoid_: Pi registry, all active tools

**Eval Tool Error**:
The structured, serializable error thrown by a Nested Tool bridge call after validation, authorization, or execution failure. Its persisted trace preserves the underlying normalized tool result and diagnostic.
_Avoid_: TUI error text, swallowed tool failure

**Eval Display Value**:
A bounded, inspectable value emitted through display() separately from an Eval Transcript's final result. The first Eval version admits JSON-safe data and text, not binary, images, HTML, or interactive output.
_Avoid_: Arbitrary object serialization, UI trace

**Eval Lease**:
The exclusive ownership of one active run by an Eval Runtime. A concurrent request is refused as busy and does not queue, cancel, or share the active run.
_Avoid_: Run queue, concurrent cell

**Eval Final Value**:
The awaited value of an Eval Source's final expression. It is emitted separately from printed text and Display Values; undefined has no final-result row.
_Avoid_: Console output, display output

**Detached Eval Work**:
Async work started by Eval Source but not awaited by its top-level execution. Inline Eval does not attribute its later output or unhandled rejection to the Eval Transcript.
_Avoid_: Managed background run, recoverable floating promise

**Eval Result Detail**:
The bounded persisted representation of an Eval Transcript, Display Values, and Nested Tool traces. It references full text through Output when available and never copies Eval Source or raw nested tool details.
_Avoid_: Raw result dump, TUI cache

**Eval Script API**:
The supported globals in Eval Source: admitted `tool` methods, `console`/`print`, `display()`, and optionally read-only `cwd()`. Host APIs outside this set, even if reachable in trusted local JavaScript, have no Eval compatibility contract.
_Avoid_: Helper bag, Bun API contract
