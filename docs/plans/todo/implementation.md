# pi-basics Todo 实作方案

> Archived plan: retained for implementation history. Current behavior is defined by source, tests, and `packages/pi-basics/README.md`.

> 输入：[`high-level.md`](./high-level.md) 与 [`design.md`](./design.md)。本文件描述实现顺序、文件改动、测试和验收；不是已完成声明。

## 1. 实作原则

- 先 domain model，再 snapshot/replay，再 tool/command，最后 widget 与 active-runtime integration。
- 每阶段产出可运行的 focused test。
- 不先建 config、storage abstraction、通用 contribution API。
- 不修改 `pi-extcore`、`pi-loadout`、`pi-ssh`、`pi-inturl`。
- 不碰现有 Settings/Loadout 行为，Todo 只在 entry 增加独立注册。
- 不为了参考实现 parity 增加未要求功能。

## 2. 预期改动清单

### 修改

- `packages/pi-basics/package.json`
- `packages/pi-basics/src/index.ts`
- `packages/pi-basics/README.md`

### 新增

- `packages/pi-basics/src/modules/todo/model.ts`
- `packages/pi-basics/src/modules/todo/state.ts`
- `packages/pi-basics/src/modules/todo/widget.ts`
- `packages/pi-basics/src/modules/todo/index.ts`
- `packages/pi-basics/test/modules/todo/model.test.ts`
- `packages/pi-basics/test/modules/todo/state.test.ts`
- `packages/pi-basics/test/modules/todo/widget.test.ts`
- `packages/pi-basics/test/modules/todo/integration.test.ts`

不新增 root-level Todo export、独立 package、config 文件或 snapshot fixture。

## 3. Phase 0：Review Gate

实现前先由用户确认 [`high-level.md`](./high-level.md) 的推荐项，至少包括：`todo` tool、直接 `/todos` command、branch-only persistence、hard delete、四字段、ordered `operations[]` mixed batch、完整替换 `blockedBy`、四条来源化 prompt guidance、只读 widget。任一项改变时，先同步详细设计和 acceptance；未确认前不改完整逻辑。



## 4. Phase A：Domain model

### A1. 建立类型与 reducer

目标文件：`src/modules/todo/model.ts`

实现：

1. `TaskStatus`、`TodoAction`、`TodoOperation`、`Task`、`TaskState`、`TodoParams`。
2. `freshTaskState()` factory；每次返回新 array。
3. strict positive integer helper。
4. dependency list validation。
5. cycle detection。
6. status transition table。
7. `applyTodo(state, params)` tagged result。
8. textual formatter保持在 command/tool 层，不放 reducer。

建议内部 helper：

```ts
freshTaskState(): TaskState
isTransitionAllowed(from, to): boolean
validateBlockedBy(state, taskId, ids): string | undefined
wouldCreateCycle(tasks, taskId, blockedBy): boolean
applyTodo(state, params): ApplyTodoResult
```

不要导出 cycle implementation，测试通过 public reducer 行为覆盖；只有 replay validation 真正需要时再导出 validator。

### A2. Model tests

目标文件：`test/modules/todo/model.test.ts`

最小 cases：

- create 生成 #1 pending，trim subject，不 mutate input。
- 同一 branch lineage连续 create id单调递增。
- action/field legality matrix拒绝 silent ignore。
- status-only update成功。
- completed不能回到 active；blockedBy为 advisory，不结构性阻止 transition。
- full blockedBy replacement及 `[]` 清空。
- missing/self/duplicate/cycle全部拒绝。
- no-op update标记 `changed:false`。
- delete删除 task、清理 dependents、保留 nextId。
- error返回原 state reference或 deep-equal unchanged state。
- ordered mixed batch支持 delete + create；整批成功只 commit一次。
- batch任一 operation失败则全部 unchanged；error包含 operation index。
- `list`只能是唯一 operation；省略 task不代表 delete。

### A3. Phase check

```bash
bun test packages/pi-basics/test/modules/todo/model.test.ts
```

完成条件：reducer 没有 Pi API、TUI、filesystem import。

