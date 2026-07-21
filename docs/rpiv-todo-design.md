# rpiv-todo 设计摘要

## 定位与边界

`@juicesharp/rpiv-todo` 是 Pi extension：注册 `todo` 工具、`/todos` 命令，以及挂在编辑器上方的持久 TodoOverlay。README 明确其目标是让模型在长会话中维护任务；状态通过会话分支中的工具结果重放，跨 `/reload` 与 conversation compaction，而不是写入独立磁盘数据库。[README](../references/rpiv-mono/packages/rpiv-todo/README.md#L11-L21)

包入口为 [`index.ts`](../references/rpiv-mono/packages/rpiv-todo/index.ts)，npm `pi.extensions` 指向 `./index.ts`；发布清单显式包含配置、入口、状态、工具和视图模块。[package.json](../references/rpiv-mono/packages/rpiv-todo/package.json#L29-L52) 运行时依赖 `@juicesharp/rpiv-config` 与 `typebox`；Pi AI、coding-agent、TUI 为 peer，`@juicesharp/rpiv-i18n` 为可选 peer。[package.json](../references/rpiv-mono/packages/rpiv-todo/package.json#L54-L68)

边界：包只负责 Todo 领域模型、状态变换、分支快照恢复和 Pi UI 接线；不负责会话持久化基础设施、任务执行、网络存储或外部任务系统同步。

## 公共 API 与模型

### 工具、命令与入口

入口初始化时注册：

- `todo` 工具：[`registerTodoTool`](../references/rpiv-mono/packages/rpiv-todo/todo.ts#L66-L99)。
- `/todos` slash command：[`registerTodosCommand`](../references/rpiv-mono/packages/rpiv-todo/todo.ts#L105-L144)。
- 默认导出 extension：[`index.ts`](../references/rpiv-mono/packages/rpiv-todo/index.ts#L63-L87)。

`todo` 的 action 是 `create | update | list | get | delete | clear`；参数由 TypeBox schema 声明，主要字段包括 `subject`、`description`、`activeForm`、`status`、`blockedBy`、`addBlockedBy`、`removeBlockedBy`、`owner`、`metadata`、`id`、`includeDeleted`。[类型与 schema](../references/rpiv-mono/packages/rpiv-todo/tool/types.ts#L23-L128)

核心类型：

- `TaskStatus`：`pending`、`in_progress`、`completed`、`deleted`。
- `Task`：数字 `id`、`subject`、状态，以及可选描述、进行中标签、依赖、owner、metadata。
- `TaskState`：`{ tasks: Task[]; nextId: number }`，无派生缓存。[模型](../references/rpiv-mono/packages/rpiv-todo/tool/types.ts#L26-L39) [状态](../references/rpiv-mono/packages/rpiv-todo/state/state.ts#L3-L18)
- `TaskDetails`：每次工具结果中的持久快照，含 `action`、原始 `params`、完整 `tasks`、`nextId`，错误时附 `error`。[类型](../references/rpiv-mono/packages/rpiv-todo/tool/types.ts#L41-L53)

`todo.ts` 继续从旧路径重导出 `Task`/action/status、`applyTaskMutation`、状态访问器、依赖图函数等，保持 overlay、入口和测试的既有导入面。[兼容重导出](../references/rpiv-mono/packages/rpiv-todo/todo.ts#L39-L49)

### 工具结果

执行路径是：按调用 session id 读取状态 → 纯 reducer 计算 → 将新状态提交到 session store → 构造 `{ content: [{type: "text", text}], details }`。[注册执行](../references/rpiv-mono/packages/rpiv-todo/todo.ts#L77-L81) `details` 是 replay 的唯一快照格式；文本按 action 输出人类/LLM 可读摘要。[response envelope](../references/rpiv-mono/packages/rpiv-todo/tool/response-envelope.ts#L37-L97)

`list` 默认隐藏 deleted，可按一个 status 过滤；`get` 输出描述、activeForm、blockedBy、反向 `blocks` 和 owner；错误同时以 `Error: ...` 文本及 `details.error` 表示。[response envelope](../references/rpiv-mono/packages/rpiv-todo/tool/response-envelope.ts#L11-L35) [response envelope](../references/rpiv-mono/packages/rpiv-todo/tool/response-envelope.ts#L43-L97)

## 状态变换与持久化

### Reducer 规则

[`applyTaskMutation`](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L67-L227) 是纯函数，返回新 `TaskState` 与封闭的 `Op` union；提交由 store/调用方负责。创建要求非空（trim 后）subject，id 使用 `nextId`，初始状态固定为 `pending`；依赖必须存在且不能指向 deleted 任务。[create](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L78-L107)

更新要求存在 `id` 且至少有一个可变字段。状态转换允许：`pending ↔ in_progress`、两者到 `completed`、任意状态到 `deleted`；`completed` 不能回到 active，`deleted` 终态。相同状态允许调用，但若最终字段完全相同，结果标记 `changed: false`，文本为 `No change`。[转换表](../references/rpiv-mono/packages/rpiv-todo/state/invariants.ts#L3-L20) [update](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L109-L183)

依赖更新支持先移除再 additive 添加；拒绝自依赖、未知/ deleted 依赖和会形成环的图。metadata 是逐键 merge，值为 `null` 删除键，空对象最终省略该字段；`blockedBy` 为空时也省略。[update](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L134-L170) [图算法](../references/rpiv-mono/packages/rpiv-todo/state/task-graph.ts#L3-L40)

`delete` 不移除数组元素，而把任务改为 deleted tombstone；重复删除报错。`clear` 清空任务并把 `nextId` 重置为 1。[delete/clear](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L204-L225) 因此历史 `blockedBy` 数字引用仍可在快照中解析；README 也将 tombstone 定义为审计用途。[README](../references/rpiv-mono/packages/rpiv-todo/README.md#L79-L80)

### Session store 与 replay

store 以 `Map<sid, TaskState>` 分区；`getState`/`commitState` 面向调用 session，overlay 和无 session 上下文的 render hook 通过 `activeRenderSession` 指针读取前景 slot。缺省 slot 返回新的空状态副本，避免共享数组别名。[store](../references/rpiv-mono/packages/rpiv-todo/state/store.ts#L4-L59) [store](../references/rpiv-mono/packages/rpiv-todo/state/store.ts#L62-L115)

[`replayFromBranch`](../references/rpiv-mono/packages/rpiv-todo/state/replay.ts#L15-L38) 按当前 branch 时间顺序扫描 `message/toolResult`，只接受 `toolName === "todo"` 且满足 `tasks[]`、数字 `nextId` 的 `details`；最后一个快照胜出（last-write-wins），任务浅克隆。无有效快照或损坏条目时跳过并返回新空状态。

生命周期：`session_start` 为每个 session 重放并写入自身 slot；第一个有 UI 的 session 取得前景 overlay，子 session 不得重绑它。`session_compact`/`session_tree` 重放对应 slot，只有前景 session 刷新 overlay；已知 stale context 错误保留现状，其他 replay 错误继续抛出。shutdown 总是淘汰自身 slot，前景 shutdown 通过 `try/finally` 释放 overlay 和 render pointer。[生命周期](../references/rpiv-mono/packages/rpiv-todo/index.ts#L89-L174)

这意味着“持久化”实际依赖 Pi branch 中此前的 `todo` toolResult；清空或分支切换后的有效最后快照决定当前状态，不存在额外跨分支全局任务库。[INFERENCE] 该结论直接由 `TaskDetails` 与 replay 的读取范围得出。

## UI 与扩展集成

### Overlay

`TodoOverlay` 使用 Pi `setWidget` 的 `aboveEditor` placement，widget key 固定为 `rpiv-todos`。无可显示任务时卸载 widget；首次显示注册 factory，后续调用 TUI `requestRender()`。[overlay 生命周期](../references/rpiv-mono/packages/rpiv-todo/todo-overlay.ts#L31-L83)

显示任务排除 deleted。完成项在完成后继续显示，下一次 `agent_start` 才被加入隐藏集合；session replay/reset 或 `nextId` 回退会清除这段显示记忆。[overlay 显示记忆](../references/rpiv-mono/packages/rpiv-todo/todo-overlay.ts#L85-L127) [入口事件](../references/rpiv-mono/packages/rpiv-todo/index.ts#L176-L185)

标题显示 `Todos (completed/total)`；有 pending/in_progress 时用 active 图标。布局预算由 `maxWidgetLines - 1` 传入：超限先隐藏 completed，再截断非 completed 尾部，并追加 `+N more` 汇总；最后固定追加一个空行与编辑器隔开。[overlay 渲染](../references/rpiv-mono/packages/rpiv-todo/todo-overlay.ts#L138-L220) [布局选择器](../references/rpiv-mono/packages/rpiv-todo/state/selectors.ts#L63-L97)

折叠状态只显示标题和展开提示。入口在 extension 初始化时读取并注册一次 collapse shortcut；`collapseKey: "off"` 不注册，配置改变后需 `/reload` 才重新绑定，但折叠提示文本每次 render 重新解析配置。[入口快捷键](../references/rpiv-mono/packages/rpiv-todo/index.ts#L70-L87) [折叠渲染](../references/rpiv-mono/packages/rpiv-todo/todo-overlay.ts#L154-L169)

### `/todos` 与渲染钩子

`/todos` 要求 interactive UI；无 UI 时 error notify，无可见任务时 info notify。否则按 pending、in_progress、completed 分组，并在标题显示完成/总数、进行中数、待办数。[命令](../references/rpiv-mono/packages/rpiv-todo/todo.ts#L105-L141)

工具 `renderCall` 使用前景 render slot（其上下文没有 session identity）；找不到对应 id 时保守地显示 `#id`，避免跨 session id 重复导致错误 subject。`renderResult` 仅依据结果 details 格式化。[render hooks](../references/rpiv-mono/packages/rpiv-todo/todo.ts#L83-L97) 具体 glyph、颜色和文本位于 [`view/format.ts`](../references/rpiv-mono/packages/rpiv-todo/view/format.ts#L12-L162)。

### 配置与本地化

配置通过 `loadJsonConfigWithLegacyFallback("rpiv-todo")` 读取。`maxWidgetLines` 每次 render 读取，非数字或小于 3 回退 12；`collapseKey` 校验 pi-tui grammar，缺失/空白/非法回退 `ctrl+shift+t`，`off` 禁用。[配置](../references/rpiv-mono/packages/rpiv-todo/config.ts#L4-L42) [快捷键解析](../references/rpiv-mono/packages/rpiv-todo/config.ts#L68-L101)

LLM guidance 可由 `guidance.promptSnippet` 与 `promptGuidelines` 覆盖，字段经 `validateGuidanceFields` 校验；默认指导模型使用 3+ 步复杂工作、及时更新状态、避免失败时误标 completed。[注册与默认 guidance](../references/rpiv-mono/packages/rpiv-todo/todo.ts#L55-L75)

i18n 是软可选集成：入口动态加载 `@juicesharp/rpiv-i18n/loader` 并注册包内 locales；缺少 SDK 时捕获异常，桥接函数使用内联英文 fallback，扩展仍可加载。[入口加载](../references/rpiv-mono/packages/rpiv-todo/index.ts#L1-L53) README 规定仅 TUI chrome（overlay 标题、命令分组标题、状态词）本地化，LLM-facing response、reducer 错误和 schema 描述保持英文。[README](../references/rpiv-mono/packages/rpiv-todo/README.md#L147-L151)

## 错误与边界语义

- 创建、更新、查询、删除缺少必需参数或找不到 id：返回 error `Op`，状态不变。[reducer](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L78-L124) [reducer](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L197-L217)
- 非法状态转换、依赖悬空/deleted、自依赖、环：拒绝 mutation，错误在 envelope 中可见。[reducer](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.ts#L126-L149)
- deleted 是可查询的历史对象，但默认不出现在 list、`/todos`、overlay；`includeDeleted: true` 只影响 list。[selectors](../references/rpiv-mono/packages/rpiv-todo/state/selectors.ts#L4-L7) [response envelope](../references/rpiv-mono/packages/rpiv-todo/tool/response-envelope.ts#L62-L66)
- `tool_execution_end` 只在成功的 todo 调用后刷新 overlay；读取 live store，而不在该事件中重放 branch，因为 branch 更新时序可能尚未包含当前结果。[入口事件](../references/rpiv-mono/packages/rpiv-todo/index.ts#L176-L181)
- UI context 变化（例如 reload）会使 widget registration 失效，下一次 update 重新注册；dispose 清 widget、清引用并重置折叠/完成显示记忆。[overlay](../references/rpiv-mono/packages/rpiv-todo/todo-overlay.ts#L40-L48) [overlay](../references/rpiv-mono/packages/rpiv-todo/todo-overlay.ts#L222-L229)

## 测试覆盖与维护线索

测试直接刻画了 observable contract：工具注册/schema/execute/render hooks（[`todo.register.test.ts`](../references/rpiv-mono/packages/rpiv-todo/todo.register.test.ts)）、`/todos` 的 interactive guard、空列表和分组输出（[`todo.command.test.ts`](../references/rpiv-mono/packages/rpiv-todo/todo.command.test.ts)）、状态 reducer 的参数校验、转换、依赖环、metadata merge/no-op（[`state/state-reducer.test.ts`](../references/rpiv-mono/packages/rpiv-todo/state/state-reducer.test.ts)）、分支重放的 last-write-wins 与损坏快照跳过（[`state/replay.test.ts`](../references/rpiv-mono/packages/rpiv-todo/state/replay.test.ts)）、session 隔离及前景 overlay 所有权（[`todo.session-isolation.test.ts`](../references/rpiv-mono/packages/rpiv-todo/todo.session-isolation.test.ts)）、stale context 行为（[`todo.invalidation.test.ts`](../references/rpiv-mono/packages/rpiv-todo/todo.invalidation.test.ts)）。overlay 快捷键、生命周期、渲染与配置另有专门测试文件，包清单测试保证生产模块都纳入 npm tarball。[测试目录](../references/rpiv-mono/packages/rpiv-todo/)

维护时应优先保持三项稳定契约：工具名 `todo`（同时是 replay discriminator）、widget key `rpiv-todos`、`TaskDetails` 字段形状；入口注释明确这些名称用于旧 session history replay 兼容。[入口兼容说明](../references/rpiv-mono/packages/rpiv-todo/index.ts#L17-L19) [类型兼容说明](../references/rpiv-mono/packages/rpiv-todo/tool/types.ts#L41-L45)
