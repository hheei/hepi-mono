# Transcript 高度稳定性：排查与重设计计划

状态：原高水位方案已被以下两行尾项方案取代；原章节仅保留为调查背景，不再作为实施方案。

## 最新更正：按总高度补齐

用户确认：Tool backgrounds 开启时统一至少 4 行，关闭时至少 2 行，内容与自带色块 padding 均计入。补偿数为 `max(0, 下限 - 本帧总高度)`，顶部语义分隔和独立 OSC 标记行不计入；空输出不补行。无色块的单行 thinking / notice 在着色模式补 3 行；两行工具加上下两行 padding 不补。补偿仍在完整色块外且不参与点击。

不再需要扣除背景装饰，删除私有 padding WeakMap，直接使用本帧输出计数；背景开关沿现有投影路径传给 TailUnit。下面两行内容方案与验证记录保留为历史背景。

## 前次决策与可行性调查

用户已同意：尾项内容 1 行时，在色块后补 1 行无背景空白；2 行原样输出；超过 2 行不补偿、不截断，接受特殊高度变化。颜色 padding 不计入内容行数。取消整轮高水位、冻结占位和折叠重置设计。

用户已确认未成组时最后一个可见工具、notice、thinking 也采用相同下限。进入实施阶段，源码结论不代表真实终端验收完成。

实施边界：背景模块用 package 私有 WeakMap 记录已知 view 本次渲染的垂直背景 padding 行数，不扩展公开类接口。ToolView 在隐藏、缓存命中与正常渲染路径均更新该事实；MessageView 的固定 shell 声明自己的 padding。host 投影只为受支持成员读取这些事实；TailUnit 在原组件渲染完成后扣除背景装饰，按整个尾项计算一次补偿。没有测量重绘、ANSI 颜色猜测或跨帧高度反馈。此映射仅含弱引用和数字，不持有生命周期资源。

### 可行性

- ToolView 先形成 `safeLines`，再由 `surfaceBlock` 加上下背景 padding；MessageView 先形成 `#shellRows`，再交给 `Box(0, 1)`。内容与装饰有明确边界。
- 工具 self-render shell 和自定义消息 host wrapper 会额外加顶部空行。尾项包装层可以在完整色块之后补空行，不改变内容的鼠标 offsets。
- 无需高水位、计时器、run 状态或跨帧反馈；旧 `noteTailRows` 及两套高度保留应删除。

### 实施前需解决的边界

1. **内容高度获取。** TailUnit 目前只拿最终字符串，没有本帧装饰行数。不能扫描颜色或删除所有空白推断；正文空行、主题和 OSC 会破坏推断。也不能重复 render 来测量。需要最小的 package 私有布局事实协作；ToolView / MessageView 是公开类，不应为此随意扩展公共 getter 或 renderer API。
2. **thinking。** Pi host 在顶部 Spacer 行附加 OSC 133 标记，该行不算内容，但标记必须保留。一个尾项可能含多个 assistant parts，按整个尾项计数，不能每个 part 各补一行，不能删除正文内部空行。
3. **覆盖范围。** 当前 TailUnit 只在达到成组门槛且尚未断开的连续段出现。未成组直接输出原组件，正文断组会移除尾项。仅改 TailUnit 不覆盖这些情况。建议补偿只跟随实际展示的尾项，结束后不转移给 collapse view；未成组是否同样覆盖需明确。
4. **缓存和交互。** 同帧布局事实在 cache hit、隐藏 call view、结果 view 替换时均须正确。补偿不进入点击 offsets；保留原有分隔、OSC 和 thinking 鼠标偏移修复。

### 替代实施步骤

1. 明确未成组尾项是否纳入范围，审计实际渲染及缓存路径。
2. 从真实投影入口测试 1/2/3 行、工具、普通 notify、自定义 notice、thinking/OSC、多 parts、背景开关和空白点击；变化第一帧与后续无变化帧一致。
3. 删除组和尾项历史高度、report 回调及退色释放耦合；只在完整尾项末尾做无状态补偿。
4. 接入最小同帧布局事实，不重复渲染、不扫描颜色、不增加通用 registry 或公共契约。
5. 更新 DESIGN.md，执行聚焦验证及真实 Pi TUI 验收。组行数变化、背景 padding 差异、超过两行和尾项消失仍可改变总高度；不把两行下限宣称为全局防抖。

