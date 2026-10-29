# pi-ext-ui 折叠视图问题排查

状态：只读排查完成，未修改实现。仅新增本文档。
执行拆分：[Tickets 索引](pi-ext-ui-rendering-tickets/README.md)；本批仅建票，尚未实施。
基线：发布 v0.6.0，提交 cd12365b；结论来自当前源码、测试和本机 Pi host 实现。未运行 herdr 或新增运行时复现。

## 用户报告与目标

1. Notice：展开分类后出现 a 分类标题、b 可展开通知标题、c 重复通知正文。om 的普通通知不应存在 b，直接显示 c，无子展开操作。
2. Thinking：子条目只有 token 标签，点击后无正文。hide-thinking-block 开启时显示约 20 字符内容预览，truncate、不换行；点击显示全文，子项展开互斥。关闭时直接平铺正文，不单独折叠。
3. Tools：codemode/python_eval 子调用拆分仅用于统计；展开分类保留原工具 ext-ui Level 0。分组不感知具体工具渲染。保留工具左导轨，箭头和导轨左侧均留一个空格。
4. 完全展开：thinking、工具、notice 之间一个空行；保留 footer。
5. 设计语言：统一语义着色，不能一律灰色；bash 展开后可检查完整命令；read/bash 着色对齐原生 Pi。
6. 后续修订：footer 始终显示实时统计；最后一条 message 考虑保持原样放在组外，间隔一行，避免画面抖动。第 6 节覆盖旧运行态 footer 方案。

已查看截图：
- /tmp/herdr-clipboard-images-1000/client-365-clipboard-1793271486310626962-0.png：活动组标题、分类和 footer 低对比度，工具分类名称较亮。
- /tmp/herdr-clipboard-images-1000/client-365-clipboard-1793271640259628447-0.png：bash/read 状态为绿色，read 路径灰色；bash 命令与标题样式缺少原生语义一致性。

## 1. Notice：普通通知被制造出子展开层

### 已确认发生点

- packages/pi-ext-memory/src/hooks/consolidation-trigger.ts:653–654：observer 使用普通 ctx.ui.notify(message, "info")，没有声明 detail 或展开行为。
- packages/pi-ext-ui/src/host-transcript-patch.ts：NotifyView.member（约 197 行）无条件提供 detail；summary 与 #detail 都来自同一 #content。
- packages/pi-ext-ui/src/tool-group-view.ts:421，#renderNotices：只要 detail 存在就画箭头；展开后先画 summary，再画 detail。因此同一内容出现两次。
- 另一条路径 noticeMember:161 使用 MessageView.hasDetail，而不是 expandable。packages/pi-ext-ui/src/message-view.ts:200 附近的 hasDetail 把 preview-only 也视为可展开，改变了原 MessageView 只有 body 才可展开的语义。

### 方案

- 普通 NotifyView 直接输出一份带缩进、按宽度换行的通知内容，不生成 item 展开动作；分类本身仍可折叠。
- MessageView 保留自身展开契约：header/preview 是直接可见内容，只有真实 body 才支持子展开。不能以“存在可显示内容”代替“可以展开”。
- 渲染内容和展开能力由 notice 自身负责；分组只管理分类及真实可展开项目的选择。不根据 om 字符串做特殊判断，不用比较 summary/body 相等来猜测语义。
- 优先复用 MessageView 的布局与交互，必要的分组互斥控制留在 pi-ext-ui 内；不先扩展 ext-core 公共契约。

### 验证

- 普通 info/warning/error 通知：正文仅一次，无子箭头、无 item 点击动作；长行换行，保持 warning/error 语义。
- 无 body、preview-only、真实 body 三种 MessageView；preview-only 不增加展开层，有 body 时保留正文和互斥行为。
- 当前 host-transcript-patch.test.ts:664 附近明确断言 preview-only 有箭头，需要按新契约替换，不是只添加一个 om 特例。

## 2. Thinking：正文被丢弃，设置被误当作数据过滤

### 已确认发生点

