# pi-basics Todo 详细设计

> 状态：提案。高层功能边界先见 [`pi-basics-todo-high-level.md`](./pi-basics-todo-high-level.md)。本设计默认采用其中推荐项。

## 1. 目标

为 `packages/pi-basics` 增加一个真正可用、但足够小的 Todo module：

1. 模型能用结构化工具维护多步骤任务。
2. 用户能从直接 `/todos` command和 editor 上方 widget 看到同一份进度。
3. Todo 能在 reload、compaction、branch/tree 变化后，从 session history 恢复。
4. Todo state 与不同 session 隔离。
5. 不引入第二套配置、磁盘数据库、复杂 UI 或长 prompt。

## 2. 架构位置

```text
packages/pi-basics/
├── src/
│   ├── index.ts
│   └── modules/
│       └── todo/
│           ├── index.ts       # todo tool、/todos command、active runtime、compact/tree hooks
│           ├── model.ts       # domain types、reducer、DAG validation
│           ├── state.ts       # snapshot validation、deep clone、branch replay
│           └── widget.ts      # above-editor read-only widget
└── test/
    └── modules/
        └── todo/
            ├── model.test.ts
            ├── state.test.ts
            ├── widget.test.ts
            └── integration.test.ts
```

不建立通用 Todo API、controller 基类或 storage abstraction。四个 source 文件已有清楚责任，未出现第二个实现前不再拆。

## 3. pi-basics 整合边界

### 3.1 使用现有能力

- `pi.registerCommand()`：直接注册 `/todos` read-only summary。
- `pi.registerTool()`：注册 `todo`。
- `pi.on(...)`：补现有 lifecycle 未覆盖的 compact/tree refresh和持久化后的 `tool_execution_end` widget refresh。
- `ctx.ui.setWidget()`：仅在 TUI runtime 注册 `aboveEditor` widget。
- `src/ui/text.ts`：复用 `truncateToWidth()` / `visibleWidth()`。

### 3.2 不使用的能力

- `HePiSettingsState` 只允许 primitive/null，不适合 Task array；Todo 不伪装成 Settings provider。
- Shell 目前硬编码 Settings/Loadout 两个 tab；Todo 不修改 shell，也不增加第三个 tab。
- contribution API 目前只有 marker type；Todo 不扩展 editor/footer ownership。
- Loadout storage 与状态不作为 Todo state backend。

### 3.3 注册顺序

`pi-basics` extension entry先创建一个 `TodoFeature` 并注册 `todo` tool、`/todos` command、compact/tree及 `tool_execution_end` hooks一次；然后才注册现有 `HePiLifecycleController`。每次 runtime start调用 `todo.start(runtime)`，由当前 runtime拥有 Todo state和 widget cleanup。

Tool必须在 `HePiLifecycleController.onStart` 创建 Loadout inventory之前注册。这样 `createLoadoutInventory(pi)` 能发现 `tool:todo`，并由现有 Loadout active-tool计算正常启用或禁用；Todo不绕过 `setActiveTools()`。Command独立注册，不随 active tools开关移除。

```ts
const todo = createTodoFeature(pi);

const lifecycle = new HePiLifecycleController({
  onStart: async (runtime) => {
    const sessionId = runtime.ctx.sessionManager.getSessionId();
    await todo.start(runtime);
    runtime.registry.registerLifecycle({
      id: "todo",
      cleanup: () => todo.dispose(sessionId),
    });
    // existing Settings / Loadout setup
  },
});
```

`TodoFeature` 是 extension instance object，但只持有当前 active runtime state；不建立第二套 `session_start` / `session_shutdown` owner，也不把 domain state放入 registry。Cleanup closure在 context 仍新鲜时捕获 session id，`dispose()` idempotent。

## 4. Domain model

```ts
export type TaskStatus = "pending" | "in_progress" | "completed";
export type TodoAction = "create" | "update" | "list" | "delete";

export interface Task {
  readonly id: number;
  readonly subject: string;
  readonly status: TaskStatus;
  readonly blockedBy: readonly number[];
}

export interface TaskState {
  readonly tasks: readonly Task[];
  readonly nextId: number;
}

export function freshTaskState(): TaskState {
  return { tasks: [], nextId: 1 };
}
```

