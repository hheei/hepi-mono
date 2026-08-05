# Public Reference Repositories

External source used for research lives locally under `references/repos/`. That directory is ignored by Git and is never part of the Bun workspace, build, tests, lint, or published packages.

Use `<owner>-<repo>` directory names. Documentation must cite the public URL and exact revision; a local clone path is optional and must not be required by a clean checkout.

## Recorded Revisions

| Repository | Revision | What was studied |
| --- | --- | --- |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `c13ffe1877c3a47ce9f2fc98d9880447d64a0e87` | Shared upstream reference clone for Pi extension lifecycle, model registry, TUI, tools, and agent runtime |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `b4f293684bba718d59cc1157679bcf6157b3a7f5` (`v0.82.1`) | Project-only `pi-development` skill source reference |
| [gabelul/bpx-mono](https://github.com/gabelul/bpx-mono) | `64567efe1177739b2eb110a746fff7c736c9468b` | Isolated advisor agents and result delivery |
| [pasky/pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor) | `43eb9a976d751c06016a62b5423e2c6ddaff43a1` | Read-only advisor behavior |
| [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw) | `4f858102706910ee9d520a9666832f3103631b61` | Side-agent orchestration and transcript handling |
| [Firstp1ck/npm-packages](https://github.com/Firstp1ck/npm-packages) | `7ff59ae4baa303ccbb66212355ecc335bee3a4c1` | BTW lifecycle, RPC/WebUI, and transfer boundaries |
| [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) | `700c2d370353ca145d2658c61df1eee6297e8d80` | Ask, BTW, and package architecture |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | `c5dc930cd85a6f661c3fd530fa62e44109c86070` | Plan and BTW implementations |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | `0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0` | Caveman prompt behavior |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | `16f29800fd2681bdf24f3eb4ccffe38be3baec6b` | Ponytail rules and companion workflows |
| [ShpetimA/pi-fff](https://github.com/ShpetimA/pi-fff) | `694837d0644abc8527ebfa3ea50135e0f5d1ece4` | FFF runtime, tools, commands, formatting, and autocomplete behavior adapted for HEPI ownership |
| [Romelium/mpatch](https://github.com/Romelium/mpatch) | `v1.6.4` | Vendored library source for cancellable native fuzzy patch application |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | `01c1f91ff529c6af3fc27724a8ba429d83d41aed` | PTY lifecycle: native process-group termination, raw output transport, resize, and bounded reader teardown; no OMP runtime imported |
| [mattpocock/skills](https://github.com/mattpocock/skills) | `ed37663cc5fbef691ddfecd080dff42f7e7e350d` | Grill and domain-modeling skills adapted for the HEPI skills bundle |
| [hheei/magic-context](https://github.com/hheei/magic-context) | `f9c964da0c5cc53d1ef0658af588b46acd2e740d` | Fixed Magic Context Pi plugin/core source, including external Pi subagent accounting API |
| [cortexkit/magic-context](https://github.com/cortexkit/magic-context) | `7af5961d0a6af6e02a5200dc42c3ac0bbebc5864` | Current `master` Pi plugin reference for behavioral comparison |
| [hheei/pi-subagents](https://github.com/hheei/pi-subagents) | `594140b50a159dcd33c4c265dc73729d6cb19765` | Agent policy, child-session factory, tool scoping, worktree isolation, and MCTX inheritance bridge; not a target API contract |

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
