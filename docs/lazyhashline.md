# File-Scoped Lazy Hashline Design

## 1. Goal

Lazy hashline provides stable, short line anchors for agent editing without hashing the entire file upfront.

The core idea is:

```text
Only lines that have been observed or created receive hashlines.
Unseen lines do not have anchors and do not participate in hashline bookkeeping.
```

A line anchor is scoped to one canonical file, not to one read block and not globally across the repository.

```text
locator = canonical file path + 3-character hashline
```

The model-facing tool family is:

```text
read, grep, insert, edit
```

The tool may maintain hidden internal region handles for acceleration and validation, but these IDs are not shown to the model.

---

## 2. Output Format

`read` and `grep` return only hashline-marked content:

```text
a9K|const x = 1;
Pq2|const y = 2;
Lm0|console.log(x + y);
```

There is no visible block ID or version ID in the model-facing output.

Each `a9K`, `Pq2`, `Lm0` is a 3-character file-scoped hashline. If the same canonical file line is later returned by another `read` or `grep`, it should reuse the same hashline while the file state remains valid.

---

## 3. Internal State

Each canonical file maintains a lazy hashline state:

```ts
type FileState = {
  canonicalPath: string;
  displayPaths: Set<string>;

  // Used to detect external file modification.
  serial: FileSerial;

  // Ranges of lines that have received hashlines.
  cacheSections: IntervalSet; // e.g. [(10, 20), (40, 55)]

  // Current line number -> hashline.
  lineToHash: Map<number, Hash3>;

  // Hashline -> current line number.
  hashToLine: Map<Hash3, number>;

  // Hashlines that were once exposed but are no longer valid.
  retiredHashes: Set<Hash3>;

  // Optional checksums for cached sections or edit boundary sections.
  sectionChecksums?: Map<string, string>;

  // Optional hidden handles for acceleration and internal validation.
  regions: Map<string, RegionPointer>;

  // Per-file hashline allocator.
  salt: string;
  allocId: number;
};
```

The internal state key is always `canonicalPath`, so symlinks, relative paths, and alternate display paths do not create duplicate hashline states for the same file.

`fileSerial` can be implemented cheaply with:

```text
inode + size + mtimeNs
```

A stronger safety setting may additionally verify checksums for cached sections or edit boundary sections. It should not require a full-file checksum on every operation.

---

## 4. Hashline Allocation

Hashlines are 3 characters long and use the original pi-hashline 6-bit alphabet:

```text
ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_
```

That gives:

```text
64^3 = 262144 possible hashlines
```

The allocator should reuse the original pi-hashline duplicate-avoidance idea: hash canonicalized line content, convert the high bits to the 3-character 6-bit alphabet, and retry with a deterministic suffix or probe until the candidate is unique. Lazy mode changes only the uniqueness set.

Allocation rule:

```text
candidate = hash3(fileSalt + allocId + probe + canonicalLineContent)

if candidate is not live and not retired:
    assign candidate
else:
    increment probe and try again
```

A newly allocated hashline must not collide with:

```text
1. currently live hashlines in the same file
2. retired hashlines in the same file
```

Retired hashlines are not reused within the same file state. If the anchor space is exhausted, the tool returns a clear allocation error rather than emitting a duplicate hashline.

Required invariants:

```text
lineToHash and hashToLine are always inverse mappings for live anchors.
No live hashline appears on two lines in the same file state.
No retired hashline is live.
New or changed lines receive fresh hashlines.
Unchanged observed lines keep their hashlines across line shifts when the file state remains valid.
```

---

## 5. `read` Algorithm

Given:

```text
read(file, startLine, length)
```

The tool performs:

```text
1. Canonicalize the file path and lock that file state.
2. Check fileSerial.
3. For read/grep: If fileSerial is stale, discard the old file state and build a fresh lazy state. For edit/insert by hashline: If fileSerial is stale, reject the operation and require a new read/grep.
4. Read the requested line range.
5. Compute which parts of the range are already in cacheSections.
6. For uncached lines, allocate new hashlines.
7. Update lineToHash and hashToLine.
8. Merge the new ranges into cacheSections.
9. Persist the updated lazy state if persistence is enabled.
10. Return hashline|content for the whole requested range.
```