### 设计理由

- `id`：正整数，在单一 branch lineage内单调递增；切到旧节点再分叉时，不同 branch可复用同一数字 id。
- `subject`：唯一的人类描述字段；减少 schema/prompt/token 成本。
- `status`：三态足够表达待办、执行、完成。
- `blockedBy`：保留参考实现最有价值的 DAG 能力；它是 advisory scheduling metadata，未完成 blocker不从结构上禁止 status update。
- 不保存 derived `blocks`、`isBlocked`、counts；读取时计算，避免 state 不一致。
- 删除是 hard delete；`nextId` 在当前 branch lineage不回退。

## 5. Tool contract

### 5.1 Identity

```ts
const TODO_TOOL_NAME = "todo";
const TODO_TOOL_LABEL = "Todo";
const TODO_COMMAND_NAME = "todos";
const TODO_WIDGET_KEY = "pi-basics:todo";
```

`TODO_TOOL_NAME` 同时是 branch replay discriminator。v1 clean cutover只注册 `todo`，不保留 `hepi_todo` alias。通用名与其他 `todo` extension不能同时注册，这是本次命名决策接受的约束；不再增加 prefix或 collision wrapper。

### 5.2 参数

```ts
type TodoOperation =
  | { action: "create"; subject: string; blockedBy?: number[] }
  | { action: "update"; id: number; subject?: string; status?: TaskStatus; blockedBy?: number[] }
  | { action: "list"; status?: TaskStatus }
  | { action: "delete"; id: number };

interface TodoParams {
  operations: TodoOperation[];
}
```

Action语义不变：

| Action | 必需字段 | 可选字段 | 结果 |
|---|---|---|---|
| `create` | `subject` | `blockedBy` | 建立 pending task |
| `update` | `id` + 至少一个 mutable field | `subject/status/blockedBy` | 替换传入字段 |
| `list` | 无 | `status` | 列出全部或单一状态；必须是唯一 operation |
| `delete` | `id` | 无 | 移除 task 并清理依赖 |

`operations` 至少一项，按数组顺序作用于同一个 draft。Reducer对整批输入完成 action/field、id、transition与DAG验证后才返回可 commit state；任一 operation失败，整批 state保持原引用或 deep-equal unchanged。省略 task是 no-op，不采用 OpenCode / legacy Claude TodoWrite 的 full-list replacement omission-as-delete。

`blockedBy` 在 `update` 是完整替换，不提供 `addBlockedBy` / `removeBlockedBy`。清空依赖传 `[]`。每个 nested operation仍使用 flat provider-safe字段；reducer拒绝不属于该 action的字段，不静默忽略。

### 5.3 Schema

`packages/pi-basics/package.json` 增加 runtime dependency：

```json
{
  "dependencies": {
    "typebox": "^1.1.38"
  }
}
```

Schema 使用 `Type.String({ enum: [...] })`，不使用 literal union 生成的 `anyOf/const`；`pi-xtodo` 已记录某些 provider 会丢失 optional `anyOf` 字段。

```ts
const TodoOperationSchema = Type.Object(
  {
    action: Type.String({ enum: ["create", "update", "list", "delete"] }),
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    subject: Type.Optional(Type.String({ minLength: 1 })),
    status: Type.Optional(Type.String({ enum: ["pending", "in_progress", "completed"] })),
    blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
  },
  { additionalProperties: false },
);

const TodoParamsSchema = Type.Object(
  {
    operations: Type.Array(TodoOperationSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
```

### 5.4 Argument normalization

保留 `pi-xtodo` 的一个实用兼容点：模型可能把 id 输出成字符串。`prepareArguments` 只接受普通十进制正整数：

- 接受：`1`、`"1"`。
- 拒绝：`0`、`-1`、`2.7`、`"2.7"`、`"1e2"`、空字符串。
- 同样规则应用到 `blockedBy`。

