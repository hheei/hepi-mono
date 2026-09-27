# 异步任务管控工具按需动态注入设计方案

## 1. 背景与用户可见目标

### 1.1 背景与现状

在引入统一异步任务编排能力后，`pi-ext-tools` 向模型暴露了三个任务管控工具：
- `list_tasks`：查看当前会话启动的后台任务（支持 `includeTerminal`）。
- `wait_tasks`：阻塞等待一个或多个后台任务直至完成并提取结果。
- `stop_tasks`：终止一个或多个正在运行的后台任务。

当前这三个工具在会话启动时默认处于激活状态（`defaultActive: true`），作为基础工具常驻在模型的工具目录中。
然而，在日常开发任务中（如阅读代码、单文件编辑、前台执行快速测试与格式检查），模型绝大多数轮次都不需要后台任务能力。常驻存在带来了以下问题：
1. **基础 Prompt 噪音与 Token 浪费**：模型每轮推理的 API 请求中都携带了这 3 个工具完整的 JSON Schema 定义、说明与 `promptGuidelines`。（数量级需在实现后实测校正；三个工具的 schema 本身较小，粗估约 250~350 tokens，不应沿用未经测量的更大数字。）
2. **提前试探与幻觉调用**：在尚未启动任何后台任务时，部分模型可能在规划初期盲目调用 `list_tasks` 或尝试对不存在的任务发起 `wait_tasks`。
3. **Prompt 关注点发散**：基础系统提示词的 `<tools>` 块被任务工具占据视觉权重，稀释了对核心编辑与检索工具的注意力。

### 1.2 用户可见目标

1. **默认状态零污染**：会话启动后，在未产生任何后台任务前，`list_tasks`、`wait_tasks`、`stop_tasks` **完全不对模型暴露**。模型的 `<tools>` 块及 API Payload 中只保留常规前台工具。
   - **Host 事实（已核对 pi-coding-agent 0.87.0）**：`AgentSession._buildRuntime()` 以 `includeAllExtensionTools: true` 调用 `_refreshToolRegistry()`，所以**会话启动与 `/reload` 之后 Host 会强制把全部已注册的 extension 工具放进 active 集合**（`defaultActive` 只是 core/Loadout 侧元数据，Host 不读）；`/tree` 则先执行 `_restoreToolsFromTranscript()`，用目标分支 transcript 声明的工具集合**整体替换** active 集合，然后才发出 `session_tree`。结论：“默认不激活”不会由 Host 自动成立，必须由 pi-ext-tools 在 `session_start` 真实下发一次停用，并能在 `/tree` 之后纠正 Host 恢复出来的状态。
2. **首个任务按需激活（0 → 1 跃迁）**：当且仅当当前会话中产生第一个异步任务时（无论是 `bash(async: true)`、前台 60s `autoAsync` 超时提升，还是未来其他扩展任务），系统自动将这三个工具注入当前会话。
3. **次轮无缝可用**：工具激活后，下一轮模型推理立即获得这三个工具的调用签名与参数说明，可按需调用 `wait_tasks` 或 `stop_tasks`。
4. **同 package 内多生产者天然通用（Multi-Producer）**：依赖任务注册中心的活跃任务引用计数（`runningCount`），未来同 package 内新增的后台任务类型只要走 `AsyncTaskRegistry.create()`，就自动享受相同的按需注入能力，无需额外适配。
   - **边界澄清**：仓库现有规则禁止其他 extension 导入 `pi-ext-tools`，`pi-subagents`（`agent-*`）接入任务面也已被明确推迟，所以本方案**不承诺、也不暗示**跨 package 生产者，只覆盖 pi-ext-tools 自己的任务。
5. **对话内平稳保持 vs 宏观安全边界退场（Boundary-Driven Reset）**：
   - **普通对话轮次中**：即使后台任务全部完成（`runningCount` 回归 0），在当前对话流中依然保持 Active，便于模型查看终态输出或收尾，避免 turn 之间工具突兀消失导致模型困惑或 Prompt Cache 频繁失效。
   - **宏观安全边界（`/compact` 上下文压缩、`/tree` 切分支、`/reload` 重载）**：当且仅当 `runningCount === 0` 时，安全将工具从 Active 集合中移除，恢复纯净的 0 token 开销；若此时仍有任务在后台运行（`runningCount > 0`），则坚决保留工具，绝不误杀。
6. **Prompt Guidelines 模块化归位**：将针对 `wait_tasks` / `stop_tasks` 的禁止轮询等使用规范从 `bash` 的全局规则中拆分，挂载到任务工具自身的 `promptGuidelines` 上，随工具激活动态并入系统规则 `<rules>`。

---

## 2. 状态机与核心控制流