- host-transcript-patch.ts:71，assistantInfo 读取 lastMessage 的 thinking 与 hideThinkingBlock。
- 同文件 rebuild（约 295 行）：hidden=true 时仍传 thinkingChars，但通过 thinking === "" || info.hidden 条件省略 thinking 正文。
- tool-group-view.ts:170 用 thinkingChars 判定条目存在；#renderThinking:387 总是输出可点击 token 标签，随后 text===undefined 就跳过正文。因此隐藏设置下点击只能改变箭头，永远无内容。
- hidden=false 仍使用同一子项折叠逻辑，未按设置直接平铺。
- preview:91 取整个首个非空行，不是约 20 字符；之后仅受整行终端宽度裁剪。
- assistantInfo 将多个 thinking block 直接拼接，无分隔；当前粒度是每个 assistant message 一项，并非每段原始 thinking 一项。
- host-transcript-patch.test.ts:651 的测试明确要求 hidden=true 点击后仍不显示 reason；测试固定了旧行为。

### 方案

- 投影保留正文和隐藏偏好，二者分开。hide-thinking-block 是初始展示策略，不是删掉正文的开关。
- 开启：子项显示真实内容的约 20 字符预览，按 grapheme/终端单元格安全截断，再受剩余列宽约束；点击完整换行显示；复用单一选中项实现互斥。不可再以 token 标签代替内容。
- 关闭：直接显示完整 thinking 内容，无子项箭头和点击展开动作。
- 正文使用 thinkingText + italic，优先复用 Pi Markdown/TUI 原语；展开正文不能退回无语义色的普通字符串。
- 原始内容段间保留段落分隔。建议对齐 Pi 的连续 thinking run 粒度；若实现仍采用 message 粒度，必须显式记录，避免无分隔拼接。
- 完全展开时也保留正文与设置的明确关系，不能再靠隐藏原始字段实现预览。

### 上游依据与验证

本机 Pi 的 dist/modes/interactive/components/assistant-message.js:90–135 保留 thinking 数据，隐藏态用标签、可通过 thinkingVisibilityOverrides 单独切换；正文用 Markdown、thinkingText、italic。无需改 Pi host 或新增 host hook。

验证：设置开/关 × 分类开/关；两个子项互斥；空 thinking 不画假箭头；多段段落、中文/emoji、ANSI、窄宽布局；切换设置后重绘。替换旧的“隐藏后无法查看”断言。

## 3. Tools：统计展开被错误复用为展示展开

### 已确认发生点

- host-transcript-patch.ts:108，toolMember 同时传原 component、children 和 childCount。
- tool-group-view.ts:178，#calls 已用 childCount 或 children.length 替换父计数；这部分应保留。
- #renderFrame 的 counts 循环使用子名称聚合，属于统计用途，也可保留。
- #renderTools:343：children 存在时完全绕过 member.component，改为手工拼每个 child 标题和 detail。父工具原本 Level 0、容器正文、copy 与自身交互不再进入此路径。
- #renderTools 和 #renderRaw 都调用 renderWithoutToolRails；tool-view.ts:97–107 通过模块级 outerRailDepth 抑制所有内层 ToolView 导轨，renderBody:537 和 render:611 读取此状态。这是导轨消失的直接原因，不是终端裁切。
- 分组自己拼的子标题没有左 padding；正常 ToolView 依赖 context.outputPad，不能用“拼一行字符串”替代其布局。

### 方案

- 分开统计事实和展示：children/childCount 只用于有效 calls 与类型统计；工具分类始终交回原工具 component 绘制。
- 删除 #renderTools 的手工 child 分支及对应 child 选择状态（先检查其他使用点）；使用已有折叠契约在分类初次展开时回到 Level 0，不在每帧强制重置，保留后续原工具点击行为。
- 不调用 renderWithoutToolRails；检查全部调用方后删除无剩余用途的 outerRailDepth 动态作用域机制，不能再叠一层恢复导轨的 wrapper。
- 一个空格的工具左 padding 在工具布局层统一拥有，包含箭头、导轨、内容和 copy 命中坐标；分组不能和工具重复加 padding。宽度预算与鼠标 x/y 必须一起调整。
- codemode/python_eval 保留各自原有 Level 0，包括其工具自身提供的子调用展示。禁止的是分组把容器拆成顶层列表，不是禁止容器原本的内容。

### 验证

容器有 N 个子调用：统计仍为 N，列表却保留一个父工具视图；无子调用父工具按 1 次计算。验证普通工具、codemode、python_eval 的 Level 0、点击展开、copy、错误正文；窄宽布局下一个空格和导轨均存在，点击内容行不触发错误项目。已有 child row duration 等分组测试应移到工具自身展示测试或改成父组件保真断言。

