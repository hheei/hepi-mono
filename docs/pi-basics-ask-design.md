# pi-basics Ask 详细设计

> 状态：提案。高层功能边界先见 [`pi-basics-ask-high-level.md`](./pi-basics-ask-high-level.md)。本设计默认采用其中推荐项。

## 1. 目标

为 `packages/pi-basics` 增加一个小而可靠的结构化 Ask module：

1. 模型先调查，再把真正需要用户决定的 1–4 个相关问题交给阻塞式 UI。
2. 用户能选择 single、multi或 automatic Other，并在最终提交前检查答案。
3. TUI与RPC/ACP host共享同一 normalized questionnaire和result contract。
4. Tool在无交互能力时不暴露；Loadout仍是 enable/disable的唯一用户配置来源。
5. Abort、cancel、session replacement和UI unsupported都不会留下悬挂 interaction。
6. 不复制参考实现的 preview、comments、配置、i18n、events或form framework。

## 2. 架构位置

```text
packages/pi-basics/
├── src/
│   ├── index.ts
│   └── modules/
│       └── ask/
│           ├── index.ts       # schema、tool registration、execution、result/transcript、feature lifecycle
│           ├── model.ts       # normalized types、validation、pure questionnaire state transitions
│           ├── component.ts   # inline TUI component
│           └── fallback.ts    # RPC select/input questionnaire walker
└── test/
    └── modules/
        └── ask/
            ├── model.test.ts
            ├── component.test.ts
            ├── fallback.test.ts
            └── integration.test.ts
```

不建立 `controller.ts`、`render/`、`session/`、`view/` 多层目录。四个 production files足以表达当前责任；出现第二个真实 form consumer前，不抽通用 questionnaire framework。

## 3. pi-basics 整合边界

### 3.1 使用现有能力

- `pi.registerTool()`：注册 model-facing `ask`。
- `executionMode: "sequential"`：Ask之后的 sibling tool call不得在用户回答前执行。
- `pi.getActiveTools()` / `pi.setActiveTools()`：无UI时strip工具。
- `ctx.ui.custom()`：TUI inline questionnaire。
- `ctx.ui.select()` / `ctx.ui.input()`：RPC/ACP fallback。
- `HePiLifecycleController` + registry cleanup：session replacement/shutdown终止pending interaction。
- `src/ui/text.ts`：ANSI/grapheme-safe wrap、truncate、visible width。
- `src/ui/keymap.ts`：宽度受限的快捷键提示。
- Pi TUI `Input`：由module-private bounded adapter包住，保留native keybindings，同时确保custom text进入state/render前已受长度与字符限制。
- `typebox`：package已有runtime dependency，不新增依赖。

### 3.2 不使用的能力

- Ask没有durable domain state，不进入 Settings storage、Loadout storage或Todo snapshot replay。
- Ask不是人类command，不进入 `/hepi` shell/module registry。
- 不使用 `setWidget()`；questionnaire只在tool execute期间存在。
- 不注册public Ask API或root export。
- 不发public event；没有真实listener consumer。
- 不写session label、analytics metadata或custom entry。

### 3.3 注册顺序

```ts
const ask = createAskFeature(pi);
const todo = createTodoFeature(pi);

const lifecycle = new HePiLifecycleController({
  onStart: async (runtime) => {
    await todo.start(runtime);
    // existing Settings / Loadout setup
    await loadoutController.load();

    const sessionId = runtime.ctx.sessionManager.getSessionId();
    ask.start(runtime);
    runtime.registry.registerLifecycle({
      id: "ask",
      cleanup: () => ask.dispose(sessionId),
    });
  },
});
```

`createAskFeature(pi)`在Loadout inventory建立前注册tool。`start(runtime)`必须在Loadout应用active set后运行，记录当前session identity并做一次strip-only capability reconciliation，不建立state snapshot。`dispose(capturedSessionId)`只终止属于该session的pending interaction，且idempotent。

## 4. Tool identity与prompt surface

```ts
export const ASK_TOOL_NAME = "ask";
export const ASK_TOOL_LABEL = "Ask";
export const ASK_OTHER_LABEL = "Other (type your own)";
```

只注册 `ask`。不保留alias，避免多个工具定义、prompt和Loadout identity竞争。