Normalization 只做形状兼容，不修正错误语义。

## 6. Reducer contract

```ts
interface TodoOperationResult {
  readonly index: number;
  readonly action: TodoAction;
  readonly changed: boolean;
  readonly id?: number;
}

type ApplyTodoResult =
  | {
      readonly ok: true;
      readonly state: TaskState;
      readonly operations: readonly TodoOperationResult[];
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly state: TaskState;
      readonly error: string;
      readonly operationIndex?: number;
    };

function applyTodo(state: TaskState, params: TodoParams): ApplyTodoResult;
```

纯 reducer不读 session、UI、filesystem，也不格式化 Pi tool result。它按顺序把 operations应用到内部 draft，但外部只观察原子结果：全部成功才返回新 state；任一失败则返回 unchanged state与带 operation index的错误。`list`只能单独出现。Action/field mismatch一律拒绝，不允许 silent ignore。

### 6.1 Create

1. `subject.trim()` 不得为空。
2. `blockedBy` 中每个 id 必须存在。
3. 不允许重复 dependency id。
4. 创建 `{ id: nextId, status: "pending" }`。
5. `nextId + 1`。

Create 只能引用既有 task；在既有 state 已通过 invariant 的前提下，新 task只指向旧 id，不可能形成 cycle，因此不额外扫描全图。完整图 validation只用于 snapshot import和 update。

### 6.2 Update

1. `id` 必须存在。
2. 至少传入 `subject/status/blockedBy` 之一。
3. `subject` 提供时，trim 后不得为空。
4. 状态转换必须合法。
5. `blockedBy` 提供时：
   - 正整数且无重复；
   - 不含自身；
   - 每个 dependency存在；
   - 替换后整张图无 cycle。
6. 与当前 task完全相同则 `changed: false`，state可复用原引用。

Tool response formatter必须在 `changed: false` 时输出稳定的 `No change: #<id> already matches the requested values`，不能伪装成 `Updated`。这样模型能区分真实 mutation 与重复调用，避免再次发送相同 update。

### 6.3 Status 与 blocker 语义

| From | To | 允许 |
|---|---|---:|
| pending | pending | ✓ no-op |
| pending | in_progress | ✓ |
| pending | completed | ✓ |
| in_progress | pending | ✓ |
| in_progress | in_progress | ✓ no-op |
| in_progress | completed | ✓ |
| completed | completed | ✓ no-op |
| completed | pending/in_progress | ✗ |

`blockedBy` 是 advisory scheduling metadata：renderer把未完成 dependency显示为 blocked；reducer不因 blocker未完成而拒绝 `in_progress` / `completed`。Prompt仍要求 blocked task不得标 completed，避免 partial/failing work被误报完成。

不强制“一次只能有一个 in_progress”；这是 prompt使用策略。未来若真实使用证明必须强制，再单独增加 invariant。

### 6.4 Delete

1. `id` 必须存在。
2. 从 `tasks` 移除目标。
3. 从所有其他 task 的 `blockedBy` 移除该 id。
4. `nextId` 不变。

删除不存在 id返回 error，不静默成功。

### 6.5 List

- 不改变 state。
- 无 filter时按 task id升序输出。
- `status` 只影响 textual response，不影响 snapshot。
- blocked 信息格式保持紧凑：`blocked by #1,#2`。

## 7. Snapshot 与 replay

### 7.1 Durable details shape

```ts
interface TodoSnapshot {
  readonly tasks: readonly Task[];
  readonly nextId: number;
}

interface TodoToolDetails {
  readonly snapshot: TodoSnapshot;
}
```

每次成功 invocation都返回当前完整 snapshot，包括 `list`和全 no-op batch。Reducer、schema或 abort失败由 execute抛出，不返回 tool result，也不写入可能覆盖历史的 snapshot。

不保存 raw params、action 或 derived counts：tool call本身已有参数，snapshot只承担恢复职责。State -> details和 details -> state都必须 deep-clone task及每个 `blockedBy` array，防止 tool-result middleware或branch object mutation回写 store。