### 实施结果

- 已覆盖成组和未成组尾项，空 assistant 占位不替代前一个可见成员。旧高水位、尾项缓存及跨帧 report 已删除。
- 最先加入的 7 个投影用例在旧实现上全部失败，替换实现后通过；另补窄/宽布局、缓存、工具完成与背景切换、thinking 展开/收起、多 parts、退色及断组测试。
- 实际验证：指定 7 个 TypeScript 文件的 Biome 通过；`pnpm exec vitest run packages/pi-ext-ui` 共 301 测试通过；`pnpm --filter @hheei/pi-ext-ui run build` 通过；指定改动文件 `git diff --check` 通过；`graphify update .` 完成。
- 未执行全仓 typecheck/test/check；尚未完成真实终端人工验收，不能以测试通过代替实机无抖动结论。

以下为已取代的高水位方案和调查背景。

## 1. 目标与范围

用户报告：thinking 出现时尾部空行被收回；出现快速抖动；发送 notice 也会收回空行。用户要求先排查、设计，不继续打补丁。

目标：活动输出区域因自动更新、尾项替换或成组而变短时，在区域末尾保留必要空白，避免输出整体回弹。补偿空白属于 transcript 布局，不属于 collapse view 内容。

必须区分：

- 真实增长：超过保留高度后允许自然增长，不截断输出。
- 自动收缩：尾部占位吸收，不能先缩一帧再补回。
- 主动重排：用户改变折叠或终端宽度时，按明确契约重新排版。

高度稳定不代表内容内部绝对不动。工具折入分类、notice 替换尾项会改变排列；必须消除的是补偿机制额外推动内容、总高度回弹，以及无内容变化的后续帧再次改变布局。

不改成组权重、thinking 显隐语义、工具折叠层级、notice 内容、spinner 节奏、Pi host 滚动算法。不引入依赖、配置项、持久化格式、跨 package 公共 API 或 ext-core 基础设施。

## 2. 证据与待核实项

### 2.1 已从源码确认

主要位置：

- `packages/pi-ext-ui/src/tool-group-view.ts`：`TailUnit.render`、`#padToReserve`、`noteTailRows`、`#quiet`。
- `packages/pi-ext-ui/src/host-transcript-patch.ts`：`attach` 内的 `rebuild` / `flush`、`groups` / `tails`、`RunBox`。
- `packages/pi-ext-ui/test/tool-group-view.test.ts`：现有高度测试。

**A. 占位归属错误。** `#padToReserve` 在 footer 后、背景 Box 内追加行，还加入组的 hit 列表。补偿位于尾项之前，属于组表面。即使总高度一致，补偿在组内与尾项下方之间转移，也会推动 thinking。

**B. 跨帧读写。** 投影先渲染 group，再渲染 tail。group 使用上一帧 `#tailRows`；tail 本帧渲染结束才报告新高度。一次输出混用了两帧的数据。

示例，忽略固定分隔行：

| 帧 | 组真实高度 | 计算采用的尾项高度 | 实际尾项高度 | 总高度 |
| --- | ---: | ---: | ---: | ---: |
| 原始帧 | 6 | 10 | 10 | 16 |
| 短尾项替换 | 6 | 10（旧值） | 2 | 8 |
| 后续重绘 | 6 + 8 补偿 | 2 | 2 | 16 |

这是算法推导，不是实机帧日志。需用真实投影入口验证对应的失败路径。

**C. notice 换掉尾项身份。** `flush` 取 `members.at(-1)` 作为未断开段的尾项。notice 加入后成为新尾项，旧 thinking/tool 进入组内。`TailUnit` 按 component 身份保存高度，新 notice 从零开始，与 B 共同形成收缩风险。

**D. 生命周期耦合错误。** `#quiet` 使用最后一个有状态成员及背景保持时间释放高度。工具完成不等于 thinking 或整轮活动结束；5 秒退色不应压缩布局。

**E. 测试掩盖时序。** 尾项折入测试在 tail 报告高度后额外调用 `group.render`，再执行折入，给实现多一帧吸收高度，没有检查变化第一帧。

**F. thinking 不一定断组。** 满足 `assistantInfo().eligible` 的 thinking 继续加入当前段，不能统一解释为 `flush(true)`。

