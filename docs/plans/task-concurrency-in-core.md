# Task 并发与排队机制下沉至 ext-core 实施计划

状态：设计草案已就绪；尚未实施代码修改。  
适用范围：`packages/pi-ext-core`（`TaskRegistry` 核心契约）、`packages/pi-subagents`（`AgentTaskExecutor` 队列瘦身与迁移）、`packages/pi-ext-tools`（后台任务控制与交付）。

---

## 1. 背景与核心动机

当前仓库中，后台任务的并发控制与排队逻辑存在明显的**职责割裂与重复建设**：

1. **`pi-subagents` 私有队列与重复实现**：
   - `packages/pi-subagents/src/task-executor.ts` 在内部手写了 `#queue`、`#drain()`、`DEFAULT_MAX_TASK_EXECUTIONS = 4` 与 `DEFAULT_MAX_QUEUED_TASKS = 32`；
   - 外部派发一个 `task` 时，`task-executor` 既在自己内部排队，又向 `ext-core` 的 `TaskRegistry` 登记一个占位项；两者状态同步依赖复杂的双向状态更新，增加了时序竞态风险。
2. **`TaskRegistry` 缺乏执行并发控制**：
   - 目前 `packages/pi-ext-core/src/tasks.ts` 的 `TaskRegistry` 仅维护了 `maxPendingDeliveries`（活动任务 + 未交付终态的总数上限），只负责防内存泄漏，**完全没有执行并发调度能力（即同时处于运行中的任务数管控）**。
   - `bash` 后台任务缺乏全局并发保护，若并发启动多个重量级编译/测试命令，可能导致主机资源耗尽。
3. **架构违背中立协调原则**：
   - 跨插件的资源并发（CPU 核心、任务槽位、模型调用吞吐）是典型的**系统级共享资源**；
   - 由具体 extension（如 `pi-subagents`）自定并发配额，既无法感知其他插件的负载，也使得未来新增后台任务类型的插件必须重新发明一套排队轮子。

**方案 A 的核心决策**：将并发槽位管控（Concurrency Admission）与先进先出排队（FIFO Queueing）从 `pi-subagents` 中彻底剥离，作为**无副作用的通用纯状态机能力**下沉至 `packages/pi-ext-core/src/tasks.ts`。

---

## 2. 目标与非目标

### 目标 (Goals)
1. **精准的类型化并发管控**：`TaskRegistry` 支持按任务类型配置并发上限（`maxConcurrentByType`）。未配置的轻量类型（如 `bash`）**完全不占用排队数、不参与限流、直接即时启动**；仅对重型子进程任务（`task`）进行并发限制与排队。
2. **延迟激活契约（Deferred Begin）**：排队任务在排队阶段不启动底层物理执行；只有在获得并发槽位时，`TaskRegistry` 才触发执行回调（`begin`）。
3. **排队任务的即时低成本取消**：处于 `queued` 状态的任务若被 `stop_tasks` 取消，直接从队列移出并进入 `cancelled` 终态，零物理清理开销。
4. **`pi-subagents` 大幅瘦身**：移除 `task-executor.ts` 中的私有 `#queue`、`#drain`、`maxRunning` 与 `maxQueued`，直接成为纯粹的 `TaskRegistry` 生产者。
5. **保持零外部依赖与零副作用**：`ext-core` 内部仅使用纯 TypeScript 数据结构（数组、Map、计数器），不发起任何网络请求、不依赖任何外部工具。

### 非目标 (Non-Goals)
1. **不限制轻量或已在运行的任务**：`bash` 后台任务绝不排队，不占用排队数，完全保留现有即时运行机制。
2. **不引入跨进程锁或复杂优先级调度**：维持简单可靠的 FIFO 队列与单会话内存状态，不增加抢占式优先级与持久化队列。
3. **不改变现行 `wait_tasks` 与 `stop_tasks` 交互协议**：上层模型可见的任务 ID（`task-1`、`bash-1`）、状态流转与终端展示完全保持不变。

---

## 3. 核心契约与接口设计（`packages/pi-ext-core/src/tasks.ts`）

### 3.1 `TaskRegistryOptions` 扩展

