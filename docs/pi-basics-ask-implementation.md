# pi-basics Ask 实作方案

> 输入：[`pi-basics-ask-high-level.md`](./pi-basics-ask-high-level.md) 与 [`pi-basics-ask-design.md`](./pi-basics-ask-design.md)。本文件描述实现顺序、文件改动、测试、smoke scenario和验收；不是已完成声明。

## 1. 实作原则

- 先锁定外部schema与cancel semantics，再写pure model，再接TUI/RPC，最后整合lifecycle与Loadout。
- 每阶段只增加使该阶段contract成立的代码；不预建preview/comment/config abstraction。
- 复用pi-basics现有`text`、`keymap`、lifecycle与registry cleanup；custom输入使用Pi TUI `Input`加module-private bounded adapter。
- 不增加dependency；`typebox`、Pi coding-agent和Pi TUI均已存在。
- 所有交互路径必须区分：submitted、user cancelled、host unsupported、signal/session aborted。
- `executionMode:"sequential"`与one-active guard都保留：前者约束agent tool batch，后者保护host/API重入。
- 不改`pi-extcore`、`pi-loadout`、`pi-ssh`、`pi-inturl`或Todo domain behavior。
- 不为了参考实现feature parity增加alias、fallback fields、events、i18n、preview、notes或timeout。

## 2. 预期改动清单

### 修改

- `packages/pi-basics/src/index.ts`
- `packages/pi-basics/README.md`
- `packages/pi-basics/test/integration/index.test.ts`

### 新增

- `packages/pi-basics/src/modules/ask/model.ts`
- `packages/pi-basics/src/modules/ask/component.ts`
- `packages/pi-basics/src/modules/ask/fallback.ts`
- `packages/pi-basics/src/modules/ask/index.ts`
- `packages/pi-basics/test/modules/ask/model.test.ts`
- `packages/pi-basics/test/modules/ask/component.test.ts`
- `packages/pi-basics/test/modules/ask/fallback.test.ts`
- `packages/pi-basics/test/modules/ask/integration.test.ts`

### 不修改

- `packages/pi-basics/package.json`：已有`typebox`；不增依赖。
- Settings/Loadout schema与storage格式。
- Todo tool contract、snapshot或widget。
- Root public exports：Ask保持module-private。

## 3. Phase 0：Review Gate

实现前由用户确认 [`pi-basics-ask-high-level.md`](./pi-basics-ask-high-level.md) 的推荐项，至少包括：

- Tool名称`ask`。
- 同一process只启用一个`ask`实现；参考extension必须停用，不能依赖registration覆盖。
- 1–4 related questions；每题2–5 options。
- required stable question `id`。
- option为label + optional description，不加machine value。
- explicit `recommended` index，只影响focus。
- automatic Other，不能关闭。
- single/multi，无text question。
- all answered + Review + Submit，无partial outcome。
- fixed inline TUI + RPC select/input fallback。
- 无notes、preview、timeout、config、i18n、events、persistence或public API。
- non-UI strip-only，不能覆盖Loadout disabled。

若任一项改变，先同步high-level、detailed design、schema与acceptance，再开始production code。

## 4. Phase A：Normalized model与validation

### A1. 建立外部/内部类型

目标文件：`src/modules/ask/model.ts`

实现：

1. `AskOption`、`AskQuestion`、`AskQuestionnaire`。
2. `AskSelection`、`AskAnswer`、`AskToolDetails`。
3. `AskMode`、`AskAnswerDraft`、`AskState`、`AskAction`。
4. `AskInteractionResult`：submitted/cancelled/aborted internal union。
5. 所有collection使用readonly external contract；reducer返回新state。

不导出UI-only row或component props。

### A2. Text validation helpers

实现：

```ts
printableSingleLine(value, field, maxLength): string
normalizedContext(value): string | undefined
normalizeAskParams(value): AskQuestionnaire
```

规则：

- trim single-line values。
- context把CRLF转LF，trim首尾，保留内部LF。
- single-line拒绝C0/C1、LF/CR/Tab、U+2028/U+2029。
- context除LF外拒绝相同controls。
- id pattern：`^[A-Za-z][A-Za-z0-9_-]{0,63}$`。
- counts、lengths、duplicates、reserved Other、recommendation bounds全部runtime重验。
- custom answer最大1000字符；component与RPC fallback使用同一constant。
- `validateAskCustomAnswer()`由TUI commit与RPC `input()`共同调用；invalid RPC值fail closed且不回显原文。
- 返回canonical deep copy，不保留unknown fields。

