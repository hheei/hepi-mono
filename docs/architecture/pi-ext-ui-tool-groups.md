# pi-ext-ui 连续活动组 Spec

状态：已实现（tickets 01–06）。本文仍是行为与验收依据；实现偏差与已知缺口见文末“实现记录”。历史讨论见 [PLAN](../plans/pi-ext-ui-collapse-views.md)。

已实现的公共契约：`@hheei/pi-ext-core` 的 `ToolPresentation.children`（`ToolPresentationChild`：id、title、summary、status、durationMs、detail）承载容器子调用事实；`@hheei/pi-ext-ui` 的 `ToolView.children` 与 `MessageView.kind`/`detailRows` 供活动组读取，不新增 host hook。

## Problem Statement

现有活动组将每个顶层工具、thinking 和通知各占一行，信息层级分散；容器的父调用与子调用容易混淆，当前/最后一次 codemode、python_eval 的展开内容也会占据过多高度。用户需要快速判断发生了哪些工作，同时保持每份结果可检查。

原生 TUI 内容可以打断连续展示段，但展示断组不代表整个回合重新开始。若时间依附组件实例，重绘或断组可能导致重新计时。结束后的 block 还需要简洁的请求消耗统计，其公式与数字格式应与原生 Pi footer 一致。

## Solution

### 1. 用户可见目标

活动态使用固定 header、上下两条 rails、三行可展开分类和一条只读工具状态。示例：

```text
▸ collapse views · 1m 12s · 20 calls
────────────────────────────────────────
▸ notice · memory ×2 · optimizer ×1 · info ×3
▸ thinking · 800 tokens
▸ read ×7 · grep ×12
────────────────────────────────────────
◐ codemode
```

示例中历史工具共 19 calls，尾行 codemode 尚无子调用，暂计 1；有子调用后由子调用集合替换该父调用。三个分类标签统一小写，顺序固定为 `notice`、`thinking`、`tools`，每个非空分类占一行；空分类整行省略，不画零统计行。notice 行只列类型计数（如 `memory ×2 · info ×3`；`ui.notify` 的级别直接写作 `info`／`warning`／`error`），不再重复 `N notices`，条数由各项计数体现。

展开分类后的内容：

```text
▾ read ×7 · grep ×12
▸ ✓ read a.ts
▎ 120 lines

▸ ✓ grep needle
▎ 3 matches
```

工具分类逐项显示该工具自身的 Level 0 状态（真实 header 行与内容预览行，通常两行），相邻工具之间恰好一个空行；点该项由工具自己的组件处理展开，UI 不复制工具状态、不重画其颜色与 copy 热区。thinking 分类每项为一行标签加一行首行预览，项间一个空行，点开显示完整文本；notice 每项仍为一行，点开显示提供者给出的详情行，不加空行。

footer 是最后一条 rail 下的**单一槽位**：运行态显示当前/最后工具的真实状态行，block 完成或被真实原生边界打断后，该行由请求统计覆盖，不加 rail、不追加行：

```text
运行态                                  完成态
▸ collapse views · 1m 12s · 20 calls    ▸ collapse views · 1m 12s · 20 calls
──────────────────────────────          ──────────────────────────────
▸ notice · memory ×2 · …                 ▸ notice · memory ×2 · …
▸ thinking · 800 tokens                 ▸ thinking · 800 tokens
▸ read ×7 · grep ×12                    ▸ read ×7 · grep ×12
──────────────────────────────          ──────────────────────────────
◐ codemode                              Requests ×3 · IN 24k · OUT 1.5k · CH 75%
```

运行态的尾行工具不进历史列表（它就在 footer 槽位里）；完成后 footer 换成统计，该工具回到 `tools` 列表，调用数不丢。header 与 body 不因完成而改写。统计只累计该 block 内的 assistant usage，格式（k/M 步进与 CH 分母）对齐原生 footer。footer 不删除或隐藏原始内容，检查路径仍是分类详情、原始视图与 Ctrl+O。原生打断内容保持原位；新 block 的时间继续从同一个 run 起点计算。

### 2. 三个不同的边界

| 名称 | 定义 | 结束时的影响 |
| --- | --- | --- |
| Run | 一次公开 agent_start 到 agent_end 的 agent loop | 冻结回合时间、收束最后一个 block |
| Turn | Pi host 内一次模型响应及工具执行循环 | 不重置 run 时间，不自动断组 |
| Block | transcript 中连续、可聚合的活动展示段 | 收束局部统计和成员归属，不结束执行或 run |