```ts
export interface TaskRegistryOptions {
	/** 未交付通知与活动任务的总上限（防止内存泄漏），默认 16 */
	readonly maxPendingDeliveries?: number;
	/** 保留的终态记录上限，默认 32 */
	readonly maxRetainedTerminal?: number;
	/** 首个任务创建时的回调（激活控制工具） */
	readonly onFirstTask?: () => void;
	/**
	 * 按任务类型细化的最大并发执行数。
	 * 例如：{ task: 4 }。未配置的类型（如 bash）不限制并发，直接即时启动。
	 */
	readonly maxConcurrentByType?: Readonly<Record<string, number>>;
	/**
	 * 排队等待队列容量上限。
	 * 某一限制类型的排队任务数超出此限制时，create() 抛出 TaskQueueFullError。默认 32。
	 */
	readonly maxQueued?: number;
}
```

### 3.2 任务登记输入与延迟启动回调

现有 `create` 接口的 `begin` 函数由“同步必须返回 binding”升级为**支持排队调度**：

```ts
export interface TaskCreateInput {
	readonly type: string;
	readonly purpose: string;
	readonly initialStatus?: TaskStatus; // 允许指定初始状态，缺省由调度器判断
	readonly anchor?: string;
	readonly inlineResult?: boolean;
	/**
	 * 执行启动钩子。
	 * 当任务从队列出队并获得执行槽位时调用，返回用于停止和描述任务的 TaskBinding。
	 * 可以是同步函数，也可以是返回 Promise<TaskBinding> 的异步启动器。
	 */
	readonly begin: (id: string) => TaskBinding | Promise<TaskBinding>;
}
```

### 3.3 异常类型定义

```ts
export class TaskQueueFullError extends Error {
	readonly limit: number;
	public constructor(limit: number) {
		super(`Task queue capacity reached (limit: ${limit})`);
		this.name = "TaskQueueFullError";
		this.limit = limit;
	}
}
```

---

## 4. 状态流转机与调度算法

```
            create() [槽位已满]
               │
               ▼
           [ queued ] ── stop() ──► [ cancelled ] (立即出队并终止，不触发 begin)
               │
               │ 前序任务 settle / 槽位释放
               ▼
          [ starting ] ── begin(id) 激活物理执行
               │
               ▼
          [ running ] ── settle() ──► [ completed / failed / cancelled ]
                                              │
                                              ▼
                                     触发 #drainQueue()
                                     出队下一个排队任务
```

### 4.1 入队与准入（Admission）
1. 检查总容量：`this.activeCount + this.undeliveredCount >= this.#maxPending` 时抛出 `TaskCapacityError`。
2. 计算该任务类型的有效并发限制 `limit = this.#concurrencyFor(type)`：
   - 若 `limit === undefined` 或 `当前运行数 < limit`：
     - 分配 `id = nextId(type)`；
     - 标记状态为 `starting`；
     - 立即调用 `begin(id)` 绑定物理执行；
     - 计入活动并发数。
   - 若 `当前运行数 >= limit`：
     - 检查队列长度：`this.#queue.length >= this.#maxQueued` 时抛出 `TaskQueueFullError`；
     - 分配 `id = nextId(type)`；
     - 标记状态为 `queued`；
     - 任务进入内部 FIFO 队列 `this.#queue.push({ id, input })`；
     - **不调用 `begin`**，不产生物理进程。

### 4.2 出队与调度（`#drainQueue`）
每次有任务进入终态（调用 `settle(id, terminal)` 或 `stop(id)`）时：
1. 释放该任务类型占用的并发槽位；
2. 扫描 FIFO 队列，寻找首个其所属类型尚有可用槽位的排队任务；
3. 将该任务从队列移出：
   - 状态由 `queued` 转换为 `starting`；
   - 触发其 `begin(task.id)` 钩子，完成执行绑定；
   - 状态更新为 `running`；
4. 重复此过程，直到队列中无可调度任务或所有并发槽位占满。

### 4.3 排队期的快速取消（Cancellation）
当用户或模型调用 `stop_tasks([id])`：
- 若目标任务仍处于 `queued` 状态：
  - 从 `this.#queue` 中定位并剔除该项；
  - 直接调用内部 `settle` 将其置为 `cancelled`（`output: "cancelled while queued"`）；
  - **不需要调用底层任何进程清理代码**（因为物理进程尚未生成）；
  - 触发 `#drainQueue` 尝试调度后续任务。

---

## 5. 模块改造与影响分析

