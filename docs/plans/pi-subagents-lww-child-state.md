# pi-subagents：本地生成 child id，状态改为读时判活

状态：提案（未实现）

## 1. 目标

把 child id 的分配和 liveness 判定改成维护者自己的 `@earendil-works/pi-subagent`（[badlogic/pi-subagent](https://github.com/badlogic/pi-subagent)，920 行，无数据库）已经在用的形状：**id 本地随机生成，状态最后写入者胜出，死活读时算**。

去掉三处「用数据库约束仲裁」的机制 —— 它们换来的只是响亮失败，没有任何恢复路径。

**不保留兼容性**：旧 `agent-N` id、旧 ledger、旧 MCP 客户端都不做双读、回填或兼容分支。

## 2. 上游怎么做的

上游一个 run 一个目录 `~/.pi/agent/subagents/<handle>/`，里面 `metadata.json` + `inbox/`。没有数据库。

**id（`subagent.ts:generateHandle`）**

```ts
function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}
```

6 位小写 hex，本地查重，100 次，无全局计数器，无数据库约束。`runDirForHandle` 用 `/^[a-z0-9]+$/` 再校验一次 —— 因为它要当目录名。

**状态（`shared.ts:writeMetadata` / `updateMetadata`）**

```ts
writeFileSync(temporary, JSON.stringify(metadata), ...);
renameSync(temporary, target);          // 原子替换
```

`updateMetadata` = 读 → 合并 → 写。没有版本号，没有 compare-and-swap，没有 stale 错误。

**liveness（`shared.ts:effectiveRunState`）**

```ts
export function effectiveRunState(metadata: RunMetadata): RunState {
	if ((metadata.state === "starting" || "busy" || "idle") && !tmuxSessionExists(metadata.tmuxSession)) {
		return "exited";
	}
	return metadata.state;
}
```

**这是关键**：`metadata.state` 是「最后一次声明」，**永不回写修正**。谁死谁活完全由 `tmux has-session` 在读的时候算。没有 reconcile 写盘，没有「标记为死」这一步。

## 3. 改动 1：id 改为本地生成

```ts
export function createSubagentId(existingIds?: readonly string[]): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = `agent-${randomBytes(3).toString("hex")}`;
		if (!existingIds?.includes(id)) return id;
	}
	throw new Error("Could not allocate a unique subagent id");
}
```

- 删 `nextSubagentIndex`、`resetSubagentIdCounter`，以及 `session-bootstrap.test.ts:106` 的顺序断言。
- `existingIds` 保留（`extension.ts:271` 传 `registry.list()` 的结果），`resolve()` 的依赖不动 —— 只有 id 的**内容**变了，接线不变。
- **小写是硬要求**：id 会变成文件名（`processLockPath` → `locks/<parentSessionId>/<subagentId>.lock`）。macOS APFS 默认大小写不敏感，大小写混用会让两个 id 落到同一个锁文件。
- 6 位 hex 与 `bash-jobs.ts:runtimeNonce()` 同字母表同长度。50 个 child 的碰撞概率 7.5e-5，代价是一次重试。
- **不是安全边界**：id 不承担保密职责。模型查到别的 child 就能唤起它，这是合理行为。
- `registry.create` 的 `duplicate_child`（`registry.ts:574`）**保留**，但降级为不变量断言：本地查重之后，只剩两个进程同微秒 spawn 才会撞到。不为它加跨进程重试 —— 上游也没有（见 §6 的 TOCTOU 说明）。

## 4. 改动 2：删掉 CAS，删掉 `children.revision` 列

`children` 表已经是每个 child 一行，PK 已经是 `(parent_session_id, subagent_id)`，`insertChild` 已经 `ON CONFLICT DO NOTHING` 并返回 boolean，`replaceChild` 已经支持 `expectedRevision === undefined` 的无条件分支。**存储层已经支持 LWW，只有调用方在硬塞版本号。**

而没有任何调用方传过真正的期望版本：`lease.ts:114` 是 `expectedRevision ?? current.revision`，填的是刚读到的值。于是 CAS 只在「读和写之间真有另一个写者」时触发 —— 也就是**纯竞态探测器，没有恢复路径**。全仓没有任何地方 catch `stale_revision`（`manager.ts:2439` 的注释直说「no stale_revision retry is needed」）。

不做兼容，所以连列一起删：

```sql
CREATE TABLE children (
  parent_session_id TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (parent_session_id, subagent_id)
);
```

- `readChild` 返回 `record: string | undefined`，不再拼 `{ revision, record }`。
- `insertChild(db, parent, id, record)` / `replaceChild(db, parent, id, record)` 去掉版本参数；`replaceChild` 只剩一条无条件 `UPDATE`。
- **`SubagentRecord.revision` 保留在记录 JSON 里**，写入时 `+1`，语义变成「这条记录被写过几次」。它仍是 `tool-presentation.ts:100-105` 的 `rev N` 和 `mcp-server.ts:422` 的数据源 —— 只是不再参与任何比较。
- 删除 `expectedRevision` 参数链：`registry.update`（`registry.ts:79,586-590,614-627`）、`commitLease`（`lease.ts:73,87,103,114`）、`"stale_revision"` 错误码（`registry.ts:45`）、`registry.test.ts:123`、`lease.test.ts:113-140`。
- `runtime_mismatch`（`registry.ts:592`）比较的是 runtime 身份，不是记录版本，本次不动。

### 迁移

`SCHEMA_VERSION` 2 → 3，沿用 `migrate()` 已有的列修复模式：`ADDED_COLUMNS` 旁边加一个对称的 `DROP_COLUMNS`，用 `PRAGMA table_info` 判断列是否存在再 `ALTER TABLE ... DROP COLUMN`。新建库走新 `TABLES`，已有库丢掉这一列，**行数据保留**。

不写任何双读、回填或 `agent-N` 兼容分支：旧 id 直接失效，旧 ledger 不做语义迁移。

## 5. 改动 3：liveness 读时判定

上游用 `tmux has-session` 算。我们用 child 自己的进程锁（`mailbox.ts:329` 的 `holdProcessLock`，SQLite `BEGIN EXCLUSIVE`，进程死即由内核释放，含 SIGKILL）。

- 记录里的 `runtime` 从「当前状态」变成「最后一次声明」，**永不清理**。
- 死活 = `processLockHeld(processLockPath(...))`，在读的时候算。
- panel 型 attachment 同样持锁：`openChildPanel` 之后等 `mailbox.waitUntilSeen`，而 bridge 能连上的前提就是 mailbox `start()` 里 `holdProcessLock` 成功。所以 process / panel 两种 attachment 都由锁覆盖。
- `processes.alive(attachment.pid)` 只对 `kind === "process"` 生效，而这类 child 也持锁 → 同一事实的第二个信号，**删除**。pid 只留作诊断（会被复用，不能当权威）。

`reconcile`（`lease.ts:205`）退化：

| # | 今天 | 改后 |
|---|---|---|
| 1 | 锁空 → `releaseRuntime(drop)` 清 `runtime` | **删** |
| 2 | 列 herdr/cmux panel：在则重绑，不在则重开或 stop | **保留**（唯一真正的工作） |
| 3 | `kind === "process"` 且 pid 死 → drop | **删** |
| 4 | 记 host generation | 保留 |

`LeaseReady.released / stopped` 变成计算值，不再写盘。

读时判活落在 `SubagentManager.#project()`：每次读记录探一次锁，`state === "running"` 但锁空时投影成 `blocked`，不写盘。`agents_get` / `agents_dashboard` / 状态栏都走它。

`#ready` memo（`manager.ts:2359-2361`）**保留**。原先计划去掉它，但那是为了「每 turn 刷新 liveness」；判活改成读时计算后就不需要刷新了。而 `reconcile` 会调 `hosts.list()`（一次 herdr/cmux 子进程调用，10 秒超时），每 turn 跑一次是真成本。所以 reconcile 仍是启动时一次，只负责重绑 surface。

## 6. 抄什么，不抄什么

| | 上游 | 本仓 |
|---|---|---|
| id | 6 hex 本地生成 | **抄** |
| 状态 | LWW 覆盖 | **抄** |
| 死活 | 读时算 | **抄** |
| 存储 | 一个 run 一个 JSON 文件 | 保留 sqlite：还需要 `commands`（带 status/result/error_code 的邮箱）和 `delegations`（模型可查的历史 revision）。上游靠读 child 的 transcript JSONL（`readLatestAssistant`）拿结果，没有历史查询 |
| 并发写 | `updateMetadata` 读-改-写，会丢更新 | 保留 `withWrite`（`BEGIN IMMEDIATE`）串行化，整个记录 LWW，不丢更新 |
| 唯一性检查 | `existsSync` 后 `mkdirSync({recursive:true})` → TOCTOU，两个进程可能**静默共用一个 run 目录** | `insertChild` 的 PK 检查原子，零成本，不抄这个漏洞 |
| 父退出 | suspend（kill tmux）+ resume 时重启 idle | 保留：background child 由 stdin pipe 持有，panel child 存活 |
| 宿主 | tmux | herdr / cmux |

## 7. 删除清单

| 删 | 位置 |
|---|---|
| `nextSubagentIndex` / `resetSubagentIdCounter` | `session-bootstrap.ts:197-201` |
| `createSubagentId` 的顺序逻辑 | `session-bootstrap.ts:203-210` |
| `expectedRevision` / `stale_revision` | `registry.ts:45,79,586-590,614-627`；`lease.ts:73,87,103,114` |
| `children.revision` 列 | `state-db.ts:22`（+ `DROP_COLUMNS` 修复步骤） |
| `replaceChild` 的条件分支 | `state-db.ts:239-256` |
| `reconcile` 的 drop 分支与 pid 检查 | `lease.ts:211-232,268-276` |
| `#ready` memo | `manager.ts:373,2359-2361` |
| 顺序 id 测试 | `session-bootstrap.test.ts:106-114` |
| `stale_revision` 测试 | `registry.test.ts:123` |

## 8. UI 变化

状态栏与 info entry 的编号从 `#21` 变成 `#3f9a1c`（6 字符）。显示值仍与真实 id 可逆（现状就是剥 `agent-` 前缀），不引入「位置序号」这个新概念。窄屏沿用现有 ANSI/单元格宽度安全裁剪。

同步更新：`docs/architecture/pi-subagents.md`、`docs/pi-subagents/spec.md:453`、`DESIGN.md:203`、`markdown.ts` 正则、`status.ts:9`、`tools.ts:118` 的示例。

## 9. 范围外

- **跨 session 可达**：要显式授权，不用 id 保密。本提案不实现。
- **`agents_get` 回看历史 revision**：`delegations` 表已有历史，本次不动。
- **`rev N` 降噪**：明确不做。
- **`runtime_mismatch`**：另一个不变量，本次不动。

## 10. 测试

- id：匹配 `^agent-[0-9a-f]{6}$`；连续调用不重复；`existingIds` 里的 id 被跳过；100 次耗尽后抛错。
- LWW：`update` 不再因记录版本抛错；两个写者串行时后者胜出。
- 迁移：v2 库升级后 `children` 无 `revision` 列、行数不变；新建库直接是新形状。
- 判活：锁被持有时 `alive = true`；锁释放后**无需写入**即变 false；`reconcile` 不再修改 `runtime`。
- 回归：`agents_delegate` / `agents_get` / `agents_stop` 行为不变；`delegation_revision` 不受影响。

## 11. 顺序

1. id 本地生成（含渲染四处 + 文档三处）
2. 删 CAS / `expectedRevision` / `stale_revision` / `children.revision` 列（schema v2 → v3）
3. liveness 读时判活 + `reconcile` 退化 + 去 `#ready` memo

1 独立可验证，不改 schema。2 改 schema（v2 → v3），需要迁移测试。3 是唯一有用户可见行为变化的一条：死掉的 child 立刻显示为死，而不是等下一次 `reconcile`。

## 12. 实施记录

按 1 → 2 → 3 全部落地，`packages/pi-subagents` 380 个测试通过。与提案的三处偏差：

1. **`#ready` memo 保留**（见 §5）。判活变成读时投影后不需要每 turn 刷新，而 `hosts.list()` 是子进程调用，不该每 turn 跑。
2. **判活落在 `SubagentManager.#project()`**，而不是 `delegationView`。`PublicSubagent` 本来就是 manager 的投影，探锁在那里只发生一次；放进 view 会让每次重绘都开一次 sqlite。
3. **外部杀死改为启动时结算一次**。原先 `reconcile` 在锁空的记录上写 `blocked` + `#noteReleasedRuntime` 触发自动报告；写盘删掉后这条路径没有数据来源。但读时投影不是投递——`#performAutoReport` 会重读记录并在 `state === "running"` 时直接返回，所以纯投影的回报会被静默丢弃。最终做法：`#reconcile()` 在 surface 修复之后跑一趟 `#settleUnrecovered()`（`recover()` 已在用的同一个原语），只处理 `running`、没有写者、也不在本次 `rehydrated` 里的记录。panel child 走 `#recordWriterGone`（已完成回复则交付结果，否则 `blocked` + 回报），background child 走 `parent-exit`（`done` + 退出说明，不回报）。频率由 `#ready` memo 固定为每个 parent 进程一次，投递频率仍由既有的 500ms/10s 批处理收敛。

`children` 表丢掉 `revision` 列（`DROP_COLUMNS` 修复，行保留），`SCHEMA_VERSION` 2 → 3。
