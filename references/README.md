# Public Reference Repositories

External source used for research lives locally under `references/repos/`. That directory is ignored by Git and is never part of the Bun workspace, build, tests, lint, or published packages.

Use `<owner>-<repo>` directory names. Documentation must cite the public URL and exact revision; a local clone path is optional and must not be required by a clean checkout.

## Recorded Revisions

| Repository | Revision | What was studied |
| --- | --- | --- |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `65ff8e7f6db447dcddb1a9c8fd05f081c5cda76a` | Pi extension lifecycle, model registry, TUI, tools, and agent runtime |
| [gabelul/bpx-mono](https://github.com/gabelul/bpx-mono) | `64567efe1177739b2eb110a746fff7c736c9468b` | Isolated advisor agents and result delivery |
| [pasky/pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor) | `43eb9a976d751c06016a62b5423e2c6ddaff43a1` | Read-only advisor behavior |
| [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw) | `4f858102706910ee9d520a9666832f3103631b61` | Side-agent orchestration and transcript handling |
| [Firstp1ck/npm-packages](https://github.com/Firstp1ck/npm-packages) | `7ff59ae4baa303ccbb66212355ecc335bee3a4c1` | BTW lifecycle, RPC/WebUI, and transfer boundaries |
| [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) | `700c2d370353ca145d2658c61df1eee6297e8d80` | Ask, BTW, and package architecture |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | `c5dc930cd85a6f661c3fd530fa62e44109c86070` | Plan and BTW implementations |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | `0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0` | Caveman prompt behavior |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `16f29800fd2681bdf24f3eb4ccffe38be3baec6b` | Ponytail rules and companion workflows |

## Other Design References

| HEPI area | Public repositories | What was studied |
| --- | --- | --- |
| Ask | [edlsh/pi-ask-user](https://github.com/edlsh/pi-ask-user), [mrclrchtr/supi](https://github.com/mrclrchtr/supi), [anthropics/claude-code](https://github.com/anthropics/claude-code) | Question schemas, fallback dialogs, and review flow |
| Plan | [backnotprop/plannotator](https://github.com/backnotprop/plannotator) | Plan artifacts and approval flow |
| Todo | [sst/opencode](https://github.com/sst/opencode), [x4cc3/pi-xpi](https://github.com/x4cc3/pi-xpi), [zhushanwen321/xyz-pi-extensions](https://github.com/zhushanwen321/xyz-pi-extensions) | Ordered mutations, persistence, widgets, and cancellation |
| Loadout | [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | MCP discovery and runtime boundaries |
| RTK | [MasuRii/pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) | Command rewriting and output compaction |
| SSHFS | [libfuse/sshfs](https://github.com/libfuse/sshfs) | Invocation, mount semantics, and reconnect behavior |

External code remains under its original license. A reference is not a dependency or behavior contract. Adapted material included in an HEPI package must retain attribution in that package.
