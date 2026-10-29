# PLAN：pi-ext-ui 活动组聚合与分层展开

状态：设计已收敛。用户已确认 Q1–Q6、完成态可展开单行、block 局部统计与逻辑 Requests 口径，并要求 to-spec / to-tickets；本轮不修改实现。
正式行为与验收依据已整理为 [连续活动组 Spec](../architecture/pi-ext-ui-tool-groups.md)，共享 UX 同步到 `DESIGN.md`。本文仅保留讨论过程；下文历史建议或待确认措辞均以正式 spec 为准。逐项 ticket 草案位于 `.scratch/pi-ext-ui-collapse-views/drafts/`，尚待确认拆分，未发布为 ready-for-agent。

## 1. 用户可见目标

把现有“标题计数 + 每个成员一行”改成“固定标题 + 三类历史统计 + 当前/最后工具状态”。完整内容仍保留。
建议将原文 `collpase views` 拼写改为 `collapse views`。

```text
▸ collapse views · 1m 12s · 20 calls
────────────────────────────────────────
▸ codemode ×2 · read ×7 · grep ×10

▸ Thinking · 800 tokens

▸ Notice · 3 notices
────────────────────────────────────────
◐ codemode
```

示例假设历史有效调用 19 次，尾行容器尚无子调用，暂算 1 次。数字仅示意。

- 上下两条水平 rails 保留，分类间恰好一个空行。
- 尾行只显示状态 glyph + 顶层工具名，不画 pin、参数、子调用看板、copy；点击不能展开。
- 复用现有状态 glyph；容器自身当前使用 `none` 时，尾行仍须显示真实运行/结束状态。
- 三类不固定：空分类整行省略（原「空类显示 0 calls / 0 tokens / 0 notices」已被 2026-10-29 反馈推翻）。
- 工具名按首次出现顺序计数，保留命名空间；窄屏单行 ANSI/Unicode-safe 截断。

## 2. 明确需求

1. codemode/python_eval 无子调用时计自身；有子调用时只计子调用，父容器不计。
2. Thinking 只统计 thinking 文本，按字符数 `/4` 估算，不计工具、正文、通知或整条模型输出 usage。
3. Tools、Thinking、Notice 独立展开；同组同时最多展开一个分类。
4. 分类打开先逐块显示一行身份摘要，再点击某块查看详情；工具按调用平铺，不先展开父容器。
5. 单项详情同时最多一个；点另一个先关前一个。
6. header 切换原始成员视图；展开前、收缩前都先折叠内部全部项目。
7. 尾行不可展开，原始结果不因聚合而丢失。

## 3. 已确认语义与剩余决策

### 3.1 历史与尾行

已确认：历史排除尾行。尾行工具及其子调用不进入历史 tools 列表，直到下一条顶层工具开始；空闲时最后一条仍留尾行。Thinking/Notice 按自身身份归类。

header 统计整个组，body tools 只统计历史：

```text
header calls = 历史有效调用数 + 尾行所属工具的有效调用数
```

并行时尾行优先最近开始且仍活动的顶层调用；没有活动调用时选最后开始的调用。其他调用仍在历史列表显示真实状态，“历史”不等于已完成。不按 partial 抵达顺序跳动。

不采用 body 包含尾行、尾行重复状态的方案。

### 3.2 total-time

已确认：显示回合用时，以 h/m/s 格式化；删除累计顶层工具 duration 的方案。

Q5 已确认：一回合对应公开 `agent_start → agent_end` 的整个 agent loop，而不是 SDK 的单个 `turn_start → turn_end`；后者在连续模型/工具循环中会重复发生。

