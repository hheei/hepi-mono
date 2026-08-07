# Pi Documentation Routing

All paths below are relative to `references/pi/packages/coding-agent/docs/`, pinned at Pi `v0.82.1`. Read the named document completely before making an API or behavior claim. Follow its direct links when the question crosses a boundary.

## Start points

| Question | Read first | Follow when needed | Source entry points |
| --- | --- | --- | --- |
| Install, invoke, interactive workflow, CLI flags | `quickstart.md`, `usage.md` | `settings.md`, `keybindings.md`, `sessions.md` | `src/cli/`, `src/modes/interactive/interactive-mode.ts` |
| Project trust, what can auto-load, sandbox/security | `security.md` | `settings.md`, `packages.md`, `environment-variables.md` | `src/core/project-trust.ts`, `src/core/trust-manager.ts`, `src/core/resource-loader.ts` |
| Extension events, tools, commands, context, custom UI | `extensions.md` | `tui.md`, `sessions.md`, `compaction.md` | `src/core/extensions/types.ts`, `runner.ts`, `wrapper.ts`, `src/core/agent-session.ts` |
| Project/global skills and skill commands | `skills.md` | `packages.md`, `prompt-templates.md`, `settings.md` | `src/core/skills.ts`, `src/core/resource-loader.ts`, `src/core/slash-commands.ts` |
| Package manifest, distribution, installation/resources | `packages.md` | `skills.md`, `themes.md`, `prompt-templates.md` | `src/core/package-manager.ts`, `src/core/resource-loader.ts` |
| Prompt template behavior | `prompt-templates.md` | `skills.md`, `settings.md` | `src/core/prompt-templates.ts`, `packages/agent/src/harness/prompt-templates.ts` |
| Theme creation or semantic colors | `themes.md` | `tui.md` | `src/modes/interactive/theme/`, `packages/tui/src/` |
| TUI components, editor, ANSI, focus, overlays, rendering | `tui.md` | `extensions.md`, `keybindings.md` | `packages/tui/src/`, `src/modes/interactive/components/` |
| Session JSONL, tree navigation, branch/fork/clone | `sessions.md`, `session-format.md` | `compaction.md`, `sdk.md` | `src/core/session-manager.ts`, `agent-session.ts`, `agent-session-runtime.ts` |
| Compaction or branch summaries | `compaction.md` | `sessions.md`, `extensions.md` | `src/core/compaction/`, `src/core/agent-session.ts` |
| Programmatic embedding or replacement runtime | `sdk.md` | `sessions.md`, `extensions.md` | `src/core/sdk.ts`, `agent-session.ts`, `agent-session-runtime.ts`, `agent-session-services.ts` |
| Print JSON events or external process integration | `json.md` or `rpc.md` | `sdk.md`, `session-format.md` | `src/modes/`, `src/core/messages.ts` |
| Built-in model/provider setup | `providers.md`, `models.md` | `settings.md`, `environment-variables.md` | `src/core/model-runtime.ts`, `model-registry.ts`, `packages/ai/src/` |
| Custom provider, OAuth, or unsupported API | `custom-provider.md` | `models.md`, `sdk.md`, `extensions.md` | `src/core/provider-composer.ts`, `packages/ai/src/providers/`, `packages/ai/src/auth/` |
| Local llama.cpp router | `llama-cpp.md` | `models.md`, `providers.md` | `src/extensions/llama/`, `packages/ai/src/` |
| Settings, config precedence, agent directory | `settings.md` | `environment-variables.md`, `security.md` | `src/core/settings-manager.ts`, `src/core/resolve-config-value.ts` |
| Terminal/platform behavior | `terminal-setup.md`, then `windows.md`, `termux.md`, or `tmux.md` | `keybindings.md`, `tui.md` | `packages/tui/src/`, interactive mode |
| Shell aliases or bash environment | `shell-aliases.md`, `environment-variables.md` | `usage.md`, `security.md` | `src/core/bash-executor.ts`, `src/core/exec.ts` |
| Upstream Pi contributor workflow | `development.md` | repository `AGENTS.md`, package tests | package-local `package.json`, `test/` |
| Container/sandbox deployment | `containerization.md` | `security.md`, `environment-variables.md` | external runtime configuration |