### 2.1 状态机设计

采用**强化版引用计数（Active Task Count）+ 宏观生命周期边界重置状态机**：

```text
       [ 会话初始化 / Session Start (/new, /reload, /resume) ]
                     │
                     │ runningCount === 0
                     ▼
             ┌───────────────┐
             │   Inactive    │  <tools> 无 task 工具
             │ (默认初始状态) │  API payload 无 task schema (节约数百 tokens)
             └───────┬───────┘
                     │
                     │ 首次任务创建 (First Task Created, 0 -> 1):
                     │ 1. bash(async: true) 启动
                     │ 2. autoAsync (60s) 超时提升
                     │ 3. 未来同 package 内其他 task.create()
                     │    (跨 package 生产者不在本次范围，见 1.2/4.5)
                     ▼
             ┌───────────────┐
             │    Active     │  <tools> 包含 list/wait/stop
             │ (会话内已激活) │  次轮具备完整的任务管控能力
             └───────┬───────┘
                     │
                     │ 任务运行完成: runningCount 回归 0
                     │ (对话普通轮次内保持 Active，避免提示词震荡与缓存失效)
                     │
                     │ 遇到明确的宏观重置边界 且 runningCount === 0:
                     │ 1. session_compact (/compact 或自动上下文压缩)
                     │ 2. session_tree (/tree 切换分支)
                     │ 3. session_start (/reload, /resume, /new 重建会话)
                     ▼
             [ 恢复 Inactive 状态 ]
```

### 2.2 详细控制流

#### 场景 A：无后台任务的日常交互（保持 Inactive）
```text
User: "请帮我修改 a.ts 中的类型定义"
Agent: 调用 read -> edit -> write -> 运行前台 bash 测试
        │
        └─> 全程未创建 AsyncTask (runningCount === 0)，task tools 始终处于 Inactive 状态，
            每轮请求保持极简，节约 400~600 tokens。
```

#### 场景 B：显式启动后台任务 `bash(async: true)` 触发动态注入
```text
User: "在后台启动长时间服务"
Agent: 调用 bash(command: "pnpm dev", async: true)
        │
        ├─> startBashTask() 调用 tasks.create()
        ├─> AsyncTaskRegistry 检测到 runningCount 从 0 变为 1，触发 onFirstTask 钩子
        ├─> 钩子调用 activateTaskTools(context, true)
        │   └─> pi.setActiveTools 追加 list_tasks, wait_tasks, stop_tasks
        ├─> bash 工具返回执行结果：
        │   "Started background task bash-1. Its result is added to context... Use wait_tasks only if next step needs it."
        │
        ▼ (Turn 结束)
AgentSession.prepareNextTurnWithContext()
        │
        ├─> 检测到 ActiveTools 增加了 3 个任务工具
        ├─> diffSystemPromptSections() 生成 <tools> 与 <rules> 的系统更新
        │
        ▼ (下一 Turn 开始)
Agent: 收到带有任务工具与新规则的提示词，如需等待可立即调用 wait_tasks({ ids: ["bash-1"] })。
```

#### 场景 C：前台长时间运行超时（60s autoAsync）自动提升触发动态注入
```text
User: "运行完整集成测试"
Agent: 调用 bash(command: "pnpm test:e2e") (未设置 timeout)
        │
        ├─> 命令运行至 60 秒，定时器触发
        ├─> promoteBashJobToTask() 调用 tasks.create()
        ├─> 引用计数 0 -> 1，触发 onFirstTask 钩子，激活任务工具集
        ├─> bash 提前结算并返回提升通知：
        │   "Command transitioned to background task bash-1... To wait: wait_tasks... To stop: stop_tasks..."
        │
        ▼ (Turn 结束并进入下一 Turn)
Agent: 下一轮提示词中已注入任务工具，模型可立刻决定 wait_tasks 或继续处理其他任务。
```

#### 场景 D：任务全部完成后，遭遇上下文压缩 (`/compact`) 恢复纯净
```text
User: "总结并继续后续开发" (或执行 /compact，或达到上下文阈值自动压缩)
        │
        ├─> Pi 执行会话压缩，将历史详细对话折叠成 Summary
        ├─> 触发 session_compact 事件
        ├─> lifecycle 监听器检查: tasks.runningCount === 0 ?
        │   ├─> 是 (所有任务都已跑完)：
        │   │   调用 activateTaskTools(context, false)
        │   │   任务工具被安全卸载，压缩后的新起点恢复为 0 token 纯净状态！
        │   └─> 否 (仍有任务在跑，runningCount > 0)：
        │       继续保留任务工具，供模型后续随时管控。
```

---

## 3. Ownership、生命周期与架构权衡