Example:

```text
cacheSections = [(1, 50)]

read(file, 40, 30)
target = [40, 69]

already cached = [40, 50]
uncached       = [51, 69]
```

Only lines `51..69` receive new hashlines. The returned output still includes all lines `40..69`.

---

## 6. `grep` Algorithm

`grep` uses FFF as the backend. Fuzzy behavior is user-configurable; the algorithm does not restrict short queries or reinterpret fuzzy risk. The tool's responsibility is to mark the returned lines correctly and keep hashline state consistent.

Given:

```text
grep(pattern, path?, fuzzySetting?, context?, limit?)
```

The tool performs:

```text
1. Canonicalize each matched file path and lock each file state while updating it.
2. Run FFF grep with the configured fuzzy behavior.
3. Collect match windows and context windows returned by FFF.
4. For each matched window, compare it with cacheSections.
5. Allocate hashlines only for uncached lines.
6. Merge all newly exposed ranges into cacheSections.
7. Persist updated lazy states if persistence is enabled.
8. Return hashline|content for all grep result windows.
```

If a grep result overlaps previously read lines, those lines reuse their existing file-scoped hashlines.

Output metadata may state which fuzzy setting produced the result, but fuzzy-vs-exact result choice is a user/model policy concern, not a hashline correctness concern.

---

## 7. `edit` Algorithm

`edit` may support one or more range edits in one call. Multiple edits are always interpreted against the initial file state, not against intermediate states produced by earlier edits in the same call.

Given:

```text
edit(file, changes[])

type Change = {
  startHashline: Hash3;
  endHashline?: Hash3;
  newContent: string[];
}
```

The tool performs:

```text
1. Canonicalize the file path and lock that file state.
2. Check fileSerial and optional configured checksums.
3. Resolve every startHashline/endHashline against the initial hashToLine map.
4. If endHashline is omitted, endLine = startLine.
5. Convert every resolved line range to an initial byte span.
6. Reject overlapping ranges in the initial file state.
7. Compute all replacement spans from the initial file state.
8. Apply spans from the end of the file toward the start. After applying all spans, surviving cached lines outside replaced ranges are relocated by the cumulative line-count deltas of edits before them.
9. Retire all live hashlines inside every replaced range.
10. Allocate fresh hashlines for replacement content.
11. Shift, trim, or remove cached ranges affected by each initial span and line-count delta.
12. Preserve unchanged observed lines and their hashlines where their content and identity are unaffected.
13. Refresh fileSerial.
14. All state updates are prepared transactionally. The file is written atomically first; only after the write succeeds and the new fileSerial is known should the lazy state be committed and persisted.
15. Return a diff with current post-edit hashlines for the changed area.
```

The edit range may cross unseen lines. Unseen lines have no hashline bookkeeping; they are rewritten as ordinary file content. The tool only retires known live hashlines in the affected range.

Example:

```text
cacheSections = [(10, 20), (40, 50)]

edit(hash at line 15, hash at line 45, newContent)
```

This rewrites:

```text
15..45
```

Lines `21..39` were never cached, so they have no hashline bookkeeping. The tool retires known hashlines in `15..20` and `40..45`, allocates fresh hashlines for the replacement content, preserves `10..14`, and shifts any surviving cached ranges after the edit according to the line-count delta.

All state updates are transactional: the file content, cacheSections, lineToHash, hashToLine, retiredHashes, serial, and persisted state must either all reflect the edit or all remain unchanged.

---

## 8. `insert` Algorithm

`insert` replaces the previous `append` naming. It inserts content before a known hashline, or at EOF when the target is `-1`.

### Insert before a known hashline

```text
insert(file, beforeHashline, newContent)
```

Steps:

