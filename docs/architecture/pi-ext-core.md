# pi-ext-core 架构提案

## 状态

已实现 v1：`@hheei/pi-ext-core` package、focused tests 与 lifecycle、Service、ExtensionPoint、
JSON settings provider registry、Loadout managed-tool registration 均已建立。custom surface runtime、
Extension page router 和 BTW popup consumer 已实现，边界见 [TUI 宿主架构](tui.md)。`pi-settings` host、
Loadout router page 与 editor rail compositor 仍未实现；它们必须先完成 focused tests 和用户确认，才可实现行为。

维护者与 consumers 的开发约定见 [pi-ext-core 开发约定](../development/pi-ext-core.md)。

## 目标

`@hheei/pi-ext-core` 是独立 `pi-<name>` extension 的最小协调依赖。它提供：

- 以同一 Pi runtime 为范围的 identity；
- session start/shutdown 生命周期注册和幂等 cleanup；
- 1:1 独占 Service 的注册、查询和可取消等待；
- 1:N ExtensionPoint 的 hook 注册和消费；
- Pi global/project settings JSON 的无 policy 文件 transport；
- 取消、revision 和 async ownership 所需的通用基础能力。

core 本身不是 Pi extension：没有 `pi.extensions`、命令、tool、renderer、timer 或
listener。导入 package 没有副作用。只有 extension 显式调用注册 API 后，core 才创建
对应 runtime state 或订阅 Pi lifecycle。因此未安装或未使用子包时，core 不影响 Pi
runtime 的性能或界面。

## 非目标

已实现 v1 不迁移或提供下列 HEPI 专属行为：

- Settings policy、feature-owned schema/content、UI、`/hepi` command、model selection；
- 具体 feature 的业务状态、持久化和 UI；
- 通用 event bus、RPC 框架或自动 discovery；
- 对旧 `hepi-basics` API 的兼容 adapter。

这些能力只有在至少两个独立 extension 有明确的同类需求时，才以单独提案考虑。鼠标与局部文本选择是明确记录的第六个受限例外；它只提供 feature-neutral 的 terminal input、region dispatch 与 local selection contract，不提供页面内容、clipboard policy 或新的 TUI layout tree。

已批准六个限定例外：core 公开 Loadout tool registration contract、提供 global Extension page router 与
feature-neutral TUI host、拥有 root-session-scoped subagent execution contract，并提供 JSON settings file
transport 与 provider registry，并提供 terminal mouse 与 local selection contract。它们的边界分别由
[ADR 0002](../adr/0002-core-loadout-contract.md)、
[ADR 0001](../adr/0001-core-extension-page-shell.md) 与
[TUI 宿主架构](tui.md)、
[ADR 0004](../adr/0004-core-subagent-execution.md)、
[ADR 0007](../adr/0007-core-json-settings-substrate.md) 与
[ADR 0008](../adr/0008-mouse-selection-core-exception.md) 及
[鼠标与局部文本选择 contract](../mouse/README.md) 限制；core 不接管 Loadout policy、page content、
Settings policy、feature-owned schema/content、agent/config/delivery policy 或 clipboard policy。

## Pi 集成边界

Pi extension 的公共入口是 `ExtensionAPI`。它提供 `pi.events` 以及
`session_start` / `session_shutdown` 事件。独立 extension 在同一 Pi runtime 中会获得
不同的 `ExtensionAPI` facade，但共享 `pi.events`。

core 因此以 `pi.events` 作为 runtime identity；没有该字段时才以 `pi` 对象作为
fallback。内部 runtime state 以 `WeakMap` 延迟存放，不会让 session 或 extension
instance 被长期持有。

Pi 没有为大部分 extension 注册面提供公开 unregister。core 的 lifecycle 注册必须以
`runtime identity + stable feature key` 淘汰旧 generation，而不是假设旧 listener 能被
移除。

## 第一阶段公开接口

根入口 `@hheei/pi-ext-core` 只导出实际 consumer 需要的类型与函数，不允许 deep
import。已实现 v1 包含 lifecycle、Service、ExtensionPoint、cleanup、JSON settings/provider registry、
Loadout registration、custom surface runtime、Extension page router API 与 mouse/local-selection transport。Mouse/selection
边界见 [鼠标与局部文本选择](../mouse/README.md)。Subagent execution contract 的边界见
[Subagent 执行架构](subagents.md)，Loadout 细节见 [Loadout 架构](loadout.md)。