- agent_start 开始计时，运行中显示 elapsed，agent_end 后冻结。包含该 loop 内思考、模型等待、工具执行及其他等待；排除开始前用户闲置、排队/前置钩子时间和结束后的后台任务。
- 并行工具不叠加时间，内部 turn 不重置。取消/错误按真实 loop 结束时间冻结；session 切换/关闭清理计时，缺少结束事件时不伪造成功结束。
- 用单调时钟测本进程 elapsed，不从首次 render 或工具 duration 推算回合起止。
- 建议秒向下取整，省略前导零单位，保留低位单位：`0s`、`9s`、`1m 05s`、`1h 02m 03s`。不显示小数或毫秒。
- 当前 ext-core formatDuration 只提供 ms/小数秒；本功能使用局部 h/m/s 格式化，不全局改变工具耗时等消费者。
- 每组绑定所属 run 的计时身份，不读取会被下一回合覆盖的全局 current elapsed。同回合被正文或原生 TUI 内容切成多组时共享回合起点，不跨回合合并。block 重建、断组或统计清空都不能重置回合时钟。
- 公开事件能测本次运行，但旧 session 没有完整回合起止。恢复时无法精确重建则显示 `—`，不以消息 timestamp 或文件时间猜测，不默认新增持久化格式。若要求重启后仍精确恢复，另行批准 run timing 持久化契约。
- 使用既有状态更新重绘，不默认新增跳秒定时器。

### 3.3 Notice

基础行只列类型计数 `▸ notice · memory ×2 · info ×3`（不再写 `N notices`，条数由计数体现）。每条真实通知一项，同一通知更新不重复计数。

已核对的可靠接口：

| 来源 | 明确字段 | 能可靠识别什么 | 边界 |
| --- | --- | --- | --- |
| MessageView | MessageViewSpec.header.kind | 提供者声明的种类，仓库已有 memory / optimizer / agents / bg-bash | 是 string 标签，不是全局 taxonomy；不能据此推断 recall/injection 等子类型 |
| 原生 ui.notify | type: info / warning / error | 通知级别 | 没有来源 extension ID 或语义子类型 |
| 持久化 custom entry | customType 和提供者拥有的 data | 提供者声明的记录类型/状态 | 当前 MessageView 通用接口未传这些字段；UI 不读 stateHolder 私有数据、不维护具体 extension 名单 |

Q6 已批准第一版按 header.kind 精确原值聚合；未知 kind 原样保留，不猜别名、不读 summary/正文/颜色。原生 notify 单独使用来源类别 notify，按明确 type 细分；内部来源键与 MessageView.kind 分域，防止同名碰撞。

已批准统计行方向：

```text
▸ Notice · 6 notices · memory ×2 · optimizer ×1 · info ×3
```

按首次出现顺序显示，窄屏截断统计后缀。展开仍是逐条平铺列表，保留来源类型，不新增分类子树或第三层折叠；若需要类型过滤再定义交互。

第一版分类无需新增公共字段。更细的 recall/injection、agent 状态或 bg-bash heartbeat，应由提供者显式给出结构化分类键，再讨论最小契约；不能从 tone 推断 severity。

此精确分组策略与文案已获 Q6 批准。原生 notify 的真实来源无法从现有参数可靠补出，保留未知来源。

### 3.4 两层展开、原始视图与 Ctrl+O

已批准将分类层与 ToolView FoldLevel 分开：

- 分类关闭：一行统计。
- 分类打开：逐块一行 summary，不展示现有工具 Level 1 内容预览。
- 点击某块：工具直接显示 ext-ui Level 2；再点该块收起。点击另一块先关旧详情，再开新详情。
- 分类标题只开/关列表，不在第二次点击时展开所有正文。
- Thinking 详情显示对应文本，遵守 host 的思考可见性策略；不补造未提供的 thinking。
- Notice 详情复用 MessageView preview/body；它没有独立 Level 2，不为所有通知新增三级折叠。无 body 的原生 notify 显示原文。
- header 打开原始视图时按 transcript 顺序保留原组件，两条水平 rails 保留；进入时全部内部收起，之后沿用原组件交互。
- 分类互斥仅限聚合视图；原始视图不改变原生多项展开规则。
- Ctrl+O 保留 host 强制展开原始成员，作为全局检查入口，优先于局部互斥；关闭后返回全部收起的聚合视图，不恢复旧详情。regular 仍通过此入口看全文。

