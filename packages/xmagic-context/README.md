# @hheei/xmagic-context

Inactive shared-source baseline copied from
[`cortexkit/magic-context`](https://github.com/cortexkit/magic-context) at
`7dcd2e5726a1466126b2eea460482cca2b53283b`.

It retains the upstream shared implementation for source comparison, with the
OpenCode adapter, OpenTUI/TUI, builtin commands, auto-update checker, OpenCode
tool wrappers, and model-suggestion HTTP helper removed. It has no build,
extension, or plugin entry and declares no runtime dependencies.

Configuration migration and legacy OpenCode/Pi config fallback are also absent;
the baseline reads only the CortexKit config paths.
