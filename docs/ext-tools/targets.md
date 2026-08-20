# pi-ext-tools Target 路由

## 状态

已确认。`read`、`grep`、`find`、`bash`、`apply_patch` 已实现 SSH Target。`apply_patch` 是逐 path Publish（见 [ADR-0018](../adr/0018-apply-patch-per-path-publish.md)）；ADR-0017 已作废。`edit` / `write` 的 SSH 走同一 Publish（见 [ADR-0019](../adr/0019-write-edit-ssh-use-publish.md)），排在 Patch Core 落地之后。真实 Pi ToolExecutionComponent smoke 仍待补。

`pi-ext-tools` 为可见且显式的 target 选择。它不把 remote workspace、Output 与 local filesystem 伪装成同一种 URL，也不静默切换 transport 或 SSH destination。

## 用户目标

同一个 tool 参数形状可以明确选择本地、内部 Output 或已授权的 SSH host：

```text
tool arguments { path?, target? }
        |
        +-- internal URL in path -> legacy internal resolver
        +-- target omitted / local -> local filesystem
        +-- target output -> session-bound Output
        +-- target SSH alias -> authorized SSH host
```

失败不得因为 path 或 target 看起来像 remote 而回退、改写或静默在 local workspace 执行。

## 公开工具契约

工具增加可选 string `target`：

```json
{ "path": "src/config.ts" }
{ "path": "src/config.ts", "target": "local" }
{ "path": "opaque-output-id", "target": "output" }
{ "path": "src/config.ts", "target": "devbox" }
{ "command": "uname -s", "target": "devbox" }
```

省略 `target` 与 `target: "local"` 等价。`local` 和 `output` 是保留名称；它们优先于同名 SSH alias。extension 加载时若白名单 SSH alias 与保留名称冲突，只显示一次 warning，并排除该 alias。

legacy `output://N` 暂时保留为独立 internal URL branch。它优先于 `target`，不正则化为 target arguments；例如 `{ path: "output://12", target: "devbox" }` 仍由 legacy Output resolver 执行。该优先级避免调用参数宣称 remote、实际却读取 internal resource 而没有可观察解释。新产生的 recovery reference 使用 `{ target: "output", path: "<opaque-id>" }`；legacy URI 在新 contract 稳定后才另行 deprecate。

unknown target、未授权 alias、target/path capability 不匹配、或 remote capability 缺失，都返回明确错误。任何失败不得 fallback 到 local 或其它 target。

### 能力矩阵

| Tool | local | output | SSH alias |
| --- | --- | --- | --- |
| `read` | existing local behavior | read one Output id | SFTP text/image read |
| `grep` | existing local/FFF behavior | search one Output id | remote `rg --json` |
| `find` | existing local/FFF behavior | rejected | remote `rg --files` plus local non-FFF ranking |
| `bash` | existing local foreground/pty/async | rejected | foreground `ssh` only；cwd 为远端 `$HOME` |
| `apply_patch` | Patch Core + LocalBackend | rejected | Patch Core + SftpBackend（ADR-0018） |
| `edit` / `write` | existing local Pi native | rejected | Publish + SftpBackend（ADR-0019；方言仍是 native；排在 Patch Core 之后） |

Output 没有 tree/directory 语义：`find({ target: "output" })` 一律拒绝。`read` 和 `grep` 的 output target 都要求 `path`。local 与 SSH `grep`/`find` 保留其原有的 optional search path。`bash` 与 `apply_patch` 不接受 `output`。

## Target 解析与授权

SSH target 是 OpenSSH config 的 literal `Host` alias，不是任意 `user@host`、SSH argument、credential 或 private-key path。`pi-ext-tools` settings 的 user-wide `targets.sshWhitelist` 是唯一 authorization set：

- 默认空 list，不允许任何 SSH target；
- 只有同时在 whitelist 和 SSH config literal `Host` 中的 alias 可以执行；
- `Host *`、wildcard alias 与未配置 alias 不可用；
- project settings 不得扩大 whitelist；
- settings 修改在 `/reload`、新 session 或新 Pi process 后才生效，当前 session snapshot 不变。

extension 在 load/reload 时解析并验证 whitelist，生成同一份 bounded target catalog。该 catalog 注入每回合 system prompt，列出 `local`、`output` 与已授权 SSH aliases，说明 remote 的 POSIX、timeout 与 search boundary。最多注入 32 个 aliases；不在 tool execution 前连接或 probe host。settings validation 同样限制 whitelist 为最多 32 个不重复 aliases。