## 5. Phase B：Snapshot、replay 与 active runtime state

### B1. 建立 durable snapshot

目标文件：`src/modules/todo/state.ts`

实现：

```ts
interface TodoSnapshot {
  tasks: readonly Task[];
  nextId: number;
}

interface TodoToolDetails {
  snapshot: TodoSnapshot;
}
```

提供：

```ts
snapshotFromState(state): TodoSnapshot
stateFromSnapshot(value): TaskState | undefined
latestTodoSnapshot(branch): TaskState | undefined
```

`stateFromSnapshot()` 必须重验 domain invariants，不只检查 `tasks` 是 array。两个方向都 deep-clone tasks及 `blockedBy`。`latestTodoSnapshot()` 必须区分无 snapshot (`undefined`) 与有效空 snapshot。不预建 version/migration系统。

### B2. Runtime semantics

- `TodoFeature` 只保存当前 active runtime `{ sessionId, state, widget? }`，不建立 per-session Map或第二套 lifecycle owner。
- runtime start无 snapshot使用 fresh state。
- tree无 snapshot切 fresh state；compact无 snapshot保留 live state。
- commit只接受已验证、deep-isolated state。
- tool ctx sid不等于 active sid时 fail closed。
- registry cleanup按 captured session id执行 idempotent dispose。

### B3. State tests

目标文件：`test/modules/todo/state.test.ts`

覆盖：

- last valid malformed-safe snapshot wins。
- 非 `todo` toolResult忽略。
- malformed snapshot / duplicate id / whitespace subject / duplicate or dangling dependency / cycle / invalid nextId拒绝。
- replay和details deep isolation；后续外部 mutation不影响 active state。
- empty history与有效 empty snapshot可区分。
- runtime replacement从各自 branch恢复，不共享 mutable state。
- compact无 snapshot保留 live state；tree无 snapshot切 fresh state。

### B4. Phase check

```bash
bun test packages/pi-basics/test/modules/todo/state.test.ts
```

完成条件：没有磁盘文件、环境变量、replay cache。

## 6. Phase C：Tool、command 与 prompt

### C1. 增加 TypeBox dependency

修改 `packages/pi-basics/package.json`：

```json
"dependencies": {
  "typebox": "^1.1.38"
}
```

运行 workspace install only if lockfile needs update；使用现有 Bun workflow，不引入 `@sinclair/typebox` 第二套版本。

### C2. Tool schema 与 normalization

目标文件：`src/modules/todo/index.ts`

实现 provider-safe nested operation string enums、`Type.Integer({ minimum: 1 })` 和递归 `prepareArguments()`。

顶层 schema只有 non-empty `operations[]`；每个 operation设 `{ additionalProperties:false }`，顶层同样设 `additionalProperties:false`。Reducer另做 action/field matrix与 `list`-must-be-alone validation。Nested schema是明确需求，不再保留 flat single-action入口或 full-list replacement alias。

Normalization helper必须单测：

```text
"1" -> 1
"01" -> reject/unchanged
"1e2" -> reject/unchanged
"2.7" -> reject/unchanged
```

推荐只接受 regex `^[1-9]\d*$`；`"01"` 不视为 canonical id。

### C3. Tool execute flow

Tool identity：`todo`；设置 `executionMode: "sequential"`，不建 custom queue，也不注册 `hepi_todo` alias。

```text
signal?.aborted -> throw before state access
-> sid(ctx) == active.sessionId
-> applyTodo(active.state, { operations }) // sync, no await; validates full batch
-> changed batch: one deep-isolated commit
-> all no-op: keep current state and format explicit per-operation "No change"
-> construct one result summary + ordered op results + deep-cloned details.snapshot
-> later tool_execution_end: best-effort widget refresh from active state
```

失败：

- 不 commit，不返回 durable snapshot；dispatcher抛出带 operation index的稳定 error，由 Pi host记录失败。
- schema pre-validation error由 host产生，不承诺 Todo snapshot。
- abort在 reducer前抛出，不 commit，也不承诺 Todo snapshot。

