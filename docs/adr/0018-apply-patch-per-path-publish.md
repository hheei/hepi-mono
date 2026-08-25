# apply_patch 是逐 path 独立 Publish，不再用 Linux coordinator 事务

local Linux/macOS/Windows 与 Unix-like SSH Target 共用同一套 Patch Core：每个 path 独立 Publish，已确认的 mutation 不 rollback。放弃 detached coordinator、directory fd、inode identity、request journal。现有文件（含 delete 与 Update+Move 的源）大于 32 MiB 在读完整内容前拒绝；Add/Update 的 new bytes 也不得超过 32 MiB。公开方言仍是 V4A Add / Delete / Update / `Move to`，不新增独立 rename。

## 考虑过的方案

- 维持 ADR-0017：本机 Linux coordinator 在 temp 跑完整 request，再 SFTP Patch Push。Remote 能开，但 macOS/Windows local 仍拒绝，且 local 与 SSH 不是同一套 mutation 语义。
- 只给 SSH 换新引擎、local 保留 coordinator。同一工具两套终态（cancel 时 local rollback、remote 保留 Changed）。
- 本轮只开 remote、不动 local。更小，但放弃跨平台与单一合约。

## 后果

`/reload` 不再重连进行中的 mutation。取消或断线不撤回已 Changed 的 path：尚未发出 replace/remove 的为 NotApplied，已发出未见 ACK 的为 Unconfirmed。同一 Update 的 hunk 按顺序在 staging copy 尝试；失败 hunk 只记录 Rejected，至少一个成功 hunk 时将它们的 combined result Publish 一次，零个成功 hunk 不 Publish。Fuzzy 匹配成功仍是 Changed。Update+Move 是 dest Publish 与 source delete 两次独立 mutation；dest 已 Changed 后，source 失败也不撤回 dest。apply_patch、write 与 edit 共用 mutation lock：local 按 workspace、SSH 按本机 alias，原语为平台原生 kernel lock（不是合约里的 `flock`，也不是远端锁文件）。后到的请求排队直到持锁者释放；取消排队中的请求不会取得锁。外部编辑器或其它进程的并发写入既不检测也不阻止。Update 写穿 leaf symlink 的目标（可在 workspace 外）；Delete unlink 字面路径上的目录项；Add 若该名字已存在（含 symlink）则 Rejected。SFTP 单 path 逾时：传输 ≤1 MiB 为 30s，否则 60s；写 temp 逾时为 NotApplied，rename 逾时为 Unconfirmed。local 无逾时，只靠取消。Publish 前不对帐 size/mtime/hash。没有原子 replace primitive 则 Rejected，不 fallback 成 rm+rename 或直接覆盖。持锁后扫本次涉及目录，立刻删除 `*.agentpatch-<uuid>.tmp`。Changed+Rejected 且无 Unconfirmed/NotApplied 时为 `partial`、`isError: false`；有 Unconfirmed 或 NotApplied 则为 `isError: true`。TUI：exact `✓`，fuzzy `!`，Changed+Rejected partial `!`，Rejected `✗`，Unconfirmed `?`，NotApplied dim `–`。不为罕见多 writer 或中途断线增加 journal、reconnect 或 snapshot hash。非 Linux localhost 不再被引导去改 Edit Mode。ADR-0017 的「本机 commit 仍是 staging」不再成立。
