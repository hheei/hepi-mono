# Hashline-aware FFF grep design

## Problem

`pi-hashline` currently gives the model stable `HASH│content` anchors through `read`, but grep output from the FFF reference package still uses normal line numbers. The goal is to make grep output directly usable by `replace` without preserving normal line numbers as an alternate locator.

## Proposed V1

Add a branch in the `packages/pi-hashline` submodule that registers a `grep` tool backed by `@ff-labs/fff-node`.

The tool should:

- initialize and reuse a single `FileFinder` per active cwd;
- call FFF `grep()` for search ranking, filtering, pagination, context, and smart-case behavior;
- process only the files needed for the displayed result page;
- compute anchors from a fresh stat-validated hash snapshot when available;
- otherwise use no-snapshot prefix hashing when eligible, or compute stable anchors with `lineHashes(fullContent, absolutePath)` and update the snapshot cache;
- format all code rows as pure `HASH│content` rows;
- add `hit: HASH` metadata after each match block to identify the actual matched anchor;
- omit normal line numbers entirely from the user-visible grep output.

## Output Shape

Example:

```text
src/example.ts
Ab3│function target() {
Cd4│  return value;
Ef5│}
hit: Cd4

[Continue with cursor="fff_c1"]
```

Rules:

- File headers may include FFF file annotations such as git/frecency status.
- Context and match rows must stay pure `HASH│content` rows.
- The matched row is identified by `hit: HASH` after the block.
- No normal line numbers are printed.
- No-match output is `No matches found`.
- Pagination notices are metadata lines, not code rows.

## FFF to Hashline Mapping

FFF returns 1-based `lineNumber` for each match.

Mapping:

- match anchor: `hashes[match.lineNumber - 1]`;
- before context anchor: `hashes[match.lineNumber - contextBefore.length + index - 1]`;
- after context anchor: `hashes[match.lineNumber + index]`.

This assumes FFF context rows are contiguous around the match. Tests should lock this assumption against representative FFF-shaped fixtures.

FFF also exposes `byteOffset`, `col`, `matchRanges`, file `size`, and file `modified`. These fields are useful for diagnostics and future optimizations, but v1 should not treat them as anchors. The hashline contract remains `lineHashes(content, absolutePath)` plus 1-based line-number indexing.

## Performance Strategy

The naive path would make FFF search file content, then make hashline grep load and hash the same displayed files again. For large files this can be expensive, especially when the model later calls `read`. V1 should therefore include a stat-validated hash snapshot cache rather than treating optimization as future work.

Hash-store snapshots should be extended from `{ content, hashes }` to include stat metadata derived from `fileSnap(absolutePath)`, for example `snapshotId`, `mtimeMs`, and `size`. Existing snapshots without metadata remain valid for normal `lineHashes(content, path)` calls but are not eligible for grep's no-full-read fast path until refreshed by a full read/hash operation.

Grep anchor resolution should use three tiers:

1. Fresh snapshot cache hit: stat the file, compare current `fileSnap().snapshotId` with stored snapshot metadata, and use `hashes[lineNumber - 1]` directly without loading the full file.
2. True cold prefix path: when no full hash-store snapshot exists for the file, read from file start through the last displayed context line, compute pure prefix hashes, and store them only in a separate partial prefix cache keyed by file snapshot id. If a later request needs more lines than the cached prefix covers, recompute from the beginning through the larger prefix and replace the partial cache; do not append incrementally and do not write partial hashes to the persistent full hash-store.
3. Full-load fallback: when a full snapshot exists but is stale/metadata-less, prefix validation is insufficient, or window reading fails, load and validate the full displayed file, normalize it the same way `read` does, call `lineHashes(fullContent, absolutePath)`, and store the resulting hashes with fresh stat metadata.

The cache-hit path still needs display text. It should prefer a small local line-window reader around FFF `byteOffset` so output text gets the same explicit truncation marker as the cold path. FFF's `lineContent`/context strings are useful fallback data, but the type definition says `lineContent` may already be truncated, so using it as an exact `HASH│content` row without marking would be misleading.

Cold-prefix hashing is correct only under narrow conditions: pure hash assignment for line N depends on previous lines, not future lines, so a prefix through the last displayed row can match full pure hashing. V1 should enable this path by default only when the canonical path has no full hash-store snapshot at all. It must not be used when a stored full snapshot exists but stat metadata is stale or missing, because `lineHashes(fullContent, path)` might still preserve old hashes after full content comparison.

The prefix cache should be deliberately simple: store only the current file snapshot id, the covered prefix end, and the hashes for that prefix. If a request is within the cached prefix, reuse it. If a request needs beyond the cached prefix, reread from byte 0 / line 1 through the larger prefix and replace the cached prefix. This avoids incremental append state and removes the need for profitability heuristics. Existing validation still applies: require FFF `isBinary === false`, local stat size within `MAX_BYTES`, a known prefix end through the last displayed context row, and prefix/window text validation.