### 3.1 职责划分与 Ownership

- **`packages/pi-ext-tools`**：
  - 拥有任务管控工具（`list_tasks`, `wait_tasks`, `stop_tasks`）的实现、元数据声明与激活时机策略。
  - 拥有 `AsyncTaskRegistry`，作为任务产生、引用计数维护与状态查询的唯一发源地。
- **`@hheei/pi-ext-core`**：
  - 提供无副作用的工具激活与目录管理机制 `setManagedLoadoutToolsActive`。
  - 负责维护全局工具静态所有权与生命周期清理，不侵入业务决策。
- **Pi Host (`@earendil-works/pi-coding-agent`)**：
  - 提供 `pi.getActiveTools()` / `pi.setActiveTools()` 原生能力。
  - 在 turn 结束后的 `prepareNextTurnWithContext` 阶段执行 Section Diffing，向 LLM 下发增量变更。
  - 分发 `session_start`、`session_compact`、`session_tree` 等生命周期事件。

### 3.2 为什么采用“强化版引用计数 + 安全边界重置”，而非“Branch 历史扫描”或“每轮即时卸载”？

#### 1. 为什么坚决不用“每轮即时卸载（Turn-level Deactivation）”？
- **消除致命的调用竞态（Tool-call Race Condition）**：LLM 生成输出需要时间。假设某一轮模型正在决定并开始生成 `wait_tasks(["bash-1"])`，而后台进程恰好在该瞬间结束（`settle` 发生）。如果系统在 turn 结束时发现任务为 0 立即卸载工具，当模型调用发出时，Pi Host 会直接抛出 `Tool "wait_tasks" not found or inactive` 异常中断会话。
- **满足终端历史查询需求（Terminal History Inspection）**：`list_tasks` 具有参数 `{ includeTerminal: true }`，用于排查刚结束的任务信息或提取输出摘要。如果任务一结束就卸载工具，模型在任务完成后将失去检查历史任务的能力。
- **保护大模型上下文缓存（Preserve Prompt Cache / Anti-Churn）**：频繁地添加/删除工具会导致每次状态跃迁都在 transcript 中注入 `tool+:` / `tool-:` 与 System Prompt 差量，打破主流模型供应商的 Prefix Prompt Cache，导致推理延迟骤增和额外的缓存写入费用。

#### 2. 为什么“强化版引用计数”全面优于“Branch 历史扫描”？
- **极致性能（O(1) vs O(N)）**：
  - Branch 历史扫描必须在会话启动时深层遍历整个会话的数百上千条消息结构，解析嵌套的 toolCall 对象与 custom message，带来不可忽视的启动延迟与内存分配开销。
  - 引用计数是纯内存整数计算（`#runningCount`），加减法与 `=== 0` 比较耗时 0 纳秒，**完全零性能开销**。
- **实现极其简洁（不到 15 行代码）**：
  - Branch 扫描需要写繁琐易碎的 AST / JSON 提取逻辑，且易随 Pi 上游数据结构微调而失效。
  - 引用计数内聚在 `AsyncTaskRegistry` 内，状态明确，逻辑单一直观。
- **天然支持多工具扩展（Multi-Producer Ready）**：
  - 未来无论新增 `subagents` 任务、远程容器任务还是长时 `eval` 任务，所有生产者都通过统一的 `tasks.create()` 注册。
  - 引用计数自动将其统一管理，新工具**零额外适配、零胶水代码**。

#### 3. 为什么选择 `/compact`、`/tree`、`/reload` 作为安全卸载边界？
- **上下文已折叠/重构（Context Refactor Boundary）**：在 `/compact` 发生时，历史中具体的 toolCall 和长输出被折叠为一段自然语言摘要，详细的任务调用在活跃上下文中已不复存在。此时若 `runningCount === 0`，正是让提示词重归干净的最自然时刻。
- **分支切换与重载（Branch & Session Reset）**：`/tree` 切换分支或 `/reload` 重载会话代表用户显式的工作流跳转。若此时无运行中任务，重置回初始 Inactive 状态符合直觉。

---

## 4. 详细实施变更方案

### 4.1 任务工具声明与注册改造 (`packages/pi-ext-tools/src/task-tools.ts`)

1. **导出静态元数据配置常量**：
   ```typescript
   export const TASK_TOOL_REGISTRATIONS = [
     {
       id: "list_tasks",
       owner: OWNER,
       group: "Built-in",
       origin: OWNER,
       priority: 100,
       conflictSets: [],
       defaultActive: false, // 声明默认不激活
     },
     {
       id: "wait_tasks",
       owner: OWNER,
       group: "Built-in",
       origin: OWNER,
       priority: 100,
       conflictSets: [],
       defaultActive: false,
     },
     {
       id: "stop_tasks",
       owner: OWNER,
       group: "Built-in",
       origin: OWNER,
       priority: 100,
       conflictSets: [],
       defaultActive: false,
     },
   ] as const;
   ```