Validation error包含field path，例如：

```text
questions[1].recommended must be an integer between 0 and 2
questions[0].options[2].label is reserved: Other
```

### A3. Pure state reducer

实现：

```ts
freshAskState(questionnaire): AskState
reduceAsk(state, questionnaire, action): AskState
answersFromState(state, questionnaire): readonly AskAnswer[]
```

Reducer覆盖：

- recommendation focus only。
- single Select/custom with first-answer auto-advance and answered-question edit in place。
- multi Select/custom/explicit empty answer semantics。
- question-tab and Review-tab navigation with non-wrapping boundaries。
- Review edit/submit; Submit rejects unanswered tabs。
- question skip、custom cancel、Review whole-form cancel。
- abort。
- terminal immutability。

不在reducer调用`done()`、TUI、timer、signal、notify或filesystem。

### A4. Model tests

目标文件：`test/modules/ask/model.test.ts`

最小cases：

- Valid params trim/canonicalize/deep isolate。
- 1与4 questions合法；0与5拒绝。
- 2与5 options合法；1与6拒绝。
- Blank/malformed/duplicate id拒绝。
- Duplicate question text拒绝。
- Duplicate option label按case-folded比较。
- Reserved `Other`与`ASK_OTHER_LABEL`均拒绝。
- Control characters与所有length bounds拒绝。
- Recommended index合法、越界、fraction、string cases。
- Recommendation不设置answered/selected。
- Single option Select first answer advances; answered question reselect stays current。
- Single Other empty不可commit，valid custom成功并遵循同一advance rule。
- Multi Select order稳定；first selection advances，later add/remove stays current；Other与selected可共存。
- Multi explicit empty answer semantics保持可区分。
- Review edit回题；完成后用户手动切回Review。
- Submit要求all answered。
- Cancel/abort discard result；terminal后所有actions no-op。
- Input state/questionnaire不被mutation。

### A5. Phase check

```bash
bun test packages/pi-basics/test/modules/ask/model.test.ts
bunx biome check packages/pi-basics/src/modules/ask/model.ts packages/pi-basics/test/modules/ask/model.test.ts
```

完成条件：model无Pi API、TUI、filesystem或timer import。

## 5. Phase B：TUI component

### B1. Component boundary

目标文件：`src/modules/ask/component.ts`

API：

```ts
interface AskComponentOptions {
  questionnaire: AskQuestionnaire;
  host: {
    requestRender(): void;
    getTerminalRows(): number;
  };
  theme: Theme;
  signal?: AbortSignal;
  done(result: AskInteractionResult): void;
}

createAskComponent(options): Component & { dispose(): void }
```

内部持有：

- current immutable `AskState`。
- bounded `Input` adapter；paste buffer与stored value均不超过custom-answer limit。
- last width。
- optional inline error。
- settled boolean。
- abort listener cleanup。

### B2. Single-settle lifecycle

建立唯一helper：

```ts
function settle(result: AskInteractionResult): void
```

要求：

- settled后立即return。
- remove abort listener。
- 只调用一次`done(result)`。
- reducer进入terminal后才settle。
- signal已aborted时component初始化后立即settle aborted。

Component `invalidate()`只requestRender，不重建state。Component `dispose()`通过同一settle guard结束为aborted并移除listener；settled后no-op。

### B3. Render question screen

实现block-based renderer：

1. Header。
2. Optional context。
3. Question。
4. Author options。
5. Automatic Other row。
6. Optional error。
7. Footer keymap。

每个option block包含第一行与wrapped description。颜色/符号按详细设计固定。

### B4. Row-aware viewport

实现private pure helper并通过component tests覆盖：

```ts
visibleBlocks(blocks, focusedIndex, rowBudget): {
  rows: string[];
  clippedAbove: boolean;
  clippedBelow: boolean;
}
```

规则：

- focused block尽量完整显示。
- 先向后、再向前或平衡扩张，但结果deterministic。
- indicator占用自己的row budget。
- 单一block超过budget时cell-safe截取rows，不越界。