当前inventory以tool name识别资源，尚不能区分`tool:pi-basics/ask`与其他来源的`ask`。因此v1要求同一Pi process只有一个`ask`实现；迁移时应停用`pi-ask-user`、SuPi Ask或rpiv Ask，而不是注册alias或last-writer-wins wrapper。未来source-aware identity落地后再解除约束。

### 4.1 Description

建议：

```text
Ask user 1-4 related questions when evidence cannot resolve a material decision. Supports single-select, multi-select, automatic `Other`, and final review. Requires interactive UI.
```

### 4.2 Prompt snippet

```text
Request a focused user decision after gathering evidence
```

### 4.3 Prompt guidelines

```text
1. MUST inspect code, config, docs, and prior decisions first. NEVER ask for facts available through tools.
2. Use `ask` only for materially different options requiring user preference or authorization boundary. If several choices work, choose the conservative default and continue.
3. Keep one questionnaire per decision boundary. Group related questions in one call. Use `context` only for concise facts shared by all questions. NEVER batch unrelated decisions or repeat without new ambiguity.
4. Provide 2-5 concise options. Put trade-offs in descriptions, not labels. Set `multi: true` for multiple selections; omit it for single-select. Set `recommended` to the preferred zero-based index; it sets focus, not an answer. NEVER add `(Recommended)` to labels.
5. The UI adds `Other (type your own)` automatically; NEVER author it. After submission, use returned answers and continue. Cancellation or abort yields no decision or consent; NEVER infer either or continue irreversible work that depends on it.
6. `ask` clarifies decisions only. It NEVER grants tool permission or bypasses host approval rules.
```

不附带skill。Tool guidance已经是单一权威来源，避免skill与schema wording漂移。

## 5. 外部参数schema

### 5.1 TypeBox shape

```ts
const AskOptionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);

const AskQuestionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    question: Type.String({ minLength: 1, maxLength: 500 }),
    options: Type.Array(AskOptionSchema, { minItems: 2, maxItems: 5 }),
    multi: Type.Optional(Type.Boolean({ default: false })),
    recommended: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "0-based index of the recommended option; changes focus only",
      }),
    ),
  },
  { additionalProperties: false },
);

export const AskParamsSchema = Type.Object(
  {
    context: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    questions: Type.Array(AskQuestionSchema, { minItems: 1, maxItems: 4 }),
  },
  { additionalProperties: false },
);
```

只有一种question shape，因此不使用provider容易破坏的`anyOf`/literal union。`recommended`上界依赖options长度，由runtime validator检查。

### 5.2 `prepareArguments`

若现有provider compatibility test证明integer以string到达，`prepareAskArguments()`只转换严格十进制`recommended`：

```text
"0" -> 0
"04" -> 4
"2.0" -> reject
"2x" -> reject
```

没有证据前不加入option alias、primitive coercion或silent malformed-entry drop。Schema和runtime必须表达同一contract。

## 6. Normalized model

```ts
export interface AskOption {
  readonly label: string;
  readonly description?: string;
}

export interface AskQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: readonly AskOption[];
  readonly multi: boolean;
  readonly recommended?: number;
}

export interface AskQuestionnaire {
  readonly context?: string;
  readonly questions: readonly AskQuestion[];
}

export interface AskSelection {
  readonly index: number;
  readonly label: string;
}

export interface AskAnswer {
  readonly id: string;
  readonly question: string;
  readonly selected: readonly AskSelection[];
  readonly custom?: string;
}

export interface AskToolDetails {
  readonly questionnaire: AskQuestionnaire;
  readonly answers: readonly AskAnswer[];
  readonly cancelled: boolean;
}

export const ASK_LIMITS = {
  maxContextLength: 2000,
  maxQuestionLength: 500,
  maxLabelLength: 60,
  maxDescriptionLength: 300,
  maxCustomAnswerLength: 1000,
} as const;
```

### 6.1 Identity

- Question `id`必须匹配：`^[A-Za-z][A-Za-z0-9_-]{0,63}$`。
- 同一questionnaire内id唯一，case-sensitive。
- Question text trim后也必须唯一，避免用户看到重复题目。
- Option没有machine value；index由question-local ordered array定义。
- Result同时返回index与label：index保持精确，label让模型直接阅读。

### 6.2 Text safety

`id`、question、label、description与custom answer必须拒绝：

