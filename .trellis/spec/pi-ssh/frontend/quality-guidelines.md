# Frontend Quality Guidelines

## Rendering Standards

- Tool output previews should trim trailing whitespace for display while preserving meaningful output in details.
- Empty output should render as `(no output)`.
- Long collapsed output should show only the last preview lines and a skipped-line notice.
- Duration text should use seconds with one decimal place.

## Testing

- Existing tests cover output tailing and SSH tool behavior; add render-specific tests if formatting logic is extracted.
- Keep UI text stable enough for users and tests to recognize statuses.

## Forbidden Patterns

- Do not show stale host enable/disable values after a failed save.
- Do not render raw ANSI from remote output as control UI.
- Do not hide timeout/non-zero-exit notices in collapsed results.

## Examples

- `packages/pi-ssh/src/index.ts#sshExecResult`
- `packages/pi-ssh/src/index.ts#renderCollapsedResult`
