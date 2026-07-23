# @hheei/pi-basics

`pi-basics` provides session-scoped HEPI runtime coordination, Settings/Loadout UI, and integrated Todo, Ask, SSHFS, and Advisor tools.

## Advisor

Use `/advisor on`, `/advisor off`, or `/advisor status` to control the session-scoped read-only reviewer. Advisor settings are available in `/hepi setting` under `pi-basics.advisor`; `model` uses `provider/model` and may be left empty to keep Advisor unconfigured. Advisor can submit structured advice and only uses `read`, `grep`, `find`, `ls`, and `advise`; it never receives `bash`, `edit`, or `write`.

## Load and use

Load package as a Pi extension. For local development, run `bun run pi:dev -- basics`. Package entry registers `/hepi`, direct `/todos`, and the model-facing `ask`, `todo`, and `sshfs` tools.

`Guard patch` in `/hepi setting` controls streamed `bash` interception with `auto`, `on`, and `off` modes. `auto` aborts generation when `apply_patch` appears in executable command position only when no configured `apply_patch` tool exists; `on` always guards and `off` disables the guard. An abort injects guidance to use Pi's `edit` or `write` tool instead. Commands that only mention `apply_patch` do not trigger it. The mode persists under `pi-basics.guardPatch` in `.pi/settings.json`.

`/hepi setting` opens the Settings and Loadout tabs. Settings includes the built-in RTK provider alongside other Pi Basics settings. RTK rewrites bash commands through an installed external `rtk` executable and compacts `bash`, `read`, and `grep` results; it never installs the executable itself.

The rewrite path preserves native `find` commands when they use predicates or actions unsupported by the installed RTK version, such as `-empty`, `-not`, `-exec`, or `-mtime`, preventing deterministic RTK failures and agent retry loops.

The `OpenAI Responses compatibility` settings are disabled by default. `Strip assistant message status` removes `status` from replayed assistant `message` input items, while `Normalize assistant message IDs` rewrites their `item_` ID prefix to `msg_`. Enable them only for an OpenAI Responses gateway that rejects those fields. Reasoning and tool items are left unchanged. The settings persist under `pi-basics.openai-responses-compat` in `<cwd>/.pi/settings.json`; legacy configurations that enabled status stripping implicitly enable ID normalization until that setting is explicitly saved.

Loadout stores global choices in `~/.pi/agent/setting.json` and project choices in `<cwd>/.pi/setting.json`, under `pi-basics-loadout`. Within each kind, built-in/core items appear first; remaining items are ordered by package/source, then by name inside that package. Persisted entries use stable `kind:name` identities so extension source paths may change across reloads without losing the choice. Existing source-scoped entries remain readable and are migrated when that item is next changed.

## Goal

Run `/goal <objective>` to start or replace a Goal. Run `/goal` with no argument to suspend an active Goal, restore the latest suspended or blocked Goal on the current branch, or wait for the next interactive/RPC text input when no Goal is stored.

When enabled in Loadout, the `goal` tool remains exposed so the active-tool prefix stays stable, but calls fail closed unless Goal is active. Active Goal runs inject the completion instruction before the objective; the model must then call `goal` with the current `goal_id`, a `blocked` or `complete` status, and a summary. A settled run without a final Goal result receives a follow-up after 15 seconds, up to 20 continuations.


Goal snapshots live in branch-local session history. Restoring a blocked Goal preserves its evidence summary. Manual compaction, final agent errors or aborts, the continuation limit, and Loadout disabling Goal attempt a durable suspend. If that write fails, Goal remains active and reports an error instead of claiming a durable stop.

Objectives are limited to 2,000 characters and summaries to 4,000 characters. Malformed Goal history entries are ignored with a warning.

## Ask

The `ask` tool opens a focused questionnaire in TUI sessions, or uses dialog UI when available. It collects answers and submits only from the final Review screen; non-interactive sessions fail closed.

## BTW

`/btw <question>` 仅在 TUI 中可用，并使用当前 active model 发起无工具侧问。侧问请求的 tools 为空，因此不能执行工具或修改文件。成功的侧问历史只保存在当前 session 的内存中，不写入主 transcript 或磁盘。按 `Esc` 取消并关闭，使用上下键滚动，按 `x` 清除历史；一次只处理一个请求。

## SSHFS

The `sshfs` tool accepts one OpenSSH host alias or destination, mounts that host's remote root (`<host>:/`) under `~/.cache/sshfs-addon/`, and returns the absolute local `Home path`. The agent can pass paths below it directly to `grep`, `edit`, `write`, `read`, `find`, and `ls` to inspect or change remote files.

SSHFS requires Linux or macOS, a local `sshfs` executable, and OpenSSH authentication that works non-interactively in batch mode. macOS mounts are marked `local` so Pi can access them under system volume privacy rules. A healthy existing SSHFS mount is reused only when its source matches the requested host; another filesystem occupying that path is left untouched and reported as a conflict. A mount operation has a 24-second deadline, followed by at most 5 seconds of rollback, keeping a tool call below 30 seconds. Mounts created by the current Pi Basics session are unmounted serially during session cleanup, with failed cleanup retained for a later retry.

## Dollar skill references