2. **改用 `registerManagedTool` 原型注册**：
   原有的 `registerManagedLoadoutTool` 会直接发布静态 Loadout 目录并默认激活。将其改为：
   - 使用 `registerManagedTool` 向 Pi 和 core 注册工具原型（保证 Host 知道它们的存在）；
   - 不在启动阶段将其推入 Active 集合。
3. **补充专用 `promptGuidelines`**：
   将任务管控的核心行为准则直接赋予工具自身：
   - `wait_tasks`: `["Do not poll background tasks. Use wait_tasks only when the next step needs their results."]`
   - `stop_tasks`: `["Stop background tasks when their results are no longer needed."]`
4. **导出 id 列表与激活/停用管理方法**：
   ```typescript
   export const TASK_TOOL_IDS: readonly string[] = TASK_TOOL_REGISTRATIONS.map(
     (registration) => registration.id,
   );

   export function activateTaskTools(
     context: ExtensionLifecycleContext,
     active: boolean,
   ): void {
     setManagedLoadoutToolsActive(context, TASK_TOOL_REGISTRATIONS, active);
   }
   ```
   > 本方案不声明 `forcedActive`，也不依赖 Loadout 策略：Loadout 不参与工具 active 集合的最终裁决（见 4.5）。

### 4.2 任务注册中心扩展 (`packages/pi-ext-tools/src/tasks/registry.ts`)

1. **内置活跃任务计数器与首任务回调**：
   ```typescript
   export interface AsyncTaskRegistryOptions {
     readonly pi?: ExtensionAPI;
     readonly onFirstTask?: () => void;
   }

   export class AsyncTaskRegistry {
     #runningCount = 0;
     readonly #onFirstTask?: () => void;

     constructor(options: AsyncTaskRegistryOptions = {}) {
       ...
       this.#onFirstTask = options.onFirstTask;
     }

     /** 当前正在运行中的任务总数。 */
     get runningCount(): number {
       return this.#runningCount;
     }

     /** 是否存在正在运行中的任务。 */
     get hasRunningTasks(): boolean {
       return this.#runningCount > 0;
     }
     ...
   ```
2. **在 `create()` 时维护计数与触发 0 → 1 激活**：
   > **关键审查修正**：`onFirstTask` 必须在 `begin(id)` **执行成功之后**才触发，绝不能在 `begin` 之前调用。若任务启动因 spawn 等原因抛错，任务并未真正建立，绝不能误激活工具，也不能增加计数。
   ```typescript
   create(request: AsyncTaskRequest): AsyncTaskSnapshot {
     if (this.#closed) throw new Error("Task registry is disposed");
     const id = this.#nextId(request.type);
     const record: TaskRecord = {
       id,
       type: request.type,
       purpose: request.purpose,
       startedAt: Date.now(),
       status: "running",
       delivered: false,
       waiters: [],
     };
     this.#records.set(id, record);

     try {
       record.binding = request.begin(id);
     } catch (error) {
       record.status = "failed";
       record.endedAt = Date.now();
       record.terminal = { status: "failed", output: errorText(error), truncated: false };
       this.#release(record, false);
       this.#evictTerminal();
       throw error;
     }

     // 只有在 begin() 成功、任务确已开始运行后，才触发首任务激活并递增计数
     if (this.#runningCount === 0) {
       try {
         this.#onFirstTask?.();
       } catch {
         // 防御性捕获，避免工具激活偶发异常影响任务本身运行
       }
     }
     this.#runningCount++;

     return snapshot(record);
   }
   ```
3. **在 `settle()` 与 `dispose()` 时递减与归零**：
   ```typescript
   settle(id: string, terminal: AsyncTaskTerminal): void {
     const record = this.#records.get(id);
     if (record === undefined || record.status !== "running") return;
     this.#runningCount--;
     this.#settle(record, terminal);
   }

   dispose(): void {
     if (this.#closed) return;
     this.#closed = true;
     ...
   }
   ```
   > **维护成本提醒（建议收窄为可派生值）**：手动维护的 `#runningCount` 是一个与 `#records` 重复的第二数据源，且需要 `create()` / `settle()` / `dispose()` 三处同步修改，漏一处就会与真实状态漂移；`Math.max(0, ...)` 的钳位只是掩盖漂移而不暴露它。更简单的写法是不持有计数器，而是从唯一数据源派生：
   > ```typescript
   > /** 当前正在运行中的任务总数。 */
   > get runningCount(): number {
   >   let count = 0;
   >   for (const record of this.#records.values()) {
   >     if (record.status === "running") count += 1;
   >   }
   >   return count;
   > }
   > ```
   > 此时 `create()` 在插入记录**之前**先记下 `const wasIdle = this.runningCount === 0;`，仅在 `begin(id)` 成功后才在 `wasIdle` 为真时触发 `onFirstTask`；`begin` 抛错时记录会变成 failed，派生值自然回到原值，**无需任何手工递减**。记录上限为 64（`MAX_RETAINED_TERMINAL`），单次遍历成本可忽略，节 3.2 对“O(1) 计数”的论证针对的是 transcript 扫描，不受影响。
   > 本节代码块保留计数器写法以说明语义；实现时建议改用派生写法，减少一处可漂移的状态。

