# Third-Party Forks

This directory contains pinned Git submodules. They are external source trees,
not Bun workspaces and not Pi package resources. HEPI packages import only a
fork's public package-root exports.

Initialize them after cloning HEPI:

```bash
git submodule update --init --recursive
```

## Magic Context

`magic-context` builds `@hheei/pi-magic-context`. `hepi-mctx` composes its
default Pi extension and the public subagent-accounting export. Run the normal
HEPI aggregate build; it builds this public package first:

```bash
bun run build:aggregates
```

## AFT

`aft` is the source fork behind HEPI's AFT integration. `hepi-aft` uses only
the public `@cortexkit/aft-bridge` API and the matching platform binary package.
The unified Git package declares the bridge plus all platform optional binaries;
Pi installs the binary for the current platform during `pi install`.

Install the unified HEPI Git release with a pinned tag:

```bash
pi install git:github.com/hheei/hepi-mono@<tag>
```

Start a Pi session after installing. If AFT cannot resolve its platform binary,
the AFT tools report the startup error without taking ownership from Pi's native
tools. Develop or update the fork in `third_party/aft`, commit it there, then
advance the HEPI submodule pointer after its public bridge contract is verified.

## Pi Subagents

`pi-subagents` is an optional external extension source. HEPI does not bundle or
import it. It can cooperate with HEPI only through its public Pi events and the
Magic Context public accounting API.
