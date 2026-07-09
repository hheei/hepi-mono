# Lazy Hashline Contract

## Scenario: File-Scoped Lazy Hashline Tools

### 1. Scope / Trigger

- Trigger: changing `packages/pi-hashline` model-facing file tools, lazy anchor allocation, lazy persistence, or hashline edit semantics.
- Applies to: `read`, `grep`, `insert`, `edit`, and compatibility code that can affect lazy state.
- Source of truth: `docs/lazyhashline.md`; this spec captures implementation contracts future changes must preserve.

### 2. Signatures

- `read(path, offset?, limit?)` returns `HASH│content` rows for the requested visible range.
- `grep(pattern, path?, fuzzy?, context?, limit?, exclude?, caseSensitive?)` uses FFF-backed search and returns hashline-marked matched/context rows.
- `insert(path, beforeHashline, content_lines)` inserts complete content lines before `beforeHashline`; `beforeHashline: -1` inserts at EOF.
- `edit(path, changes[])` applies one or more hashline ranges where each change has `hash_range_inclusive: [start, end]` and `content_lines: string[]`.

### 3. Contracts

- Hashlines are 3-character anchors from `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`.
- Lazy state is keyed by canonical file path, not display path.
- Only observed lines from `read`/`grep` and newly created lines from `insert`/`edit` may become live lazy anchors.
- `lineToHash` and `hashToLine` are the authoritative inverse live mappings. `cacheSections` is derived from `lineToHash`.
- New allocations must avoid both current live hashes and `retiredHashes` for the same canonical file.
- `read` must hash only the rendered/requested range. If `limit` is omitted, use the read preview default page size rather than observing to EOF.
- `grep` must not impose algorithm-side short-query or fuzzy safety restrictions. Fuzzy behavior is controlled by parameters/settings.
- Mutating operations prepare the next lazy state in memory, write file content atomically, refresh serial, then commit and persist the lazy state.
- Compatibility paths such as legacy `replace` must not seed the lazy store with full-file hashes. They may preserve previously live observed hashes that survive, and must retire previously exposed hashes that disappear.

### 4. Validation & Error Matrix

| Condition | Behavior |
|-----------|----------|
| Unknown or malformed hashline | Reject with a clear hashline reference error such as `[E_BAD_REF]` or `[E_STALE_ANCHOR]` |
| File serial changed before hashline `edit` or insert-before-hashline | Reject with `[E_STALE_FILE]` and require fresh `read`/`grep` |
| File serial changed before `read`/`grep` | Discard stale lazy state and rebuild lazily from returned lines |
| Multi-edit ranges overlap in initial state | Reject before writing |
| Replacement content contains hashline-prefixed rows | Reject; content lines must be raw file content |
| Write fails during `insert`/`edit` | Do not commit or persist the prepared lazy state |
| Lazy mappings diverge or duplicate live hashes appear | Treat as `[E_LAZY_STATE]` invariant failure |

### 5. Good/Base/Bad Cases

- Good: `read(path, offset: 40, limit: 10)` observes only lines 40-49, reusing existing anchors inside that range.
- Good: `edit` replacing lines 10-50 retires only live anchors inside that span; unseen lines inside the span have no lazy bookkeeping.
- Good: legacy `replace` after lazy `read` preserves surviving observed anchors and retires exposed anchors that no longer appear.
- Base: EOF `insert` may proceed with refreshed state because it does not modify unseen existing content.
- Bad: `read(path)` allocates anchors for every line in a large file while returning only the preview page.
- Bad: mutating shared lazy state before `writeAtomic()` succeeds.
- Bad: persisting `content + hashes` full-file snapshots as lazy state.

### 6. Tests Required

- Duplicate-anchor prevention with repeated identical lines and sparse observed ranges.
- Anchor reuse across overlapping `read` and `grep` results.
- Retired-anchor non-reuse after lazy `edit`, lazy `insert`, and legacy `replace` compatibility paths.
- Multi-edit initial-state semantics with line insertions/deletions before later ranges.
- Edit ranges crossing unseen gaps.
- Stale serial: `read`/`grep` refresh; `edit` and insert-before-hashline reject.
- Canonical path aliases, including symlink path vs real path where practical.
- Same-file lock/concurrency behavior when adding or mutating observed anchors.
- Atomic write/state commit order for mutating operations.

### 7. Wrong vs Correct

#### Wrong

```ts
const state = await loadLazyState(path, serial, "reject");
setFreshLineHash(state, insertedLine, content);
replaceLiveMappings(state, state.lineToHash);
await writeAtomic(path, nextContent);
await persistLazyState(state);
```

This mutates shared state before the file write succeeds. A failed write leaves in-memory or persisted state describing content that is not on disk.

#### Correct

```ts
const baseState = await loadLazyState(path, serial, "reject");
const nextState = cloneLazyState(baseState);
setFreshLineHash(nextState, insertedLine, content);
replaceLiveMappings(nextState, nextState.lineToHash);
await writeAtomic(path, nextContent);
nextState.serial = await fileSerial(path);
updateInMemoryState(nextState);
await persistLazyState(nextState);
```

All mutations happen on an uncommitted next state. The shared lazy state changes only after the atomic file write succeeds and the new serial is known.
