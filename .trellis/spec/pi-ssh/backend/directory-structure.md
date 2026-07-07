# Directory Structure

## Overview

Backend code is split by SSH capability: tool registration, host discovery, execution, mount management, session management, and output tailing.

## Directory Layout

```text
packages/pi-ssh/src/
  index.ts             extension entry, settings, tool registration, rendering
  ssh-host.ts          OpenSSH config host discovery and pattern validation
  ssh-exec.ts          ssh_exec argument validation and command execution
  ssh-mount.ts         sshfs mount validation and lifecycle
  session-manager.ts   ControlMaster, paths, sanitization, and connection reuse
  stream-output.ts     bounded stdout/stderr capture
  output-tail-sink.ts  UTF-8-safe tail buffer
```

## Module Organization

- Keep Pi tool registration and result formatting in `index.ts`.
- Keep argument validation close to each tool executor.
- Keep process/session reuse logic in `SessionManager`.
- Keep output truncation reusable and tested independently.

## Examples

- `packages/pi-ssh/src/ssh-exec.ts#validateSshExecArgs`
- `packages/pi-ssh/src/session-manager.ts`
- `packages/pi-ssh/src/output-tail-sink.ts`
