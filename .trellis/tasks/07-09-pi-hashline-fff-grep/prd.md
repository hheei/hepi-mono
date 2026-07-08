# Build hashline-aware fff grep

## Goal

Plan a `pi-hashline` branch that uses the FFF search backend from `@ff-labs/fff-node` to provide a hashline-aware grep function. The grep output should use `HASH│content` anchors from `pi-hashline` instead of normal line numbers, so the model can jump directly from grep output to `replace` without a separate `read` call when the matched/context lines are sufficient.

## Background

The current reference package `pi-fff` already wraps `@ff-labs/fff-node` and registers FFF-backed `ffgrep`, `fffind`, and optional `fff-multi-grep` tools. Its grep output groups results by file, but it still formats match and context rows with normal line numbers such as `12:` and `11-`.

`pi-hashline` already replaces the normal `read`/`replace` workflow with strict hashline anchors. Its read output uses `HASH│content`, and its replace tool accepts only `hash_range_inclusive` anchors. The new grep path should make grep output participate in the same anchor protocol.

## Repository Evidence

- `packages/pi-fff/src/index.ts` imports `FileFinder` from `@ff-labs/fff-node` and calls `FileFinder.create({ basePath, frecencyDbPath, historyDbPath, aiMode: true, enableHomeDirScanning: true, enableFsRootScanning })`.
- `pi-fff` serializes concurrent `FileFinder.create()` calls because native DB locks can race/deadlock if created in parallel for the same base path.
- `pi-fff` calls `finder.grep(query, { mode, smartCase, maxMatchesPerFile, cursor, beforeContext, afterContext, classifyDefinitions })`.
- FFF grep results include `relativePath`, `lineNumber`, `byteOffset`, `col`, `lineContent`, `matchRanges`, optional `contextBefore`, optional `contextAfter`, file annotations such as git status/frecency, file `size`/`modified`, and pagination cursor data.
- `pi-fff` currently formats grep rows with normal line numbers and truncates each line to `GREP_MAX_LINE_LENGTH = 500`.
- `packages/pi-fff/src/query.ts` normalizes path/exclude constraints and builds the query string consumed by FFF's query parser.
- `packages/pi-hashline/src/hashline/hash.ts` exports async `lineHashes(content, path)` and `HASH_SEP = "│"`; `lineHashes` is the single source of truth for stable anchors and uses a persistent hash store when a file path is supplied.
- `packages/pi-hashline/src/read.ts` formats read previews with `fmtRegion(selectedHashes, selected)` to emit `HASH│content` rows.
- `pi-hashline` strict semantics require consumers to use just the 3-character anchor in `replace`; normal line numbers are not part of the edit contract.
- `packages/pi-hashline/package.json` currently does not depend on `@ff-labs/fff-node`; this branch should add it as a normal dependency.
- `packages/pi-hashline` is tracked as an upstream submodule from `https://github.com/YuGiMob/pi-hashline-edit-pro`; implementation work should happen on a branch inside that submodule, not as ordinary parent repo files.
- `packages/pi-fff` is a local reference package only and should not become a maintained dependency target.
- Upstream `packages/pi-hashline` is already at latest `origin/master` (`83f4145`, release `0.15.5`) as of this research pass; no submodule pointer update was needed.
- Recent upstream hash changes did not replace the full per-line hash-array approach. They improved stable duplicate-line disambiguation by making `mapStableHashes()` hash-aware and by collecting every hash in an edited range into `removedHashes`, including interior duplicates.

## Key Constraints and Limits

- FFF grep gives line numbers and byte offsets, but hashline anchors cannot be computed safely from returned snippets alone. V1 must read the full displayed file and call `lineHashes(fullContent, absolutePath)`, then map FFF's `lineNumber` and context offsets to the corresponding hash entries.
- Context rows returned by FFF are only text arrays. Their anchor mapping must be derived from `match.lineNumber - contextBefore.length + index` and `match.lineNumber + 1 + index`; this assumes FFF context rows are contiguous around the match.
- Grep output should use bounded line display with a clear truncation marker. The anchor still refers to the full file line; if exact full content is needed, the model can call `read` on the file or use the anchor in `replace` directly.
- `lineHashes(content, path)` writes/updates the persistent hash store. V1 may use that normal side effect, but should only hash files included in the displayed grep result page.
- A no-full-file optimization is not a v1 requirement. Prefix hashing could match pure hashes for displayed rows when no stable snapshot is involved, and stat-validated hash-store lookup could avoid reads on cache hits, but both require additional hash-store/API design to preserve strict `read`/`replace` equivalence.
- FFF can refuse root scanning unless explicitly enabled. The hashline-aware grep should inherit `pi-fff`'s safe default: no filesystem-root scan unless an explicit flag/env enables it.
- Binary/image/non-text files must not produce hashline rows; reuse `pi-hashline` file loading helpers where possible. `loadFileKindAndText()` already rejects unsupported files, detects null bytes, handles UTF-8 decode errors, and enforces the existing `MAX_BYTES = 100 * 1024 * 1024` limit.
- The tool must avoid adding line numbers back as an alternate locator; the requirement explicitly removes normal line numbers from the primary output.
- Output format for v1: file header line, one or more pure `HASH│content` rows for context/match lines, then `hit: HASH` metadata identifying the actual match anchor for that block. No-match output is `No matches found`. Pagination uses a non-code notice such as `[Continue with cursor="..."]`.