上述点击模型、原始视图互斥例外及 Ctrl+O 行为已获 Q4 批准。

### 3.5 原生断组、block 结束与请求统计（新增）

用户已明确：原生 TUI 内容可能打断活动 block；时间不能重新计算，block 内统计可以重置。block 完成或被打断后改为请求信息统计：

```text
Requests ×N · IN <tokens> · OUT <tokens> · CH <percent>%
```

CH 最多显示一位小数，去除无意义的 `.0`，例如 `0%`、`85.2%`、`100%`。

#### 生命周期与断组

```text
agent_start → run 时钟开始
  block A 活动 → 原生内容形成真实边界 → A 收束为请求统计
  block B 活动（局部统计从空开始，时间仍从同一个 agent_start 算）
agent_end → 最后 block 收束；run 时钟冻结
```

- block 是连续活动展示段，不是 SDK turn，也不是 run。run 持有时钟，block 持有局部计数、请求归属和展开状态。
- 只有实际 transcript 边界或 run 结束才收束 block；resize、主题失效、重绘、Ctrl+O、renderer 重建不是新 block，也不清统计或重新计时。
- 原生节点继续原位展示，不移动、不隐藏、不吞事件；仍能归类的 MessageView/notify 留在原 block，不因每条通知都断组。
- 新 block 的 tools/Thinking/Notice 和请求汇总可重新开始，旧 block 的记录保留供检查；后续 block 不重复计入旧请求。
- 断组不等于取消执行，不能把仍运行工具标成完成，也不能用旧 block 的结束时间覆盖 run 起点。
- 原生历史重建不能靠每次 render 推测新边界；须复用 run、block、request 的稳定身份。只在所属 session 生命周期内保留运行时记录，不新增磁盘持久化。

#### 完成态布局（2026-10-29 最终确认，已覆盖早期"缩成一行"建议）

已结束 block 的 header、rails、三类列表不变；最后一条 rail 下只有一个 footer 槽位，运行态是当前/最后工具状态行，完成后由请求统计覆盖该行。不替换 header，不折叠 body，不追加 rail。Requests 的 N 与 calls 无关。

```text
▸ collapse views · 1m 12s · 20 calls
────────────────────────────────────────
▸ read ×7 · grep ×12
▸ thinking · 800 tokens
▸ notice · memory ×2 · info ×3
────────────────────────────────────────
Requests ×3 · IN 24k · OUT 1.5k · CH 75%

<打断 block 的原生内容，位置不变>

▸ collapse views · 2m 04s · 2 calls
────────────────────────────────────────
<新 block 自己的三类统计>
────────────────────────────────────────
◐ python_eval
```

两个 block 的 header 都显示整个 run 的 elapsed（`2m 04s` 不是新 block 用时）；footer 槽位只出现在已结束的 block 上并覆盖尾行工具状态，只统计该 block。原始异常和中断提示不得因收起丢失；未知/不安全 renderer 继续原生回退。

#### IN、OUT、CH：完全参照原生 footer

用户已要求复用原生统计口径。核对已安装 Pi host 的 `dist/modes/interactive/components/footer.js`（formatTokens、getSessionStats、render）与 `dist/core/usage-totals.js`（addUsageToTotals），删除此前总提示输入 IN、加权累计 CH、原值整数展示的建议。

