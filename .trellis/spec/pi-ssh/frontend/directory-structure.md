# Frontend Directory Structure

## Overview

The package keeps UI rendering and settings panel code in `src/index.ts` because it is tightly coupled to tool registration and settings state.

## UI Locations

```text
packages/pi-ssh/src/index.ts
  renderCall handlers for ssh_host, ssh_mount, ssh_exec
  renderCollapsedResult()
  createSshHostsPanel()
  sshHostItems()
```

## Organization

- Keep renderCall/renderResult functions near tool registration.
- Keep host settings panel helpers near settings parsing helpers.
- Extract pure formatting only when it becomes independently testable.

## Examples

- `packages/pi-ssh/src/index.ts#createSshHostsPanel`
- `packages/pi-ssh/src/index.ts#renderCollapsedResult`
