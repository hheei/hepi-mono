# @hheei/hepi-tools

Single-entry HEPI tools group for Pi. It requires `@hheei/hepi-basics` to be
loaded in the same runtime because the included tools use Pi Basics runtime
coordination and lifecycle APIs.

Included packages:

- `pi-ask`
- `pi-goal`
- `pi-sshfs`
- `pi-fff`
- `pi-codex-tool`
- `pi-advisor`
- `pi-todo`
- `@cortexkit/pi-magic-context`
- `pi-web-access`

The Magic Context package is bundled from its published `@cortexkit` package.
The optional upstream submodule remains available for development and is not
loaded automatically by this group.

Install it with:

```bash
pi install npm:@hheei/hepi-tools
```

Load `@hheei/hepi-basics` before this group. Do not install this package
together with the same individual packages.
