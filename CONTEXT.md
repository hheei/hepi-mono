# HEPI Extensions

Pi concrete extensions and ext-core use this language to keep tool contracts and user-visible resource references consistent.

## Language

**Output**:
Processed text produced by a tool and retained behind an opaque, read-only `output://` URI for the process lifetime. It is a resource for inspection, not a reusable search-result data model. In displayed text, `output://N:START-END` denotes inclusive, one-based Output lines. It is not an input URI: agents read it with base `output://N` plus native `offset` and `limit`.
_Avoid_: Artifact, artifact URL

**Grep Result**:
The canonical representation of content-search matches, based on ripgrep match data. FFF results add available indexed-search metadata without replacing the common match meaning.
_Avoid_: FFF result, rg result

**Trace**:
One complete Pi agent loop from `agent_start` through `agent_end`. When the next Trace begins, completed tools from every prior Trace collapse in an unexpanded view. On session resume, all historical tools are collapsed until globally expanded.

**Collapsed Tool Footer**:
A tool-owned, metrics-only completion summary rendered when a prior Trace is collapsed. It never parses model content. Failed or cancelled tools render only a concise reason plus duration.

**Search Engine**:
FFF or ripgrep, selected to execute a grep request and recorded only as internal result provenance. It is never shown to the model or TUI. An Output is a search input source, never a Search Engine.
_Avoid_: Backend

**Patch Outcome**:
Actual committed or rejected result of one V4A patch operation. It records affected paths and per-hunk matching facts; model content, TUI, and collapsed summaries format this fact rather than infer results from requested patch text or renderer-local state.
_Avoid_: Patch request, patch render state