### 4.3 生命周期与安全边界监听 (`packages/pi-ext-tools/src/fff/lifecycle.ts`)

1. **会话初始化（默认 Inactive 与幂等切换）**：
   在 `startFffLifecycle` 中：
   > **关键审查修正 2**：不能用 `let taskToolsActive = false` 这种“本地布尔 + 提前返回”做去重。Host 会在会话启动/`/reload` 时强制激活全部 extension 工具，并会在 `/tree` 时按 transcript 恢复 active 集合，本地布尔会与 Host 真实状态失配：初始那次“停用”会被自己的提前返回吞掉（功能直接失效），`/tree` 之后该卸载时也不会卸载。幂等判断必须以 Host 真实状态为准：
   ```typescript
   const setTaskToolsActive = (active: boolean): void => {
     const applied = pi.getActiveTools().some((id) => TASK_TOOL_IDS.includes(id));
     if (applied === active) return;
     activateTaskTools(context, active);
   };

   // 会话启动时必须真实下发一次停用：此刻 Host 已把全部 extension 工具放进 active
   setTaskToolsActive(false);

   const tasks = new AsyncTaskRegistry({
     pi,
     onFirstTask: () => {
       setTaskToolsActive(true);
     },
   });
   state.tasks = tasks;
   ```
   注意：`setManagedLoadoutToolsActive` 自身是“取 `getActiveTools()` 后只增删本组 id”的集合运算，重复调用不会破坏其他工具（也不会覆盖 Host 的整体替换结果）；上面的判断只用于避免无意义地反复触发 Host 的 system prompt 重算。
2. **挂载安全重置边界监听（`session_compact` & `session_tree`）与生命周期退订**：
   > **关键审查修正**：`pi.on` 会返回退订函数，必须将其注册到 `context.resources`，防止多次 `/reload` 产生无用监听器泄漏。
   ```typescript
   // 当上下文压缩成功后：若无正在运行的任务，恢复 Inactive
   const handleCompact = (): void => {
     if (tasks.runningCount === 0) {
       setTaskToolsActive(false);
     }
   };
   const unsubCompact = pi.on("session_compact", handleCompact);

   // 当用户切换分支后：若无正在运行的任务，恢复 Inactive。
   // Host 在发出 session_tree 之前已用目标分支 transcript 的声明整体替换 active 集合，
   // 可能把 task 工具又恢复成激活，所以这里必须能真的移除（依赖上面的 Host 状态判断）。
   const handleTree = (): void => {
     if (tasks.runningCount === 0) {
       setTaskToolsActive(false);
     }
   };
   const unsubTree = pi.on("session_tree", handleTree);

   context.resources.add("task-tools-boundary-listeners", () => {
     unsubCompact();
     unsubTree();
   });
   ```

### 4.4 提示词规则精简 (`packages/pi-ext-tools/src/bash.ts`)

从 `BASH_PROMPT_GUIDELINES` 中移除针对 `wait_tasks` 的微观操作要求，简化为通用契约：
```typescript
const BASH_PROMPT_GUIDELINES = [
	"Use `async` only for finite commands that may outlive this tool call; its result is added to the context when it finishes.",
	"Local commands without timeout transition to background tasks (e.g. bash-1) after 60s.",
	"Remote `target` is an authorized SSH host; omit async. Working directory is the remote home.",
] as const;
```
当异步任务真正启动后，注入的 `wait_tasks` 会将 `"Do not poll background tasks. Use wait_tasks only when the next step needs their results."` 自动带入系统规则。

---

### 4.5 与 pi-settings Loadout 引擎的边界（已决定：Loadout 不影响动态加载）

**决定**：工具的 active 集合由工具 owner 自我管理（动态激活/停用是工具能力的一部分），Loadout 引擎**不对工具的 active 集合做最终裁决**；日后 Loadout 将不再对工具做限制。因此本方案：