- IN = `Σ(usage.input)`，不把 cacheRead/cacheWrite 加入 IN；OUT = `Σ(usage.output)`。OUT 不再叠加 Thinking 的 `/4` 估算。
- 原生累计遍历全部 session entries，不仅是压缩后的模型上下文；计入独立 usage entry、assistant message usage、带 usage 的 toolResult、带 usage 的 branch_summary/compaction。block 统计参照这些 entry 类型与加法，仅把输入集合限定为该 block 归属的记录，不能漏掉工具或摘要 usage，也不能重复加入 assistant 的工具返回。
- CH 取输入集合中按原始 entry 顺序最后一条 assistant 的 usage：`100 × cacheRead / (input + cacheRead + cacheWrite)`。不是全体请求加权平均，不是命中请求数 / Requests；toolResult/独立 usage/摘要不会覆盖最后 assistant CH。
- 最后一条 assistant 的提示输入为 0 时，CH 不可用；不能保留上一条非零输入 assistant 的旧 CH。原生仅在累计 cacheRead 或 cacheWrite 大于 0 且 latestCacheHitRate 可用时显示 CH。此处固定字段布局建议对应不可显示情况写 `CH —`，不凭空补 `0%`。
- 原生 CH 用 toFixed(1)；本需求已明确“最多一位小数”，因此额外去掉 `.0`，其计算公式不变。
- 原生 formatTokens 以十进制 1000 为单位，后缀是小写 `k`、大写 `M`：小于 1000 原值；1000–9999 保留一位小数 k；10000–999999 四舍五入整数 k；1000000–9999999 保留一位小数 M；10000000 以上四舍五入整数 M。例如 `999`、`1.0k`、`9.9k`、`24k`、`1.0M`、`24M`。阈值与舍入全部照原生，不改成 ext-core formatCompactNumber 的 K/M 规则。
- 所有统计用原始 token 数计算，只在渲染时格式化。记录缺少可用 usage 时不伪造零；已存在的错误/取消 usage 仍按原生 entry 扫描规则保留，不额外按 stopReason 排除。
- 原生 helper 位于内部组件，未见顶层公共导出；实现前检查支持版本的可用公共 API。不能为复用几行格式化而 deep-import 私有 footer 或新增 host hook；必要时在 UI 内放同语义的局部函数及原生阈值对照测试。

#### Requests：原生 footer 没有此计数，仍待确认

- 原生 footer 没有 Requests 字段，不能宣称原生已定义请求数语义。
- 仍建议计该 block 归属的 assistant 逻辑请求数；同一请求产生多条工具调用/usage entry 不增加 Requests。正常、错误、取消请求都按真实身份记一次，不累加 message_update 快照。
- 这是逻辑请求数，不是 HTTP attempts。底层重试、cache warming、工具内部请求不能凭 usage entry 数量推断；若要真实 HTTP attempts，须另定义事件关联、版本支持和失败重试语义。

#### 请求归属和迟到 usage

建议每个 assistant 请求只归属一个 block，以首次关联的活动 block 为 owner；同一请求横跨原生边界时，后续工具可进入新 block，但该请求及其 usage 不再算第二次。无活动 block 的普通正文不为此额外创建工具卡。

block 收束锁定成员/请求归属，不要求当场锁死 usage：请求尚未结束时显示待结算，最终 message_end 或已关联的原生 usage entry 到达后只补全原 owner block 的统计。这样既不丢 token，也不重复归账。CH 按请求/entry 原始顺序确定最后 assistant，不按异步回调抵达顺序挑选。tool partial 可更新保存结果，但不能重新打开旧 block 或重置时钟。

当前建议仍是 block 归属集合，按原生 footer 相同公式统计；原生 footer 自身是整个 session 累计，而非 block/run 累计。此范围差异必须显式确认，不能把整 session 的数重复贴到每个 block。

## 4. 统计、身份与完整性

### 4.1 有效调用集合

```text
effective(call):
  有可验证子调用 → 按发生顺序展开子调用
  无子调用       → 保留 call 自身
```