不建立通用viewport class；helper留在`component.ts`，直到第二个consumer出现。

### B5. Input routing

Question mode：

- Up/Down move answer cursor。
- Enter `Select` current option；题目未answered且首次由未选变已选时前进，已answered question改选时留在当前panel，Other进入custom。
- `↔`切换question tabs与Review；实际按Left/Right，question panel不因已answered改选而前进。
- Esc skip current question panel，不提交draft；Review中的Esc才cancel whole questionnaire。

Custom mode：

- Enter commit non-empty draft；题目未answered时进入下一panel，已answered时留在当前question panel。
- Esc cancel custom editor，回所属question。
- 其余交给bounded adapter：bracketed paste由adapter按剩余容量缓冲，所有insertable text在进入Pi `Input`前拒绝control/U+2028/U+2029并执行1000字符上限；委托native editing key后再次验证value invariant，render前不允许unsafe/oversized draft存在。
- Custom commit仍调用共享`validateAskCustomAnswer()`，不能把editor invariant当成唯一validation boundary。

Review mode：

- Up/Down move action cursor。
- Enter只执行Edit question或Submit；Submit仅当所有question answered。
- `↔`切换tabs；实际按Left/Right，Esc cancel whole questionnaire。

每个分支最多一次state assignment与一次requestRender。

### B6. Component tests

目标文件：`test/modules/ask/component.test.ts`

建立最小host/theme/done harness，覆盖：

- Initial recommendation focus但无selection；tab显示`☐ #N`。
- Single Select首次answer自动前进；切回后改选不前进，answer color保持。
- Multi Select首次选择前进；返回后增删selection留在当前panel。
- `↔`切换所有question与Review，实际Left/Right边界不循环。
- Review action focus；未全部answered时Submit disabled，全部answered后Submit成功。
- Other editor type/backspace/commit/Esc，custom首次answer遵循同一advance rule。
- Direct/Kitty/bracketed-paste输入在存储与render前受printability/1000字符限制；chunked paste buffer也有界。
- Toggled row、focused row、focused+toggled row的color precedence与`)`/`→` cursor slot正确。
- Esc question skip、Esc custom返回、Esc Review cancelled。
- Abort settle一次；Enter/abort竞态settle一次；Terminal后input无效。
- Narrow 20-cell、normal 80-cell、wide 140-cell均不越width。
- Width 40 reference layouts（single、multi、Other、Review）保持每行不超过40 cells，并保留sticky header/footer结构。
- Long context/description在10-row terminal保持focus与indicators。
- Questionnaire打开后terminal由30 rows缩到10 rows，下一次render仍保持focus或Submit row可见。
- Footer窄屏保留关键hints。

### B7. Phase check

```bash
bun test packages/pi-basics/test/modules/ask/model.test.ts packages/pi-basics/test/modules/ask/component.test.ts
bunx biome check packages/pi-basics/src/modules/ask/model.ts packages/pi-basics/src/modules/ask/component.ts packages/pi-basics/test/modules/ask/model.test.ts packages/pi-basics/test/modules/ask/component.test.ts
```

完成条件：可用headless harness走完single、multi、Other、tab navigation、Review submit、skip、cancel和abort。

## 6. Phase C：RPC/ACP fallback

### C1. Capability API

目标文件：`src/modules/ask/fallback.ts`

实现：

```ts
export interface AskDialogOptions {
  signal?: AbortSignal;
}

export interface AskDialogUI {
  select(title: string, options: string[], opts?: AskDialogOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: AskDialogOptions): Promise<string | undefined>;
}

export function hasAskDialogUI(value: unknown): value is AskDialogUI;

export async function runAskFallback(
  ui: AskDialogUI,
  questionnaire: AskQuestionnaire,
  signal?: AbortSignal,
): Promise<AskInteractionResult>;
```

### C2. Strict option wire values

每次`select()`先建立wire map：

```ts
Map<string, { kind: "option"; index: number } | { kind: "other" } | { kind: "finish" }>
```

只接受map exact key。Host返回unknown string抛明确error；不使用`parseInt`、regex prefix或label-only lookup。

### C3. Single flow

