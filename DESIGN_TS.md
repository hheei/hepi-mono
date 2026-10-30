## TypeScript 规范与工程约定

### 1. 严格基线与编译器设置
- **MUST** 保持最严格的 TypeScript 设置，包括 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`；**NEVER** 放宽编译器配置来掩盖类型问题。
- 共享基线为根目录 `tsconfig.base.json`，所有 package 的 `tsconfig.json` 必须继承该基线。
- 保持 `compilerOptions.types` 为显式白名单，禁止污染全局命名空间。

### 2. 不可信边界与运行时收窄
- 只在真实不可信边界验证数据：文件 I/O、JSON 解析、环境变量、网络請求、第三方库返回以及 `catch (err)`。
- 外部数据使用 `unknown` 接收并在边界立即收窄；小型数据结构优先使用纯函数类型守卫（type guards），复杂/共享契约优先使用现有的 TypeBox schema。
- **NEVER** 在业务层之间无目的地传递 `unknown`，收窄后应以确定性领域模型流转。

### 3. 禁止与受限模式
- **NEVER** 使用显式 `any`、`@ts-ignore`、`@ts-nocheck`、生产代码非空断言（`!`）、`enum` 或 `namespace`。
- 生产代码 **NEVER** 使用 `as unknown as T` 进行强制类型双重断言。真正的互操作缺口（如第三方库类型不匹配或私有 API 临时挂载）必须使用窄范围 `as`，并让注释依据紧贴该行。
- 临时 `@ts-expect-error` 必须附带明确的理由和移除条件（如上游 issue 编号）。
- 鼓励使用 `as const` 固定字面量类型。

### 4. exactOptionalPropertyTypes 最佳实践
- 严格区分「字段缺省」与「显式 `undefined`」。上游库（如 `@earendil-works/*`）很多属性声明为 `prop?: T` 而非 `prop?: T | undefined`。
- 向外部或公共 API 构造对象时，对于未定义的可选属性，优先在字面量中省略该 key，或使用条件展开（`...(val !== undefined ? { val } : {})`），避免直接赋值 `undefined` 触发类型报错。

### 5. 异步生命周期与 Promise 契约
- 每一个 Promise **MUST** 被 `await`、`return`、显式处理 rejection，或使用 `void` 明确标明有意放弃等待。
- 禁止用类型断言掩盖取消（AbortSignal）、清理（Disposer）、错误传播或资源生命周期。

### 6. 测试用例与 Fixture 规范
- 测试代码同样遵循类型严格，禁止为了省事滥用 `as unknown as T`。
- 例外：`biome.json` 对 `packages/*/test/**` 关闭 `noExplicitAny`。测试替身要顶替 Pi host 的`ExtensionAPI`、事件、模型等外部对象，逐一补齐成员只会把上游类型复述一遍，却不检验被测行为；生产代码仍为 error。能用工厂函数（见下条）表达的数据结构仍应优先工厂，不要因该例外放弃可读性。
- 面对复杂上游模型（如 `AssistantMessage`、`SessionEntry`、`Usage`），优先编写集中式工厂函数（如 `createAssistantMessage`、`createSessionEntry`）填充符合规范的默认字段。
- 测试 fixture 在已知且不变的前置断言下，允许使用非空断言 `!`。
- 验证联合类型或历史条目时，优先使用判别联合守卫（如 `if (entry?.type === "compaction")`），使 TypeScript 自动收窄类型。
