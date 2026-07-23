# HEPI TypeScript Design

本文是 `hepi-mono` 的 TypeScript 设计规范，适用于 `packages/*/src`、测试和仓库脚本。它结合本仓库的严格编译规则与 Pi 上游 `v0.80.10` 的实际写作风格。

当本文与代码冲突时，新代码遵循本文；迁移旧代码时保持行为优先，不为统一风格做无关重写。当本文与 `AGENTS.md` 冲突时，以 `AGENTS.md` 为准。

## 1. 设计目标

HEPI TypeScript 应具备以下特征：

- 严格：不把未验证数据伪装成可信类型。
- 显式：公开 API、状态变体、错误和生命周期可从类型与命名看出。
- 窄：模块导出真实消费者需要的最小契约。
- 可组合：通过函数、对象契约和依赖注入组合，不靠继承层级。
- 可清理：异步工作、session state 和外部资源都有 owner。
- 可测试：测试观察公共行为和协议，不绑定私有实现。

Pi 上游的代表性模式是“公开 interface/type + 工厂函数 + 私有或局部可变实现”。HEPI 采用该方向，但保留本仓库更严格的 `any`、非空断言和 exact optional 规则。

## 2. 编译基线

根项目保持：

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noEmit: true`
- `moduleResolution: "Node16"`
- 显式 `compilerOptions.types` allowlist

不得通过降低 compiler option、扩大 global types 或跳过文件来解决类型错误。

新代码只使用可擦除的 TypeScript 语法：

- 不使用 `enum`；使用字面量联合或 `as const` object。
- 不使用 `namespace` / `module`。
- 不使用 parameter property；字段显式声明，constructor 内赋值。
- 不使用 `import =` / `export =`。
- 不依赖 decorator metadata 或其他必须经过特殊 emit 的类型语法。

本仓库目前没有启用 `erasableSyntaxOnly`，但新代码仍遵守该子集，避免源码直跑环境与未来编译配置分裂。

## 3. 模块边界

### 3.1 导出契约，不导出内部结构

公开模块优先导出：

- 数据 contract；
- 窄 interface；
- discriminated union；
- 工厂函数；
- 少量稳定 helper。

内部 Map、cache、mutable state、具体 controller 和 parser 不因“可能有用”而导出。

当读写能力不同，拆成只读与可变契约：

```ts
export interface FeatureCatalog {
	get(id: string): Feature | undefined;
	list(): readonly Feature[];
}