- `select(questionTitle, optionWires + Other)`。
- Real option写answer。
- Other调用`input()`；trim后blank回到select，不形成answer；`undefined`视为cancelled。
- 非blank结果先通过`validateAskCustomAnswer()`；control/ANSI、1001字符等invalid value抛不含原文的明确error，不自动重试。

### C4. Multi flow

- 每轮按draft生成`[x]`/`[ ]` wire strings。
- Option选择toggle并重新open select。
- Other调用`input()`；blank保留原draft并回到select，非blank先通过`validateAskCustomAnswer()`再保存；unsafe/overlong值fail closed。
- Finish显式confirm，空集合合法。
- `undefined`取消whole questionnaire。

### C5. Final review

生成bounded summary并调用select：

```text
Submit answers
Start over
Cancel
```

- Submit构建submitted。
- Start over从fresh answer drafts重跑全部问题。
- Cancel返回cancelled，answers为空。

防无限start-over loop不需要额外次数限制；用户主动控制。Abort始终退出。

### C6. Abort handling

Pi dialog primitives原生接受`{ signal }`。每次`select()`/`input()`都传入当前signal；返回`undefined`后先检查`signal.aborted`，分别产生aborted或user-cancelled。不要添加`Promise.race()`、timer或第二套abort listener。

### C7. Fallback tests

目标文件：`test/modules/ask/fallback.test.ts`

覆盖：

- Capability guard。
- Single option/Other/cancel。
- Multi toggle/deselect/custom/empty finish。
- Exact wire matching；`2abc`、unknown label拒绝。
- Duplicate labels已在normalize前拒绝。
- Blank Other不形成answer。
- RPC custom answer 1000字符合法；1001字符、control/ANSI、U+2028/U+2029 fail closed且不进入result。
- Multi和single结果与model output一致。
- Final submit/start over/cancel。
- Abort during select/input/review。
- Signal传入每个dialog；abort与dismiss结果不会混淆。

### C8. Phase check

```bash
bun test packages/pi-basics/test/modules/ask/fallback.test.ts
bunx biome check packages/pi-basics/src/modules/ask/fallback.ts packages/pi-basics/test/modules/ask/fallback.test.ts
```

完成条件：fallback不依赖TUI imports，所有host返回值strict解释。

## 7. Phase D：Tool execution与feature lifecycle

### D1. Tool schema与constants

目标文件：`src/modules/ask/index.ts`

实现：

- `ASK_TOOL_NAME`、`ASK_TOOL_LABEL`、`ASK_OTHER_LABEL`、prompt snippet/guidelines。
- TypeBox schema，`additionalProperties:false`。
- `AskFeature`与`createAskFeature(pi)`。
- tool registration、start-time capability reconciliation、execute、result builders、transcript renderers。

不从root export constants。

### D2. Active runtime/pending shape

```ts
interface ActiveAskRuntime {
  readonly sessionId: string;
  readonly runtime: HePiRuntimeContext;
}

interface PendingAsk {
  readonly sessionId: string;
  abort(): void;
}
```

Feature只保存一个active runtime与一个pending。`start()`替换旧runtime前abort旧pending。`dispose(sessionId)`按captured id清理。

### D3. Tool registration

```ts
pi.registerTool({
  name: ASK_TOOL_NAME,
  label: "Ask",
  description,
  promptSnippet,
  promptGuidelines,
  executionMode: "sequential",
  parameters: AskParamsSchema,
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... },
  renderCall,
  renderResult,
});
```

若TypeBox static类型不能准确表达runtime params，保持cast只在normalize boundary一次，不向后扩散`unknown as`。

### D4. Execute path

实现顺序严格按详细设计：

1. abort precheck。
2. normalize。
3. active session check。
4. reentrant guard。
5. pending settle/abort boundary。
6. waiting update。
7. TUI custom。
8. custom undefined → dialog fallback。
9. RPC direct fallback。
10. no UI error。
11. submitted/cancelled result。
12. finally cleanup。

No UI/unsupported error必须提示“用户未看到问题”，cancel result必须提示“用户主动取消且未提交”。

### D5. Start-time capability reconciliation

`ask.start(runtime)`由root lifecycle在`loadoutController.load()`完成后调用：

