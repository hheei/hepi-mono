# Component Guidelines

## Tool Rendering

- `ssh_host` call rendering shows the searched host pattern.
- `ssh_mount` call rendering shows `@host`.
- `ssh_exec` call rendering shows `@host`, timeout, and command text.
- Collapsed results should show a tail preview, skipped line count when applicable, and duration when available.

## Host Settings Panel

- Use `SettingsList` with search enabled.
- Host rows use labels like `@alias` and values `enabled` / `disabled`.
- Rebuild host items asynchronously from OpenSSH config.
- Revert a row to the previous value if persistence fails.

## Forbidden Patterns

- Do not show the entire output in collapsed mode when it is long.
- Do not block settings UI construction while host discovery is pending; render and request updates.
- Do not expose raw local mount implementation details beyond the useful local path.

## Examples

- `packages/pi-ssh/src/index.ts#renderCollapsedResult`
- `packages/pi-ssh/src/index.ts#createSshHostsPanel`
