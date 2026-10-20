# @hheei/pi-ext-tools

Pi file tools, foreground shell, and package-owned tool discovery: `read`, `grep`, `find`, `edit`, `write`, `bash`, `tool_search`. `tool_search` replaces Pi's replaceable built-in when this package is loaded, reports both newly loaded and already available matches, and searches names/descriptions rather than parameter schemas. Install with `pi install npm:@hheei/pi-ext-tools`. Each tool executes relative to its call context’s `cwd`.

Uses Pi host definitions where appropriate, preserves structured read results and persisted edit/write diff views, and shares workspace mutation locks with `apply_patch` through `@hheei/pi-ext-core`. Rendering works without `pi-ext-ui`; optional richer views use ext-core extension points.

`codemode` belongs to Pi host; this package does not provide it. See [tool package architecture](../../docs/architecture/tool-packages.md) and [file tool contract](../../docs/ext-tools/README.md).