## Full document catalog

Use this catalog when no start point above fits. The route is intentionally explicit so a task does not rely on a broad, stale summary.

| Document | Use it for | Do not use it as authority for |
| --- | --- | --- |
| `index.md` | Documentation index and cross-links | Runtime API details |
| `quickstart.md` | First install/auth/session | Extension contracts |
| `usage.md` | Interactive commands, CLI modes, context files | Package internals |
| `settings.md` | Settings shape, scopes, precedence | Provider protocol details |
| `keybindings.md` | Defaults and customization | Component input ownership |
| `sessions.md` | User-facing tree and session behavior | JSONL parser details |
| `session-format.md` | JSONL entries and SessionManager surface | Interactive layout |
| `compaction.md` | Compaction and branch summaries | Arbitrary transcript mutation |
| `extensions.md` | Public extension API and lifecycle | Private runner internals as stable API |
| `skills.md` | Agent Skills discovery, format, commands | HEPI Loadout policy |
| `prompt-templates.md` | File-backed slash prompt templates | Skill execution semantics |
| `themes.md` | Theme files and discovery | Custom component state |
| `packages.md` | Pi package manifests and resource publishing | HEPI aggregate architecture |
| `tui.md` | Component interfaces, width, focus, theme, overlay | Host-specific HEPI rails |
| `sdk.md` | AgentSession/Runtime embedding | Interactive-only extension UI |
| `rpc.md` | stdin/stdout RPC protocol | SDK object ownership |
| `json.md` | Print-mode JSON event stream | Bidirectional RPC |
| `providers.md` | Built-in provider authentication | Custom adapter implementation |
| `models.md` | Model catalogs/custom model entries | Provider transport code |
| `custom-provider.md` | Custom provider and OAuth extension contract | Built-in provider support guarantees |
| `llama-cpp.md` | Local llama.cpp router | Generic provider behavior |
| `environment-variables.md` | Runtime/process metadata and configuration | User-facing settings defaults |
| `security.md` | Trust model and security boundaries | Permission policy outside Pi |
| `containerization.md` | Sandboxed/container deployment | Extension API behavior |
| `terminal-setup.md` | Terminal capability setup | TUI component API |
| `tmux.md` | tmux integration | Generic session tree semantics |
| `windows.md` | Windows-specific installation/terminal behavior | POSIX shell behavior |
| `termux.md` | Android/Termux setup | Desktop terminal behavior |
| `shell-aliases.md` | Shell alias installation/behavior | Pi tool rendering |
| `development.md` | Upstream source setup, debugging, tests | Published package contract |

## HEPI-specific overlay

Pi docs define host behavior; HEPI documents define project policy. After reading upstream docs, read the matching local source of truth:

| HEPI concern | Read |
| --- | --- |
| Visual/layout contract | `DESIGN.md` |
| Pi source design, lifecycle, integration boundaries | [`DESIGN.md`](DESIGN.md), `AGENTS.md` |
| Aggregate install/publish behavior | root `README.md`, `docs/user/packages.md`, package README |
| Shared TUI primitives and statusbar | owning `packages/pi-*/src/` extension, `packages/pi-ext-core/` lifecycle and UI contracts |
| Skills and Loadout behavior | `packages/pi-ponytail/`, `packages/pi-caveman/`, `packages/pi-loadout/`, `packages/pi-dollar-skill/` |
| TUI replay | `packages/pi-debug/TUI_REPLAY.md` |

When upstream and HEPI differ, first determine whether HEPI intentionally adapts the host. Document the host contract, the HEPI policy, and the compatibility boundary separately.