- C0/C1 control characters。
- CR、LF、Tab。
- U+2028、U+2029。
- ANSI/terminal escapes。

`context`允许LF，先把CRLF正规化为LF；除LF外仍拒绝control characters和Tab。Context保留显式段落，但UI必须按cell width wrap。

Other custom answer最大1000字符；TUI与RPC使用同一`ASK_LIMITS.maxCustomAnswerLength`检查，不允许一条回答扩大tool result或session details。
`validateAskCustomAnswer(value)`是TUI与RPC共享的唯一custom-answer boundary：trim后必须非空、single-line printable且不超过上限；返回canonical string。TUI在text进入editor state前维持同一invariant，commit时仍调用此helper；RPC `input()`返回blank时回到选择且不形成answer，非blank必须先调用helper再写answer。Unsafe/overlong host value fail closed，error不得回显原始text。

不以正则控制字符范围规避Biome；使用code point loop，与Todo subject validation一致。

### 6.3 Runtime validation

`normalizeAskParams(value)`必须：

1. 检查object/array边界，即使provider声称已执行JSON Schema。
2. trim所有single-line strings；trim context首尾但保留内部LF。
3. 检查question count 1–4、option count 2–5。
4. 检查id grammar与duplicate id。
5. 检查duplicate question text。
6. 检查每题duplicate option label，比较trim后的case-folded label。
7. 拒绝case-insensitive `Other`与`ASK_OTHER_LABEL`；TUI/RPC只显示该常量，不产生其他sentinel spelling。
8. 检查`recommended`为integer且`0 <= recommended < options.length`。
9. 检查所有长度与printability。
10. deep-copy并返回只含canonical fields的questionnaire。

Unknown/deprecated fields由TypeBox `additionalProperties:false` 拦截；runtime boundary不为旧字段建立兼容alias。

## 7. Interaction state

### 7.1 State

```ts
export type AskMode = "question" | "custom" | "review" | "terminal";

export interface AskAnswerDraft {
  readonly answered: boolean;
  readonly selected: readonly number[];
  readonly custom?: string;
}

export interface AskState {
  readonly mode: AskMode;
  readonly questionIndex: number;
  readonly focusedOption: readonly number[];
  readonly answers: readonly AskAnswerDraft[];
  readonly reviewIndex: number;
  readonly customDraft: string;
  readonly returnToReview: boolean;
  readonly terminal?: "submitted" | "cancelled" | "aborted";
}
```

`focusedOption`按question保存，返回编辑时保留位置。`selected`使用ordered integer array，不把mutable `Set`暴露在state中。

### 7.2 Initial state

- 每题`answered:false`、`selected:[]`。
- `focusedOption[i] = question.recommended ?? 0`。
- Recommendation只决定focus；不写answer draft。
- `returnToReview:false`；从Review编辑题目时才设为true。
- `mode:"question"`、`questionIndex:0`。

### 7.3 Actions

```ts
type AskAction =
  | { type: "move_option"; delta: -1 | 1 }
  | { type: "select_option" }
  | { type: "move_tab"; delta: -1 | 1 }
  | { type: "open_custom" }
  | { type: "set_custom_draft"; value: string }
  | { type: "commit_custom" }
  | { type: "cancel_custom" }
  | { type: "move_review"; delta: -1 | 1 }
  | { type: "edit_question"; index: number }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "abort" };
```

`reduceAsk(state, questionnaire, action)`为纯函数；不调用TUI、done或notification。

### 7.4 Transition rules

#### Single-select

- Focus落在真实option：`Select`若该题尚未answered，写入`selected:[index]`、清custom、设`answered:true`并进入下一panel；若该题已answered，改写answer但停留当前panel。
- Focus落在Other：进入custom mode；custom commit按同一规则，首次有效answer进入下一panel，已answered时留在当前panel。

#### Multi-select

- Focus落在真实option：`Select`切换该option；若题目尚未answered且由未选变已选，设`answered:true`并进入下一panel；若题目已answered，增删selection但停留当前panel。
- Other进入custom mode；commit后保留已选options并写custom、`answered:true`，首次answer进入下一panel，已answered时留在当前panel。
- Question panel没有Finish/Submit action；需要补选multi option时通过`↔`返回该question。

#### Navigation

