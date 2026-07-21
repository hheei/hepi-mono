# @hheei/pi-ssh

`@hheei/pi-ssh` registers practical SSH tools for Pi:

- `ssh_host(ssh_host: string)` finds configured OpenSSH aliases.
- `ssh_mount(host: string)` mounts a remote host locally through `sshfs`.
- `ssh_exec(host: string, command: string, timeout?: number)` runs a non-interactive remote command.


## Requirements

- OpenSSH with usable aliases in your local SSH config
- `sshfs` for `ssh_mount`
- Pi Coding Agent

`ssh_host` and `ssh_exec` do not require `sshfs`; only `ssh_mount` does.


## Development

```bash
bun run --filter @hheei/pi-ssh test
bun run typecheck
```

To test one run from this workspace:

```bash
pi -e packages/pi-ssh/src/index.ts
```
