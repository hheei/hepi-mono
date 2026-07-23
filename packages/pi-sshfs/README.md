# @hheei/pi-sshfs

`sshfs` tool for mounting a remote root through an OpenSSH host alias or destination. Requires `@hheei/pi-basics`, Linux or macOS, a local `sshfs` executable, and non-interactive OpenSSH authentication.

Mounts live under `~/.cache/sshfs-addon/`. Healthy matching mounts are reused; conflicting filesystems are left untouched. Mounts created by the current session are unmounted during cleanup, with failed cleanup retained for retry.