- `↔`切换question tabs与Review tab；实际按Left/Right，边界不循环，不改变draft。
- `⎋ skip`离开当前question panel并进入下一个panel；不提交或清除draft，当前未回答tab保持`☐`。
- Review包含`Submit answers`与每题`Edit question #N` row；选择edit回到对应question tab。
- Review submit只在所有`answered:true`时合法；否则Submit disabled/error，reducer fail closed。
- First Select auto-advances; changing an already answered question stays on current panel. Review edit后返回原question tab，完成后仍由用户按Left/Right回Review。

#### Cancel/abort

- Custom mode Esc只放弃当前editor draft，返回所属question；不取消整个form。
- Question mode Esc执行skip，不产生terminal result；Review Esc产生terminal cancelled。
- AbortSignal/session dispose产生terminal aborted。
- Terminal state拒绝后续mutation，确保done后输入不会改变result。

## 8. TUI component

### 8.1 Rendering mode

固定使用inline：

```ts
await ctx.ui.custom<AskInteractionResult>((tui, theme, _kb, done) =>
  createAskComponent({
    questionnaire,
    host: {
      requestRender: () => tui.requestRender(),
      getTerminalRows: () => tui.terminal?.rows ?? 30,
    },
    theme,
    done,
    signal,
  }),
);
```

不传overlay options；不注册raw terminal listener。

### 8.2 Visual hierarchy

- Panel header：`? Ask · Question #N`或`? Ask · Review`，accent/bold。
- Context：muted，wrap，位于question上方。
- Question：normal/bold。
- Answer row cursor slot：未focus显示`)`，focus显示`→`；slot不表达selected。
- Toggled answer：整行answer color；focused未toggle answer：整行cursor color。
- Toggled + focused：answer color优先；推荐badge不改变该优先级。
- Single/multi不使用`●`/`○`作为状态来源；selected state来自draft，tab state来自`answered`。
- Description：muted，缩进并wrap。
- Other：普通action row，不伪装author option。
- Error hint：warning，例如empty custom answer。
- Footer：使用`formatKeymap()`，窄屏按priority移除低优先hint。

### 8.2.1 Tabbed panel layout（40-cell reference）

Ask TUI改为Settings风格的tab bar：每个question是一个panel，最后一个panel固定为`Review`。`width = 40`作为基准；tab bar沿用`renderTabs()`的active-open-bottom结构，不新增第二套tab primitive。

Tab标题与状态：

- 未完成question：`☐ #N`。
- 已回答question：`☑ #N`；`☑`及tab label使用answered color。
- 最后tab：`≡ Review`。
- 当前tab沿用Settings active样式：active tab底边打开，inactive tab底边闭合。
- `↔`是footer中的←/→ tab提示；实际按键仍为Left/Right，只切换active panel，不修改answer，也不自动提交。

Question panel（active `#2`，40 cells）：

```text
 ╭──────╮╭──────╮╭───────────╮
 │☑ #1  ││☐ #2  ││≡ Review   │
─┴──────┴╯      ╰┴───────────┴──────────
? Ask · Question #2

Q: Which storage backend should we use?
)SQLite (Recommended)
  No new service; fits deployment.
→PostgreSQL
  More concurrency; adds service.
)type my answer

↕ navigate · ↔ tab · ↵ Select · ⎋ skip
────────────────────────────────────────
```

Mockup中`)`是每个answer row预留的中性cursor slot：cursor不在该row时显示`)`，cursor切换到该row时用`→`替换`)`，不是selected marker。示例中`SQLite`是已selected答案（使用answer color），`PostgreSQL`是当前cursor所在的未selected答案（使用cursor color）；`type my answer`保留中性`)`。首次由未selected变为selected时进入下一panel；已回答question中改选answer时留在当前panel。最终实现使用ANSI color区分两种状态；marker只负责位置，不负责表达selection。

Color precedence：

1. toggled answer：整行label及其description使用`theme.fg("accent", ...)`；未focus时仍显示`)`。
2. cursor所在的未toggle answer：整行使用`theme.fg("warning", ...)`，并把该row的`)`替换为`→`。
3. cursor与toggle同时命中：toggle answer color优先，但cursor slot仍显示`→`，不叠加cursor color。
4. `Recommended` badge不改变toggle/cursor precedence；tab answered color只反映`answered`，不代表recommended。