### 2.2 实施前必须核实

- 已安装 Pi host 版本及 Container 的渲染顺序、缓存、invalidate、鼠标布局行为。
- Pi TUI 对尾部空行、OSC 133 标记、终端视口和滚动区域的处理；返回空行数组不等于已证明终端保留空间。
- `beginRun` / `endRun` 与首个 assistant、notice、取消、异常、延迟消息的事件顺序。
- grouping 门槛、正文边界、未知 renderer 边界是否重建投影身份。
- 同一 run 内正文和多个 collapse block 的关系；run、连续分组段、tail 不是同一概念。
- run 结束后到达的后台 notice 如何归属，不能重新打开已结束区域。

先读 Pi 文档及对应上游实现，记录实际版本和路径。诊断仅限测试或临时可检查输出，不增加常驻日志、计时器或隐藏模式。

## 3. 建议架构

### 3.1 数据与控制流

```text
Pi host transcript + run 生命周期事实
  → 投影确定区域身份与本帧内容
  → 渲染本帧全部真实内容
  → 统计完整真实高度
  → 区域末尾追加无背景、无交互的补偿空行
  → Pi host 原生 TUI 输出与滚动
```

```text
活动输出区域
├─ collapse view：真实内容与自身设计 padding
├─ thinking / tool / notice：真实内容与语义分隔
└─ 布局补偿：终端默认背景，不属于任何内容块
```

Box 设计 padding、语义分隔行、布局补偿是三个概念，不能互相替代。

### 3.2 Ownership

| 所有者 | 责任 | 不应负责 |
| --- | --- | --- |
| Pi host | transcript 来源、原生终端输出、滚动与输入调度 | extension 分组策略 |
| pi-ext-ui transcript 投影 | 稳定区域身份、生命周期、完整帧组合、唯一高水位、补偿与坐标映射 | 修改消息或 session 数据 |
| ToolGroupView | 组真实布局、分类折叠、背景、命中区域 | tail 高度、区域高水位 |
| TailUnit | 尾项真实渲染、分隔标准化、原生鼠标转发 | 高水位、向兄弟组件回报高度 |
| 内容组件 | 工具/notice/thinking 内容和交互 | transcript 高度策略 |

优先复用现有投影 Container。确实需要封装完整区域渲染、保留高度和坐标映射时，才新增 package 私有组件；不抽通用布局框架或公共 API。

### 3.3 同帧算法

同一宽度、同一布局周期内：

```text
rows = 本帧区域内全部真实内容行
H = rows.length
R = max(此前保留高度, H)
padding = R - H
output = rows + padding 个空行
```

不变量：

- 每个内容组件每次区域 render 只渲染一次，不先测量再重画，不依赖第二帧补齐。
- 只统计真实内容高度，不能把旧补偿重新当作内容累计。
- 高度和鼠标 offsets 使用同一份本帧结果。
- 补偿只在区域末尾，不填背景、不创建点击目标、不输出消息区标记。
- 空内容也是有效帧，不能早返回绕过保留。
- 相同内容、宽度、生命周期和折叠状态重复 render，行数、补偿和 offsets 不变。
- render 错误继续传播，不返回旧画面掩盖失败。
- 不新增 render 内部触发下一帧的反馈或防抖定时器。

### 3.4 区域身份与决策门槛

建议候选：以实际 live run 为生命周期，覆盖本轮新增投影输出，不以 tail 或 collapse group 为身份。同轮多个分组、notice 和必要的原生正文变化，不因展示边界变化丢失记录。

不能对整个 chatContainer 的历史高度做全局 max：这会把历史折叠、宽度重排和当前活动混在一起，无法局部释放。

实施前通过事件轨迹确认：

- 历史内容不被新 run 追溯纳入高水位。
- 成组前散列内容和成组后内容属于同一布局区域。
- 首 component 改变不自动销毁区域。
- 正文保留原生顺序、交互及分组边界；外层组合不把正文变成组成员。
- run 外 notice 不创建伪活动区域、不覆盖前一轮记录。

若现有 run 观察机制不足，先提交轨迹与候选方案取舍，再定内部身份契约；不静默增加全局注册表或用组件状态猜生命周期。

## 4. 生命周期与释放策略（待确认）

