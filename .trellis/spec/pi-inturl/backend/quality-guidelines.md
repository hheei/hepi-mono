# Quality Guidelines

## Path Safety Standards

- Decode `tmp://` paths before validation.
- Normalize backslashes to slashes before segment checks.
- Reject traversal before resolving against the temp root.
- Verify the resolved path is the temp root or below it.
- Mutate only `event.input.path` after a successful changed result.

## Tests

- Cover enabled and disabled settings.
- Cover unsafe traversal and absolute path cases.
- Cover supported built-in tools and ignored custom tools.
- Cover settings-state derivation.

## Forbidden Patterns

- Do not use ad hoc string prefix replacement without `resolve()` boundary checks.
- Do not add a new scheme without tests for traversal and absolute paths.
- Do not expand every tool indiscriminately.

## Examples

- `packages/pi-inturl/src/index.ts#expandTmpPath`
- `packages/pi-inturl/test/path-shortcuts.test.ts`