- 针对实际容器递归到有效叶调用；不跨 session、不展开 subagent 私有会话。
- live capture、persisted capture、result details 必须择一，不能相加。
- 同参数调用也可能真实执行多次；不能按名称/参数去重。优先稳定 toolCallId，历史缺 ID 时用父身份 + 原始序号。
- streaming/partial/running/完成/错误更新原项；失败、取消也计一次。
- 父从无子调用变成有子调用时原子替换计数，例如 codemode ×1 → read ×2，父项不能残留。
- 摘要、header calls、平铺列表来自同一有效集合；历史/尾行仅作分区。
- 不执行 renderer 猜计数，不解析 ANSI 摘要，不从输出文本猜工具调用。

### 4.2 Thinking

建议每个非空 thinking block 一项，用 assistant message 身份 + block 序号定位。

```text
thinking tokens = ceil(sum(rawThinking.length) / 4)
```

先汇总再取整；不累加逐项取整结果。不计 signature、JSON 包装、标签、渲染 Markdown。流式按当前文本重算，不能把完整快照当 delta 累加。`.length` 与现有工具 `/4` 估算一致，是字符启发式，不是 provider 精确 usage。

空白块不生成详情。隐藏 thinking 时统计不泄露文本，详情不能绕过 host 可见性策略。

### 4.3 容器自身输出和异常不能丢

只平铺子调用会漏掉容器 `text()/display()/result`、源码、namespace、脚本异常。

建议分类打开后，为有独立内容的容器保留一条“不计 calls 的执行记录”入口，显示原容器内容；子调用仍平铺，不套父折叠层。不默认重复每个容器。

例如 read 成功后 Python 报错：read 计 1 call，父异常仍在执行记录/尾行可见。当前或最后工具详情始终可经 header 原始视图检查，尾行本身只读。

## 5. 控制流、ownership 与契约

```text
Pi host 原始 transcript（保留节点）
  + 工具所属 package 的结构化子调用事实
  + 已有 live capture / 可恢复 details
                  ↓
pi-ext-ui 统一活动投影（身份、分类、有效调用）
                  ↓
聚合视图 / 原始成员视图
  一个分类 → 一个项目详情
```

- Pi host 拥有 transcript、session、执行、Ctrl+O、原生滚动。
- 具体工具拥有 args/result/details 验证、子调用事实、错误语义；UI 不依赖具体 extension。
- ext-core 只承载必要的无副作用展示契约，不管理调用状态、不导入具体工具。
- pi-ext-ui 拥有聚合、分类选择、详情选择、布局、鼠标 hit map，以及本功能 run 时钟、block/request 关联和 usage 快照；状态限于所属 runtime/session。不把 UI request 记录扩展为通用任务账本。
- 沿用已批准两个 prototype seam，不新增 host hook、不改 host 磁盘文件、不读取新的 host 私有字段。现有 seam 内的新行为仍须兼容验证。

Q4 已批准以下跨包契约方向；确切字段及边界测试在实现前记录于正式架构文档：

1. `ToolPresentation` 增加可选结构化子调用事实：稳定 ID（有则提供）、工具名、args、result、状态、duration、实际存在的后代。类型放在现有契约附近，不建新 registry/event bus。
2. python_eval 在所属 provider 内复用 `readEvalDetails()`，从 `rows[kind=tool].trace` 提供事实；通用 UI 不复制专属解析。
3. codemode 复用 tracker/已有 details，统一成相同 UI 内部项；live 与恢复快照择一，不重复持久化。
4. ToolView 在 UI 内提供活动快照与显式折叠控制，全文仍由原 renderer 持有，不逆向解析 summary。
5. MessageView 在 UI 内补显式收起/详情投影能力，不扩充跨包 MessageViewSpec 的折叠层数。

跨包范围包括 ext-core 公共展示契约与 Python provider，已获批准。只改 ToolGroup 不能可靠提供 Python 子调用完整结果，不采用临时文本适配层。批准不包含新 host hook、回合计时持久化或 Notice 细分契约。

## 6. 生命周期、并发、回退