- **不声明** `forcedActive`，也不把 `defaultActive` 当作运行时契约；本方案不为 Loadout 的策略做任何适配层，不用适配层掩盖不属于本 package 的行为。
- 运行时契约只有一个：任务工具的 active 状态由 pi-ext-tools 自己决定（`session_start` 停用、首个任务激活、宏观边界卸载）。

**已落地**：`docs/plans/loadout-tool-policy-removal.md` 已把该方向实现——Loadout engine 不再调用 `pi.setActiveTools`（也不再持有 initial active baseline），core 的工具注册契约收敛为 `registerManagedTool(pi, { id, owner }, tool)` + `setManagedToolsActive`，`isManagedLoadoutTool` 更名为 `isManagedTool`。因此本方案里 `TASK_TOOL_REGISTRATIONS` 的写法要与实际契约对齐：注册用 `registerManagedTool`，激活/停用用 `setManagedToolsActive`，并且**不再声明** `defaultActive`（该字段已从工具注册契约删除）。

**因此本方案的验证不包含 Loadout 引擎集成测试**；只在 §6 记一行与 pi-settings 当前行为的已知交叉点。

---

## 5. 聚焦测试与验证策略

根据仓库 Verification Policy，本改动属于 `pi-ext-tools` 单一 package 的行为优化，采用聚焦验证：

### 5.1 待增设/修改的测试用例

1. **初始未激活验证** (`packages/pi-ext-tools/test/tools.test.ts`)：
   - 验证在调用 `registerTools(host.pi)` 并初始化后，`host.activeTools()` 中**不包含** `list_tasks`、`wait_tasks`、`stop_tasks`。
   - 验证此时常规工具 `read`、`bash`、`edit`、`write` 等正常处于活跃状态。
2. **首次显式 async 激活验证** (`packages/pi-ext-tools/test/bash-jobs.test.ts`)：
   - 初始状态下活跃工具无任务工具，`runningCount === 0`；
   - 执行 `bash(command: "echo test", async: true)`；
   - 断言执行后 `runningCount === 1`，`host.activeTools()` 立即包含了 `list_tasks`、`wait_tasks`、`stop_tasks`。
3. **autoAsync 超时提升激活验证** (`packages/pi-ext-tools/test/bash-jobs.test.ts`)：
   - 初始状态无任务工具；
   - 模拟前台运行超 60 秒触发 `promoteBashJobToTask`；
   - 断言执行后任务工具被成功激活。
4. **多任务并发与单向幂等性验证**：
   - 启动第二个异步任务，断言 `runningCount === 2`，验证不会发生重复激活或抛出异常；
   - 第一个任务变为 terminal 完成状态后，`runningCount === 1`，验证活跃工具列表中依然保留任务工具。
5. **普通 Turn 之间平稳保持验证**：
   - 所有任务均变为 terminal 状态，`runningCount === 0`；
   - 模拟随后的普通 turn 推进，验证任务工具依然保持 Active，不发生提前卸载。
6. **宏观边界安全卸载验证 (`session_compact` / `session_tree`)**：
   - **Case 6.1 (runningCount === 0)**：触发 `session_compact` 或 `session_tree`，断言任务工具成功卸载为 Inactive。
   - **Case 6.2 (runningCount > 0)**：在任务仍在运行状态下触发 `session_compact` 或 `session_tree`，断言任务工具继续保持 Active，绝不误杀。
7. **Host 强制激活与 transcript 恢复的对抗验证（关键回归）**：
   - 在生命周期启动**之前**先把 `list_tasks`、`wait_tasks`、`stop_tasks` 放进 `getActiveTools()` 的结果（模拟 Host 的 `includeAllExtensionTools: true` 与 `/tree` 的 `_restoreToolsFromTranscript()`），再让 `session_start` 完成，断言最终 active 集合**不含**这三个工具。本地布尔去重的写法会漏掉这条，必须由该测试守住。
8. **会话隔离验证（`/reload` 与新建会话）**：任务运行中结束旧会话并启动新会话，断言新会话初始为 Inactive 且 `runningCount` 归零。
9. **不新增 Loadout 相关测试**：4.5 已确定工具 active 集合不归 Loadout 裁决，因此不写引擎集成测试，也不为引擎当前行为写适配回归。
10. **Prompt Guidelines 同步与精简验证** (`packages/pi-ext-tools/test/bash-backend.test.ts`)：
   - 验证 `BASH_PROMPT_GUIDELINES` 移除 `wait_tasks` 细则后的通用说明；
   - 验证 `wait_tasks` 与 `stop_tasks` 工具各自的 `promptGuidelines` 正确声明。