Tool execute不调用 `setWidget()` / `requestRender()`。UI failure不得阻止 result snapshot进入 transcript；`tool_execution_end` handler捕获 refresh failure、清失效 registration并等待下次 bind。

### C4. Prompt contract（线上来源交叉验证）

```ts
promptSnippet: "Manage a task list to track multi-step progress"
promptGuidelines: [
  "Use `todo` for complex work with 3+ distinct steps, when the user provides multiple tasks, or after new instructions. Skip single trivial or purely conversational requests.",
  "Mark a task `in_progress` before beginning work and `completed` immediately when done; keep exactly one task `in_progress` while work remains, and do not delay completions to batch them.",
  "Never mark a task `completed` when work is partial, failing, or blocked; keep it `in_progress` and add a task for the blocker.",
  "When several task changes are already known, submit them together in one `operations` batch to reduce tool calls; never infer deletion from omitted tasks.",
]
```

测试锁定四条 guidance及来源语义。使用门槛/实时状态/完成安全来自 OpenCode与Claude TodoWrite；snippet交叉参考 `pi-xtodo` / `rpiv-todo`；batch优先来自 `@zhushanwen/pi-todo`。Tool description采用 OpenCode开句并补 ordered atomic operations，不复制长 examples。

### C5. 直接 `/todos` command

在 `src/modules/todo/index.ts` 内直接调用：

```ts
pi.registerCommand("todos", {
  description: "Show current todos",
  handler: async (args, ctx) => { ... },
});
```

- 不经过 `HePiModule`、`HePiRegistry` 或 `/hepi` dispatcher。
- 不注册 `/hepi todo` alias。
- 不创建 `ctx.ui.custom()`。
- non-interactive context显示 `/todos requires interactive mode`。
- `args.trim()` 非空显示 `Usage: /todos`。
- 按状态输出 notify；tool被 Loadout禁用时仍可只读 active branch state。

### C6. Integration tests（第一部分）

目标文件：`test/modules/todo/integration.test.ts`

- tool identity、provider-safe nested schema、action/field matrix、four-guideline sourced prompt。
- `executionMode: "sequential"`。
- create/update/list/delete单项及 ordered mixed batch execute。
- delete + create同 call；整批只 commit一次。
- 中段 invalid operation使整批 unchanged且不产生 durable snapshot。
- no-op operations返回稳定 `No change`文案及 final unchanged snapshot。
- aborted execute不读取/修改 state，也不触发 widget refresh。
- direct command registration metadata。
- `/todos` interactive/empty/grouped/usage。
- `createLoadoutInventory()`含 `tool:todo`；只注册 `todo`，不注册 `hepi_todo`。
### C7. Phase check

```bash
bun test packages/pi-basics/test/modules/todo/integration.test.ts
```

## 7. Phase D：Widget

### D1. Component

目标文件：`src/modules/todo/widget.ts`

只实现：

- active runtime `ctx.mode === "tui"` 时绑定。
- UI context ownership。
- lazy `setWidget` registration。
- `requestRender()`。
- `render(width)`。
- context invalidation/re-registration。
- dispose/unregister。

不实现 input handler、collapse/scroll、completed-turn memory、configuration或 direct stdout。

### D2. Render selection

```ts
selectWidgetTasks(state, limit = 6)
```

排序：`in_progress` by id，再 `pending` by id。Completed只进入 header count。Task row始终显示 id；只有未完成 blocker才显示 `blocked by`。

### D3. Width safety

- 复用 `src/ui/text.ts`。
- 每行最终通过 `truncateToWidth()`。
- 测试 ANSI stripped visible width `<= width`。
- 极窄 width下允许只剩 truncated header，不抛错。

### D4. Widget tests

- non-TUI runtime不注册 widget。
- no tasks -> no widget / unregister。
- first task注册一次；later update只 requestRender。
- invalidation后 next update重注册。
- all completed -> one header line。
- max six task rows + overflow summary。
- blocked label只显示 unresolved blocker；resolved blocker不显示。
- width 12/20/80不溢出。
- dispose idempotent；dispose内部失败仍由 feature cleanup释放 owner。

