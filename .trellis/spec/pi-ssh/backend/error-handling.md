# Error Handling

## Overview

Tool execution should return structured tool results with clear text messages instead of crashing the Pi extension runtime.

## Argument Validation

- `ssh_exec.host` must be a non-empty string without whitespace/control characters and must not start with `-`.
- Commands must be non-empty strings.
- Timeout values must be finite numbers and are clamped to supported bounds.
- Host lookup patterns are validated before reading OpenSSH config.

## Process Failures

- Command timeouts can return a result with `exitCode: null` when `timeoutMode` is `result`.
- Cleanup processes use SIGTERM then SIGKILL fallback.
- Tool handlers catch errors and return `errorResult()` with details.
- Disabled hosts return a normal tool result explaining that the host is disabled.

## Forbidden Patterns

- Do not pass unvalidated host strings to `ssh` or `sshfs`.
- Do not concatenate shell commands to run SSH; use `spawn()` with argument arrays.
- Do not drop timeout output when the caller requested captured timeout results.

## Examples

- `packages/pi-ssh/src/ssh-exec.ts#validateHost`
- `packages/pi-ssh/src/ssh-exec.ts#managerLikeSpawn`
- `packages/pi-ssh/src/index.ts#errorResult`