| 事件 | 建议行为 |
| --- | --- |
| 新 run | 创建当前区域记录；历史区域独立 |
| 自动更新、尾项替换、notice | 同帧计算，保留高水位 |
| 跨成组门槛、自动组内外迁移 | 允许内容重排，不更换高度记录 |
| 退色、spinner 重绘 | 不释放、不增加补偿、不改变布局周期 |
| 正常结束、取消、异常 | 最终真实帧纳入计算，结束活动；建议冻结剩余占位，不定时回收 |
| 下一 run 开始 | 创建新区域，不借机清空旧区域占位 |
| 用户主动折叠/展开 | 为受影响区域建立新布局周期，以新真实高度为基线 |
| 终端宽度改变 | 新宽度重新排版、建立新基线，不沿用旧宽度行数 |
| 仅终端高度改变 | 不无故清空记录；结合 Pi host 视口行为验证 |
| session 切换、恢复、fork、卸载 | 清理运行时记录，不持久化；历史从真实内容重建 |

冻结是保留高度下限，不是缓存画面或禁止真实增长。结束后仍发生的原生状态变化须正常渲染，其归属由事件审计确认。

代价：同一 session 的历史输出可能留下空白。不能同时保证自动删除已显示空白与总高度绝不收缩，不能靠延时回收回避取舍。

主动操作必须明确识别：不能把任意 `invalidate`、`requestRender` 或 `handled: true` 当成折叠；复制和动画也可能走这些路径。审计组标题、分类、thinking、工具嵌套折叠和 Ctrl+O 后，选择最小明确布局变更信号。若必须扩展跨 package API，先评审范围。

状态属于 attachment/session，dispose 幂等。多个异步事件更新事实，但同步 render 只组合当前事实，不读取上帧兄弟反馈；无锁、无新计时器、无异步测量，保留原有取消和清理。

## 5. 先复现再实现

测试使用真实 `host-transcript-patch` 投影入口，不手工调用 group、tail 预热。一次用户可见帧对应一次完整投影 render；每次变化检查第一帧，再检查无变化的第二、第三帧。

记录区域身份、真实行数、输出行数、补偿行数、组/尾项起始行和点击 offsets。记录仅放测试断言上下文，不增加生产诊断 API。

### 5.1 必须覆盖的状态序列

| 场景 | 断言 |
| --- | --- |
| 长 thinking → 短 notice | 第一帧不缩，下一帧不回弹，补偿在 notice 后 |
| 长 tool → thinking → notice → tool | tail 换身份不丢记录 |
| thinking 变短或瞬时空输出 | 不绕过保留，无重复分隔，不丢 OSC 标记 |
| 未成组 → 成组 → 尾项折入 | 成组不是记录创建/销毁边界 |
| 正文或未知 renderer 断组 | 分组语义保持，布局按已确认区域契约稳定 |
| 活动 thinking 中最后工具已结束超过 5 秒 | 退色不收占位 |
| 正常结束 / 取消 / 异常 | 最终帧与占位遵循释放策略 |
| 已结束 run 后到达 notice | 不重新打开旧 run，不丢既有记录 |

### 5.2 几何、交互与生命周期

- 宽度 30 / 120，覆盖 ANSI、CJK、emoji、换行、OSC 133；不超宽，resize 不继承旧宽度高水位。
- 背景开/关：补偿始终无组/工具/notice 背景；内容自身 padding 保留原有样式。
- 标题、分类、thinking、工具折叠和复制命中正确；点击补偿无效，滚轮不拦截。
- 主动折叠按约定重算；普通 redraw 和复制反馈不释放。
- 同帧每个内容组件只 render 一次；重复帧不累积空白。
- 历史恢复、reload、session 切换、fork、卸载无状态泄漏或遗留回调。
- spinner、错误传播、幂等 cleanup 回归测试继续通过。

### 5.3 真实终端验收

固定序列：长工具输出 → thinking → notice → 后续工具 → 正文结束。观察变化第一帧、后续重绘和超过 5 秒后的画面。

分别检查不足一屏/超过一屏、窄/宽终端、背景开/关。记录区域顶部是否额外回弹、补偿是否在末尾、notice 是否先缩后补、主动折叠后坐标是否正确。数组断言不能替代 Pi TUI 验收。

## 6. 实施步骤与交付物

### 阶段 1：事实和失败用例，不改生产实现