原生断组、resize、主题重绘和 renderer 重建均不能产生新的 run 起点。Requests 是逻辑模型请求数，calls 是有效工具调用数，两者独立。

## User Stories

1. 作为 TUI 用户，我希望活动 block 使用稳定的标题与三类摘要，以便快速扫读工作进展。
2. 作为 TUI 用户，我希望当前或最后工具只显示状态和名称，以便容器代码与看板不持续挤占界面。
3. 作为 TUI 用户，我希望历史工具列表排除尾行工具及其子调用，以便不重复展示同一调用。
4. 作为 TUI 用户，我希望 header 仍包含整个 block 的有效 calls，以便知道实际工具调用总量。
5. 作为容器工具用户，我希望有子调用时只计子调用、没有时才计父调用，以便数字反映实际工作。
6. 作为并行工具用户，我希望状态更新不改变调用身份或随 partial 抵达顺序跳动尾行，以便保持阅读位置稳定。
7. 作为 Python 用户，我希望可直接查看平铺的子工具全文，以便不用先打开父容器。
8. 作为容器工具用户，我希望独立打印输出、源码与脚本异常仍可检查，以便不因平铺子调用而丢失证据。
9. 作为 TUI 用户，我希望 Thinking 显示独立估算 token，以便区分思考体量和 provider 的真实输出 usage。
10. 作为 TUI 用户，我希望隐藏思考时不能通过聚合详情绕过 Pi host 的可见性策略。
11. 作为 TUI 用户，我希望 Notice 按提供者明确声明的类型统计，以便不依赖猜测正文的分类。
12. 作为 extension 用户，我希望未知 Notice 类型原样保留，以便新 extension 无需修改 UI 名单就能展示。
13. 作为 TUI 用户，我希望每次只打开一个分类和一个详情，以便界面保持紧凑。
14. 作为 TUI 用户，我希望从分类中的单项直接查看完整工具详情，以便不经过无用的中间预览层。
15. 作为 TUI 用户，我希望能切换到原始成员布局，以便检查聚合未展示的完整执行记录。
16. 作为 TUI 用户，我希望切模式时先折叠旧详情，以便没有隐藏展开状态在切回时突然出现。
17. 作为 regular 模式用户，我希望 Ctrl+O 仍能强制检查原始内容，以便不依赖 fullscreen 鼠标。
18. 作为 TUI 用户，我希望整个回合使用 h/m/s 时间，以便长回合仍易读且并行工具不会重复计时。
19. 作为 TUI 用户，我希望原生 TUI 内容打断 block 后时间连续，以便展示变化不冒充新回合。
20. 作为 TUI 用户，我希望已结束 block 缩成请求统计，以便释放高度但仍可展开查证。
21. 作为 TUI 用户，我希望 IN、OUT 的统计公式和 k/M 格式与原生 footer 一致，以便不混淆两处指标。
22. 作为 TUI 用户，我希望 CH 使用原生最后一笔 assistant 的缓存命中口径，以便不把它误当累计平均值。
23. 作为 TUI 用户，我希望同一请求横跨 block 也只归账一次，以便不重复统计 token。
24. 作为 TUI 用户，我希望迟到 usage 能补回原 block，以便断组和取消不丢失已知消耗。
25. 作为历史 session 用户，我希望已有 usage 可恢复而缺失时间明确显示未知，以便不看到伪造的历史耗时。
26. 作为窄屏或 Unicode 终端用户，我希望每行安全裁剪且保留完整检查入口，以便界面不溢出或损坏。
27. 作为多 session 用户，我希望 reload、fork、切换与卸载清理隔离，以便旧回合数据不会污染新 session。
28. 作为 extension 用户，我希望未启用或无法安全挂接时保留原生行为，以便展示功能不影响工具执行与错误传播。

## Implementation Decisions

### D1. Ownership 与控制流

- Pi host 拥有 session、原始 transcript、工具执行、全局展开、原生节点与滚动。
- ext-core 只承载无副作用的 ToolPresentation 结构化展示契约，不管理活动组、请求或运行时状态，不依赖具体 extension。
- 具体工具提供者拥有 args/result/details 的边界验证、子调用事实和错误语义；python_eval 由其提供者读取自己的持久化 trace。
- pi-ext-ui 拥有聚合投影、有效调用集合、run 时钟、block/request 关联、usage 快照、交互状态与布局。状态限定在所属 runtime/session，不建立通用任务账本。
- 数据流是原始 transcript 与工具结构化事实进入 UI 投影，再产生聚合或原始视图；不改写模型可见 content，不替换执行路径。

