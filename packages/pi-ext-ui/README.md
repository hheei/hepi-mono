# @hheei/pi-ext-ui

Pi UI primitives and a small set of specialized tool renderers.

`pi-ext-ui` owns the visual result, not tool execution. Its default resolver only handles tools with an explicit specialized renderer (`edit`, `read`, `write`, `apply_patch`, `eval`, and `codemode`). Other tools remain on Pi's native renderer. Extensions can opt into the shared visual API with `createToolView`, `ToolView`, and `DiffView`, or explicitly add a tool through resolver options.

The shared view API owns fold levels, compact sections, status glyphs, copy feedback, and width-safe rendering. It does not read files, execute tools, infer outcomes, or import a concrete extension.