> **测试基座缺口（需一并处理）**：`packages/pi-ext-tools/test/bash-jobs.test.ts` 的 `toolHost()` 只有 `registerTool`，没有 `getActiveTools`/`setActiveTools`，也没有可用的 `ExtensionLifecycleContext`；本 package 目前也没有能真正驱动 `startFffLifecycle`（需要 settings、`TargetRuntime`、`FffRuntime`）的 harness。建议把“激活切换 + 边界监听”抽成一个只依赖 `(context, tasks)` 的小函数并由 `startFffLifecycle` 调用，测试直接驱动该函数；若要做整链路验证，则照 `test/todo/integration.test.ts` 的 fake-event-map pi 追加 `session_start`/`session_compact`/`session_tree` 事件与 active 工具读写。

### 5.2 敏感度探测 (Sensitivity Probe)

按照仓库既定规范：
- 故意将 `onFirstTask` 激活注释掉，断言“任务启动后激活工具”测试失败；
- 故意把 `setTaskToolsActive` 换回“本地布尔提前返回”的写法，断言“Host 强制激活对抗验证”失败；
- 故意在 `session_compact` 时跳过 `runningCount === 0` 检查直接卸载，断言“运行中 compact 保留工具”测试失败。

---

## 6. 风险评估与防御对策

| 风险项 | 影响评估 | 防御对策 |
| :--- | :--- | :--- |
| **Pi Host 内部 setActiveTools 在工具执行期间被调用的兼容性** | 低 | 经源码审计，Pi 在 `prepareNextTurnWithContext` 阶段每次都会重新读取 `getActiveToolNames()` 并与前一轮做 Diff，工具执行期间修改 state 会在当前 turn 结束后完美生效。 |
| **未安装 pi-settings 时的独立运行表现** | 低 | `setManagedLoadoutToolsActive` 底层直接调用 `ExtensionAPI.setActiveTools`，不依赖 `pi-settings` 的配置引擎，独立运行完全安全。 |
| **Host 在会话启动 / `/reload` 强制激活全部 extension 工具** | 高（不处理则功能直接失效） | `session_start` 必须真实下发一次停用；幂等判断以 `pi.getActiveTools()` 为准，不能用本地布尔。见 4.3 / 5.1 第 7 条。 |
| **`/tree` 时 Host 用 transcript 整体替换 active 集合** | 中 | `session_tree` 在 `_restoreToolsFromTranscript()` 之后发出，处理函数可在 `runningCount === 0` 时重新移除；不能用本地布尔跳过。 |
| **pi-settings Loadout 引擎当前仍会整份重写 active tool 集合** | 中（与 pi-settings 的交叉点） | 已定为不由本方案适配：工具 active 集合归工具 owner，Loadout 日后不再对工具做限制（方向已记入 `docs/architecture/loadout.md`）；修复归属 pi-settings 侧引擎。本方案只保证自己一侧的状态切换正确。 |
| **外部多工具直接调用 tasks.create()** | 极低 | `AsyncTaskRegistry.create()` 是 pi-ext-tools 内所有异步任务建立的唯一入口（当前为 bash；跨 package 生产者不在本次范围）。 |
| **begin() 启动失败导致计数泄漏与误激活** | 极低 | `onFirstTask` 触发和 `runningCount++` 严格放置在 `begin(id)` 成功返回之后；若任务启动异常，不激活工具且计数保持不变。 |
| **未激活工具被模型幻觉调用** | 极低 | Pi Host 在 `prepareToolCall` 中会对未激活工具立即返回 `Tool ... is unavailable` 错误 toolResult，绝不导致崩溃。 |
| **`--exclude-tools list_tasks` 之类的 Host 排除配置被动态激活重新加回** | 低 | `apply()` 只做 active 集合增删，不去核对 Host 的 `allowedToolNames`/`excludedToolNames`；这是 core 现有 edit/eval 激活路径的同一行为，本次不扩大处理范围，仅记录。 |
| **`toolGuidelines` 是否真随激活生效** | 低（已核实） | Host `buildRules()` 只遍历 `selectedTools` 取 `toolGuidelines[name]`，因此 `wait_tasks`/`stop_tasks` 的规则确实只在激活时进入 `<rules>`。 |

## 7. 实现状态

已按本方案实现（`packages/pi-ext-tools`），落地位置与偏差记录如下。

### 7.1 落地内容