### JSON Settings

`readMergedJsonSettingsSection()` 是 extension 的默认 configuration entry。它一次读取 Pi global 与
project settings 文件的同名 object section，并同时返回未解释的 `global`、`project` 与递归合并后的 `merged`。
plain object 按 key 递归合并；scalar、array、`null` 或类型不一致时 project value 覆盖 global value。

调用 `sourceOf(["nested", "key"])` 可定位 effective value 的来源：`global`、`project`、`mixed` 或
`undefined`。`mixed` 只表示该 object 的有效 descendants 来自两层；调用者应继续查询具体 leaf path。key path
是 string array，不解析 dotted key，避免配置键名歧义。

API 不验证 section fields，也不决定某个 project override 是否可信。需要 security/trust 限制的 consumer 必须
读取返回的 raw layers 并自行应用 policy；例如 project 不得选择 user-paid model 时，consumer 不能直接把
`merged` 当作 active configuration。

### Lifecycle

extension 通过 stable key 注册 session-scoped feature。core 串行 start/shutdown，启动
失败时清理已创建资源；重复 reload 只允许最新 generation 处理事件。

stable key 必须是 extension 的 package name，例如 `@hheei/pi-example`。不得使用
临时字符串或自动生成值；key 用于跨 reload 识别同一个 extension。

```ts
registerExtensionLifecycle(pi, {
	key: "pi-example",
	start(context) {
		context.resources.add("example", () => {});
	},
});
```

`start()` 使用 `context.resources` 注册 cleanup。cleanup 必须幂等；它负责该 feature
创建的 timer、listener、process、subscription 和 async operation 的取消。

### Service

Service 是 1:1 的核心资源，例如资料库连接、全局路由或唯一的弹出视窗管理器。一个
runtime 中每个 service ID 保留第一个 provider；后续 provider 不替换它。

consumer 可以同步查询，也可以在自己的 start lifecycle 建立非阻塞 continuation 等待
provider：

```ts
void waitForService(context.pi, databaseService, { signal: context.signal })
	.then((database) => startConsumer(database))
	.catch((error: unknown) => handleConsumerStartupError(error));
```

`signal` 是必填参数。若 service 已存在，`waitForService()` 立即 resolve；若 `signal`
abort，它必须 reject 并移除 waiter；session shutdown 时未完成的 waiter 也必须停止。
Pi 会串行 await `session_start` handler，因此 `start()` 不得直接 await 此 Promise，否则
可能阻塞排在后面的 provider。consumer 自己决定 deadline、等待失败后的降级或后续初始化，
不允许 core 无限等待。core 为该 Promise 附加 no-op rejection observer，防止 caller 尚未
处理时触发 host-level unhandled rejection；公开 Promise 的 reject 语义不变。

Service key 只提供 TypeScript generic 标记，没有 runtime schema 或跨 package validation。
独立 package 用相同 ID 时，类型与语义兼容由单一开发者的约定负责。

公开 API 以本地声明的 generic key 为参数：

```ts
const databaseService = createServiceKey<Database>("@hheei/pi-database/service");

const provided = provideService(context, databaseService, connection);
getService(pi, databaseService);
await waitForService(pi, databaseService, { signal });
```

provider 和 consumer 可以各自用同一 ID 建立 key。`provideService()` 接收 lifecycle
context，不返回手动 disposer；当前 provider 的 resource registry 在 failed startup cleanup
或 session shutdown 时移除 service。Service 在 session-ready 后不得中途移除。若已有
provider，函数返回 `false`，保留 first provider，后注册者自行 no-op。

### ExtensionPoint

ExtensionPoint 用于可扩充的 1:N 行为。point owner 只能有一个，用来声明该 point 的
语义和消费 hook 的方式；其他 extension 可为同一 point 注册多个 hook。一个 hook 的
disposer 只移除自己的 registration generation。

典型场景是工具、路由或 UI surface 的可选 feature。ExtensionPoint 不等同于通用 event
bus：hook 只在 point owner 明确定义的调用位置运行，不能广播任意事件、读写其他
extension 的状态或提供同步 RPC。

owner 的 subscription 先接收已有 hook，再动态接收 add/remove。subscription 接受
必填的 `AbortSignal`，并在 session shutdown 时自动清理。abort 后 core 立即解绑，不能再
调用 owner callback。hook payload 使用 generic key 的 TypeScript 类型约束；独立 package
间的兼容性由约定负责。