- 以`ctx.hasUI`、`ctx.mode`、`ui.custom`和`hasAskDialogUI()`计算实际Ask capability。
- 无capability且active包含ask时移除；有capability时no-op，绝不自行add/restore。
- 记录captured session并注册cleanup。
- 不注册`before_agent_start` tool mutation，避免与现有skill prompt filter产生stale prompt ordering。

Integration test必须模拟Loadout disabled Ask并证明start不恢复；另模拟non-UI active Ask，证明first turn前已strip且prompt不含Ask snippet/guidelines。

### D6. Result builder

实现pure helpers：

```ts
buildAskResult(questionnaire, answers): AgentToolResult<AskToolDetails>
buildAskCancelledResult(questionnaire): AgentToolResult<AskToolDetails>
formatAskSummary(answers): string
```

- deep clone normalized questions/answers。
- submitted summary按question order。
- selected label使用`; `分隔。
- custom明确标`Other: ...`。
- submitted empty multi明确输出`None selected`，不能与unanswered混淆。
- cancelled answers永远`[]`。

### D7. Transcript renderer

- Call collapsed：question count。
- Call expanded：context摘要与question texts，不显示完整option descriptions。
- Result submitted：success + answers。
- Result cancelled：muted。
- 所有line用Pi text helpers防cell overflow。

### D8. Integration tests

目标文件：`test/modules/ask/integration.test.ts`

需要可控fake：

- registered tool definition。
- active tool list。
- lifecycle runtime/session id。
- custom UI result。
- dialog responses。
- pending custom Promise。
- abort controller。
- onUpdate capture。

覆盖：

- Schema/name/label/guidance/executionMode。
- TUI submitted/cancelled/custom undefined fallback。
- RPC submitted/cancelled。
- no UI error与before-agent strip。
- UI hook不restore disabled ask。
- active session mismatch。
- reentrant call rejection。
- validation fails beforeUI。
- abort before/duringUI。
- cleanup abort、idempotency、session replacement。
- success/cancel/error/abort后下一次call可用。
- onUpdate waiting result。
- renderCall/renderResult compact/expanded。

### D9. Entry integration

修改`packages/pi-basics/src/index.ts`：

1. import/create AskFeature。
2. 保持Todo、Settings与Loadout现有初始化；等待`loadoutController.load()`完成。
3. 随后调用`ask.start(runtime)`，捕获session id并注册`id:"ask"` cleanup。
4. 不改变现有`before_agent_start` skill filter，也不新增tool mutation handler。

修改`test/integration/index.test.ts`：

- tools从`["todo"]`改为`["ask", "todo"]`，顺序按实际registration pin。
- lifecycle integration证明Ask cleanup不影响现有module cleanup。
- 不把详细Ask interaction cases塞进root integration test。

### D10. Phase check

```bash
bun test packages/pi-basics/test/modules/ask packages/pi-basics/test/integration/index.test.ts
bunx biome check packages/pi-basics/src/modules/ask packages/pi-basics/test/modules/ask packages/pi-basics/src/index.ts packages/pi-basics/test/integration/index.test.ts
```

完成条件：TUI、RPC、cancel、abort、non-UI、Loadout ownership与session replacement全部有behavioral test。

## 8. Phase E：Package integration smoke

### E1. Focused package tests

```bash
bun test packages/pi-basics/test/modules/ask packages/pi-basics/test/integration/index.test.ts
bun test packages/pi-basics/test
```

若full suite出现既有failure，记录exact failing test并证明focused Ask tests独立通过；不得修改无关包求绿。

### E2. Type diagnostics

对新增/修改 TypeScript files 运行 LSP diagnostics；然后运行 repository 适用的 targeted typecheck。若 workspace-wide `tsc` 仍含既有 Loadout Theme diagnostics，按文件区分，不宣称全绿。

### E3. TUI smoke

启动：

```bash
bun run pi:dev -- basics
```

在真实session要求模型调用`ask`，至少验证：

1. 两题questionnaire，tab bar显示`☐/☑ #N`与`≡ Review`。
2. 第一题single + recommended marker；首次`Select`自动前进，回到已answered题目改选不前进。
3. `↔`切换第二题，multi + Other；验证Select、answer color、cursor color与`)`/`→` slot。
4. Review显示答案与Edit rows；未完成时Submit disabled。
5. 所有问题回答后只在Review Submit，模型收到正确结构化答案。
6. Question `Esc skip`、Review `Esc cancel`，确认cancel不提交partial答案。
7. 开启Ask后中断当前turn，确认UI关闭且下一次Ask可用。