### 7.2 Replay algorithm

```text
latest = undefined
for entry in current branch, chronological:
  if entry is message/toolResult
  and toolName === "todo"
  and details.snapshot has the valid TodoSnapshot shape:
    latest = deep-cloned snapshot
return latest
```

Replay decoder返回 `TaskState | undefined`，保留“branch没有 Todo snapshot”和“snapshot明确表示空 tasks”的差异。调用事件决定 fallback：runtime start / tree无 snapshot使用 fresh state；compact无 snapshot保留当前 live state。

Snapshot validation至少检查：

- `tasks` 是 array。
- `nextId` 是正整数。
- 每个 task有正整数 id、trim后非空 subject、合法 status、integer且无重复的 `blockedBy` array。
- task id唯一；dependency存在；图无 cycle。
- `nextId > max(task.id)`；empty tasks时 `nextId >= 1`。

Malformed snapshot可跳过并继续寻找更早的有效 snapshot。若整个 branch没有 snapshot，返回 `undefined`。不预建 version/migration系统；真实 schema变更出现时再定义新 discriminator或迁移。

### 7.3 事实来源

Branch snapshot是唯一事实来源。明确不做 disk fallback：

- 避免 branch与磁盘冲突时定义优先级。
- 避免同步 filesystem I/O、path sanitization、corrupt file recovery。
- 避免跨 branch意外恢复旧 task。

如果未来出现“新 session没有 branch history，但必须恢复 Todo”的真实需求，再设计独立 project/session storage contract；不复用 Settings primitive state。

## 8. Active runtime state

```ts
interface ActiveTodoRuntime {
  readonly sessionId: string;
  state: TaskState;
  widget?: TodoWidget;
}

class TodoFeature {
  #active?: ActiveTodoRuntime;

  start(runtime: HePiRuntimeContext): void;
  getState(sessionId: string): TaskState | undefined;
  commit(sessionId: string, state: TaskState): void;
  refreshFromBranch(kind: "compact" | "tree", ctx: ExtensionContext): void;
  dispose(sessionId: string): void;
}
```

约束：

- 只保存当前 `HePiLifecycleController` active runtime；不建立独立 per-session owner或 Map。
- `start()` 先从 branch加载 latest snapshot或 fresh state，再在 `ctx.mode === "tui"` 时创建 widget。
- Tool execute 的 ctx session id必须等于 active session id；不匹配时 fail closed，绝不读取另一 session state。
- `commit()` 保存 deep-cloned/readonly state。
- runtime replacement先由现有 lifecycle cleanup旧 Todo，再 start新 Todo；新 branch从自己的 snapshot恢复。
- `dispose(sessionId)` 只有 id匹配 active runtime时生效，且重复调用安全。

## 9. Tool result

成功：

```ts
{
  content: [{ type: "text", text: "Created #3: Add replay tests" }],
  details: { snapshot }
}
```

No-op update：

```ts
{
  content: [{ type: "text", text: "No change: #3 already matches the requested values" }],
  details: { snapshot: unchangedSnapshot }
}
```

失败：

```text
throw new Error("Operation #2: #9 not found")
```

失败永远不 commit新 state，也不返回 durable snapshot；Pi host负责记录失败。这样 latest successful snapshot不会被失败调用覆盖。No-op不 commit新 state，但属于成功调用，仍返回当前 deep-cloned snapshot。Tool开始执行时若 `signal?.aborted`，在读取/修改 active state前直接抛出 `Todo call aborted`。

不实现 custom `renderCall` / `renderResult`；先使用 Pi 默认 tool rendering。若实机可读性不足，再以独立 UI task 添加。

## 10. Prompt design

```ts
const TODO_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
const TODO_PROMPT_GUIDELINES = [
  "Use `todo` for complex work with 3+ distinct steps, when the user provides multiple tasks, or after new instructions. Skip single trivial or purely conversational requests.",
  "Mark a task `in_progress` before beginning work and `completed` immediately when done; keep exactly one task `in_progress` while work remains, and do not delay completions to batch them.",
  "Never mark a task `completed` when work is partial, failing, or blocked; keep it `in_progress` and add a task for the blocker.",
  "When several task changes are already known, submit them together in one `operations` batch to reduce tool calls; never infer deletion from omitted tasks.",
];
```