### D2. 已有挂接边界与回退

- 保留现有 toolGroups.enabled 设置，默认开启；停用后当前 session 恢复原展示。
- 只沿用两个已批准的 prototype seam：InteractiveMode.getRegisteredToolDefinition 用于发现所属 host 并挂展示投影，InteractiveMode.showExtensionNotify 用于保存每次原生通知。原方法的错误继续传播。
- 不增加 host hook、host 私有字段读取、thinking patch、全局输入拦截或磁盘补丁。既有 AssistantMessageComponent.lastMessage 读取边界不扩大。
- 仅 TUI 安装，HTML export、RPC、print 不安装投影。沿用 fullscreen 鼠标与 regular Ctrl+O；不扩展滚动能力。
- 保留至少两条顶层工具才成组的门槛，不因单个容器拥有很多子调用就擅自成组。
- 正文、user、未知组件、图片与未知工具 renderer 维持原生断组/回退。异常终态不被吞掉。可识别 MessageView/notify 留组，不因每条通知都断组。

### D3. 有效调用、身份与历史/尾行分区

- 可验证地有子调用时递归展开其有效后代；没有子调用时计父调用。只展开实际工具容器，不进入 subagent 私有 session。
- 同一次执行的 live capture、persisted capture、result details 择一，不能相加；优先可信的完整结构化事实。
- 稳定 toolCallId 优先；缺少 ID 的历史使用父身份与原始序号区分。同名同参数的两次真实调用必须分别计数，不按参数去重。
- streaming、partial、完成、错误、取消均更新原身份，失败/取消的真实调用仍计一次。父转子时原子替换父集合。
- header calls 来自整个 block 的有效集合；工具分类只使用历史分区。尾行及其所有子调用不进入历史工具列表。
- 并行时尾行选择最近开始且仍活动的顶层调用，无活动调用则选择最后开始的调用；不由 partial 到达顺序决定。
- 尾行只画真实状态 glyph 和顶层工具名，无 pin、参数、源码、看板、copy 或点击展开；presentation 的 none 不能掩盖真实执行状态。
- 工具名按首次出现顺序聚合，保留命名空间。容器独立输出、源码、异常保留为不计 calls 的执行记录入口，原始视图始终保留原组件。
- 聚合消费结构化事实，不执行 renderer 猜计数、不解析 ANSI summary、不从输出文本猜工具调用。

### D4. Thinking 与 Notice

- Thinking 按非空 thinking block 建项，身份取 assistant 与原始 block 序号；总估算为所有原始 thinking 文本长度之和除以 4 后向上取整。先求和再取整，不计 signature、JSON、标签、工具或正文。
- 流式完整快照替换旧值，不能当 delta 重复累加。provider usage 与思考估算独立，OUT 不再叠加该估算。
- 尊重 Pi host 的思考可见性，不修改全局偏好、不暴露未提供的文本。
- Notice 每条真实通知计一次，更新原项不增加次数。MessageView 按 header.kind 精确值分类，未知值原样保留；原生 notify 只按 info/warning/error 区分，来源未知。
- 两类来源键分域，避免 MessageView 的同名 kind 与原生 notify 碰撞。按首次出现顺序显示统计，窄屏截断后缀。
- 不读正文或颜色猜类型，不把 tone 当 severity，不读取 stateHolder 私有数据或维护具体 extension 名单。第一版不新增 MessageViewSpec 分类字段，不增加类型过滤或分类子树。

### D5. 两层详情、原始视图与 copy

- 聚合中同时最多一个分类打开。工具分类逐项渲染工具自身 Level 0 行并转发点击给该组件；容器子调用没有组件，用真实 glyph、工具名与 dim 摘要合成一行，点开显示提供者详情。
- thinking 分类逐项为标签行加首行预览行，点开显示完整文本。Notice 每项一行（可展开时带 pin），点开显示 MessageView 的 preview/body 或保存的原文；两者都不新增第三层折叠。
- header 切原始成员视图，按 transcript 顺序保留原组件引用与两条 rails；切入/切出前均折叠全部内部项目，包括工具、MessageView 和巢状工具。
- 分类/单项互斥仅限聚合，原始视图沿用原生多项展开。Ctrl+O 优先强制展示原成员，关闭后回到全部收起的聚合视图，不恢复旧详情。
- 已结束 block 默认只显示 Requests 行；点该行展开完整 frame，再点 header 收回单行。展开后仍可检查保存活动与原始输出，不新建独立的结果副本。
- 详情中的 copy 热区继续由原工具拥有，父级点击不能截获 copy 或误切模式。regular 通过既有 Ctrl+O 检查全文。
- 状态变化后请求重绘；不得每次 render 都重置详情。选择对象进入尾行、被替换或消失时清除旧选择，不能按同序号继承给新项。

