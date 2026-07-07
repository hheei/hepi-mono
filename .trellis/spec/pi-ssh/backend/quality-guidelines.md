# Quality Guidelines

## SSH Safety Standards

- Use `spawn()` with argument arrays for SSH/sshfs processes.
- Validate host aliases before use and reject option-looking values.
- Reuse ControlMaster sessions through `SessionManager` instead of starting ad hoc connections.
- Clamp all timeout and alive settings to documented ranges.
- Sanitize output with `manager.sanitize()` before returning it.

## Tests

- Cover host validation and option-injection cases.
- Cover timeout result behavior and captured output.
- Cover ControlMaster/session reuse and repeated failure behavior.
- Cover sshfs missing-binary and unsupported-platform paths.
- Cover UTF-8-safe output truncation.

## Forbidden Patterns

- Do not use shell interpolation for remote commands beyond passing the user command as the SSH remote command argument.
- Do not assume sshfs is installed.
- Do not return full output when truncation limits are exceeded.

## Examples

- `packages/pi-ssh/test/ssh-exec.test.ts`
- `packages/pi-ssh/test/output-tail-sink.test.ts`