因此，`)` / `→`只表示cursor位置；答案是否toggle只由颜色和state决定。

Panel spacing：

- tab bar三行之后显示panel title：`? Ask · Question #N`或`? Ask · Review`。
- title与question body之间保留一行padding。
- question/options body与control hint之间保留一行padding。
- control hint固定在底部separator上一行；separator独占一行并延伸到40 cells。
- footer不换行；40 cells不足时按priority压缩文字，但保留`↵`与`⎋`。

Review panel：

```text
 ╭──────╮╭──────╮╭───────────╮
 │☑ #1  ││☑ #2  ││≡ Review   │
─┴──────┴┴──────┴╯           ╰──────────
? Ask · Review

☑ #1  Storage: SQLite
☑ #2  Hardening: 2 selected
→ Submit answers
  Edit question #1
  Edit question #2

↕ move · ↔ tab · ↵ submit · ⎋ cancel
────────────────────────────────────────
```

- 只有Review panel的`Submit answers` action允许`submit`；question panel按`Select`选择answer。首次由未选变为已选会进入下一panel，已回答question改选answer则停留当前panel。
- 未全部回答时，`Submit answers`显示disabled/error状态；Review仍允许通过`Edit question #N`返回。
- Review的`↔`可回最后一个question；question的`↔`可进入Review。实际Left/Right边界不循环。
- Question panel的`⎋ skip`只跳过当前panel，不提交draft；该tab保持`☐`。Review的`⎋ cancel`才取消整个questionnaire。

State/render contract：

- UI label使用`Review`，内部`AskMode`继续使用`"review"`，避免为显示名称新增状态分支。
- Question panel首次`Select`产生answer时自动前进；已回答question改选时不前进；panel切换仍由Left/Right控制，`↔`只作为提示符号。
- `☑`只在该题`answered:true`时显示。Multi题可以在已有answer后取消全部selection，仍保留显式answered语义。
- 每次render按terminal cell width执行`wrap()`/`truncateToWidth()`；tab bar、separator、footer均不得超过40 cells。
- Body按真实row budget裁切；优先保留cursor所在answer block，必要时显示`↑`/`↓`，不按option数量分页。
### 8.3 Row-aware viewport

虽然option最多5项，description和context在窄terminal仍可能占多行。Renderer必须以terminal row为预算：

1. 计算sticky header/footer占用。
2. 把context、question和每个option渲染成block。
3. Question mode优先保留focused option完整block。
4. 从focus向前后扩张直到body row budget用完。
5. 被裁切时显示`↑`/`↓` indicator。
6. 不按item count分页；按真实rendered rows计算。

不实现横向split pane或跨question全局宽度协调。

### 8.4 Input

- `Key.up` / `Key.down`：question panel移动answer cursor；Review panel移动action cursor。
- `Key.enter`：question panel执行`Select`；Other进入custom；首次answer从未选变已选时前进，已回答question改选时留在当前panel；Review只允许open edit或submit。
- `Key.left` / `Key.right`：切换question tabs与Review tab；边界不循环。
- `Key.escape`：question panel执行skip；custom mode返回所属question；Review取消整个questionnaire。
- 不使用`Key.space`作为Ask主控制；question action统一命名为`Select`，footer显示`↵ Select`。
- Other editor使用module-private bounded adapter包装Pi TUI `Input`。Adapter自行处理并封顶bracketed-paste buffer；任何可插入文本必须先通过single-line printability与1000字符上限，才交给`Input`或进入其value。删除、移动、undo等native keybinding仍委托给`Input`；每次委托后再次检查invariant，失败即恢复前值。`render()`永远只读取已验证value。

每个handled input只触发一次`requestRender()`。`done()`通过单一`settle()` guard调用，防止Enter/abort/session cleanup竞态重复完成。

每次`render(width)`调用`host.getTerminalRows()`取得即时高度；不缓存初始terminal rows。Resize后的下一次render必须按新高度重算viewport并保持focus/submit row可见。

Component实现`dispose()`：若尚未settle，移除listener并以aborted结束pending custom Promise；若已settle则no-op。Host teardown与feature `dispose(sessionId)`共享同一single-settle boundary。

## 9. RPC/ACP fallback

### 9.1 Capability gate