### D6. Run 时钟与 block 收束

- agent_start 记录本进程单调时钟起点，agent_end 冻结；包含 loop 内思考、模型等待、工具执行及期间等待，不包含开始前排队/用户闲置和结束后后台任务。
- 同一 run 的多个 block 关联同一时钟身份，turn_start、断组、统计重置、重绘、resize、主题变化、Ctrl+O、renderer 重建均不重置时钟。并行工具耗时不叠加。
- 时间向下取整到秒，省略前导零单位并保留低位单位，示例为 0s、9s、1m 05s、1h 02m 03s，不展示小数秒。不全局修改 ext-core 的工具 duration 格式化。
- 使用既有状态更新触发渲染，不默认新增跳秒定时器。
- 真实 transcript 边界或 run 结束收束 block，锁定成员和请求归属；不等于取消工作。后续 partial 可更新保存结果，不自动重新打开旧 block。
- 新 block 的局部工具/Thinking/Notice/请求统计重新开始，但旧 block 仍可检查。只有新的 agent_start 创建新回合时间。
- 正常、取消和错误均按实际 run 结束事件冻结；session 离开时清理，不把缺失的结束事件伪装为成功完成。

### D7. 原生 footer 统计与紧凑格式

- 统计范围为该 block 归属的记录，不是整个 session/run；公式、usage entry 类型与格式均参考原生 Pi footer。范围是有意缩小，不能把 session 累计值复制到每个 block。
- 累计 IN 只加 usage.input，不加 cacheRead/cacheWrite；OUT 只加 usage.output，不重复加 Thinking 估算。
- 沿用原生可计量来源：独立 usage、assistant usage、带 usage 的 toolResult、带 usage 的 branch_summary/compaction。单个记录只计一次，压缩不能让已归属的历史 usage 消失。未归属该 block 的记录不强塞进来。
- CH 取按原始记录顺序最后一条 assistant 的 cacheRead 占其 input + cacheRead + cacheWrite 的比例，既非累计加权平均，也非命中请求数比例；其他 usage 不改变最后 assistant 的身份。
- 最后 assistant 的提示输入为 0 时 CH 不可用，不沿用上一条的 CH。原生累计缓存读写都为零或 latest CH 不可用时，本固定字段布局显示 CH —。
- CH 最多一位小数，去掉 .0；已知缓存为零且原生显示条件成立时可为 0%。不在格式化前舍入 token 或比例。
- IN/OUT 使用原生十进制 formatTokens 规则：小于 1000 原数；1000 至小于 10000 为一位小数 k；10000 至小于 1000000 为整数 k；1000000 至小于 10000000 为一位小数 M；更大为整数 M。示例 999、1.0k、24k、1.0M、24M，含原生边界舍入行为，不擅自改成 K 或另一套阈值。
- 存在的错误/取消 usage 保留，不额外按 stopReason 排除。缺少真实 usage 时显示未知，不能把未完成或缺失测量当零。可确认没有请求/消耗与 usage 不可用是不同状态。
- 原生 response-status 仅保留最后响应并会清除，不作为 block 累计来源。不为复用格式化而导入 host 私有 footer；优先可用公共能力，否则局部同语义实现并做原生阈值对照。

### D8. Requests 归属与迟到 usage

- 原生 footer 没有 Requests 字段；本功能定义为该 block 归属的 assistant 逻辑请求数量，不是 HTTP attempts。工具数量、独立 usage entry、内部不可见重试不推断为新请求。
- 每个 assistant 请求只归属其首次关联的活动 block；跨原生边界时后续工具可进入新 block，但请求与 usage 不重复归账。纯正文没有活动 block 时不为此创建工具卡。
- 用稳定请求/entry 身份更新记录，message_update 不累加快照；正常、错误、取消的已观测请求按身份各计一次。
- block 收束后若最终 usage 迟到，只补回原 owner。未结算时显示待结算或未知字段，不移账给当前 block。
- CH 按原始请求/entry 顺序决定最后 assistant，不能因旧响应晚到就覆盖较新的响应。独立 usage 与摘要必须有可检查归属；无法可靠关联时不凭抵达时间猜测或重复分摊。

