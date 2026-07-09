# Block-scoped hashline mode design notes

## Core Shift And Tool Names

Existing mode:

```text
path + file-global anchors -> replace
```

Block mode as a separate tool family:

```text
block_id + block-local anchors -> replace
```

The model no longer passes `path`, file ID, file snapshot ID, or block version in the block replace call. `block_id` is the only file/range handle exposed to the model. Existing file-global `read`/`replace` behavior remains unchanged because block mode uses separate tools: `bread`, `breplace`, and `bgrep`.

## Main Components

### Block Store

A new internal store tracks returned writable blocks:

```ts
type BlockRecord = {
  blockId: string;
  version: string;
  source: "read" | "grep";
  path: string;
  canonicalPath: string;
  createdFileSnapshot: string;
  startLine: number;
  endLine: number;
  anchors: BlockAnchor[];
  retiredAnchors: Set<string>;
};

type BlockAnchor = {
  anchor: string;
  lineOffset: number;
  content: string;
  live: boolean;
};
```

Block records are session-only for v1. They live in memory and expire when the Pi session ends. The store should use LRU GC for inactive blocks when memory/count limits are reached. To preserve strict semantics, block IDs are not reused within the same session; if the 2-character ID space is exhausted, the tool returns an explicit error.

### Read Flow

1. `bread(path, offset, limit)` loads only the requested window if possible.
2. Tool enforces max 2000 lines per new block creation request; if exceeded, return a tool error.
3. Tool creates or merges a block record. Only same-file, same-source blocks that overlap or are directly adjacent are auto-merged. Merged adjacent blocks may exceed 2000 lines over time, but remain bounded by local-anchor allocation capacity and retired-anchor pressure.
4. Output starts with `block_id|version`, followed by local `ANCHOR|content` rows.

`bread(block_id)` refreshes the block's current range after modifications. If the original block can be exactly relocated, refresh should diff old block content against current block content, preserve anchors for unchanged lines where possible, retire removed anchors, allocate fresh anchors for new/changed lines, increment version, and return the updated block. If relocation is impossible or ambiguous, return a stale/ambiguous error and require a new `bread(path, offset, limit)`.

### Grep Flow

1. FFF finds matches and context.
2. Grep groups nearby ranges in the same file into balanced blocks.
3. Grep creates block records for those groups.
4. Output uses block headers and block-local anchors. Grep block headers may include line range metadata such as `AB|01 L120-L128`; rows stay pure `ANCHOR|content`.

Grep and read do not automatically share blocks. Grep may merge grep-result ranges internally only when they overlap or are directly adjacent in the same file.

### Replace Flow

1. `breplace({ block_id, from, to, content_lines })` loads the block record. Version is internal/display-only, not an input argument.
2. Validate block version/current file state.
3. Resolve `from`/`to` inside the block's live anchors.
4. Map local offsets to real file range.
5. Apply edit atomically.
6. Update the block internally: version increment, unchanged local anchors preserved via block-local diff, removed anchors retired, inserted/changed lines assigned fresh local anchors.
7. Return a bounded block-local changed interval / contextual diff by default. Include the block header/version and local anchors on context, removed, and added rows; removed anchors are displayed as retired and cannot be used for later edits. The model can call `bread(block_id)` to refresh the full updated block.

## Key Trade-Off

Block-range validation is the chosen v1 direction. The block record should store enough original text to prove the target segment is unchanged before applying a patch. This makes independent edits elsewhere in the file safer than whole-file snapshot validation.

Relocation is in scope, but only exact relocation. If edits before the block shift the original offset, the implementation may search for the stored block text plus boundary context. It may proceed only when there is exactly one unambiguous match. Zero matches, multiple matches, or boundary mismatches are stale/ambiguous errors. Fuzzy relocation remains out of scope.

## Preliminary Recommendation

Use block mode as a new mode, not a replacement. V1 should use block-range stale validation with exact relocation, reject cross-block replace, and only allow relocation if the exact stored block/boundary content can be found unambiguously. This gives the performance advantage for `grep` and windowed `read` while keeping the failure model strict.