Tool description：`Create and maintain a structured task list for the current coding session. Submit ordered create, update, or delete operations atomically; list must be the only operation when used.`

前3条语义直接交叉采用 OpenCode / Claude TodoWrite 的使用门槛、exactly-one-in-progress、立即完成与失败安全；第4条采用 `@zhushanwen/pi-todo` 的“批量优先、减少工具调用”语义，并加入显式 operation边界，避免 full-list replacement误删。

## 11. `/todos` command

```ts
pi.registerCommand(TODO_COMMAND_NAME, {
  description: "Show current todos",
  handler: async (args, ctx) => { ... },
});
```

Command直接注册，不经过 `HePiModule`、`HePiRegistry` 或 `/hepi` dispatcher。行为：

- 非 interactive context：通知 `/todos requires interactive mode`。
- 非空 args：通知 `Usage: /todos`。
- 无 task：通知 `No todos yet.`。
- 有 task：按 `in_progress`、`pending`、`completed` 分组。
- 每行显示 `glyph #id subject`；有未完成 dependency时追加 `blocked by #...`。
- 使用 `ctx.ui.notify(lines.join("\n"), "info")`，不创建 full-screen panel。
- Loadout禁用 `todo` tool时，command仍可只读当前 active branch state。

## 12. Widget

### 12.1 Ownership

`TodoWidget` 只拥有 UI registration state：

```ts
class TodoWidget {
  setContext(ui: ExtensionUIContext, sessionId: string): void;
  update(state: TaskState): void;
  dispose(): void;
}
```

它不拥有 domain state，不读 branch，不执行 mutation。

### 12.2 Layout

```text
● Todos 2/5
├─ ◐ #3 Implement reducer
├─ ○ #4 Add replay tests  blocked by #3
└─ ○ #5 Smoke test
```

规则：

- 第一行：`completed/total`。
- task 行只显示 `in_progress` 和 `pending`；顺序为 in_progress，再 pending，再 id。
- 固定最多 6 个 task 行；超出追加 `└─ +N more`。
- 所有行用 `truncateToWidth(..., width, "...")`。
- 无 task：卸载 widget。
- 全部 completed：先显示一行 success-colored `✓ Todos N/N`；随后两个未调用todo的完整agent turn结束后卸载widget，但不清task、不重置id。
- status颜色：pending glyph用 muted，in_progress glyph与blocker用 warning，id与active heading用 accent，completed heading用 success，tree/overflow chrome用 dim。
- widget 无 `handleInput`、shortcut、scroll、collapse。

### 12.3 Runtime ownership

Widget ownership来自现有 active `HePiRuntimeContext`，不自行选择“第一个有 UI 的 session”。`TodoFeature.start(runtime)` 仅在 `runtime.ctx.mode === "tui"` 时绑定 widget；RPC/JSON/print即使 `hasUI` 为 true也不注册 editor widget。Lifecycle cleanup调用 idempotent `dispose()`。

## 13. Lifecycle

| 入口 | 行为 |
|---|---|
| existing runtime `onStart` | latest snapshot或 fresh state成为 active Todo；TUI mode绑定 widget；注册 cleanup |
| `session_compact` hook | 事件 sid匹配active runtime时：有snapshot则replay，无snapshot保留live state；保留idle reminder streak与render-hidden状态，避免compact重触发reminder或重现已隐藏widget |
| `session_tree` hook | 事件 sid匹配 active runtime时：latest snapshot或 fresh state替换当前 branch state；刷新 widget |
| tool `execute` success | 原子 commit、构建并返回 snapshot；不调用 UI |
| `tool_execution_end` hook | 成功的 `todo` execute已返回后，best-effort从 active state刷新 widget；handler捕获 UI failure，不改变 tool outcome/state |
| `before_agent_start` hook | tool仍active、存在未完成task、且连续5个完整agent turn没有成功todo调用时，只为当前turn追加一次最小next-task system prompt；同一idle streak不重复、不写session message |
| `agent_start` / `agent_end` hooks | 追踪本轮是否成功调用todo；未完成状态累计idle turn，全部完成状态累计render-hide turn；只修改ephemeral UI/reminder计数 |
| registry cleanup | `dispose(capturedSessionId)`；清 state并在 `try/finally` 中卸载 widget/释放 active runtime |