```ts
interface DialogOptions {
  signal?: AbortSignal;
}

interface DialogUI {
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
}

function hasDialogUI(ui: unknown): ui is DialogUI;
```

只检查实际function capability，不依赖mode字符串作为唯一事实来源。

### 9.2 Single-select

- Display entries生成唯一wire strings：`1. Label — Description`。
- Other生成`${count + 1}. ${ASK_OTHER_LABEL}`。
- 只接受host原样返回的offered string；不使用`parseInt()`或prefix parsing。
- 选择Other后`input()`；trim后为空则重新显示input或返回question，不制造empty custom answer。

### 9.3 Multi-select

循环`select()`：

```text
[ ] 1. Rate limiting
[x] 2. Audit logging
[ ] 3. Key rotation
Other (type your own)
Finish selection
```

- 选择真实option严格按offered string toggle。
- Other调用`input()`并保存一个custom answer。
- Finish显式确认；空集合合法。
- Host返回unknown string视为unsupported/error，不猜测。
- Dialog dismiss (`undefined`)取消整个form。

### 9.4 Final review

RPC没有rich editable review；完成所有问题后显示bounded summary，并提供：

- `Submit answers`
- `Start over`
- `Cancel`

Start over重建fresh state；不增量保留旧draft。这个fallback比TUI少“编辑单题”能力，但提交语义一致。

### 9.5 Abort

Pi的dialog primitives原生接受`{ signal }`。Fallback每次调用`select()`/`input()`都传入当前AbortSignal；signal触发时host负责dismiss dialog并返回`undefined`。Fallback在检查`signal.aborted`后把该结果解释为aborted，而不是user cancelled；不需要`Promise.race()`或额外abort listener。

## 10. Execution lifecycle

```ts
interface PendingAsk {
  readonly sessionId: string;
  abort(): void;
}

interface AskFeature {
  start(runtime: HePiRuntimeContext): void;
  dispose(sessionId: string): void;
}
```

### 10.1 Execute顺序

1. `signal?.throwIfAborted()`。
2. normalize/validate params；失败抛明确validation error，用户未看到UI。
3. 验证active runtime/session id匹配；否则fail closed。
4. 验证无pending interaction；否则报`another ask interaction is already active`。
5. 建立single-settle pending guard。
6. `onUpdate`返回`Waiting for user input…`。
7. `ctx.mode === "tui"`优先custom TUI；custom返回`undefined`时才尝试dialog fallback。
8. 非TUI但`hasDialogUI()`时直接fallback。
9. 没有任何可用UI时抛error，明确用户未见问题。
10. submitted构建result；cancelled构建canonical cancelled result；aborted重新抛abort。
11. `finally`清pending、abort listener、UI cleanup与working state。

### 10.2 One-active guard

`executionMode:"sequential"`防同一agent turn并行side effects；feature-local pending guard防host/API重入。Guard属于当前extension instance；`start()`替换session前先abort旧pending。

### 10.3 Session cleanup

`dispose(capturedSessionId)`：

- 只在pending session id相等时abort。
- 调用多次无副作用。
- 不读取可能stale的runtime ctx。
- 不保存draft或自动resume。

## 11. Tool visibility与Loadout

### 11.1 Start-time strip-only reconciliation

Ask tool先注册，确保Loadout inventory能看见它。Session lifecycle顺序固定为：

1. 建立并`load()` Loadout controller；由Loadout应用用户配置的active tools。
2. 调用`ask.start(runtime)`记录active session。
3. `ask.start()`计算`ctx.hasUI`、`ctx.mode`、`ui.custom`与dialog capability；若无交互能力，只从当前active tools移除`ask`。
4. 注册captured-session cleanup。

不挂新的`before_agent_start` tool mutation hook。该event中的system prompt已生成，而`setActiveTools()`会重建base prompt；与现有skill-filter handler组合可能返回stale prompt。Start-time strip发生在first turn prompt assembly之前，不存在该排序问题。

只strip，不re-add：Loadout是active set唯一配置来源。Process mode在session内固定；若未来支持同process capability动态变化，应由Loadout inventory resolver表达capability，而不是Ask自行夺回active set。

### 11.2 Execute backstop

即使session start已strip unsupported Ask，execute仍检查`ctx.hasUI`和实际capability，防旧turn snapshot或host异常。Error必须包含：