## 4. 完全展开：缺少语义间距和 footer

### 已确认发生点

- tool-group-view.ts:239，#renderRaw 只输出上 rail、member rows、下 rail，不调用 #footerRow，也不输出运行态 tail。
- #offsetWrapper:471 对每个 member 移除首个空行，但 #renderRaw 没有补相邻 member 间隔；原生分隔被去掉后直接拼接。
- #renderRaw 还调用 renderWithoutToolRails，导致完全展开同样丢导轨。
- footer 当前只存在于 #renderFrame 的结尾。因此无论点击组标题还是 Ctrl+O 进入 raw 路径，都绕过 footer。

### 方案

- 框架共享 header、两条 rail、单一 footer；折叠/完全展开只切换 body。不再维护两个会漂移的 footer 决策路径。
- 完全展开保持原时间顺序，在相邻非空语义块之间恰好一个空行；只规范块边缘空行，不删正文内部段落。空成员不引入空白。
- footer 始终显示 Requests/IN/OUT/CH，运行态不再替换为工具状态；无额外第三条 rail。工具/输出放到组外，详见第 6 节。
- 布局产生的空白行记为无动作命中区域；成员自身鼠标坐标与高度按实际行数转发。

### 验证

标题点击和 Ctrl+O 两入口；运行中/完成/断组；thinking→tool→notice 混排、不可见 assistant member、已有首尾空白；footer 始终一次，rails 两条。切回聚合清理内部展开状态。

## 5. 语义着色与命令保真

### 5.1 灰色不是主题单点问题

已确认：
- ToolGroupView.render:520 的组标题用 muted，时间/calls 用 dim；#categoryRow:227 标签 muted、detail dim；#footerRow:213 整行 dim。
- NotifyView 把 info 统一映射为 dim；#detail 的正文又没有保持该语义样式。
- #renderThinking 预览使用 thinkingText，但展开正文经 #detailRows 成为无样式文本，且未 italic。
- tool-view.ts:174，formatToolHeaderText 将所有非 bash 摘要涂 dim，bash 则例外不着色。read 路径因此丢原生 accent。
- renderer.ts:121，resolveToolCallSummary 把原生 renderCall 在固定 120 列绘制后剥离 ANSI，仅取第一行；随后统一重涂摘要色。原生的路径、范围、命令语义在这里丢失。
- python-eval/src/presentation.ts:329 的 formatToolRow 独立拼行，所有摘要（含 bash）涂 dim，与 ext-ui 的 bash 例外不一致。

建议语义表（实施前同步 DESIGN.md，不引入新颜色）：

| 内容 | 样式/条件 |
| --- | --- |
| 组标题、分类标签 | 可辨识的 text；当前展开/焦点可用 accent 配合箭头，不只靠颜色 |
| 分隔线、次要耗时、计数、footer 元数据 | borderMuted/dim，避免整段正文一起降亮度 |
| thinking 内容 | thinkingText + italic，预览和正文一致 |
| notice | info 正文 text；warning/error 使用对应语义色和文字标记 |
| 工具名 | toolTitle + bold |
| read 路径 | 原生 accent；行范围 warning；保留路径链接能力 |
| bash 命令 | 原生 toolTitle + bold；timeout 等元数据 muted |
| 工具输出 | toolOutput 或原生语法高亮；错误 error；状态 glyph 保留 success/accent/warning/error |

本机上游依据：dist/core/tools/renderers/bash.js:16–21 的 formatShellCall；renderers/read.js:18–24；render-utils.js:150–156 的 renderToolPath。它们分别明确命令、路径、行范围的语义，不是所有摘要 dim。

方案：在工具展示所属层复用原生 renderer/现有语义格式，不在 ToolGroupView 按 bash/read 名称补颜色。不要继续“render(120)→去 ANSI→取第一行”反向解析视图来构造完整展示。若确需扩展公共 presentation 契约，单独列明消费者和变更范围后再确认；本轮不修改公共契约。python-eval 不能反向依赖 pi-ext-ui，需遵循 ext-core/提供者既有依赖方向。

验证：带可区分 token 的测试 theme，检查命令、路径、行范围、耗时、正文的实际样式；再用真实 Pi theme 做窄/宽截图对照。仅 strip ANSI 后断言文字无法发现此问题。