- 更新复用身份，保留仍有效选择；所选项移入尾行、被替换或消失时清掉选择，不让新项继承同序号的旧展开状态。
- 切 header 前重置分类、单项、原 ToolView/MessageView/巢状工具状态，不能只清组内 Set。
- 渲染阶段不反复收起子项，否则 streaming repaint 会立即关闭用户刚展开的详情。
- session 切换、历史替换、fork、compaction、reload 按当前节点重建；不持久化局部 UI 状态，不加迁移。
- 原生 notify 不新增持久化；已有持久化 MessageView 按原 entry 恢复。
- tracker 当前最多保留 200 个父调用，不能是历史唯一来源。旧记录只有摘要时显示摘要及“详情不可用”，不制造空结果，原父输出仍可检查。
- 图片、未知 renderer、正文、异常 assistant 终态维持现有断组/原生回退，错误不能被聚合隐藏。
- 先保留“至少两条顶层工具才成组”门槛，不默默把单个多子调用容器改成组。
- 清理继续幂等，runtime 隔离；不新增后台任务、全局锁、store 或滚动 patch。

## 7. 可行性与代码依据

| 部分 | 判断 | 依据 / 缺口 |
| --- | --- | --- |
| header、水平 rails、三类摘要、只读尾行 | 可行 | host-transcript-patch.ts 的 ToolGroup 已拥有投影/鼠标分派 |
| 分类/单项互斥 | 可行，需改局部状态 | 当前 #open 是 Set，允许多项打开 |
| 工具详情 | 可复用 | ToolView 有 FoldLevel、setFoldLevel、copy 与输出上限 |
| Thinking `/4` | 可行 | assistantInfo 已读 lastMessage.content，目前只返回 boolean |
| Notice 聚合 | 可行 | 已有 NotifyView/MessageView 路径；MessageView 目前单步展开 |
| codemode 子调用 | 有基础，历史完整度有限 | tracker、__piExtUiCapturedCalls、details.calls/nestedCalls；摘要记录可能缺 args/result |
| Python 子调用平铺 | 需补结构化契约 | Python 用 details.rows[kind=tool].trace；extractNestedCalls 只读 calls/nestedCalls |
| 回合用时 h/m/s | 本次运行可测，旧历史数据不足 | 公开 agent_start/agent_end 能定界，旧 session 无完整起止，不能累加工具 duration 代替 |
| Notice 精确来源分类 | 已有字段可用 | MessageView.header.kind 声明种类；notify 只有级别，不能识别来源 extension |
| 原生断组不重置时钟 | 可行，需独立 run 生命周期 | run 不能依附 ToolGroup 实例或每次 projection rebuild |
| block 请求 usage/CH | 可行，需请求身份和归属 | message_end 有规范化 usage；response-status 仅存最后回应且会清除，不能作为累积账本 |
| 切模式前全部收起 | 需补控制入口 | ToolView/NestedCallsView 有部分基础，MessageView 缺显式收起 |
| regular/fullscreen | 沿用现有边界 | fullscreen 鼠标、regular Ctrl+O，不扩大滚动 patch |

核对文件：`packages/pi-ext-ui/src/{host-transcript-patch,tool-view,message-view,nested-calls-view,tracker,payload-parser,renderer}.ts`、`packages/pi-ext-core/src/{tool-presentation,message-view-point}.ts`、`packages/pi-python-eval/src/presentation.ts`。

已核对安装 host 的 tool-execution.js（setExpanded/getRenderContext）、assistant-message.js（setHideThinkingBlock/逐段 thinking 点击）。不能据单个版本宣称最低支持版本全部通过；实现须验证支持范围，不能修改用户全局 thinking 偏好来实现局部折叠。

## 8. 实施与验证

1. 确认新增的结束态布局和请求计量口径，更新正式 UX/架构文档；Q1–Q6 不重复决策。
2. 建结构化事实通路与聚焦测试，确保 live/partial/完成/恢复口径一致，不新增重复持久化格式。
3. 实现聚合、尾行、互斥详情、原始视图切换及递归收起，复用工具 Level 2。
4. 验证布局、历史、并行、错误、Ctrl+O 与真实 CLI，更新图谱；提交只含本任务变更。