Type `$` in the TUI editor to complete loaded skills by name. A complete known reference acts as one editor token: left/right movement crosses it in one step, and Backspace/Delete removes it as a unit. Pi's built-in `Editor` and `CustomEditor` also restore the full reference with one Undo; unrelated custom editor implementations retain their own undo semantics. A known standalone reference such as `$librarian` is replaced at submission time with that skill command's canonical `sourceInfo.path`; it references `SKILL.md` without injecting the skill contents as `/skill:librarian` would. Partial and unknown references remain character-editable; unknown references, shell-style variables embedded in words, and numeric values such as `$5` remain unchanged at submission. Punctuation after a reference is supported.

Use `/hepi setting` to disable the behavior or change the suggestion limit. Settings persist under `pi-basics.dollarSkillReferences` in `<cwd>/.pi/settings.json`. Autocomplete is TUI-only, while path expansion also applies to interactive and RPC/print input. Do not load the standalone `pi-codex-dollar` extension with `@hheei/pi-basics`, because both transform the same input syntax.

## Automatic Titles

Enable automatic titles in `/hepi setting` and choose a title model. Titles are generated only at initial session startup, after `/new`, or when manually requested with `/hepi auto-title`. They do not run after `/resume`, `/fork`, `/clone`, or compaction. Pi Basics runs a one-shot isolated agent with no tools or inherited extensions, so automatic titles do not require `pi-subagents`. The title agent receives the latest user prompt, limited to 2,000 characters, and returns no more than five words.

## Todo

The `todo` tool accepts one ordered `operations` batch. Supported actions are `create`, `update`, `list`, and `delete`; mixed batches such as delete + create validate fully before one atomic commit.

```json
{
  "operations": [
    { "action": "delete", "id": 2 },
    { "action": "create", "subject": "Implement replacement" }
  ]
}
```

Tasks contain `id`, `subject`, `status`, and `blockedBy`. State is restored from the latest valid `todo` tool-result snapshot on the active branch. `/todos` displays the same state, and TUI sessions show a colored read-only widget above the editor.

Models inspect tasks with a sole `list` operation. Omitting `status` lists everything; `status` filters one state. There is no separate `get` or `next` action: an exact id is found in the full list, while the next recommended task is the current `in_progress` task, otherwise the lowest-id unblocked `pending` task, otherwise the lowest-id pending task.

After five complete agent turns with unfinished work and no successful `todo` call, Pi appends one hidden, turn-local reminder containing only that next recommended task. It fires only while the `todo` tool is active, is not stored in session history, and does not repeat until another successful Todo call resets the inactivity streak.

When every task is completed, the success header remains visible for two later agent turns, then only the widget is unmounted. Tasks, snapshots, and monotonic ids remain unchanged; `/todos`, `list`, or a new Todo mutation still sees the full state and shows the widget again.

## Public APIs

Register providers through public package API:

```ts
import { registerHePiSettings } from "@hheei/pi-basics";

registerHePiSettings(provider);
```

Set `provider.origin` to module identifier shown in Description panel, for example `"@my-module"`.

In Pi TUI, run `/hepi setting`. Providers are read when command opens, so providers registered after extension load are included. Optional provider id is currently ignored; Settings opens normally and shows available non-empty providers.

`registerHePiModule(module)` is also exported for module integrations.

Loadout descriptions can be supplied by integrations without relying on Pi's generated tool metadata. Register by stable `kind:name` (or an exact source-scoped key):

```ts
import { registerLoadoutDescriptionPanel } from "@hheei/pi-basics";

registerLoadoutDescriptionPanel("tool:inspect", {
	title: "Inspect tool",
	lines: ["Shows the active inspection target and its source."],
});
```

A panel may provide `render(width)` instead of `lines`. Registrations are used by the built-in Loadout inventory and can be removed with `unregisterLoadoutDescriptionPanel(key)`. When no metadata is available, Loadout omits the missing Description and Instruction sections instead of inserting empty section rows.

## RTK

The built-in RTK integration is controlled from compact `RTK Mode` (`off`, `rewrite`, `suggest`) and `RTK Compaction` (`none`, `out`, `read+out`) fields in `/hepi setting`. It persists project settings in `.pi/settings.json` under `pi-basics.rtk`. If the `rtk` executable cannot be found, bash calls are blocked with an error. The compatibility command `/rtk` supports `show`, `verify`, `stats`, `clear-stats`, `reset`, `path`, and `help`. `rtk` is optional: when unavailable, raw commands run unchanged.

The defaults keep read compaction and source filtering disabled because lossy reads can make anchored edits fail. When enabling those options, disable read compaction temporarily if an edit reports that old text does not match. Existing `pi-rtk-optimizer` configuration is read once when no project RTK settings exist; new writes use `.pi/settings.json` only.

Do not load the standalone `pi-rtk-optimizer` extension together with `@hheei/pi-basics`; both register RTK event handlers and would rewrite or compact the same tool call twice. The migrated implementation retains the upstream MIT-licensed RTK techniques and resolver behavior.

## Non-goals

Todo does not use disk fallback, tombstones, configuration, interactive editing, or a separate package. Branch tool-result history is its durable source of truth.

Runtime state belongs to the active session and is released during shutdown.
