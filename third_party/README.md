# Third-Party Forks

This directory contains pinned Git submodules. They are external source trees,
not Bun workspaces and not Pi package resources. HEPI packages import only a
fork's public package-root exports.

Initialize them after cloning HEPI:

```bash
git submodule update --init --recursive
```

Magic Context is the exception: its Pi-only fork is managed as the
`packages/hepi-mctx` submodule so the complete upstream-shaped repository is
maintained together.

## AFT

`aft` is the source fork behind HEPI's AFT integration. `hepi-aft` uses only
the public `@cortexkit/aft-bridge` API and the matching platform binary package.
The published HEPI packages declare the bridge plus all platform optional
binaries; npm installs the binary for the current platform.

Start a Pi session after installing. If AFT cannot resolve its platform binary,
the AFT tools report the startup error without taking ownership from Pi's native
tools. Develop or update the fork in `third_party/aft`, commit it there, then
advance the HEPI submodule pointer after its public bridge contract is verified.

## Pi Subagents

`pi-subagents` remains an optional Git submodule and publishes independently as
`@hheei/hepi-subagents`. HEPI does not bundle or import it. It can cooperate with
HEPI only through public Pi events and the Magic Context public accounting API.

```bash
pi install npm:@hheei/hepi-subagents
```