### D9. 公共展示契约方向

- ToolPresentation 增加可选结构化子调用事实，包含实际可用的稳定 ID、工具名、args、result、状态、duration 与后代；缺字段表示事实未提供，不能伪造空结果或成功。
- python_eval 提供者复用自身 details 解析；codemode 复用现有 capture/details 事实。UI 不复制 Python 私有解析，不新增重复持久化格式或具体 extension 依赖。
- ToolView 提供 UI 内活动快照与显式折叠控制，MessageView 提供 UI 内详情投影/收起能力；不扩大 MessageViewSpec 的公共折叠层数。
- 旧提供者未提供子调用事实时仍能原生显示；仅有历史摘要时保留摘要与详情不可用提示，原父结果可检查。tracker 的有界缓存不能成为历史唯一来源。
- 确切 TypeScript 类型与边界验证在实现时靠近契约记录；本 spec 不预建 registry、事件总线、通用 adapter 或额外配置。

### D10. 生命周期、恢复与渲染安全

- runtime 按既有 UI 身份隔离；清理幂等，reload/shutdown 恢复仍由本功能拥有的方法，别的 extension 覆盖时不反向覆盖并报告冲突。
- session 切换、树替换、fork、compaction、reload 按原始身份重建投影，不从首次 render 发明时间。新 session 不接收旧 run 回调。
- 不新增 timing、block、request 或展开状态的磁盘持久化，不增加迁移。已有 entry usage 能恢复就恢复；缺少可靠回合起止或 block 归属时明确未知，不猜时间或重复计量。
- 原生 notify 不新增持久化，已有 MessageView 继续从自己的 entry 恢复。缺少完整历史子调用不重跑脚本或读取 workspace 补造结果。
- 使用主题语义 token，颜色不作为唯一状态信号；行必须 ANSI/Unicode/单元格宽度安全，一元素一终端行，窄屏裁剪而不丢失全文入口。
- 使用既有组件缓存与 repaint 合并/节流能力，不引入私有刷新窗口、后台任务、全局锁、通用 store 或滚动 patch。

## Testing Decisions

### T1. 首选最高测试 seam

主 seam 复用现有 Pi host transcript 投影测试：从公开 extension 生命周期、工具提供者和原生节点驱动，断言用户实际看到的行、统计、鼠标/copy 与 Ctrl+O 行为。工具私有 details 解析测试留在所属提供者；公共展示契约通过真实消费者接线验证，不为测试新增 host hook。此测试方向沿用已批准的现有 seam 与跨包范围。

辅助纯函数测试仅固定易错语义：有效叶调用选择、h/m/s 边界、原生 k/M 阈值、最后 assistant CH、去重和迟到归账。避免断言私有 Set、字段布局或组件实例数量；同一行为可重构实现而不改测试。

### T2. 聚焦验收场景

| 场景 | 必须观察到的行为 |
| --- | --- |
| 无子调用到出现两个子调用 | 父 1 call 原子替换为子 2 calls，无重复父项 |
| 相同名称与参数执行两次 | 两次独立调用，partial 不增加第三次 |
| Python trace 与 codemode capture | 可平铺看全文；来源择一；父输出/异常仍可查 |
| 并行工具与尾行 | 最近开始仍活动的顶层工具为尾行；其他状态保留 |
| 分类/详情/模式切换 | 一个分类、一个详情；切模式全收起，copy 不切组 |
| Thinking 流式与隐藏策略 | 快照替换、不含 signature、不绕过 host 可见性 |
| Notice 类型 | exact kind，未知原样保留，notify 级别独立，无正文猜测 |
| 原生边界与后续 block | 旧 block 请求行、新 block 局部计数、相同 run 起点 |
| 重绘/resize/Ctrl+O | 不断组、不重计时、不重复归账；退出强制展开不恢复旧详情 |
| 多 turn/并行/取消/错误 | 时钟连续，真实 run 结束冻结，已知 usage 保留 |
| 多 usage entry 类型 | 对应原生 entry 扫描结果，单条只计一次，压缩前消耗不丢 |
| 多请求 CH 差异 | 跟最后 assistant 一致，不跟累计加权值混淆 |
| 最后 assistant 零输入 | CH —，不复用上一条百分比 |
| 边界舍入 | 原生 999/1000/9999/10000/999999/1000000/9999999/10000000 一致 |
| 横跨 block 与迟到 usage | 只更新原 owner；旧响应不覆盖较新 assistant CH |
| 历史缺少时间/全文/归属 | 明确未知或详情不可用，保留原始检查入口 |
| 窄宽布局、ANSI、Unicode、主题 | 每行宽度安全，交互坐标正确，无换行泄漏 |
| 多 runtime/reload/fork/卸载/冲突 | 无串 session、悬挂回调、半安装或吞原方法异常 |