### 5.2 bash 完整命令：存在三条不同丢失路径

1. 聚合子项：payload-parser.ts:401 的 formatArgumentSummary 对 bash 硬截到约 70 字符；renderer.ts:168 的 nestedChildren 只传摘要及结果 detail，不传完整请求；ToolGroupView 展开子项只显示 detail。因此展开不能恢复原命令。
2. python_eval 子调用：presentation.ts:343 的 summarizeTraceArgs 把参数压成 72 字符摘要；transcript.ts:263 的 trace 投影仅保留此摘要，EvalCall/EvalTrace 无原始 args 字段。仅改 UI 换行不能从这些已截断字段恢复命令。
3. 顶层普通 bash：resolveToolCallSummary 固定 120 列取首行；ToolView.#renderHeader 在所有 level 都截断 header。不过 renderGenericResult 的 createInputCodeSection 已从 context.args.command 建立完整输入 section，正常展开应有完整命令正文（受 Level 1/2 既有限额）。不能把所有顶层 bash 都判定为已丢命令。

方案：先修第 3 节，恢复父工具自己的展开路径；完整请求和 compact 摘要明确分离，宽度截断只发生在展示时。普通 bash 复用已有 request section，展开时按实际宽度换行，不把摘要当请求。codemode 嵌套详情从捕获的原 args 走既有 child renderer。python_eval 需继续检查事实账本是否保存可定位的完整 args：恢复若要跨账本/会话持久化契约，不应为此次 UI 修复直接增加跨包读取；另行设计工具提供者如何提供完整请求或可检查入口。历史数据若只有摘要，应说明不可恢复，不能把省略号后的内容当完整命令。

证据限制：用户给出的 rg 命令没有附带对应会话 toolCallId/原始参数，不能唯一判断它来自上述哪条路径。三条源码路径已核对；精确归属需下一轮用该条真实会话记录确认。

验证：长单行命令、多行命令、引号/glob/管道、Unicode；顶层与 codemode/python_eval 嵌套；Level 0 可摘要，打开详情可取得原命令；copy 与原请求一致；安全剥离终端控制序列，不能静默改写命令本身。

## 6. 后续修订：实时 footer 与组外尾部 message

### 新报告与目标

旧 footer 的“✗ codemode”丢掉 ext-ui 第一行已有的摘要、耗时等信息。若继续用旧预览机制，应复用工具完整首行，codemode/python_eval 不另画下面的子调用。

用户进一步提出替代设计：footer 固定为实时统计，工具/Thinking/输出在其后一空行原样显示；更本质的方案是最后一条 message 不进入 collapse view。

目标布局：组标题 → 上 rail → 历史分类 → 下 rail → Requests ×6 · IN 15k · OUT 5.4k · CH 99.6% → 一个空行 → 原工具/thinking/输出。

建议采用“尾部原组件留在组外”，删除组级工具预览，而不是新增一种预览 renderer。两种要求需要区分：原样保留组件会保留其自身 Level 0 子调用；“容器只显示首行”则是另一种裁剪模式。是否仍要求组外容器只显示首行，待确认。

### 已确认发生点

- ToolGroupView.#renderFrame 调 formatToolHeaderText 仅传 tail.status/title，不传 summary，直接导致信息不全。
- #tailIndex 找最后运行工具或最后工具，不是最后 message；#historyTools 仅运行时排除它，settled 后重新纳入。不能只修改 footer 分支实现新设计。
- host-transcript-patch.ts 的 rebuild 将 eligible assistant、工具、notice 全部放入 members，flush 按工具数决定成组。尾部排除应在投影层处理，不再由 ToolGroupView 挑一个工具充当尾部。
- 会话 message 和渲染组件不是一一对应：assistant 可含 thinking/toolCall，而工具另有执行组件。不能机械地把 chat.children 最后一个对象等同用户的“最后 message”。

### 建议契约（尚未实现）