```text
The user never saw these questions. Ask them in normal chat instead; do not treat this as a decline or answer.
```

## 12. Result contract

### 12.1 Submitted

Model-visible text：

```text
User submitted answers:
- storage_backend: SQLite
- hardening: Rate limiting; Key rotation
```

含custom：

```text
- hardening: Rate limiting; Other: Add IP allowlist
```

Multi题显式提交空集合时输出`None selected`。它表示用户确认不选任何项，不是unanswered，也不触发cancel。

`details`包含normalized questionnaire和answers。所有arrays/objects deep-isolated，不返回UI mutable state。

### 12.2 Cancelled

```text
User cancelled the questionnaire without submitting answers.
```

```ts
{
  questionnaire,
  answers: [],
  cancelled: true,
}
```

Cancelled不是validation/runtime error；不设`isError`。Prompt明确禁止把它解释为同意。

### 12.3 Aborted/error

- AbortSignal/session replacement：遵循Pi abort control flow，不构造正常Ask result。
- Invalid params、no UI、unsupported renderer、reentrant interaction：tool error。
- Error中区分“用户取消”与“用户从未看到UI”。

### 12.4 Output bounds

外部上限保证最坏submitted summary小于约10KB：

- 4 questions。
- 每题最多5 labels，每label 60 chars。
- 每题最多一个custom answer，1000 chars。
- question text 500、context 2000只存在details/UI，不重复进入summary。

仍可复用Pi `truncateHead()`作为防未来schema扩大保险，但当前contract不依赖巨大50KB/100KB cap。

## 13. Transcript rendering

### 13.1 `renderCall`

```text
Ask user · 2 questions
```

Expanded mode可显示question texts；collapsed mode不展开options/context。

### 13.2 `renderResult`

- Submitted：success color，最多显示前4题compact answer。
- Cancelled：muted `Questionnaire cancelled`。
- Error：沿用Pi error rendering。

不增加Ctrl+O专用展开状态；使用Pi现有expanded参数即可。

## 14. Reference取舍

### 14.1 Claude Code

保留：1–4题、2–4/5 options、automatic Other、multi-select、推荐约定、阻塞user interaction、明确结果映射。

修改：

- 不以question text为answer key，改用stable id。
- 不把`(Recommended)`编码进label。
- 不采用HTML preview。
- 不采用idle auto-continue。

官方资料：

- <https://code.claude.com/docs/en/agent-sdk/user-input.md>
- <https://code.claude.com/docs/en/tools-reference.md>
- <https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/command-development/references/interactive-commands.md>

公开 reconstructed `AskUserQuestionTool.tsx` / `prompt.ts`只用于理解schema/prompt，不视为官方source guarantee。

### 14.2 rpiv-ask-user-question

保留：independent runtime validation、answer discriminator、pure state、automatic sentinel、RPC capability fallback、custom undefined与cancel区分。

删除：preview graph、tab/submit component hierarchy、notes、i18n、config、events、lazy prewarm、collapse listener、strip-and-restore reconciler。

避免已观察风险：execute忽略AbortSignal、RPC `parseInt()`宽松接受、partial submit、multi preview cross-mode不一致、README stale Chat contract。

### 14.3 pi-ask-user

保留：sequential execution、先调查再问的guidance、context、flat provider-safe schema、dialog fallback、structured details、single-line editor/keybinding patterns。

删除：单题限制、option alias/primitive coercion、search、Markdown preview、overlay toggle、env preferences、comments、per-call timeout、bundled skill。

避免已观察风险：abort listener/timer未释放、RPC fallback不abort、invalid timeout、partial malformed options silent drop、free-form multi parser。

### 14.4 SuPi Ask

保留：stable ids、normalize boundary、headless controller、review step、terminal state、sequential + one-active guard、bounded summary、abort控制流。

删除：choice/text union、1–10题、value+label duplication、recommendation preselection、partial `needs_discussion`、question/option/form comments、TUI-only gate、tree label、terminal title/status side effects、prompt config abstraction。

避免已观察风险：terminal后comment mutator仍可修改、custom renderer result只浅验证、unbounded comments/details、extension-scoped lock ownership不清。

## 15. Failure matrix