### 5.1 `packages/pi-ext-core`
- **文件**：`src/tasks.ts`
- **改动**：
  - 增加队列容器与按类型并发计数；
  - 实现基于槽位的准入拦截与延迟 `begin` 逻辑；
  - 在 `settle` 和 `stop` 时自动运行 `#drainQueue`；
  - 导出 `TaskQueueFullError`。
- **依赖影响**：零新增外部依赖，完全符合纯协调库定位。

### 5.2 `packages/pi-subagents`
- **文件**：`src/task-executor.ts`
- **改动**：
  - **删除**：`#queue` 数组、`#drain()` 方法、`DEFAULT_MAX_TASK_EXECUTIONS` 与 `DEFAULT_MAX_QUEUED_TASKS` 常量；
  - **简化 `start()`**：不再维护私有排队逻辑，直接调用 `this.#deps.registry.create`，将物理 launch 逻辑作为 `begin` 传入；
  - **简化 `stop()`**：直接交由 `registry.stop(id)`，由 core 判定是否为未启动的排队任务；只有物理进程已启动的才需要向 runner 发送中止信号。
- **收益**：`task-executor.ts` 代码量减少约 100~150 行，彻底消除两层队列间的状态同步问题。

### 5.3 `packages/pi-ext-tools`
- **文件**：`src/extension.ts`（或提供 TaskRegistry 的地方）
- **改动**：
  - 初始化全局 `TaskRegistry` 时配置合理的默认并发：
    ```ts
    const tasks = new TaskRegistry({
        concurrencyByType: {
            task: 4, // 保持与当前 pi-subagents 默认一致的 4 并发
            bash: 4, // 为后台 bash 命令提供并发保护
        },
        maxQueued: 32,
    });
    ```
- **工具层透明**：`wait_tasks`、`list_tasks`、`stop_tasks` 无需任何参数或逻辑调整，原生感知 `queued` 状态和出队流转。

---

## 6. 异常与边界情况处理

| 边界场景 | 处理保证 |
| :--- | :--- |
| **队列已满时尝试新建任务** | 立即同步抛出 `TaskQueueFullError`，阻止新任务创建，不产生悬挂 ID。 |
| **`begin(id)` 启动失败（如进程无法 spawn）** | 调度器捕获异常，自动将该任务直接 `settle` 为 `failed`，并立即释放已占用的并发槽位，继续推进队列。 |
| **异步 `begin` 期间收到 `stop`** | 标记该任务为 `stopping`，待物理启动完成后立即触发已注册 binding 的 `stop()`，不留下孤儿进程。 |
| **父会话销毁 / Registry `dispose()`** | 清空等待队列，所有排队任务就地结算为 `cancelled`；逐一中止所有运行中的 binding；关闭准入。 |
| **任务无并发限制（如未配置的类型）** | 即时启动，不参与排队，与现有行为 100% 保持一致。 |

---

## 7. 实施步骤与验证矩阵

### 阶段一：`pi-ext-core` 核心调度器实现与聚焦测试
1. 在 `packages/pi-ext-core/src/tasks.ts` 中实现并发控制与队列流转；
2. 编写 `packages/pi-ext-core/test/tasks-concurrency.test.ts`，验证：
   - 达到 `maxConcurrent` 时新任务处于 `queued` 状态，未触发 `begin`；
   - 任务 `settle` 后自动唤醒并激活队列首个任务，触发其 `begin`；
   - 排队中任务被 `stop` 时立即取消，不调用 `begin`，且不阻碍后续任务；
   - `maxQueued` 溢出时抛出 `TaskQueueFullError`；
   - 混合不同 `type`（如 `task` 与 `bash`）时独立计数并发。

### 阶段二：`pi-subagents` 迁移与契约对齐
1. 重构 `packages/pi-subagents/src/task-executor.ts`，移除自身私有队列；
2. 保持 `task-executor.test.ts` 和 `task-tool.test.ts` 契约不变；
3. 验证端到端工具执行（`task` 工具在并发打满时的自动排队与出队结果返回）。

### 阶段三：全仓回归与静态检查
1. 运行变更文件 Biome 检查：`pnpm exec biome check <changed-files...>`；
2. 运行类型检查：`pnpm run typecheck`；
3. 运行聚焦测试与全局回归测试：`pnpm test`；
4. 运行产物构建校验：`pnpm run build`。