1. 明确末尾可见顶层单元，保留原组件身份、样式、折叠和交互；工具 call/result 作为一个执行组件。空 assistant/toolCall 占位不能把仍可见的工具误吞进组。
2. 新的可见单元到来时，上一尾部才成为历史候选；纯流式更新、状态改变和并行完成顺序不触发尾部反复迁移。原有正文断组规则保留，不把正文强行收入组。
3. 回合结束本身不吞入尾项、不切换 footer 结构。历史恢复需能稳定推导尾部位置；每个断组是否各留一个尾项，需要用真实 transcript 例子定稿。
4. 建议 footer 统计同一活动 block 的请求，包含组外尾项对应请求，避免迁移时重复计数或统计跳变；分类仅描述可展开的组内历史。header calls 是否也包含组外尾项，需统一确认。
5. 实时统计仅随已有 usage 事实更新，不用字符数伪造 IN/OUT；未有 usage 显示占位。完整 usage 可能到请求结束才提供，不能承诺逐 token 精确刷新；CH 保留既有公式。
6. 无足够历史时沿用原生显示，不产生空组或孤立 footer。排除尾部后，现有“两工具成组”阈值需重新验证，避免反复建组/拆组。

### 避免画面抖动

- footer 固定一行，窄屏 ANSI-safe 裁剪，不因数字增长换成两行；usage 更新不改变 rails 和尾项归属。
- 保留 group 和原组件身份，不以每帧新 Member 对象作身份；统计/时钟刷新不重挂载正文，不重置展开或 copy 状态。
- 尾部追加、旧尾部归组和统计更新在同一投影/帧完成，不先删除、下一帧再添加。无需额外防抖定时器。
- 组与尾部恰好一个空行，避免重复叠加原组件 leading Spacer；只处理组合边缘，保留正文内部段落。
- 不在每次流式刷新调用 collapseAll；新内容增长与用户展开允许真实高度变化，禁止用永久空白占位伪装稳定。
- 保持原生 scrollback/fullscreen follow 行为，不修改 ScrollView、不新增 host hook。

“完全不变高”与流式正文增长、旧尾部归组不兼容。防抖目标是消除重复重挂载、间距闪变、来回迁移和分帧更新；真实内容增长造成的布局变化仍存在。

### 验证与待确认项

- footer：无 usage、流式更新、多请求、结束、取消、断组、完全展开、窄屏。
- 尾部：thinking→工具→工具→正文、通知插入、并行工具乱序结束、最终工具完成但无新 message、空占位。
- 同一成员只更新 usage/status 时身份、选择和行数不变；新增可见成员只迁移一次。herdr 连续观察帧，不能只验最终截图。
- 待确认：组外保持原组件还是容器仅首行；统计是否包含尾项；尾部语义粒度以及每个历史 block 的尾项保留规则。建议优先采用原组件，统计同 block 包含尾项，减少重复 renderer 与计数跳变。

## 架构收敛与实施顺序

1. 投影层保留事实：原始内容、展示偏好、计数各司其职。保留现有必要 monkey patch，不修改 Pi host，不新增 host hooks。
2. 分组只负责聚合、顺序、分类互斥、间距、footer 和坐标转发；工具及 notice 的正文、颜色、copy 和局部折叠由原展示负责。删除手工子工具重绘及动态禁导轨逻辑。
3. 先修 notice/thinking 数据与展开语义，再统一 body/frame/footer，随后处理工具语义着色和完整命令来源。任何持久化或跨包公共契约扩大单独确认。
4. 更新 DESIGN.md、docs/architecture/pi-ext-ui-tool-groups.md 和聚焦测试；最后 herdr 逐项点击验证。旧 spec 中“平铺容器子调用”“隐藏正文”“preview-only 可展开”等不再作为新实现验收依据。

性能约束：未展开分类不构建全文；避免每帧遍历并重绘隐藏成员、固定宽度探测原生 renderer；行宽/主题/展开状态变化正确失效缓存。先删除重复渲染路径，不加新的全局缓存、事件总线或兼容 wrapper。

## 本轮验证与剩余项

- 已执行 graphify query 定位相关模块，读取当前实现、现有测试与本机 Pi upstream renderer；已查看两张截图。
- 仅新增 Markdown；执行 git diff --check 和 git status 核对改动范围。
- 未跑 TypeScript、单元测试、全量 check、herdr：本轮没有实现改动，不声称动态复现通过。
- 未决：具体 rg 记录的来源；python_eval 完整 args 的可恢复来源；新的语义着色在真实主题下的对照效果。它们不能凭静态源码或截图推断为已验证。
