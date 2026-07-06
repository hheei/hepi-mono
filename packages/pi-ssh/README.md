# @hheei/pi-ssh

`@hheei/pi-ssh` registers practical SSH tools for Pi:

- `ssh_host(ssh_host: string)` finds configured OpenSSH aliases.
- `ssh_mount(host: string)` mounts a remote host locally through `sshfs`.
- `ssh_exec(host: string, command: string, timeout?: number)` runs a non-interactive remote command.

Settings are registered in the shared `/extension-setting` panel.

## Requirements

- OpenSSH with usable aliases in your local SSH config
- `sshfs` for `ssh_mount`
- Pi Coding Agent

`ssh_host` and `ssh_exec` do not require `sshfs`; only `ssh_mount` does.

## Settings

Run `/extension-setting` in Pi and open `PI SSH` to configure:

| Setting | Default | Meaning |
| --- | ---: | --- |
| Default command timeout | `10s` | Used when `ssh_exec` omits `timeout`. |
| ControlMaster alive | `3600s` | SSH `ControlPersist` lifetime. |
| Alive interval | `300s` | SSH `ServerAliveInterval`. |
| Alive retry count | `3` | SSH `ServerAliveCountMax`. |
| Hosts panel | `enabled` | Disable selected aliases globally. |

Settings are stored under `pi-ssh` in `~/.pi/agent/ext-settings.json`.

## Development

```bash
bun run --filter @hheei/pi-ssh test
bun run typecheck
```

To test one run from this workspace, load `pi-extcore` too because it owns `/extension-setting`:

```bash
pi -e packages/pi-extcore/src/extension.ts -e packages/pi-ssh/src/index.ts
```