| 场景 | 结果 | 用户是否看到问题 | Draft是否提交 |
|---|---|---:|---:|
| Params invalid | tool error | 否 | 否 |
| Loadout disabled | tool不可调用 | 否 | 否 |
| `hasUI:false`竞态调用 | tool error | 否 | 否 |
| custom unsupported + dialog available | fallback | 是 | 依用户提交 |
| custom unsupported + no dialog | tool error | 否 | 否 |
| Esc in custom editor | 返回题目 | 是 | 否 |
| Esc in question/review | cancelled result | 是 | 否 |
| RPC dialog dismissed | cancelled result | 是 | 否 |
| AbortSignal | abort control flow | 可能部分看到 | 否 |
| Session replaced/shutdown | abort control flow | 可能部分看到 | 否 |
| Second concurrent Ask | tool error | 否 | 否 |
| Multi confirm with zero choices | submitted empty answer | 是 | 是，明确确认 |
| Unknown RPC return string | tool error | 是 | 否 |

## 16. Test contract

### 16.1 Model

- Normalizes valid single/multi questionnaire without mutation。
- Rejects 0/5+ questions与1/6+ options。
- Rejects blank/duplicate/malformed ids。
- Rejects duplicate question text、case-folded duplicate label、reserved `Other`与`ASK_OTHER_LABEL`。
- Rejects control characters、overlong strings、recommended out of range/non-integer；shared custom validator覆盖1000/1001边界。
- Recommendation sets focus only，不设置answer。
- Single/multi/custom transitions及return-edit行为。
- Multi empty explicit confirm与unanswered区别。
- Terminal state immutable。
- Cancel/abort discard draft。

### 16.2 Component

- Single select、multi toggle/confirm、Other editor、review edit/submit。
- Esc custom vs whole-form cancel语义。
- Narrow/wide widths不超过cell width。
- Long descriptions/context保持focused block可见并显示overflow indicator。
- Footer在窄宽度优先保留Enter/Esc。
- done只调用一次；abort与Enter竞态不double-settle。
- Direct、Kitty与chunked bracketed paste在进入stored value/render前受printability与length限制；paste buffer有界。
- Terminal resize后按即时row budget保持focused block或Submit可见。

### 16.3 RPC fallback

- Strict offered-string matching，不接受`"2abc"`等prefix。
- Single Other、multi toggle、custom + selections、empty multi。
- Dismiss任一dialog取消全部。
- Final Submit/Start over/Cancel。
- Unknown host return fail closed。
- Abort停止own Promise并释放listener。
- RPC custom input通过shared validator；1000合法，1001/control/ANSI/U+2028/U+2029 fail closed且不回显原文。

### 16.4 Integration

- Extension注册`ask`、`todo`与现有commands；tool在Loadout inventory之前存在。
- `executionMode:"sequential"`与prompt surface固定。
- Post-Loadout `ask.start()`在non-UI session只strip；TUI不改变active set；disabled Ask不被restore；first-turn prompt不含已strip Ask guidance。
- Non-UI start-time strip发生在Loadout之后、first-turn prompt之前，不受现有skill-filter hook覆盖。
- TUI custom、RPC dialog、no-UI backstop三条execute path。
- Reentrant Ask拒绝；success/cancel/error/abort后lock都释放。
- Session replacement/shutdown abort pending interaction。
- Result text/details isolation和bounds。
- Custom renderCall/renderResult compact。

## 17. Non-goals升级条件

只有出现下列证据才扩大范围：

- 两个以上真实decision需要视觉对比，且description不足：考虑plain `details`，再评估Markdown preview。
- 用户经常选择option后仍需补充限定条件：考虑每题一个note；不先做per-option/form三层comments。
- RPC host提供真正multi-select primitive：替换toggle loop，不改变result contract。
- 真实remote/AFK workflow需要超时：设计explicit cancelled/deferred outcome，不自动视为回答。
- 第二个pi-basics feature需要相同form engine：再抽public/internal form primitive。

## 18. 设计完成条件

- Schema、runtime validation、UI、fallback、result和prompt guidance使用同一字段/语义。
- 每个cancel/abort/unsupported分支明确说明用户是否看过问题。
- Loadout ownership不被Ask capability reconciliation破坏。
- Recommendation不成为隐式consent。
- 无preview/comment/config/i18n/event/persistence/framework残留。