观察：

- Prior transcript仍可见，inline UI不遮盖。
- 20/40/80/窄terminal宽度无越界。
- 长description时focus保持可见。
- Tool transcript不会展开整份params。

### E4. RPC smoke

若当前仓库有可用RPC harness，运行single、multi、Other和dismiss。若无真实RPC host，fallback unit/integration fake为验收证据，并明确未做live RPC smoke；不得把fake test描述为真实host验证。

### E5. Loadout smoke

- `/hepi loadout`能看到`tool:ask`。
- Disable Ask后，下一turn model tool list不含`ask`。
- Enable后恢复。
- Non-UI strip hook不改变其他active tools。

## 9. Cleanup

仅在功能和smoke通过后执行：

### 9.1 README

修改`packages/pi-basics/README.md`：

- Load and use列出`ask`与`todo`。
- 增加最小Ask schema example。
- 解释use-after-evidence、single/multi/Other/review。
- 解释TUI/RPC与non-interactive behavior。
- 明确cancel不是answer、Ask不改变permission。
- Non-goals列出preview/comments/timeout/config/persistence。

不把详细keyboard/reference matrix复制进README；详细设计是唯一长说明。

### 9.2 Changelog

`packages/pi-basics`目前无package changelog。除非仓库发布流程要求，不新建CHANGELOG文件。

### 9.3 Remove scaffolding

- 删除debug notifications/logging。
- 删除未使用generic types/helpers。
- 确认无TODO/TBD/placeholder。
- 确认无alias、deprecated fields或future preview hooks。

## 10. Final verification

```bash
bun test packages/pi-basics/test/modules/ask packages/pi-basics/test/integration/index.test.ts
bun test packages/pi-basics/test
bunx biome check packages/pi-basics/src/modules/ask packages/pi-basics/test/modules/ask packages/pi-basics/src/index.ts packages/pi-basics/test/integration/index.test.ts
```

README与三份Ask文档不在当前Biome include范围；人工核对相互链接、code fence、schema/prompt/runtime/result语义，不把“no files processed”当验证通过。

另外：

- LSP diagnostics：所有新增/修改TS files无diagnostic。
- TUI smoke：submitted、review edit、cancel、abort。
- Loadout smoke：discover/disable/enable。
- RPC smoke或明确标记fake-only evidence。

## 11. 验收矩阵

| Requirement | Unit | Integration | Live smoke |
|---|---:|---:|---:|
| 1–4 questions / 2–5 options | model | tool schema | — |
| Stable ids与validation | model | execute pre-UI | — |
| Recommendation focus only | model/component | result无implicit answer | TUI |
| Single-select | model/component | TUI path | TUI |
| Multi-select + empty confirm | model/component/fallback | result输出`None selected` | TUI/RPC |
| Automatic Other | model/component/fallback | result mapping | TUI/RPC |
| Custom input safety/bounds | validator/component/fallback | TUI/RPC boundaries | TUI/RPC |
| Review/edit/submit | model/component | custom result | TUI |
| Cancel discards draft | model/component/fallback | canonical details | TUI/RPC |
| Abort/session cleanup | component/fallback | feature lifecycle | TUI |
| Non-UI start-time strip | — | post-Loadout/first-prompt | optional JSON run |
| Loadout ownership | — | disabled not restored | Loadout |
| Bounded/cell-safe rendering | component | transcript | narrow TUI |
| One active interaction | — | reentrant/cleanup | optional |
| No persistence/config/events | source review | integration | — |

## 12. 完成定义

实现完成必须同时满足：

- High-level所有保留项可从真实user path观察。
- 所有“不做”项没有留下schema字段、empty adapter或future hook。
- TUI与RPC共享normalized model/result contract。
- Unsupported/no-UI不会被误报为user decline。
- Cancel/abort/session replacement无partial answer、double settle或stale pending lock。
- Loadout disabled不会被Ask hook恢复。
- Existing pi-basics tests保持通过；Ask focused tests和至少一个真实TUI smoke通过。
- README、schema、prompt、runtime、renderer和docs语义一致。
