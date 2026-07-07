# Database Guidelines

## Overview

This package does not use a database. It uses settings through `pi-extcore`, filesystem paths for SSH control sockets and mounts, and process state managed by `SessionManager`.

## Settings State

- Connection settings include command timeout, ControlPersist, ServerAliveInterval, and ServerAliveCountMax.
- Disabled hosts are stored in a hidden settings group and parsed from strings or arrays.
- Settings are clamped to safe numeric ranges before constructing a `SessionManager`.

## Filesystem State

- ControlMaster sockets and mount roots are managed under local cache-style paths by `SessionManager`.
- sshfs mounts are checked and remounted when stale.
- Sensitive values used in SSH args are sanitized from returned output.

## Forbidden Patterns

- Do not store host credentials in settings.
- Do not persist command output.
- Do not use unvalidated host aliases to build shell strings.

## Examples

- `packages/pi-ssh/src/index.ts#sshSettingsFromState`
- `packages/pi-ssh/src/session-manager.ts`
- `packages/pi-ssh/src/ssh-mount.ts`