| 位置 | 内容 |
| :--- | :--- |
| `src/tasks/registry.ts` | `AsyncTaskRegistryOptions { pi?, onFirstTask? }`；`runningCount` 为**派生 getter**（遍历 `#records` 数 `status === "running"`，不维护第二数据源，因此 `settle()`/dispose 无需手工递减）；`create()` 在插入记录前取 `wasIdle`，仅在 `begin(id)` 成功后触发 `onFirstTask`，并捕获其异常。 |
| `src/task-tools.ts` | 导出 `TASK_TOOL_REGISTRATIONS`（`{ id, owner }`，无 `defaultActive`）与 `TASK_TOOL_IDS`；`wait_tasks`/`stop_tasks` 各自声明 `promptGuidelines`；新增 `startTaskControl(context)`：创建 session 的 `AsyncTaskRegistry`，以 `pi.getActiveTools()` 为准真实停用一次，挂载 `session_compact`/`session_tree` 边界监听，并把退订函数注册到 `context.resources` 的 `task-tool-boundary-listeners`。 |
| `src/fff/lifecycle.ts` | `startFffLifecycle` 改为 `const tasks = startTaskControl(context); state.tasks = tasks;`。 |
| `src/bash.ts` | `BASH_PROMPT_GUIDELINES` 收敛为 3 条通用契约（去掉 `wait_tasks` 轮询细则与 wait/stop 操作指引）。 |

### 7.2 与方案的偏差

- **不提供 `hasRunningTasks`**：方案把它与 `runningCount` 并列，但全仓库只使用 `runningCount === 0` 一种判定；按“无第二调用方就不加抽象”的原则只保留 `runningCount`。
- **`startTaskControl` 是单一接缝**：方案 §4.3 建议“抽成只依赖 `(context, tasks)` 的函数”，但 `onFirstTask` 必须在 `AsyncTaskRegistry` 构造时传入，而边界监听又需要该 registry，两者无法在没有额外状态的情况下拆开；因此合并为一个函数，由它创建并返回 registry（生命周期同样只调用一次）。
- **激活失败不阻塞任务**：`onFirstTask` 在 registry 内 try/catch 吞掉异常。若让它冒泡，`create()` 会在 `begin(id)` 已经启动后台作业之后抛错，把“后台已在跑但模型拿不到 id”这种更差的状态留给调用方；而同一组 registration 在 session 启动时已经过 `setManagedToolsActive` 校验（正常会话下必然走真实停用分支），所以后续抛错只可能是编程错误。
- **激活优先于用户手动关闭工具**：若用户在空闲时用 Pi 原生工具配置关掉三个任务工具，下一次后台任务仍会把它们加回来。这是有意为之：`wait_tasks`/`stop_tasks` 是任务存在时的必需控制面。
- **不导出 `activateTaskTools`**：方案 §4.1.4 要求导出它，但它只有一个调用方且只有一行（`setManagedToolsActive` + 固定 registration 列表），按“没有第二个调用方就不抽一次性函数”的原则内联进 `startTaskControl`。
- **前置条件**：`startTaskControl` 依赖三个工具已通过 `registerManagedTool` 注册（`setManagedToolsActive` 会校验 owner），因此 `registerTools`/`registerTaskTools` 必须先于 session 生命周期执行——这与现状一致（构造期静态注册、`session_start` 启动生命周期），但已在函数注释中写明。
- **`wait_tasks` 描述与 guideline 不重复**：为避免同一句话同时出现在 `<tools>` 与 `<rules>`，`wait_tasks` 的 `description` 收缩为“等待并返回结果”，而“不要轮询”只保留在 `promptGuidelines` 中。
- **不新增 Loadout 相关测试**：按 §4.5 的决定，工具 active 集合不归 Loadout 裁决，本方案不写引擎集成测试。

### 7.3 已落地的测试

- `test/bash-jobs.test.ts`（8 例，`taskControlHost()` + `lateBoundState()` 基座）：Host 预激活被 session start 移除；首个显式 `async` 任务激活且普通轮次内保持、`session_compact` 后卸载；**边界卸载后同一 session 内的下一个任务会重新激活（回到 `bash-2`）**；任务运行中边界不卸载（stop 后卸载）；auto-async 晋升激活；`begin()` 失败的任务不激活工具且 `runningCount` 为 0；新 session 初始 Inactive 且 `runningCount` 为 0；session 拆除后边界监听失效。
- `test/tools.test.ts`（1 例）：真实 catalog（`registerTools`）在 Host 全量激活后，session start 只移除三个任务工具，`read`/`bash`/`eval` 不受影响。
- `test/bash-backend.test.ts`（2 例）：`BASH_PROMPT_GUIDELINES` 收敛为 3 条；三个任务工具的 `promptGuidelines` 声明。
- 敏感度已逐条验证：去掉 `onFirstTask` 触发、把幂等判断换成“本地布尔提前返回”、边界处去掉 `runningCount === 0` 检查、把激活条件改成“只有 registry 完全为空时才激活”（一次性激活），都会各自让对应测试失败。