export interface MutableFeatureCatalog extends FeatureCatalog {
	register(feature: Feature): () => void;
}
```

只有真实调用方需要替换实现时才增加 interface。单一实现、单一调用点的局部逻辑使用函数或普通对象。

### 3.2 Import 规则

- type-only dependency 使用 `import type`。
- value 和 type 来自同一模块时，可在同一 import 中使用 `type Foo`。
- 相对 ESM import 使用 `.js` specifier，匹配本仓库 Node16 配置。
- 默认使用顶层静态 import。
- `await import()` 只用于真实 optional dependency、延迟加载重依赖或运行时平台分支；不得用于绕过 package boundary。
- feature 只从 `@hheei/pi-basics` package root import，不使用 `src/**` 深路径。
- 不建立 feature-to-feature import。

Pi 上游源码使用 `.ts` specifier，因为其 compiler 启用了 `allowImportingTsExtensions` 和 `rewriteRelativeImportExtensions`；HEPI 没有该配置，不照搬。

### 3.3 Composition root

每个 `pi.extensions` entry 只负责：

1. 创建本包 objects。
2. 注册 tools、commands、settings 和 events。
3. 绑定 session lifecycle。
4. 注册 cleanup。

entry 不承载 reducer、schema parser、storage algorithm 或 rendering algorithm。

## 4. 类型建模

### 4.1 `interface` 与 `type`

使用 `interface` 表达：

- 对象能力；
- 公共 API；
- 依赖注入边界；
- 预期被浅层扩展的 genuine subtype。

使用 `type` 表达：

- union；
- tuple；
- function type；
- mapped/conditional type；
- 局部结构组合；
- 从现有 union 派生的类型。

```ts
export type OperationState =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly requestId: string }
	| { readonly kind: "failed"; readonly message: string };

export type ToolCall = Extract<MessagePart, { readonly type: "toolCall" }>;
```

不要建立 interface inheritance chain。一个真实 subtype 可使用一次浅层 `extends`；更复杂关系使用组合。

### 4.2 Variant state

variant state 必须使用 discriminated union，不使用多个可能冲突的 boolean：

```ts
type SaveState =
	| { readonly status: "idle" }
	| { readonly status: "saving"; readonly revision: number }
	| { readonly status: "error"; readonly message: string };
```

处理完整 union 时使用 exhaustive `switch`：

```ts
function label(state: SaveState): string {
	switch (state.status) {
		case "idle":
			return "Idle";
		case "saving":
			return "Saving";
		case "error":
			return state.message;
		default: {
			const neverState: never = state;
			return neverState;
		}
	}
}
```

### 4.3 Optional property

`property?: T` 表示 key 可以不存在。只有“key 存在但值可为 undefined”属于真实语义时，才写 `property: T | undefined`。

构造 exact optional object 时按 presence 展开：

```ts
const options = {
	...(signal === undefined ? {} : { signal }),
	...(headers === undefined ? {} : { headers }),
};
```

不要为省事写入一批值为 `undefined` 的 optional keys。

### 4.4 标识符

当同一 domain 中多个 primitive ID 容易混用，并且有明确构造或验证边界时，使用 branded type。第三方 opaque ID 不因形式相同就强行 brand；这会制造散落 assertion。

## 5. `unknown`、验证与断言

### 5.1 不可信边界

API response、JSON、文件、环境变量、extension payload 和第三方数据先视为 `unknown`。

小结构使用 focused type guard：

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

共享或复杂结构使用仓库已有 TypeBox。不要引入第二套 schema library。

### 5.2 `any`

显式 `any` 禁止，包括 generic default。使用 `unknown` 并在边界 narrowing。

Pi 上游在 `Model<any>`、`AgentToolResult<any>` 等历史或开放扩展边界仍有少量 `any`；这不是 HEPI 规范。HEPI 已由 Biome `noExplicitAny` 强制更严格规则。

### 5.3 Type assertion

优先验证，不使用 assertion 代替验证。允许的 assertion 只限 TypeScript 无法表达的 interop gap，并应局部化。

- `as const` 用于 literal preservation，推荐。
- 生产代码禁止 non-null assertion。
- 测试可对 fixture invariant 使用 non-null assertion。
- 测试构造巨大第三方 interface 的窄 fake 时，可在 helper 边界使用一次 `as unknown as ExternalType`；不要把该 assertion 传播到测试主体。

禁止 `@ts-ignore` 和 `@ts-nocheck`。临时 `@ts-expect-error` 必须写原因和移除条件。

## 6. 只读与状态所有权

公共数据默认 `readonly`：

- property 使用 `readonly`；
- collection 返回 `readonly T[]` 或 `ReadonlyArray<T>`；
- shared state 通过 immutable update 替换；
- 输入 array 在保存前复制。

这不要求全仓库纯函数。Map、Set、queue、cache 和 transcript 可以局部 mutation，但必须由一个 object/function scope 明确拥有，不能让多个 feature 任意修改同一容器。

```ts
class Registry {
	readonly #values = new Map<string, Value>();

	list(): readonly Value[] {
		return [...this.#values.values()];
	}
}
```

跨 extension runtime identity 使用宿主共享对象，例如 `pi.events`；不要用每个 extension 独有的 `ExtensionAPI` facade 作为共享状态 key。Module、Settings 等 live contribution registry 必须按该 identity 隔离，不能直接把 contribution 存在 process-global Map 中。

## 7. 函数、class 与依赖注入

### 7.1 函数优先

纯转换、validation、formatting 和单次 operation 使用函数。只有需要持有 lifecycle state、cache、Map 或 queue 时使用 class/controller。

单一调用点的一行 helper 直接 inline。helper 应减少真实重复或隔离复杂 contract，不按代码形状机械抽取。

### 7.2 工厂函数

使用 `createX(options)` 组装 stateful object，让依赖可注入、测试可替换：

```ts
interface StoreOptions {
	readonly backend?: StorageBackend;
}

export function createStore(options: StoreOptions = {}): Store {
	const backend = options.backend ?? createMemoryBackend();
	// ...
}
```

默认实现应轻量、确定，通常是 memory/default implementation。不要为单一实现建立 factory + interface + adapter 三层。

### 7.3 Class

class 适合稳定 owner，不用于模拟 namespace。字段显式声明：

```ts
class Controller {
	private readonly store: Store;

	constructor(store: Store) {
		this.store = store;
	}
}
```

不使用 parameter property。public mutation method 应表达业务动作，不直接暴露 mutable field。

## 8. Async、取消与生命周期

### 8.1 Promise ownership

每个 Promise 必须：

- `await`；
- `return`；
- 带 rejection path 处理；
- 或用 `void` 明确表示 intentionally detached。

exported async function 显式声明 `Promise<T>`。同步或异步 callback 契约可写 `T | Promise<T>`，但不要到处包装不必要的 `async`。

### 8.2 AbortSignal

可取消 operation 接受 `AbortSignal`，并沿调用链传递。不要在下层悄悄新建无法被 owner 取消的 controller。

- session-scoped owner 在 shutdown 时 abort。
- 单次 operation owner 在 replacement/revision change 时 abort。
- late result commit 前检查 session/revision。
- abort 是预期终止时，不显示成普通错误。

### 8.3 Cleanup

创建 timer、watcher、socket、process、UI component、handler registration 或 AbortController 的代码，也负责注册 cleanup。

cleanup：

- 幂等；
- 逆序执行；
- 一个 cleanup 失败不阻止其他 cleanup；
- unregister handle 只能删除自己注册的当前值；
- start 部分失败也清理已创建资源。

跨 session state 使用 `HePiLifecycleController` 和 runtime registry。extension factory 不启动长生命周期资源。

## 9. 错误设计

### 9.1 抛出还是返回

- programmer error、invalid state、collision：立即 throw，消息包含具体 ID/operation。
- 用户或外部输入失败：在 boundary 验证并返回 domain result，或按现有 API contract throw。
- stream/tool/event 已定义错误事件时：转换进协议，不在协议外另开异常通道。
- best-effort query 可返回空值，但必须是明确 contract，不得静默吞掉数据损坏或 persistence failure。

捕获 `unknown`：

```ts
const message = error instanceof Error ? error.message : String(error);
```

包装外部错误时保留 `cause`。只有调用方需要按错误类别分支时才创建 custom Error class。

### 9.2 Event handler

事件必须说明：

- handler 顺序；
- 是否串行；
- 返回值如何合并；
- 是否短路；
- 错误是否隔离；
- cancellation 如何传播。

不要假设所有 event 都有相同 middleware 语义。

## 10. 命名与注释

命名直接表达动作和 owner：

- `createX`：创建 object。
- `getX`：读取；若同时承担 lazy create/rebind，必须由公开 contract 明确说明，例如 `getToolActivationCoordinator()`。
- `setX`：替换值。
- `registerX`：注册能力，能清理时返回 unregister function。
- `resolveX`：按规则计算或查找。
- `parseX`：从外部表示转换，失败语义明确。
- `validateX`：验证，不隐式持久化。
- `runX`：执行完整 operation。
- `dispose` / `close`：释放 owned resources。

function/variable 用 `camelCase`，type/interface/class 用 `PascalCase`，固定常量用 `UPPER_SNAKE_CASE`。

注释写 contract、原因、失败语义、并发顺序和不直观限制。不要复述代码。公开 callback 的默认值、throw/return、abort 和 ownership 值得写 JSDoc。

## 11. 测试风格

测试公共行为：

- 输入输出；
- event 顺序；
- payload shape；
- duplicate registration；
- abort；
- repeated shutdown；
- reload/session replacement；
- collaborator 缺席；
- narrow/wide TUI layout。

不测试 private method 或实现使用了哪个 helper。使用 in-memory store、faux provider、deferred Promise 和最小 host fake，避免 real API、真实凭据和不稳定时间依赖。

回归测试应先证明旧实现会失败，再证明修复后的公共 contract。fixture assertion 集中在 helper 边界。

## 12. 避免的模式

- 万能 module framework。
- feature-to-feature import。
- 为未来需求预建 registry、adapter 或 config。
- process-global mutable state 没有明确 runtime identity 和 cleanup。
- 多个 boolean 表示互斥状态。
- 用 assertion 代替 boundary validation。
- 用 event bus 模拟同步 RPC 或共享状态。
- 深 class inheritance。
- 一个 implementation 对应一个无必要 interface/factory。
- 捕获所有错误后返回空值。
- extension entry 包含业务算法。
- 为修 type error 放宽 compiler/linter。

## 13. 上游参考

研究基线：Pi `v0.80.10`，commit [`8dc7883`](https://github.com/earendil-works/pi/tree/8dc78834cde4e329284cf505f9e3f99763df5529)。

- [上游开发规则](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/AGENTS.md)
- [上游 TypeScript 配置](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/tsconfig.base.json)
- [上游 Biome 配置](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/biome.json)
- [`AgentLoopConfig` callback contracts](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/types.ts#L108-L281)
- [`agent-loop.ts` state/event flow](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/agent-loop.ts#L90-L347)
- [`ImagesModels` read/write contracts and implementation](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/images-models.ts#L12-L130)
- [`EventBus` contract and error isolation](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/event-bus.ts)
- [`Component` and TUI ownership contracts](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/tui/src/tui.ts#L52-L120)