## SSH 执行

SSH target 只支持 POSIX remote hosts。执行使用系统 `ssh` 和 `sftp`，而不是新增 Node SSH dependency：

- `read` 使用 SFTP，沿用 Pi read 的 text/image 行为与限制；
- `grep` 以 remote `rg --json` 搜索；
- `find` 以 remote `rg --files` 枚举；
- `bash` 以 `ssh alias -- command` 在远端 `$HOME` 前台执行，复用同一条 ControlMaster；
- remote `grep`/`find` 必须提供 `rg`；缺失时明确报告 remote dependency error。

OpenSSH config 仍拥有 hostname、user、port、identity、agent、known-hosts 与 ProxyJump 等连接配置。extension 只追加 non-interactive 与其 own connection-master options。认证、host-key 或 passphrase prompt 不可交互完成，必须失败而不阻塞 Pi session。

每一个 alias 的 ControlMaster socket 位于：

```text
~/.pi/agent/extensions/pi-ext-tools/targets/<alias>.sock
```

同一 alias 的所有 session 共用这一条 master，不再按 session 建子目录。`ControlMaster=auto` 且 `ControlPersist=15m`：idle 到期或 master 被清掉后，下一次 ssh/sftp 会新建 master；并发 session 挂到同一条 socket。extension 在 startup 清理失效 socket；不在一般 session cleanup 主动关闭尚可被其它 session 使用的 master。所有本地 child process 和 SFTP/SSH operation 都接受 caller cancellation。`read`、`grep`、`find` 的整体 timeout 固定为 20 秒（含 SSH 连接）；这不是模型可控制参数，也不出现在 tool schema。`bash` 的 `timeout` 与 local 相同：可省略，省略则跑到结束或取消。

remote path 遵从明确、可预测的 SSH/SFTP 语义：

```text
path = "XXX"   -> remote home relative path
path = "/XXX"  -> remote filesystem absolute path
```

所有 remote path 拒绝 `..` segment 与 `~` expansion。V4A 与 tool 参数使用未加前缀的 Remote Path；TUI 可以画 `host:path` 或 bash 的 `(host)`。extension 不配置 workspace root，也不构造可绕过 SSH user permissions 的 sandbox。不显示 credentials、private key path 或 local ControlPath。

## remote bash

remote bash 不是包一层本机 `ssh` 的 local bash：

- 只接受 `local` 或已授权 SSH alias；`output`、`pty`、`async` 一律拒绝；
- 不传本机 `ctx.cwd`、`shellPath` 或环境变量；远端 sshd 用该帐号 login shell；
- cwd 为远端 `$HOME`（`cd "$HOME" && command`）；
- 取消只终止本机 ssh session，不宣称远端 process 已死；结果是 interrupted；
- 不跑 RTK rewrite；
- stdout/stderr 仍进入本机 session `BashOutputSink`；
- header 为 `status bash (host) <command>`，`(host)` 在当前 Trace 为 warning 色，塌缩后与 command 一起 dim。

## remote apply_patch（ADR-0018）

与 local 同一套 Patch Core。Unix-like SSH 走 SftpBackend：lstat/read/put/rename/rm，不是 sshfs，也不是远端 coordinator。workspace 为远端 `$HOME`。`✓` 只在 sibling 临时文件 replace 确认后。已确认 path 不 rollback。现有文件大于 32 MiB 拒绝。同 alias 跨 session 由本机平台原生 lock 串行化 apply_patch，忙则拒绝；不检测外部写入。SFTP 单 path：传输 ≤1 MiB 逾时 30s，否则 60s。Update 写穿 leaf symlink；Delete unlink 字面目录项。header 为 `apply_patch (host) N file(s)`；operation rows 为 warning 色 `host:path`。

## remote write / edit（ADR-0019，排在 Patch Core 之后）

与 apply_patch 共用 Publish 与 mutation lock，不另做 SFTP 覆盖。本机仍走 Pi native execute。远端 Write 没有就创建、有就覆盖、自动建父目录；远端 Edit 精确唯一匹配。路径是 Remote Path（相对 `$HOME` 或远端绝对路径）。锁内内容已相同则成功 no-change、不 Publish。现有文件与 new bytes 大于 32 MiB 拒绝。Unconfirmed 用 `?`，必须先 `read`。SFTP 逾时与 apply_patch 相同。header 为 warning 色 `host:path`。`output` 仍拒绝；失败不 fallback local。