hook add 先注册再调用 `onAdd`；hook remove 先移除再调用 `onRemove`。callback 的同步或
async 异常不做 rollback、failure state 或自动重试。hook registration 立即返回 handle；
其 `ready` Promise 反映 `onAdd` 的成功或失败，使 caller 可自行 catch，同时仍持有
`dispose`。core 创建 `ready` 时会附加内部 no-op rejection observer，避免 caller 尚未
await/catch 时触发 host-level unhandled rejection；该 observer 不改变公开 `ready` 的 reject
结果。hook 注册不应包含容易失败的复杂安装逻辑；需要该逻辑的 owner 自行 catch 并处理。

公开 API 将是：

```ts
const point = createExtensionPointKey<FormatterHook>("@hheei/pi-tools/formatter");

const owner = openExtensionPoint(pi, point, { signal, onAdd, onRemove });
await owner.ready;

const hookRegistration = registerExtensionHook(pi, point, hook);
await hookRegistration.ready;
await hookRegistration.dispose();
```

`openExtensionPoint()` 是唯一 owner registration，并先安装已存在的 hook；
`registerExtensionHook()` 在 owner 已打开时建立 `ready`。两者都返回 handle；handle 的
async `dispose()` 只清理自己的 registration generation。

### 高吞吐执行点

零拷贝 context 是业务 ExtensionPoint owner 的职责，而不是 `pi-ext-core` 的通用状态。
例如工具 extension 可以建立一个 context object，并把同一 object reference 传给已筛选的
hook；core 不 deep clone、spread 或合并该 object。

context 在建立时必须一次定义所有固定字段。核心资料在 TypeScript 层标为 `readonly`；
二进制 buffer 的实际写入权仍由 owner 的接口约定控制，不能把 `readonly` 误当作 runtime
immutable security boundary。extension 专属中间状态放在注册期建立的私有 mount registry，
不得动态新增或删除 context property，也不得使用 `any`。输出使用 owner 建立的稳定 array
buffer，并由 hook append；owner 负责定义结果类型和 flush 时机。

为了避免每次执行逐个调用 `canHandle()`，hook 在 registration 时声明稳定的 `topics`。
owner 以 topic 索引 hook；执行时只取得匹配 topic 的 hook。必要时，匹配后的 hook
可以有第二层 `canHandle(meta)`，但它不用于取代 topic index。hook 的 `execute(context)`
接收同一 context reference，并不得新增、删除或替换其顶层字段。

该机制保持 hot-path object shape 稳定、避免无关 hook 调用，并允许 owner 以常数额外状态
传递多个 extension 的结果。具体工具 context、topic 名称、mount state、输出格式和 topic
index 都留在该工具 package，不能提升为 core 产品语义。首个工具实现只需遵守本节规则；
有实际重复后才经用户确认抽取 generic `ExecutionPoint`。

Service 和 ExtensionPoint 的 key 均使用稳定、namespaced string ID。双方从各自 generic
key 获取 TypeScript type，独立 package 不建立互相 import。

### Reload 边界

Pi `/reload` 会先发出 `session_shutdown`，重建 extension runner，再发出
`session_start`。Service provider 必须只依赖这个完整 lifecycle 边界完成清理与重新注册；
v1 不提供单一 Service 的 HMR 覆盖、replace 或强制后门。reload 后第一个 provider 再次
获胜，符合 first-provider-wins 规则。

### Cleanup Ownership

lifecycle context 提供一个小型 disposer registry，供 feature 把资源 cleanup 集中在
自己的 session owner 下。registry 以逆序 cleanup，继续尝试其余 disposer，并将失败
汇总给调用者。它不创建后台工作或全局 timer。

## 并发与错误规则

- 每个 lifecycle transition 串行；不得并行 start 与 shutdown。
- async operation 接受 `AbortSignal` 时必须传入；session replacement 后的 late result
  必须用 runtime revision 拒绝。
- Service duplicate provider 保留 first provider 并返回 `false`；ExtensionPoint 重复 owner
  仍立即抛错。
- Service waiter abort、shutdown 或 resolve 后必须从 registry 移除，不能遗留 listener。
- lifecycle `start()` 不得 await `waitForService()`；consumer 以 non-blocking continuation
  等待晚到 provider。
- Service 只允许 provider lifecycle 的 failed-start cleanup 或 shutdown 移除；已 ready 的
  provider 不得中途 dispose。