### D5. Phase check

```bash
bun test packages/pi-basics/test/modules/todo/widget.test.ts
```

## 8. Phase E：Lifecycle 与 pi-basics entry

### E1. Feature instance

`createTodoFeature(pi)` 在 extension load时注册 `todo`、`/todos`、compact/tree及 `tool_execution_end` hooks，返回：

```ts
interface TodoFeature {
  start(runtime: HePiRuntimeContext): Promise<void> | void;
  dispose(sessionId: string): Promise<void> | void;
}
```

内部只保存 current active runtime `{ sessionId, state, widget? }`。

- 不自行注册 `session_start` / `session_shutdown`。
- `start(runtime)`由现有 `HePiLifecycleController.onStart`调用。
- widget只在 `runtime.ctx.mode === "tui"` 创建。
- compact/tree hook只在事件 sid等于 active sid时刷新。
- `tool_execution_end`只对成功的 `todo` best-effort刷新 widget；UI failure不改变 tool outcome/state。
- known stale context保留现状；其他 replay错误传播。
- `dispose(capturedSessionId)`以 `try/finally` 清 active state/widget，重复调用安全。

### E2. 修改 root entry

`packages/pi-basics/src/index.ts`：

1. extension初始化时先 `createTodoFeature(pi)`，完成 `todo` tool与 `/todos` command注册。
2. 之后才注册现有 lifecycle；其 `onStart`创建 Loadout inventory时必须已能发现 `tool:todo`。
3. lifecycle `onStart`调用 `todo.start(runtime)`。
4. 立即捕获 fresh session id，向 `runtime.registry.registerLifecycle()`登记 `todo.dispose(sessionId)`。
5. 不把 Todo state塞入 Settings/Loadout controller变量或 `HePiRegistry`。
6. 不改变 shell factories/labels、`registerHePiModule()` public behavior，也不绕过 Loadout `setActiveTools()`。

### E3. Lifecycle 与 Loadout tests

- runtime start从 branch恢复；runtime replacement先 cleanup旧 Todo再 start新 Todo。
- non-TUI mode不注册 widget。
- compact有 snapshot时 replay、无 snapshot时保留 live state。
- tree无 snapshot时切 fresh state。
- ctx sid不匹配时 tool fail closed。
- known stale context保留现状；其他错误传播。
- widget dispose抛错时仍释放 active runtime；repeated cleanup safe。
- widget refresh failure不使 tool result失败；snapshot仍进入 transcript。
- Loadout inventory含 `tool:todo`；default active。
- persisted disabled状态使 `todo`从 active tools、schema/prompt移除；`/todos`仍可只读 existing branch state。

### E4. Phase check

```bash
bun test packages/pi-basics/test/modules/todo
bun test packages/pi-basics/test/integration/index.test.ts
```

## 9. Phase F：Docs 与 package contract

### F1. README

更新 `packages/pi-basics/README.md` 当前行为：

- `todo` tool。
- direct `/todos` command。
- branch-history persistence及 compact/tree fallback。
- no disk fallback。
- minimal fields/actions。
- Loadout可启用/禁用 tool；command/widget保持只读。

删除/修正文档中“todo尚未实现”的旧表述；不要改写无关 Settings/Loadout说明。

### F2. 旧计划同步

当前 `docs/pi-basics-tasks/01-goals-and-boundaries.md`、`07-runtime-boundaries.md`、`09-phases.md`、`12-non-goals.md` 把 Todo列为 future/non-goal。实现工作完成后，最后单独更新这些状态描述：

- 只把 Todo从 future移到已实现 module。
- 其他 future modules仍保持 non-goal。
- 不重写第一版历史记录；明确这是 Phase 4 的单 module增量。

这一步必须在功能 smoke test后做，避免文档先于行为。

## 10. Verification plan

### Focused tests

```bash
bun test packages/pi-basics/test/modules/todo/model.test.ts
bun test packages/pi-basics/test/modules/todo/state.test.ts
bun test packages/pi-basics/test/modules/todo/widget.test.ts
bun test packages/pi-basics/test/modules/todo/integration.test.ts
```