不增加 replay cache。Todo 列表通常很小，session events频率低；只有 profiling证明 replay成本显著时才加入。

参考实现已记录 auto-compaction 可能在 runner replacement 时留下 stale context。实现窄 `isStaleSessionContextError()`，只匹配 `stale after session replacement`；compact/tree遇到它时保留现状并返回，其他错误继续抛出。Start/shutdown由现有 pi-basics lifecycle拥有，cleanup closure使用预先捕获的 session id，不在 teardown时读取 stale ctx。

Widget是非关键派生视图。`tool_execution_end` refresh必须捕获 UI registration/render failure、清掉失效 registration并等待下次 runtime/widget bind；不得让 UI failure改变已返回的 tool result或 active state。

## 14. Concurrency 与 mutation ordering

`todo` 明确设置 `executionMode: "sequential"`。每次 invocation执行：

1. 若 `signal?.aborted`，立即退出，不读取或修改 active state。
2. 确认 ctx session id等于 active runtime id。
3. 读取 current state。
4. reducer同步计算 next state，中间没有 `await`。
5. 成功且 `changed !== false` 才 commit。
6. deep-clone snapshot并构建 result。

不增加 custom queue；Pi现有 sequential tool contract已提供所需 serialization。若未来加磁盘/remote storage，再在 storage boundary设计异步排序。

## 15. 错误契约

建议稳定消息：

- `subject required for create`
- `subject cannot be empty`
- `id required for update`
- `id required for delete`
- `#<id> not found`
- `update requires subject, status, or blockedBy`
- `illegal transition completed -> <status>`
- `blockedBy contains duplicate #<id>`
- `cannot block #<id> on itself`
- `blockedBy: #<id> not found`
- `blockedBy would create a cycle`
- `field <name> is not allowed for action <action>`
- `Todo runtime is not active for this session`

错误不泄漏 stack，不自动猜测替代 id，不静默删除未知 dependency。

## 16. 测试契约

### `model.test.ts`

- create trim、branch-lineage monotonic id、immutable input。
- action/field legality matrix。
- update status-only、subject-only、blockedBy full replacement。
- legal/illegal transitions、no-op、advisory blocker rule。
- no-op update复用原 state，并由 response formatter明确输出 `No change`。
- missing/self/duplicate/cyclic dependencies。
- hard delete + dependent scrub。
- failed mutation preserves exact state。

### `state.test.ts`

- latest valid malformed-safe snapshot wins。
- invalid DAG/id/duplicate blockedBy/nextId snapshot rejected。
- empty history与有效 empty snapshot可区分。
- state -> details及 details -> state均 deep isolate；后续 mutation不影响 active state。
- runtime replacement从各自 branch恢复，不共享 mutable state。
- compact无 snapshot保留 live；tree无 snapshot切 fresh。

### `widget.test.ts`

- non-TUI runtime不注册 widget。
- empty unmount。
- pending/in-progress ordering。
- completed count、resolved blocker display和 all-complete header。
- six-row budget及 `+N more`。
- narrow width不溢出 terminal cells。
- UI context invalidate后安全重注册。
- dispose失败/重复调用仍释放 owner。

### `integration.test.ts`

- registers exactly one `todo` tool and direct `/todos` command。
- does not register `hepi_todo` or `/hepi todo` aliases。
- prompt guidance恰好四条并包含使用门槛、实时状态、完成安全、batch优先语义。
- enum schema uses `type + enum`、`additionalProperties:false`。
- numeric-string id normalization及 invalid id rejection。
- `executionMode: "sequential"`。
- execute success/error envelope及 deep snapshot。
- aborted execute在 reducer前退出，state与 transcript snapshot均不产生 mutation。
- branch snapshot replay与active-runtime isolation。
- delete时清理 dependent `blockedBy`。
- `/todos` interactive/usage/empty/grouped output；tool disabled时仍可只读查看 existing state。