## Requirements

- Add a branch plan for `packages/pi-hashline` that introduces a hashline-aware `grep` replacement powered by `@ff-labs/fff-node`.
- Add `@ff-labs/fff-node` as a normal dependency of the `pi-hashline` branch; grep should fail clearly if FFF initialization fails rather than silently falling back to non-hashline grep.
- Reuse or port the relevant FFF query/path/exclude normalization behavior from `pi-fff` so the grep contract remains ergonomic.
- Format grep match and context rows as pure `HASH│content` rows using anchors produced by `pi-hashline`'s `lineHashes(fullContent, absolutePath)`. Displayed line content may be bounded/truncated with an explicit marker.
- Do not include normal line numbers in the main grep output.
- Identify actual matched rows with `hit: HASH` metadata after each match block, without adding markers to the `HASH│content` rows themselves.
- Register the hashline-aware tool as `grep` in v1 rather than adding a separate `hashgrep`/`hgrep` migration tool.
- Preserve useful FFF behavior where compatible: smart-case, regex/plain detection, path/exclude constraints, context lines, limit, cursor pagination, git/frecency-aware file ordering.
- Keep strict hashline semantics: grep output anchors must be suitable for `replace` without fuzzy correction or alternate line-number fallback.
- Avoid hashing every match candidate when only a limited result page will be displayed; only read/hash files needed for the displayed results page.
- Allow grep to update the persistent hash store for displayed files, matching `read` behavior and preserving anchor consistency with future `replace` calls.
- Keep root scanning disabled unless explicitly enabled through a flag/env equivalent to `pi-fff`'s `fff-enable-root-scan` / `FFF_ENABLE_ROOT_SCAN`.
- Reuse `pi-hashline` text loading and validation behavior for displayed files so binary/image/oversized files do not emit hashline rows.
- Add tests that prove grep output anchors match the same file lines that `read`/`replace` would use.

## Acceptance Criteria

- [x] The PRD identifies the exact tool surface: v1 replaces/registers `grep` directly.
- [x] The PRD defines the output format for file headers, pure `HASH│content` rows, `hit: HASH` metadata, pagination notices, and no-match output.
- [x] The PRD defines how FFF line numbers map to hashline anchors without exposing normal line numbers.
- [x] The PRD defines dependency handling for `@ff-labs/fff-node` inside `pi-hashline`: add it as a normal branch dependency.
- [x] The PRD defines root-scan, binary-file, large-file, truncation, and hash-store side effect limits.
- [x] The truncation behavior is defined: bounded row display with an explicit marker, while anchors still refer to full file lines.
- [x] The PRD defines tests for at least one matched line and one context line, verifying anchors match `lineHashes` for the same file.
- [x] The PRD records the no-full-file hashing research conclusion: full-file `lineHashes` remains the v1 path; prefix/cache optimization is future work unless the hash-store contract changes.
- [x] Blocking product decisions are resolved before technical design begins.

## Out of Scope

- Maintaining or modifying `packages/pi-fff`; it remains a reference package.
- Keeping normal line numbers as a parallel edit locator in hashline-aware grep output.
- Replacing `pi-hashline`'s `read` or `replace` contracts.
- Implementing a full `fffind` replacement unless later planning explicitly adds it.
- Implementing this in the parent repo as ordinary tracked files; code changes belong to a branch inside the `packages/pi-hashline` submodule.

## Open Questions

- Resolved: v1 replaces/registers `grep` directly in `pi-hashline` so models naturally use hashline-aware grep output.
- Resolved: hashline-aware grep uses bounded/truncated line display with an explicit marker; use `read` when exact full line content is needed.
- Resolved: code rows remain pure `HASH│content`; each match block adds `hit: HASH` metadata after the block to identify the matched anchor.
- Resolved: hashline-aware grep may update the persistent hash store for files included in displayed grep results.
- Resolved: `@ff-labs/fff-node` should be a normal dependency of the `pi-hashline` branch.