## 远程搜索

remote target 永远跳过 FFF。`grep` 将 remote ripgrep JSON 转换为既有 canonical grep result/details 与 ToolTui body；它不把 remote shell output 当作 local `rg` output，也不泄漏 remote command construction。

remote `find` 先通过 `rg --files` 取得 snapshot，再在 extension 本地完成 non-FFF filtering/ranking：

- glob 维持 find 的 glob/path constraint；
- 普通文字是 case-insensitive path subsequence fuzzy match；
- 多字 query 的每个字都必须命中；
- details 只报告 `fuzzy` 或 `path` match type，不报告 FFF frecency、Git status 或 index metadata。

snapshot 只要超过 `1024` paths 或 `256 KiB`，立即以 scope-too-broad 失败，不返回看似完整的部分结果。符合限制的 snapshot 由 cursor record 保存 target、query、排序候选与 page index；后续 page 不重新查询 remote filesystem。cursor 在 reload 或 expiry 后明确报 invalid/expired。

## Session-bound Output 持久化

新的 Output id 是 opaque 且 session-qualified。每一个 persisted session 的 sidecar 是：

```text
<session-file>.pi-ext-tools-output.jsonl
```

它独立于 Pi session JSONL；extension 绝不向 Pi session JSONL 插入非 Pi entry。output finalization 才 append 一条完整 record，不为 streamed append chunks 写盘，也不为每笔记录主动 `fsync`。

一个 sidecar 最多保存 128 个 Outputs、8 MiB UTF-8 payload，且单个 Output 最多 1 MiB。超量时不能截断内容：Output 保留为当前 process 可读的 non-persistent resource，tool result/details 明确标示该状态并显示一次 warning；resume/restart 后该 id 不可读取。没有 Pi session file 的 `--no-session` mode 同样使用 process-only Output。

sidecar reload 逐行验证。invalid record、duplicate id、或 crash 留下的不完整行被跳过并只 warning 一次；后续有效 records 仍可恢复。persist append 失败同样保留 process-only resource，不能把未完整写入的内容宣称为 persistent success。

fork 不复制 payload。resolver 以 opaque session-qualified id 在当前 session 与其明确 parent ancestry sidecar 中查找；Handoff Continuation 也可沿已记录的 Source Session lineage 查找。它不扫描无关 session，也不把 Output 变成跨项目的全局 catalog。

## 渲染与持久化

ToolTui 仍拥有 frame、collapse 与 resume lifecycle；target backend 只提供 canonical result/details。每一个 persisted remote result 都记录足够的 target/path/typed outcome，以便 resume 仅从 persisted data 重画，不需要重新建立 SSH connection。target conflict、non-persistent Output 与 remote dependency/cancellation/timeout 都是 typed result states，不能只作为 transient notification。

path 类工具在当前 Trace 使用 warning 色 `host:path`；bash 使用 warning 色 `(host)`。collapsed / 后续 Trace 去掉 warning 色，整段 dim。

## 所有权、清理与测试

`pi-ext-tools` 拥有 target parsing、authorization、transport process lifecycle、Output sidecar policy、canonical result conversion、cursor snapshots 与 target-aware rendering。`pi-ext-core` 只扩展 feature-neutral Settings contract，以支持 `list<string>` value 和 field type；它不拥有 SSH、Output、whitelist 或 any target policy。`pi-settings` 只提供 list editor UI。

实现必须覆盖：

- local default、reserved target、legacy URL precedence、target conflict warning 与 unknown/unauthorized target；
- whitelist snapshot/reload behavior、reserved collision、SSH config literal validation 与 no-probe load；
- SFTP read text/image、remote `rg` conversion、timeout、abort、non-interactive authentication failure、POSIX rejection；
- remote bash：SSH exec、home cwd、optional timeout、cancel、output/pty/async 拒绝、无 RTK、`(host)` header、details.target；
- remote path rules、FFF bypass、find snapshot cursor、scope limits 与 cursor expiry；
- sidecar normal reload、caps、non-persistent fallback、invalid records、write failure、fork and Handoff ancestry resolution；
- list<string> storage validation and Settings TUI narrow/wide add/edit/remove/reorder behavior;
- real Pi lifecycle smoke checks for target tool rendering, partial/final states and resumed historical output.