```text
1. Canonicalize the file path and lock that file state.
2. Resolve beforeHashline -> line L.
3. newContent is a list of complete lines, without hashline prefixes.
4. Allocate fresh hashlines for newContent.
5. Shift cached line mappings at and after L.
6. Update cacheSections.
7. Refresh fileSerial and persist state.
```

### Insert at EOF

```text
insert(file, -1, newContent)
```

Steps:

```text
1. Canonicalize the file path and lock that file state.
2. Find EOF.
3. Insert newContent at the end of the file.
4. Allocate fresh hashlines for newContent.
5. Add the new range to cacheSections.
6. Refresh fileSerial and persist state.
```

EOF insert can be allowed even if the previous EOF region was never read, because it does not modify unseen existing content.

---

## 9. Safety Settings

Safety is user-configurable. The tool does not need to prevent the user or model from choosing fuzzy search, crossing unseen regions, or using relaxed validation. Its obligation is to make the chosen behavior internally consistent and to fail clearly when its own state is stale or contradictory.

Recommended safety layers:

```text
basic:
  Check fileSerial before every state-mutating operation.

stronger:
  Also verify checksums for cached sections or edit boundary sections touched by the operation.

relaxed/custom:
  May skip optional checks according to user settings, but must still preserve state invariants.
```

If fileSerial indicates external modification, v1 should clear the affected file state and require new `read` or `grep` output before hashline-based `edit` or `insert` by hashline can proceed. This keeps v1 simple and avoids relocation/diff complexity.

---

## 10. Persistence

Lazy state may be semi-persisted to disk. It should not reuse the original full-file hash store shape that stores complete file content and every line hash, because that would undermine the lazy design.

A persisted record should contain only lazy bookkeeping:

```ts
type PersistedLazyFileState = {
  version: 1;
  canonicalPath: string;
  serial: FileSerial;
  cacheSections: Interval[];
  lineToHash: [number, Hash3][];
  retiredHashes: Hash3[];
  salt: string;
  allocId: number;
  sectionChecksums?: [string, string][];
};
```

On load, if the persisted serial still matches the current file, the state can be reused. If it does not match, the state is discarded and the next `read` or `grep` creates a fresh lazy state.

---

## 11. Concurrency

All operations that read or mutate a file's lazy state should run under a per-canonical-file lock. Different files can proceed concurrently. The lock covers:

```text
read state extension
grep state extension
edit resolution + write + state update
insert resolution + write + state update
persisted state load/save for that file
```

This prevents concurrent operations from allocating duplicate hashes, resolving against stale line positions, or saving an older state over a newer one.

---

## 12. Core Semantics

The final semantics are:

```text
Hashlines are scoped to a canonical file.

Only observed or newly created lines receive hashlines.

Unseen lines have no hashline and no stability guarantee.

Edits are located by canonical file path + file-scoped hashline.

An edit range may cross unseen lines if the configured safety policy allows it.

Multiple edits in one call resolve against the initial file state.

Live hashlines inside replaced ranges are retired.

Inserted or replacement lines receive fresh hashlines.

Unchanged observed lines keep their hashlines and move with line-number shifts.

fileSerial and optional section checksums protect the tool's own state from stale external modifications.
```

## State Authority

`lineToHash` and `hashToLine` are the authoritative live-anchor mappings.

`cacheSections` is an interval index derived from the live mappings. It exists to speed up overlap and complement queries, but it must remain consistent with `lineToHash`. If inconsistency is detected, the file state should be invalidated rather than repaired silently.

## Stale Serial Policy

For `read` and `grep`, a stale `fileSerial` invalidates the old lazy state and the tool may build a fresh state from the current file content.

For `edit` and `insert` by hashline, a stale `fileSerial` must reject the operation. The caller must obtain fresh hashline output through `read` or `grep`.

## Atomic Commit Order

State mutation is prepared in memory first.

The file content is then written atomically. Only after the atomic write succeeds should the tool refresh `fileSerial`, commit the new lazy state, and persist it.

