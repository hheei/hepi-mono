# Remote apply_patch 是本机 coordinator 加 SFTP 同步，不是 sshfs

已被 [ADR-0018](0018-apply-patch-per-path-publish.md) 取代：不再先跑 Linux coordinator 再推送。

SSH Target 上的 `apply_patch` 在本机临时 workspace 跑既有 Linux coordinator，再把已 applied 的路径 SFTP put/rm/rename 到远端。不把远端或 sshfs 挂载当成 coordinator workspace：远端没有 Linux directory fd，FUSE inode 也不能支撑 rollback identity。因此远端结果不是 coordinator commit；推送中断必须报 unknown，不能说已回滚或已 applied。

## 考虑过的方案

- sshfs 挂远程 `/` 或 `$HOME`，让 coordinator 当本地盘写。看起来改动少，但 FUSE writeback、假 inode、mount 与活 coordinator 的生命周期、以及第二条 SSH transport 都会让 Patch Outcome 说谎。
- 在远端跑 coordinator / 分发 helper。新分发面，且 Darwin/BSD target 不是 Linux fd 合约。
- 这轮不对 SSH Target 开放 `apply_patch`。更稳，但模型只能用可见的 remote bash 改文件。

## 后果

远端 workspace root 是 `$HOME`，V4A 仍拒绝绝对路径与 `..`，也拒绝 `alias:` 前缀。本机 coordinator 先在 temp 跑完整 request，再一批 Patch Push：同目录 sibling 临时文件 `rename` 成功才算确认。SFTP 确认前 TUI 不得显示 `✓`。Push 中断不续传：已确认 path 为 applied，其余 unknown。每个 path 的 SFTP 30s；symlink 经 lstat 后拒绝该 operation。同一 SSH Target 跨 session 用 `flock` 互斥，忙则立刻拒绝。本机非 Linux 时 remote apply_patch 与 local 一样拒绝，不另开 SFTP-only 引擎。模型可见结果把 Changed / Unconfirmed / Rejected 分开；有 Unconfirmed 就不是 local 的 success/partial，且 `isError: true`。
