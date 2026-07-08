# Hashline-aware FFF grep design

## Problem

`pi-hashline` currently gives the model stable `HASH│content` anchors through `read`, but grep output from the FFF reference package still uses normal line numbers. The goal is to make grep output directly usable by `replace` without preserving normal line numbers as an alternate locator.

## Proposed V1

Add a branch in the `packages/pi-hashline` submodule that registers a `grep` tool backed by `@ff-labs/fff-node`.

The tool should:

- initialize and reuse a single `FileFinder` per active cwd;
- call FFF `grep()` for search ranking, filtering, pagination, context, and smart-case behavior;
- read only the files needed for the displayed result page;
- compute stable anchors with `lineHashes(fullContent, absolutePath)`;
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

## Limits and Solutions

| Limit | Why it matters | V1 solution |
| --- | --- | --- |
| FFF returns line numbers, not anchors | Hashes require full-file collision resolution and persistent store lookup | Read the full displayed file and call `lineHashes(content, absolutePath)` before formatting |
| Snippet-only hashing is incorrect | Duplicate lines need full-file perfect hashing to get distinct anchors | Never hash a single returned line in isolation |
| grep may touch many files | `lineHashes(content, path)` writes hash-store snapshots | Only hash files present in the displayed result page |
| Native FFF finder can race on DB locks | `pi-fff` already serializes `FileFinder.create()` calls | Reuse the same single-flight initialization pattern |
| Root scanning is dangerous/noisy | FFF refuses `/` unless explicitly enabled | Keep root scan disabled by default; expose flag/env equivalent if needed |
| Binary/image/oversized files cannot produce useful anchors | Hashline replace only supports text lines | Reuse `loadFileKindAndText()`/validation; skip or error cleanly for non-text files |
| Long lines can blow token budget | Full grep output may be too large | Use bounded display with explicit truncation marker; anchor still targets the full line |
| Marking match rows can corrupt hashline rows | Prefixing `>` makes rows no longer pure `HASH│content` | Keep rows pure and add `hit: HASH` metadata after each block |
| FFF dependency is native | Install/runtime failures should be explicit | Add `@ff-labs/fff-node` as a normal branch dependency and fail clearly on init errors |

## Dependency Boundary

`packages/pi-fff` is reference-only. The branch should import `@ff-labs/fff-node` directly and should port only the small pieces needed from `pi-fff`, such as query/path normalization and finder lifecycle patterns.

## Tests

Minimum tests:

- one grep match without context emits a `HASH│content` row whose hash equals `lineHashes(fileContent, path)[lineNumber - 1]`;
- one grep match with before/after context emits context anchors matching the same `lineHashes` array;
- output contains `hit: HASH` for the matched row;
- output does not contain normal line-number row prefixes like `12:` or `11-`;
- binary or oversized file handling does not emit fake hashline rows;
- cursor pagination notice is metadata and does not look like a code row.

## Branch and Repo Handling

Implementation belongs inside the `packages/pi-hashline` submodule on a feature branch. The parent repo should only track the resulting submodule commit when the branch work is ready.