- 阅读已安装 Pi 文档与对应 Container、TUI、assistant 组件实现及相关示例。
- 审计 run、notice、分组边界、主动折叠入口。
- 加入投影入口最小失败测试，报告第一帧与后续帧高度轨迹。
- 交付：失败测试、事件/帧证据、区域身份建议；不能多 render 一次让测试通过。

### 阶段 2：确认契约

- 使用 `grill-me` / `grill-with-docs` 流程评审区域身份、结束后冻结、主动重排、resize 策略。
- 确认后更新 `DESIGN.md`，删除组内补偿和 5 秒释放的错误契约；按需补高层架构说明。
- 未确认前，计划不覆盖 `DESIGN.md` 当前文本，不把建议当已批准事实。

### 阶段 3：替换 ownership，形成端到端路径

- 删除 ToolGroupView 高水位、tail 回报及高度用 `#quiet`；保留背景退色。
- 删除 TailUnit 高水位和 report 回调；保留分隔、OSC、鼠标偏移修复。
- 投影层实现稳定区域、同帧末尾补偿和明确生命周期/主动重排信号。
- 高度和鼠标布局同源，不保留旧新双算法或兼容 wrapper。
- 替换断言错误 ownership 的测试，不能只改期望数字掩盖回归。

### 阶段 4：聚焦验证与实机验收

- 补齐测试矩阵，运行受影响测试与 package build。
- 执行真实终端验收；若数组正确但终端仍抖，回到 Pi host 视口证据，不增加延时补偿。
- 报告实际命令、结果、终端观察和未覆盖边界。

### 阶段 5：收尾

- 核对 diff，保持无关用户修改不变。
- 保留 spinner、thinking rail、OSC 分隔、鼠标偏移等既有有效修复。
- 更新图谱，按验证策略决定是否升级范围。
- 需要提交时仅提交内聚改动；不自动 push、发布或纳入无关工作区修改。

## 7. 文件范围与验证

预期文件：

- `packages/pi-ext-ui/src/host-transcript-patch.ts`：区域 ownership、事件归属、组合。
- `packages/pi-ext-ui/src/tool-group-view.ts`：移除错误高度状态，保留真实布局交互。
- `packages/pi-ext-ui/test/host-transcript-patch.test.ts`：投影逐帧回归。
- `packages/pi-ext-ui/test/tool-group-view.test.ts`：移除错误层级契约，保留内容交互测试。
- `DESIGN.md`：批准契约后更新。

`extension.ts`、tool/nested view 仅在生命周期或主动折叠入口审计证明必要时纳入。是否新增内部文件由实际责任决定，不为缩短文件拆分。

修改 TypeScript 前读 `DESIGN_TS.md`。实现后的最低验证：

```bash
pnpm exec biome check <实际修改的 TypeScript 文件>
pnpm exec vitest run packages/pi-ext-ui/test/host-transcript-patch.test.ts packages/pi-ext-ui/test/tool-group-view.test.ts
pnpm --filter @hheei/pi-ext-ui run build
```

改动 tool/nested view 时增加对应测试。图谱更新用 `graphify update .`，或 `pnpm run verify:changed`；后者可能纳入工作区其他 package，报告需区分来源。

仅公共导出、跨 package 契约或根基础设施变更才升级全仓 typecheck；影响无法可靠界定才用完整门禁。文档计划阶段不跑 TypeScript、测试和全量检查。

## 8. 待确认决策与完成标准

待确认：

1. 区域采用 live run，还是更小但跨 tail/成组稳定的范围？由阶段 1 轨迹验证建议。
2. 是否接受结束后冻结占位，直到主动重排或 session 重建？这是无自动收缩与历史紧凑度的取舍。
3. 局部折叠是否重置所属整个区域的高水位？建议是，但须确认局部操作影响范围。

完成标准：

- 三个用户症状都有真实投影失败测试及修复证据，不只靠算法推导。
- 自动更新第一帧自洽，没有先缩后补。
- 补偿仅在区域底部，不属于 collapse view、不染背景、不占点击热区。
- notice/thinking/tool 替换、成组、退色不意外清空记录。
- 结束、主动折叠、resize、取消、恢复符合已批准契约。
- 真实终端验收通过；未完成时明确标记，不把测试通过等同于 UI 已修复。