- ExtensionPoint subscription 交付已有 hook 与动态 add/remove；其 `AbortSignal` 必须
  解绑 subscription。
- core 不保存 `ExtensionContext`、component 或 session object 到 process-global state。

## 跨包兼容策略

独立 package 不直接 import。Service 与 ExtensionPoint 是 core 提供的高层兼容模型，
不是 feature-specific contract package。出现无法由这两种模型表达的真实兼容需求时，先
由更低层 package 提供兼容实现；该形态在多个 package 中被证明通用后，才向用户提出
提升 core API。不确定时，先向用户说明并研究可行架构。

## Package 解析策略

Pi 的 managed npm install 会把 extension 及其 production dependencies 安装到同一 scope
root；因此建议每个 `pi-<name>` 把 `@hheei/pi-ext-core` 声明为 direct `dependencies`，
并在 bundle 时 externalize。core 不声明 `pi.extensions`，不会被 Pi 当作 extension 加载。

不同 package version 或 local development 仍可能让多个 core module instance 同时存在。
runtime registry 因此必须通过 `globalThis` 的稳定 symbol name 共享，不能仅依赖 ESM module
singleton。

## 包和测试布局

已建立：

```text
packages/pi-ext-core/
  package.json
  src/
    index.ts
    runtime-identity.ts
    lifecycle.ts
    service.ts
    extension-point.ts
    disposer-registry.ts
  test/
    runtime-identity.test.ts
    lifecycle.test.ts
    service.test.ts
    extension-point.test.ts
    disposer-registry.test.ts
```

已实现 API 先建立公开类型与函数签名，再写 focused tests，最后实现。下一阶段 Loadout tests 的
具体范围由 [Loadout 架构](loadout.md) 定义；不为尚未存在的 UI 或 settings behavior 预建测试。

## 已确认决策

1. v1 实现 runtime identity、lifecycle、Service、ExtensionPoint 和 disposer registry；
   不迁移任何
   `hepi-basics` 专属 API。
2. Service duplicate provider 保留 first provider 并返回 `false`；ExtensionPoint owner
   保持 1:1 fail-fast，hook 是 1:N registration。
3. Service consumer 可以用带 `AbortSignal` 的 Promise 等待 provider，避免加载顺序
   导致的启动脆弱性。
4. lifecycle stable key 使用 extension 的 package name。
5. ExtensionPoint owner 动态接收已有与晚注册的 hook；subscription 使用
   必填的 `AbortSignal` 清理。
6. Service value 与 ExtensionPoint hook payload 只使用 TypeScript generic key 约束；
   不做 runtime validation，兼容性由单一开发者约定负责。
7. hook add/remove 不做事务或 rollback；registration handle 的 `ready` 反映 callback
   error，caller 仍可 `dispose`。
8. feature package 将 core 声明为 direct production dependency 并 externalize；runtime
   registry 使用 stable `globalThis` symbol 跨重复 module instance 共享。
9. breaking contract 不做 semver negotiation，由单一开发者依 TypeScript 约定维护兼容。
11. 高吞吐工具以 registration-time topic index 筛选 hook；context 由业务 owner
    零拷贝建立，使用固定 shape 和私有 mount registry。v1 不抽取 generic
    `ExecutionPoint`；有实际重复后才重新提案。
12. ExtensionPoint owner subscription 的 `AbortSignal` 必填；abort 后不得再交付 hook。
13. Service provider 只可在 failed-start cleanup 或 session shutdown 移除；
    `provideService()` 由 lifecycle context 代管 cleanup，不暴露手动 disposer。
14. core 为每个 `ready` 附加 no-op rejection observer；公开 Promise 的成功或失败语义不变。
15. v1 只支持 Pi 完整 reload lifecycle，不提供单一 Service HMR replace 后门。
16. Pi 串行 session start 下，consumer 不得 await `waitForService()`；改以自行处理的
    non-blocking continuation 等待 provider。
17. Mouse/selection contract 是第六个受限 core 例外；其测试使用 pi-ext-core focused fixtures 与
    `tui-replay`，不把 frozen `hepi-debug` 当作产品 consumer。tracking lease 期间 surface 暂时拥有
    terminal mouse input，native selection 可能受影响；core 依赖 Pi TUI 已完成的 input sequence boundary，
    不读取 `process.stdin` 或建立第二个 stdin buffer。region registry 只在 layout snapshot 更新时改变，
    不得由 `render(width)` 隐式修改。
