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

**Patch Outcome**:
Actual committed or rejected result of one V4A patch operation. It records affected paths and per-hunk matching facts; model content, TUI, and collapsed summaries format this fact rather than infer results from requested patch text or renderer-local state.
_Avoid_: Patch request, patch render state