验收至少覆盖：无子计父、有子不计父、父转子不累加、重复参数调用、capture/details 不双计、Python trace、父独立输出/异常保留、旧记录缺全文、并行尾行、Thinking 流式长度/signature 排除、Notice 原文、分类/单项互斥、header 两方向收起、尾行不可点击、copy 热区、ANSI/Unicode 窄宽布局、主题失效、runtime 隔离、卸载回退。

实施阶段计划命令（尚未执行，按实际文件收紧）：

```bash
pnpm exec biome check <本任务修改的 TypeScript 文件>
pnpm exec vitest run <受影响的 pi-ext-ui / provider 测试文件>
pnpm --filter @hheei/pi-ext-ui run build
pnpm --filter @hheei/pi-ext-core run build
pnpm --filter @hheei/pi-python-eval run build
pnpm run typecheck
pnpm run test:integration
graphify update .
```

升级 typecheck 原因：共享展示契约与跨包 provider。执行真实 CLI 集成测试原因：host transcript 投影和 Ctrl+O 行为变化。不默认运行全仓 test/check。

新增验收：kind 精确分组、未知类型、notify 级别与来源键不碰撞、回合跨多个 turn 不重置、并行不叠加时间、取消/错误结束、h/m/s 边界、旧历史缺计时。

本轮追加验收：真实原生边界收束旧 block、下一 block 沿用 run 起点、重绘不重复收束、局部统计重置而旧数据可查、Requests 不逐工具/usage entry 计、请求横跨 block 不双计、迟到 usage 回补 owner、message_update 不累计、错误/取消保留 usage。原生 footer 对照验收：IN 不含缓存输入、全部支持 usage entry 类型仅计一次、CH 使用最后 assistant 而非加权平均、最后零输入清空旧 CH、无缓存/不可用 CH 占位、最多一位小数、k/M 各阈值与舍入、压缩前 usage 保留、历史 usage 重建。

本轮仅更新 Markdown，执行 `git diff --check`；不运行 TypeScript、build、测试或图谱 AST 更新。

## 2026-10-29 修订（用户实机反馈）

1. `notice` 逐项可展开，点开显示提供者详情；`MessageView.detailRows` 不再重复 header，避免与分组摘要行重复。
2. 三个分类标签统一小写：`tools`、`thinking`、`notice`。
3. 展开 `tools` 时逐项渲染工具自身 Level 0（真实 header 与预览行），相邻工具之间恰好一个空行，点击转发给原组件；展开 `thinking` 时为标签行加首行预览、项间一个空行；`notice` 保持一项一行、不加空行。
4. 拆分模块边界：`tool-group-view.ts` 只负责 block 内布局、统计与命中测试；`host-transcript-patch.ts` 只负责 host seam、成员提取与安装/卸载，不再承载大段视图逻辑。
5. 分类顺序改为 `notice`、`thinking`、`tools`（用户反馈）。分类行去冗余：空分类整行省略，notice 行不再重复 `N notices`，只列类型计数；footer 换统计后，原尾行工具回到 `tools` 列表，不丢调用。
6. 修正完成态布局（推翻上一版两次）：header 保持 `collapse views · 用时 · N calls`，body 不变；最后一条 rail 下只有单一 footer 槽位，运行态显示尾行工具状态，完成后由 `Requests ×N · IN … · OUT … · CH …` 覆盖该行，不追加 rail，也不把 block 缩成单行。

实机验证（herdr + `pnpm run pi-dev`，SGR 鼠标注入）：完成态三段式（header/body/footer）、工具分类逐项 Level 0 与空行分隔、单个工具由自身组件展开、notice 分类与单项展开、Ctrl+O 原始视图与收回，全部符合预期。