## 17. Reference lessons

### 从 OpenCode / Claude TodoWrite 保留

- OpenCode / legacy Claude TodoWrite展示一次调用提交整个 todo集合的既有 contract；它们不提供 mixed operation schema，也不作为“减少调用”宣称的来源。
- 提示词采用线上共同规则：3+ steps / multiple tasks时主动使用；单一简单或纯资讯请求跳过；开始前设 `in_progress`；完成后立即更新；失败、partial、blocked时不得标 completed。
- 不复制 full-list replacement；pi-basics保留 stable id与blockedBy，因此改用显式 ordered operations，省略项不产生删除。

来源：[`OpenCode todo.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/todo.ts)、[`OpenCode todowrite.txt`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/todowrite.txt)、[Claude Code Todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md) 及非官方镜像 [`TodoWrite prompt`](https://github.com/leaf-kit/claude-analysis/blob/main/src/tools/TodoWriteTool/prompt.ts)。

### 从 `pi-xtodo` 保留

- `type + enum` schema，避免 optional literal union provider compatibility问题。
- strict positive integer normalization。
- pure mutation logic及 DAG validation。
- branch snapshot replay。
- delete时清理 dependent `blockedBy`。
- above-editor widget lifecycle。

来源：[`pi-xtodo/index.ts`](https://github.com/x4cc3/pi-xpi/blob/main/packages/pi-xtodo/index.ts)、[`todo.test.ts`](https://github.com/x4cc3/pi-xpi/blob/main/packages/pi-xtodo/test/todo.test.ts)、[`README.md`](https://github.com/x4cc3/pi-xpi/blob/main/packages/pi-xtodo/README.md)。

### 从 `rpiv-todo` 保留

- reducer / state / replay / view分层。
- tool-result details是持久恢复 contract。
- latest-valid-snapshot-wins。
- 借鉴 session isolation意图，但复用 pi-basics现有 active-runtime owner，不复制独立 foreground owner。
- module state不放 registry。
- no-op update明确报告 `No change`，避免模型把重复调用误判为成功 mutation。

来源：[`docs/rpiv-todo-design.md`](./rpiv-todo-design.md) 及 [`references/rpiv-mono/packages/rpiv-todo/`](../references/rpiv-mono/packages/rpiv-todo/)。

### 从 `@zhushanwen/pi-todo` 保留

- extension factory closure隔离 mutable runtime；在 pi-basics 中由现有 `TodoFeature` active-runtime owner提供同等边界。
- `executionMode: "sequential"`，mutation前先完整验证。
- `texts[]` / `ids[]` / `updates[]` 及其“批量优先、减少工具调用”guideline明确支持 batch需求；pi-basics扩展为本地 mixed ordered operations设计。
- execute开始时尊重已 aborted signal，确保 cancellation不留下半完成 state。

来源：[`@zhushanwen/pi-todo@0.4.0`](https://www.npmjs.com/package/@zhushanwen/pi-todo/v/0.4.0) 及 [`extensions/todo`](https://github.com/zhushanwen321/xyz-pi-extensions/tree/cb7a3c86da2fdcd97f4e38ed8ea62603b5cf1a8e/extensions/todo)。

### 明确不复制

不复制 disk fallback、tombstone/`cancelled`、verification task、metadata、owner、activeForm、config、i18n、rich tool/RPC renderer、full hidden per-turn context、stall/completion steer、domain-state auto-clear、session-entry GC和 replay cache。保留的reminder只在5个完整idle turn后为当前turn追加一次next task system prompt，不持久化session message；completed auto-hide只卸载widget，不修改task snapshot或nextId。也不采用 full-list replacement；mixed batch必须显式列出每个 operation并整批原子 commit。
