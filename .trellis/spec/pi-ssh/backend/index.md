# pi-ssh Backend Guidelines

`pi-ssh` provides OpenSSH host discovery, remote command execution, and sshfs mounting tools for Pi.

## Pre-Development Checklist

- Read `.trellis/spec/guides/hepi-mono-project-conventions.md`.
- Treat host, command, mount path, and process output handling as security-sensitive.
- Inspect `session-manager.ts`, `ssh-exec.ts`, `ssh-host.ts`, and `ssh-mount.ts` before changing tool behavior.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Tool and process modules | Filled |
| [Database Guidelines](./database-guidelines.md) | Settings and session state | Filled |
| [Error Handling](./error-handling.md) | Tool result errors and process failures | Filled |
| [Quality Guidelines](./quality-guidelines.md) | SSH safety and tests | Filled |
| [Logging Guidelines](./logging-guidelines.md) | Output capture and notifications | Filled |

## Quality Check

- `bun run check` passes from the root.
- SSH behavior changes update `ssh-exec.test.ts` and `output-tail-sink.test.ts` as relevant.