If the file write or persistence fails, the implementation must not leave a persisted lazy state that claims to describe file content that was not successfully written.

## Multi-Edit Line Relocation

All edits in one call resolve against the initial file state.

For each live cached line:
- if it lies inside any replaced span, retire its hashline;
- otherwise, shift it by the cumulative line-count delta of all edit spans before it.

Replacement lines receive fresh hashlines after the new file layout is computed.

---

# Comparison with Full-File Hashline

## Full-File Hashline

The full-file design eagerly assigns hashlines to every line in the file.

Typical state:

```text
file content snapshot
+
hashline for every line
+
line-to-hash mapping for the whole file
```

Advantages:

```text
1. Every line has an anchor.
2. Any line can be edited after one full-file hash pass.
3. Grep and read can share the same full-file anchor table.
4. It can provide strong whole-file stability semantics.
```

Disadvantages:

```text
1. read(offset, limit) still needs to read/hash the whole file.
2. grep results may require full-file hash tables for matched files.
3. Large files pay unnecessary upfront cost.
4. The tool must maintain full-file snapshots or full-file diff state.
5. Stable insertion/replacement requires careful global collision handling.
6. More complex cache invalidation after edits or external modifications.
```

The full-file approach is strongest when the desired invariant is:

```text
Every line in the file has a stable anchor, whether or not it was shown to the model.
```

---

## Lazy File-Scoped Hashline

The lazy design assigns hashlines only to lines that have been returned by `read`, returned by `grep`, or created by `edit`/`insert`.

Typical state:

```text
cached line ranges
+
hashline mappings only for cached lines
+
retired hashline set
+
fileSerial
+
optional section checksums
```

Advantages:

```text
1. read only hashes the requested range.
2. grep only hashes returned match windows.
3. Unseen lines do not consume anchors.
4. No full-file hash table is required.
5. No full-file content snapshot is required.
6. Edits can still be accurately located by file + hashline.
7. Existing cached lines remain stable across line shifts.
8. Much lower cost for large files and sparse access patterns.
```

Disadvantages:

```text
1. Unseen lines have no anchor.
2. The system cannot promise stability for lines before they are observed.
3. Editing across unseen regions requires careful interval bookkeeping.
4. The cache must shift line mappings after edits.
5. External modification detection is necessary.
6. Debugging requires careful interval bookkeeping.
```

The lazy approach is best when the desired invariant is:

```text
Only lines the model observed or created need stable anchors.
```

---

## Summary Table

| Dimension                      | Full-File Hashline                   | Lazy File-Scoped Hashline                  |
| ------------------------------ | ------------------------------------ | ------------------------------------------ |
| Anchor scope                   | Whole file                           | Whole file, but only observed lines        |
| Hashing cost on read           | Full file                            | Requested range only                       |
| Hashing cost on grep           | Full matched file or full file table | Returned grep windows only                 |
| Grep backend                   | Any grep backend                     | FFF with configurable fuzzy behavior       |
| Unseen lines                   | Have anchors                         | No anchors                                 |
| Edit locator                   | File + global hashline               | Canonical file + observed hashline         |
| Edit across unseen gap         | Fully tracked                        | Allowed by policy, but gap has no hashes   |
| Multi-edit semantics           | Global resolved state                | All edits resolve against initial state    |
| Stability guarantee            | Stronger                             | Only for observed/created lines            |
| State size                     | O(total file lines)                  | O(observed lines)                          |
| External modification handling | Snapshot/diff or serial check        | serial check + optional section checksums  |
| Complexity                     | Full-file snapshot and remapping     | Interval shifting and partial mappings     |
| Best for                       | Strong whole-file identity           | Agent-oriented sparse editing              |

---

## Final Recommendation

Use lazy file-scoped hashline when the tool is primarily for agent editing.

It gives the model stable anchors for everything seen, avoids full-file hashing, and keeps output simple:

```text
HHH|content
```

The key rule is:

```text
A hashline is a stable handle for an observed line in a specific canonical file, not a promise that every line in the file already has an anchor.
```