### T3. 验证层级

- 每个实现 ticket 使用改动文件 Biome、受影响测试与受影响 package build；不要以最终集成项替代逐项验证。
- 公共 ToolPresentation 与跨 package 提供者改动升级根 typecheck；范围与触发原因写入 ticket 完成记录。
- host 投影与 Ctrl+O 路径执行受影响真实 CLI/PTY 集成测试，覆盖 regular/fullscreen，核对最低支持版本及已声明支持的产物；不能把单个安装版本的源码检查当作兼容性通过。
- 代码修改后更新 Graphify AST，不因文档收尾自动跑全仓 test/check。
- 本次仅产出文档，不运行 TypeScript、build、测试或图谱 AST 更新；实际检查命令与结果写最终报告。

## Out of Scope

不新增 extension/package、依赖、Notice taxonomy/subtype 公共协议、类型过滤、第三层折叠、单容器自动成组、HTTP attempts 计数、隐藏网络请求推断、run timing 持久化或旧数据迁移。不改 Pi host 文件、全局 thinking 偏好、滚动实现、工具权限或执行语义。不创建通用任务/请求服务，不引入新 host seam、兼容适配层或推测配置。

不授权 commit、push、tag、发布、外部 issue 创建或部署。文档中的目标与草案 ticket 不表示功能已上线。

## Further Notes

- Q1–Q6、完成态单行、block 局部范围与逻辑 Requests 口径已通过对话确认；IN/OUT/CH 以前案为准的旧建议已被原生 footer 口径取代。
- 现有实现仍以逐成员 summary 为主，本 spec 是下一版目标；实施时保留工作区已有的无关改动。
- 原生统计依据为本次检查的已安装 Pi host footer 与 usage-totals；实现阶段仍须核对项目声明支持的版本，发现公共事件/usage 差异时先报告，不静默提高最低版本。
- 仓库暂无正式 tracker 配置，已有本地逐项 Markdown tickets 先例。本工作线使用 .scratch 下独立 feature 目录，拆分确认前仅保存草案，不标记 ready-for-agent、不发布外部 issue。若要配置正式 tracker，运行 /setup-matt-pocock-skills。

## 实现记录

已落地：

- 活动 block 的 `collapse views · 用时 · N calls` header、两条横向 rails、非空分类行与只读尾行；运行态尾行及其子调用不进入历史列表，完成后 footer 换统计、尾行工具回到列表。
- 展开工具分类按工具自身 Level 0 逐项渲染（相邻一项一个空行），展开 thinking 分类为标签行加首行预览，notice 逐项一行并可展开详情。
- `agent_start`／`agent_end` 的单调回合计时；同一 run 的多个 block 共享起点，原生断组不重计时；缺少 run 的历史显示 `—`。
- 容器子调用来自提供者的结构化事实（codemode 的 captured calls、python_eval 的 trace rows），有效调用计数与平铺列表；单项直接展开详情。
- Thinking 的字符估算与逐项详情（宿主隐藏思考时不暴露文本）；Notice 按 `header.kind` 与 notify 级别分类。
- 完成/被打断 block 的 footer 槽位由 `Requests ×N · IN … · OUT … · CH …` 覆盖运行态的尾行工具状态，header 与 body 不变，k/M 与 CH 口径对齐原生 footer。
- 原始成员视图、Ctrl+O 强制展开、单分类／单详情互斥、切换模式时收起内部项目。
- 模块边界：`tool-group-view.ts` 只负责 block 内布局、统计与命中测试，`host-transcript-patch.ts` 只负责 host seam、成员提取与安装/卸载。

已知缺口（后续单独处理）：

- 请求统计只累计 assistant usage；带 usage 的 toolResult、branch_summary、compaction 记录目前是断组边界，不计入任何 block。
- 子调用详情使用提供者给出的纯文本 `detail`，不重建该子工具的 ToolView；python_eval 子行摘要不含 `(+N -M)`。
- 折叠层级仍由 group 的本地开关与 Pi 的 global expand 决定，未实现工具级的 `maxLines` 覆盖。