### Package regression

```bash
bun test packages/pi-basics/test
bun run typecheck
bunx biome check packages/pi-basics/src/modules/todo packages/pi-basics/test/modules/todo packages/pi-basics/src/index.ts
```

### Runtime smoke test

```bash
bun run pi:dev -- basics
```

手动场景：

1. 让模型用 `todo` create三个 task，其中 #3 blockedBy #2。
2. 将 #1设为 in_progress，再 completed；确认 prompt只在 full success后完成。
3. 确认 widget计数、排序、resolved/unresolved blocked label。
4. 执行 `/todos`，确认分组摘要。
5. 尝试 action/field mismatch、cycle及 completed -> in_progress，确认明确 error且 state不变。
6. `/reload` 后确认 branch snapshot恢复。
7. 触发 compaction/tree或切 branch，确认 defined fallback及 branch-local id语义。
8. 在 non-TUI mode确认不注册 widget。
9. 在 Loadout禁用/启用 `todo`，确认 schema/prompt/active tools同步，`/todos`仍可只读。
10. 删除 blocker，确认 dependent blockedBy被清理。
11. 人为 mutate returned details / replay branch object，确认 active state不受影响。

## 11. Acceptance criteria

- [ ] Review Gate已确认；source实现未偏离高层决策。
- [ ] `todo` tool只有四种 operation、四个 task fields；顶层只接受 non-empty `operations[]`，不注册 `hepi_todo` alias。
- [ ] mixed batch支持 delete + create，按序验证、原子 commit；省略项不删除，`list`只能单独调用。
- [ ] prompt snippet + 四条 guidelines与线上参考语义一致，覆盖使用门槛、实时状态、完成安全、batch优先。
- [ ] reducer纯函数、immutable、action/field mismatch明确拒绝；no-op明确返回 `No change`。
- [ ] DAG拒绝 missing/self/duplicate/cycle；blocker语义明确为 advisory。
- [ ] delete scrub dependencies；id只在当前 branch lineage单调且不因 delete复用。
- [ ] snapshot严格验证/deep isolation；malformed latest entry回退到更早有效 snapshot。
- [ ] branch history是唯一持久事实来源；compact/tree fallback有测试。
- [ ] Todo复用现有 `HePiLifecycleController`；runtime replacement不共享 mutable state。
- [ ] `executionMode: "sequential"`，无 custom queue或 lost-update窗口。
- [ ] execute在 reducer前检查 abort signal；aborted call不 mutation、不刷新 widget。
- [ ] `/todos` 通过 `pi.registerCommand("todos", ...)` 直接注册；不注册 `/hepi todo` alias。
- [ ] widget只在 TUI mode绑定，无输入/配置/shortcut，所有行 cell-width safe；状态使用theme颜色，全部完成两轮后只隐藏render。
- [ ] tool execute不调用 UI；`tool_execution_end` best-effort refresh failure不影响 snapshot persistence；连续5个idle turn后最多为当前turn追加一次next-task system prompt。
- [ ] Loadout发现 `tool:todo`；default active及 persisted disabled行为正确。
- [ ] 不修改 Settings/Loadout domain behavior。
- [ ] focused tests、pi-basics package tests、typecheck、Biome通过。
- [ ] 实机完成 create/update/list/delete、reload/compaction/tree、Loadout和widget smoke test。

## 12. 明确延后

只有真实需求出现后才考虑：

- description / activeForm。
- deleted tombstone / audit history。
- disk/project persistence。
- Todo full-screen panel或 shell tab。
- settings（row limit、hide completed、shortcut）。
- i18n。
- replay cache。
- custom tool call/result renderer。
- public Todo registration/storage API。
- full-list replacement `todos[]`、single-action兼容入口或 temp-id引用；只有后续出现真实跨-operation新 id依赖需求才评估。
- full hidden per-turn Todo context、stall/completion steer与domain-state auto-clear。
- RPC `details.__gui__` / `@xyz-agent/extension-protocol`。
- replay时删除旧 session entries。
