# Pi Durable 调研：持久执行底座与 TUI／功能分离

> 调研日期：2026-10-04。本文是研究与迁移建议，**不是已批准的架构或实现规格**。
> 本轮不修改代码、依赖、公共 API、会话格式或现有 UI 契约。
>
> 上游：[earendil-works/pi](https://github.com/earendil-works/pi)，固定 revision
> `200387122ca450d6387f033949423114a270b96c`；该 revision 的
> `@earendil-works/pi-durable` 为 **1.0.2**，仍明确标记为 Experimental。
> 本仓库基线：`1d9b1378f9aea2912f23fd4e7185014fe167f29c`。
> 下文区分上游事实与本项目建议，引用索引见文末。

## 1. 结论先行

**值得以 Pi Durable 为候选执行底座，逐步把本仓库变成“功能运行时 + 独立 TUI 客户端”；不适合把它当作换一个依赖名即可完成的 rebase。**

1. **它是什么：**基于 pi-ai 与 Chord 的持久 agent harness，提供会话、工具调用、自定义任务、事务状态、恢复、分叉和订阅；不是 TUI 框架，也不是现有 Pi coding agent 的替代发行版。[S1][S2]
2. **为什么契合目标：**执行状态先提交到存储，再向观察者发布。TUI 可以读取同一份已提交视图，而不拥有执行循环。官方 demo 已通过 DurableView、DurableViewSource、DurableController 分隔运行时和终端。[S3][S4]
3. **为什么不能直接整体切换：**Pi Durable extension 是工具、提示词段、hook、wrapper 与 task 的命名集合，不是本仓库使用的 ExtensionAPI／ExtensionContext。官方 durable coding-agent demo 明确没有现有扩展加载、完整会话选择／树导航、图片和 /login 等功能。[S2][S3]
4. **主要风险是语义迁移：**工具重放、取消、后台工作的归属、交付去重、fork 时业务状态如何复制，以及旧会话能否继续，都需要明确设计。[S2][S5]
5. **建议首步：**以一个小功能建立 headless 路径，再让 TUI 消费它；todo 是候选切片，不先搬最复杂的子 agent、记忆或整个 editor。这是建议，尚未实施。

这里的“rebase”按**架构底座迁移**理解，不是把本 monorepo 对上游 Pi 执行 Git rebase。

## 2. 来源、成熟度与组件关系

Earendil 在 Pi 1.0 同期推出 Pi Durable；发布文章明确说它用于长期运行、可恢复、能从多个 surface 访问的 agent 应用，**不替代 Pi coding agent**。CHANGELOG 记录初版为 2026-10-01，1.0.2 为 2026-10-04；README 警告 API 可以在版本间不经通知变化。因此，版本号 1.0.x 不能解读成 durable API 已稳定。[S1][S2][S6]

该版本直接依赖 Chord、pi-ai、diff 和 TypeBox，没有把 pi-coding-agent 或 pi-tui 作为自身直接依赖；Node engine 为 >=22.19.0。本仓库当前 Node 下限相同，但 Pi host 开发依赖仍为 1.0.0，不能据此假定跨版本 API 已兼容。[S7][L1]

```text
pi-ai                         模型／供应商访问
  │
pi-durable + Chord             会话、任务、事务状态、持久化、订阅
  │
应用运行时                     功能策略、权限、配置、工具、交付规则
  │
TUI／headless／未来远程客户端   展示与显式控制
```

这是概念关系，不是本仓库已批准的新 package 图。现有 Pi coding agent 仍是另一套完整 host；官方 demo 会复用其中的模型运行时、认证、设置和终端组件。[S1][S3][S4]

## 3. Pi Durable 实际提供什么

### 3.1 会话与执行模型

| 概念 | 责任 | 不能混淆的事情 |
| --- | --- | --- |
| Harness | 打开一个存储并运行任务／会话 | 不等于完整 CLI 或 UI host |
| Conversation | 独立 transcript、agent 配置、输入队列 | 不等于现有 AgentSession |
| Entry | 不可变记录，如用户消息、工具结果、系统提示变化 | 原始视图记录不直接等于模型上下文 |
| Document | 与记录一起提交的可变 JSON 状态 | 不保存函数、终端组件或运行时 handle |
| Task | 带 checkpoint 和 ownership 的持久状态机 | 不等于本仓库产品后台 Task 状态 |
| Submission | 已受理的输入／写入与结算状态 | submit 返回不代表回答完成 |
| Registry／Extension | 进程安装的可执行定义与命名集合 | 存储保存名字，不保存代码 |

以上来自 README 与规范。[S2][S5]

```text
submit(input) → 持久受理／队列 → generation task
                                  ├─ 模型响应
                                  └─ tool task × N → 工具结果
                               → 后续 generation → 最终回答／失败
```

每个 conversation 可选择模型、thinking、扩展、工具、instructions 和执行目录。task-owned 子会话在创建时复制 owner 的 agent 配置；之后 owner 的变更不会自动传播。显式 fork 可选择历史切点，agent 随该切点复制。[S2][S5]

### 3.2 恢复不等于“所有操作恰好执行一次”

工具执行前提交 intent。崩溃后，声明 replay: safe 的工具可重跑；默认不安全的工具得到 interrupted 结果，由模型决定下一步。未完成模型请求可能再次发送。requestId 解决同一 conversation 内 submission 的重复受理，**不保证外部命令、网络副作用或账单 exactly-once**。[S2][S8]

该 revision 的内置 read/write/edit/bash 定义没有声明 replay: safe，不会因为某个工具看起来是读取操作就自动安全重放。逐工具审核真实语义是应用责任。[S8][S9]

对本仓库的直接含义：

- 搜索、读取是否可重放，需要考虑执行环境、cwd、远端状态和输出语义。
- shell、文件修改、发布和远程命令不能整体标成 safe；需要外部幂等键、结果记录或明确禁止重放。
- tool／hook 若恢复后重复运行，审批和交付决定也必须有持久依据；task memo 不是外部副作用事务。[S1][S5]
- 重试和自动压缩会产生模型调用。迁移后仍需让触发原因、次数、模型和恢复行为可检查，不能因框架支持就默认开启不透明自动化。[S2][L2]

### 3.3 存储的保证边界

提供 Memory、SQLite、JSONL，以及自定义后端 conformance suite。Memory 不跨进程持久化；SQLite 使用 WAL 与 synchronous=NORMAL，进程崩溃和断电／主机故障不是同等级保证。[S2][S10]

**特别注意 JSONL：**README 存储表对 fsync 的简述容易让人以为每个确认提交都同步落盘；规范与源码更精确：fsync=true 时先 flush sidecar，再 append main marker，普通提交没有显式 flush main 文件。最新已确认提交仍可能在断电时丢失。不要把 durable 写成零数据损失承诺。[S5 §11.3][S11]

一个存储只能有一个进程 owner，存储层没有跨进程锁。官方本地 demo 在应用层使用 proper-lockfile 阻止重复打开；这是 host 的生命周期责任，不是 SQLite 自动解决的问题。[S2][S12]

### 3.4 扩展、执行环境与热替换

defineExtension 可注册 tools、sections、hooks、wraps 与 tasks。工具参数由 schema 验证；env 为每次使用构造执行环境，可按 conversation 映射本地目录或远端环境。环境接口提供执行能力，**本身不等于权限审批或沙箱隔离**。[S2][S5]

registry 可热替换同名 extension；已经开始的调用继续用旧实现，后续工作使用新实现。卸载不意味着可立即销毁旧调用仍在使用的资源。[S2][S5 §12]

默认 conversation 选择所有已安装扩展，后选中的同名工具替换前者。迁移 Loadout 时应显式处理选择、冲突和权限，不把注册顺序当作隐形策略。[S2][L3]

## 4. 对 TUI／功能分离的支持

### 4.1 已有的真实边界

Pi Durable 的核心规则是：**只发布已经提交的状态**。Conversation.viewState 给客户端当前结构化视图和更新；watch 给完整 commit 的 Chord operations；watchEvents 给 coding-agent 风格事件，但事件 API 也属于实验性接口。[S2][S5]

官方 durable demo 的组织：

| 文件 | 所有权 |
| --- | --- |
| runtime.ts | Harness、状态订阅、控制操作、提示映射和清理 |
| harness-setup.ts | 模型／HTTP／设置、registry、执行环境 |
| prompt.ts／subagent.ts | 提示词功能与子会话工具 |
| tui.ts | 使用 Pi interactive components 渲染和处理输入 |
| sessions.ts | 会话目录、选择、进程锁 |
| main.ts | 启动、连接 runtime 与 TUI、关闭 |

main 先 openDurable，再将 view、controller 与 UI 设置交给 TUI；业务不需要通过终端 component 才能执行。vacation demo 把编码功能换成旅行规划，展示执行底座与应用内容可独立变化。[S3][S4][S13]

**但 demo 仍是单进程，并引用 coding-agent 内部模块。** 它证明运行时／表现边界可行，不证明已提供稳定可安装的 TUI SDK、远程服务端、通用前端协议或旧扩展兼容层。[S3][S4]

### 4.2 本仓库应该落实的边界

建议把“完整分开”定义成可验证的能力，不是仅把文件移进 ui/：

```text
TUI 或 headless ──显式功能操作──► 应用／功能运行时
                                      │
                                      ▼
                                Pi Durable → 模型／执行环境
                                      │
                                   原子提交
                                      │
功能只读视图／工具语义结果 ◄─────────────┘
         │
         ▼
TUI 渲染、折叠、导航、复制、ANSI／单元格布局
```

- **功能层：**领域状态、工具语义结果、执行／取消、审批与交付策略；无 theme、terminal、editor 或 component 依赖。
- **应用 host：**Harness、存储锁、模型配置、环境 ownership，功能安装与公共操作，以及完整关闭。
- **TUI：**输入映射、布局和显示状态，不拥有真实任务进度、业务状态或恢复判定。
- **持久化：**需要恢复的状态与相应记录在同一 commit 内更新；光标、折叠状态、临时浮层不默认持久化。

这是建议责任，不预先命名新包或设计统一 plugin 框架。先用实际消费者证明边界，再确定 package ownership。[L2][L4]

### 4.3 订阅不是完整审计日志

慢速 watch 最多保留 100 个未交付 frame，溢出后用最新完整视图替换积压；重连从当前状态开始，不回放所有中间变化。实时 partial／工具输出通常按最多每 100ms 提交的节奏更新。[S2][S5 §9、§12]

因此，“重要读取、命令、编辑、委派、重试和模型变更可检查”不能只靠实时订阅。必须审计的事实应进入不可变记录或专属日志；重新挂载 TUI 时按 ID 查完整结果。渲染折叠、模型侧截断与完整结果存储继续分开。[S5][L2]

## 5. 本仓库现状与迁移落点

现有约定已经让具体 extension 拥有功能／策略／渲染，ext-core 提供共享生命周期与协调。但 ext-core 仍以 Pi host 的 ExtensionAPI、ExtensionContext、pi.events identity、session lifecycle 和 TUI 接口为边界；它不是现成的 host-neutral 功能底座。[L3][L4][L5]

源码也存在执行与展示同处工具定义的情况，如 pi-ext-tools 的 renderCall/renderResult；todo/model.ts 中有显示 glyph／tone。这不自动意味着当前代码错误，但“已有 model.ts”不等于“完全无 UI 依赖”。[L6]

| 区域 | 可沿用／提取的责任 | 需要重审的责任 |
| --- | --- | --- |
| pi-ext-tools | 文件／搜索算法、参数、语义结果、远程能力 | 注册、进度、完整输出、replay、嵌套工具渲染 |
| todo | 状态变换与操作校验 | doc 的 fork 策略、工具结果与 TUI glyph 分离 |
| pi-settings／Loadout | schema、显式选择／冲突策略 | 安装契约、registry 映射、缺少能力时如何报错 |
| pi-status／debug | 指标解释、可观察性需求 | 从 views／task graph 取数，editor 与 render ownership |
| pi-subagents | agent 定义、模型／工具策略、结果校验、交付规则 | AgentSession／RPC runner、concurrency、恢复、后台锚点 |
| pi-ext-memory | 观察／反思语义与 Hindsight 边界 | transcript、context edits、compaction hook、fork 一致性 |
| pi-ext-addon／optimizer | 独立提示词变换和配置逻辑 | editor 交互、host 上下文、hook 时序、结果变换 |
| pi-ext-core | 有价值的取消／清理／协作不变量 | session-scoped 与 durable 状态边界、TUI 能力归属 |

这是迁移分组建议，**不是每个 package 已完成的逐文件审计**，不能据此估算工期或承诺直接可移植。[L1][L3][L4][L6][L7]

要区分三层 task：业务待办、产品后台任务、durable 执行任务。不能直接把 TaskRegistry 状态枚举改名为 Harness task 状态；必要的产品状态应从执行事实投影，或存入功能自己的 document，而不是另建竞争的执行权威。[S2][L7]

## 6. 渐进迁移建议

### A：先验证功能／表现边界，不改变现有用户路径

选一个小功能，明确输入、状态、操作、结果和取消。不依赖 TUI 即可执行和测试，把颜色、glyph、折叠与通知放在表现侧。todo 是候选，因状态小且易验证原子更新、重开和 fork；选择尚待确认。[L6]

**通过条件：**同一功能可由 headless 调用与 TUI 展示；业务测试无需伪造 ctx.ui。

### B：建立独立、显式 opt-in 的 durable 路径

固定版本、独立存储目录和显式模型配置，形成“启动 → 安装功能 → submit → commit → 订阅 → close → 重开”端到端路径。Memory 用于纯测试，SQLite 用于真实进程重启。旧 Pi host 路径不被静默替换。

**通过条件：**无终端可运行；UI detach 不等于取消；重开能取得同一状态；旧路径仍可单独使用。关闭整个 host 遵循 Harness.close 的语义，而不是遗留同一 storage owner。[S2][S5]

### C：逐个工具迁移，再迁移后台与子会话

先只读工具，再写操作与命令；逐个记录 replay、完整结果、执行环境与取消。随后选一种子 agent 语义验证持久路径、交付去重与限额，再扩展其他模式。上游有 foreground、background、child tasks 与恢复例子，参考而非复制产品策略。[S2][S13]

**通过条件：**恢复不重复副作用；取消确认后无旧结果污染；交付重试不重复注入；模型继承与 override 可检查。

现有 subagent coordinator 是 root-session-scoped；当前 pi-subagents 可重连 runner／后台任务产品契约还有另一套 ownership。应分别检查实际消费者，不能把两份契约合成一个简单“换 runner”任务。[L7]

### D：接入完整 TUI，并验证 session／memory 语义

复用满足 DESIGN.md 的组件，让真实状态来自功能运行时。补齐导航、模型选择、认证接入、图片和配置等必要 host 能力。记忆与压缩涉及上下文和历史，建议在 transcript／fork 契约确定后迁移。[S3][L2][L7]

**通过条件：**TUI／headless 操作等价；窄宽布局、订阅清理、重连和完整输出可取回；fork 的记忆／状态符合规格。

### E：决定旧格式与兼容范围，再删除旧 ownership

推荐先保留旧 session 为旧 host 可读，新 durable session 使用新目录／格式；之后才决定单向导入或历史只读浏览。Pi Durable JSONL backend **不是**现有 Pi session JSONL 的格式兼容承诺。本轮未验证旧格式导入能力，不承诺无损转换。[S2][S5]

双路径应有退出条件，不建覆盖所有 ExtensionAPI 的永久兼容框架；只有用户明确需要某项旧契约时，才设计窄边界支持。[L2][L4]

## 7. 实施前必须决策的问题

1. **完整分开的最低承诺：**单进程无 UI 依赖、headless CLI，还是远程多客户端？建议先前两项；后者新增网络协议、授权与部署责任。
2. **扩展生态：**继续安装任意 Pi extension，还是只保留本仓库功能？这是 host 产品边界，不是 adapter 细节。
3. **关闭和取消：**关终端是 detach 还是关 host？后台工作是否跨 parent abort／shutdown 生存？上游 background 与现有 session 级契约不同。[S2][L7]
4. **存储：**后端、锁、备份、持久性等级、保留／删除、敏感输出与凭据处理；可存不等于都应存。
5. **模型与成本：**已保存模型不可用如何显式报错；继承何时冻结；retry／后台 compaction 的次数、成本、开关和记录。
6. **旧 session：**旧 host 续跑、只读浏览，还是转换后续跑？后两项需要另做格式研究。
7. **分叉：**todo、审批、记忆、cwd 与远端环境分别使用 asOf/current/initial 哪种业务语义？不能统一套默认值。[S5]

建议在首个实现前做聚焦设计讨论，现在无需提前定义覆盖全 repo 的公共接口。

## 8. 待执行验证与研究限制

下列是后续试验门槛，**不是本轮已通过的测试**：

- 同一功能 headless／TUI 等价；UI detach 不更改业务状态。
- commit 失败不发布成功状态；存储不确定失败后停止使用 poisoned Harness。
- 真杀进程再重开：safe 工具重跑、unsafe 得到 interrupted，完整结果仍可查询。
- requestId 去重与外部副作用幂等分别验证。
- 双进程争用被拒绝；正常 close 后新 owner 可打开。
- queued input、wait cancellation、conversation abort、background abort 边界正确。
- report 恢复后不重复交付，模型不静默变更。
- fork 的业务状态与记忆符合指定复制语义。
- watch 溢出／重连可重建视图，审计历史仍可完整查询。
- 窄宽 TUI、结果访问、订阅 dispose、关闭期间迟到更新。

本轮搜索官方来源，克隆固定 revision 到临时目录，检查 README、规范、demo 和关键源码，并对照本仓库边界；**未运行上游 demo、模型请求、benchmarks 或测试套件，没有建立迁移原型**。上游存在相关测试不代表本次验证通过。[S14]

## 9. 证据索引

源码链接固定 revision，避免 main 漂移。文章说明意图；精确保证以该 revision 源码／规范为依据。规范仍有 Pico5／未实现阶段的历史措辞，不能单凭这些措辞判断当前功能不存在。[S2][S5]

- **[S1]** [Earendil 发布文章](https://earendil.com/posts/pi-durable/)。
- **[S2]** [Pi Durable README](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/README.md)。
- **[S3]** [durable coding-agent demo README](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/experimental/durable/README.md)。
- **[S4]** [runtime.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/experimental/durable/runtime.ts)、[harness-setup.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/experimental/durable/harness-setup.ts)。
- **[S5]** [规范 spec.md](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/docs/spec.md)。
- **[S6]** [CHANGELOG](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/CHANGELOG.md)。
- **[S7]** [package.json](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/package.json)。
- **[S8]** [harness/tool.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/src/harness/tool.ts)。
- **[S9]** [内置 tools](https://github.com/earendil-works/pi/tree/200387122ca450d6387f033949423114a270b96c/packages/durable/src/tools)。
- **[S10]** [SQLite Node adapter](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/src/storage/sqlite/node.ts)。
- **[S11]** [JSONL storage.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/durable/src/storage/jsonl/storage.ts)：commit 与 reclaimSidecars。
- **[S12]** [sessions.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/experimental/durable/sessions.ts)。
- **[S13]** [main.ts](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/experimental/durable/main.ts)、[vacation README](https://github.com/earendil-works/pi/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/experimental/vacation/README.md)、[examples](https://github.com/earendil-works/pi/tree/200387122ca450d6387f033949423114a270b96c/packages/durable/test/examples)。
- **[S14]** [上游测试目录](https://github.com/earendil-works/pi/tree/200387122ca450d6387f033949423114a270b96c/packages/durable/test)。
- **[L1]** 本仓库 [package.json](../../package.json)、packages 下各 package.json。
- **[L2]** [AGENTS.md](../../AGENTS.md)、[DESIGN.md](../../DESIGN.md)。
- **[L3]** [ext-core 开发约定](../development/pi-ext-core.md)。
- **[L4]** [Extension reference architecture](../architecture/extension-reference.md)。
- **[L5]** [lifecycle.ts](../../packages/pi-ext-core/src/lifecycle.ts)、[ext-core exports](../../packages/pi-ext-core/src/index.ts)。
- **[L6]** [todo/model.ts](../../packages/pi-ext-tools/src/todo/model.ts)、[todo.ts](../../packages/pi-ext-tools/src/todo/todo.ts)、[apply-patch-tool.ts](../../packages/pi-ext-tools/src/apply-patch-tool.ts)、[eval/tool.ts](../../packages/pi-ext-tools/src/eval/tool.ts)。
- **[L7]** [Subagent 执行架构](../architecture/subagents.md)、[后台任务契约](../architecture/background-tasks.md)。二者不能视为同一套 runner 契约。
