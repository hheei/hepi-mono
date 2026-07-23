# Public Reference Repositories

This directory intentionally does not vendor external repositories. Clone public references locally when needed; Git ignores every entry here except this file. Record durable design decisions and pinned revisions in `docs/`.

| Pi Basics area | Public repositories referenced | What was studied |
| --- | --- | --- |
| Core extension APIs | [earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) | Extension lifecycle, model registry, TUI, tools, and `pi-agent-core` integration |
| Ask | [edlsh/pi-ask-user](https://github.com/edlsh/pi-ask-user), [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono), [mrclrchtr/supi](https://github.com/mrclrchtr/supi), [anthropics/claude-code](https://github.com/anthropics/claude-code) | Question schemas, fallback dialogs, review flow, and interactive command behavior |
| Plan | [backnotprop/plannotator](https://github.com/backnotprop/plannotator), [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | Plan artifacts, mode lifecycle, approval flow, and proposed-plan parsing |
| Todo | [sst/opencode](https://github.com/sst/opencode), [x4cc3/pi-xpi](https://github.com/x4cc3/pi-xpi), [zhushanwen321/xyz-pi-extensions](https://github.com/zhushanwen321/xyz-pi-extensions) | Ordered mutations, task persistence, widgets, and cancellation behavior |
| Loadout and MCP inventory | [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | MCP discovery, metadata, placeholder identity, and runtime boundaries |
| Auto Title and Advisor agents | [pasky/pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor), [gabelul/bpx-mono](https://github.com/gabelul/bpx-mono) | Isolated `pi-agent-core` agents, model/auth resolution, abort, and result delivery |
| RTK | [MasuRii/pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) | Command rewriting, output compaction, resolver behavior, and migration compatibility |
| SSHFS | [libfuse/sshfs](https://github.com/libfuse/sshfs) | SSHFS invocation, mount semantics, reconnect options, and platform behavior |

External code remains under its original license. A reference is not automatically a dependency or a behavior contract.