## Algorithm Boundary

Do not replace the current 3-character perfect/stable hash algorithm for this grep branch. The hard part is not producing any short token for a line; it is preserving all current guarantees at once: compact anchors, per-file uniqueness, duplicate-line disambiguation, stable unchanged-line anchors, and strict stale-anchor rejection.

Content-only hashes are easy to compute from FFF snippets but cannot distinguish byte-identical lines. Position-salted hashes using `lineNumber` or `byteOffset` are easy to compute from FFF metadata but make unrelated insertions or formatting shifts invalidate later anchors. Occurrence-ordinal hashes reduce dependence on absolute position, but duplicate insertions above a line still shift ordinals and 3-character collision handling still needs prefix/global state.

The practical bottom-layer change is therefore an index-layer change: evolve the persistent hash store into a stat-validated line-anchor index while keeping `lineHashes()` as the single source of truth. Fresh index hits let grep map line numbers to anchors without full-file reads; true cold files use simple prefix-coverage caching; stale or metadata-less snapshots full-load to preserve stable hashes.

## Limits and Solutions

| Limit | Why it matters | V1 solution |
| --- | --- | --- |
| FFF returns line numbers and byte offsets, not anchors | Hashes require collision resolution and persistent store awareness | Keep the existing hash algorithm; use stat-validated stored hashes on cache hit, no-snapshot prefix hashing when eligible, or full-file `lineHashes(content, absolutePath)` fallback |
| Snippet-only hashing is incorrect | Duplicate lines need full-file perfect hashing to get distinct anchors | Never hash a single returned line in isolation |
| grep may touch many files | `lineHashes(content, path)` writes hash-store snapshots and full hashing can be costly | Only process files present in the displayed result page; memoize each file once per grep call; reuse fresh stored hashes when possible |
| Native FFF finder can race on DB locks | `pi-fff` already serializes `FileFinder.create()` calls | Reuse the same single-flight initialization pattern |
| Root scanning is dangerous/noisy | FFF refuses `/` unless explicitly enabled | Keep root scan disabled by default; expose flag/env equivalent if needed |
| Binary/image/oversized files cannot produce useful anchors | Hashline replace only supports text lines | Reuse `loadFileKindAndText()`/validation; skip or error cleanly for non-text files |
| Long lines can blow token budget | Full grep output may be too large | Use bounded display with explicit truncation marker; anchor still targets the full line |
| Marking match rows can corrupt hashline rows | Prefixing `>` makes rows no longer pure `HASH│content` | Keep rows pure and add `hit: HASH` metadata after each block |
| FFF dependency is native | Install/runtime failures should be explicit | Add `@ff-labs/fff-node` as a normal branch dependency and fail clearly on init errors |
| Replacing the hash algorithm is tempting | Content-only or position-salted anchors make grep easier but weaken duplicate-line uniqueness or stability across edits | Preserve the current 3-character perfect/stable hash wire format and optimize through a line-anchor index layer |
| Prefix caching can grow complex | Incremental append and profitability heuristics add edge cases | Use simple prefix coverage: reuse if covered; otherwise reread from start to the larger prefix and replace the partial cache |

## Dependency Boundary

`packages/pi-fff` is reference-only. The branch should import `@ff-labs/fff-node` directly and should port only the small pieces needed from `pi-fff`, such as query/path normalization and finder lifecycle patterns.

## Tests

Minimum tests:

- one grep match without context emits a `HASH│content` row whose hash equals `lineHashes(fileContent, path)[lineNumber - 1]`;
- one grep match with before/after context emits context anchors matching the same `lineHashes` array;
- output contains `hit: HASH` for the matched row;
- output does not contain normal line-number row prefixes like `12:` or `11-`;
- binary or oversized file handling does not emit fake hashline rows;
- cursor pagination notice is metadata and does not look like a code row;
- a stable-snapshot duplicate-line scenario verifies grep output matches `lineHashes(content, path)`, not a standalone per-line hash;
- a fresh stat-cache hit test verifies grep maps anchors without full-file load/hash and still emits correct displayed line windows;
- a stale stat-cache test verifies grep falls back to full load/hash before emitting anchors;
- a no-snapshot prefix-hash test verifies displayed anchors match later full-file `lineHashes(content, path)` for the same lines;
- a no-snapshot prefix-cache test verifies a request inside the cached prefix reuses it;
- a no-snapshot prefix-cache test verifies a request beyond the cached prefix recomputes from the beginning and replaces the partial cache;
- a no-snapshot prefix-hash test verifies no partial hash snapshot is written to the persistent full hash-store.

## Branch and Repo Handling

Implementation belongs inside the `packages/pi-hashline` submodule on a feature branch. The parent repo should only track the resulting submodule commit when the branch work is ready.
