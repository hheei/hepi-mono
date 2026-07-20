# pi-basics Ask 高层方案（Review Gate）

> 目的：先确认功能边界，再进入详细设计与实作。推荐方案保留结构化决策的核心价值，但不复制 `rpiv-ask-user-question`、`pi-ask-user`、SuPi Ask 或 Claude Code 的完整 UI 产品面。

## 1. 一句话方案

在 `packages/pi-basics/src/modules/ask/` 内新增内建 `ask` 工具：模型完成必要调查后，可一次提出 1–4 个相关选择题；用户在阻塞式交互界面中选择单项、多项或自动提供的 `Other` 自定义答案，检查答案后提交，工具再把稳定、结构化结果返回模型。

## 2. 推荐功能范围

### 保留

- 工具名称 `ask`；不增加 `ask_user`、`ask_user_question` alias。
- 当前Loadout尚无source-aware tool identity；安装其他同名`ask` extension会冲突。v1接受单一实现约束，不用alias掩盖collision。
- `pi-basics` 内建 module；不建立独立 package。
- 一次调用包含 1–4 个**相关**问题，减少连续 Ask tool call；不允许把无关调查塞进同一表单。
- 每题 2–5 个 option；支持 single-select 与 `multi: true`。
- 每题具有稳定 `id`，结果按 id 返回；不使用可变 question text 作为唯一 identity。
- option 使用 `label` 与可选 `description`；不要求模型再生成重复的 machine value。
- `recommended` 使用显式 0-based option index；UI 标示推荐项并把 focus 放到该项，但**不预先提交或视为用户同意**。
- 自动追加 `Other`，由用户输入自定义单行答案；模型不得自行建立同名 option。
- 可选 top-level `context`，用于展示调查结果、约束和取舍；要求简短，不替代先读代码/文档。
- TUI 使用 Pi `ctx.ui.custom()` 的 inline blocking component。
- RPC/ACP host 若提供 `ui.select()` 与 `ui.input()`，使用顺序 dialog fallback；不要求 custom TUI。
- 非交互模式隐藏工具；execute 仍保留 fail-closed backstop，明确说明用户未看到问题。
- 最终`Review` panel；只有Review中的`Submit answers`可以提交。Question panel使用`Select`选择answer并支持tab切换；首次由未选变已选会进入下一panel，已answered question改选留在当前panel。全部问题必须由用户明确回答后才能submit。Multi-select明确提交空集合也算回答。
- `executionMode: "sequential"`；同一 extension instance 同时只允许一个 pending questionnaire。
- `AbortSignal`、session replacement、shutdown 与 Esc 都有明确 teardown；listener、pending callback 必须释放。
- runtime normalization 与 validation；trim 输入、拒绝 duplicate id/label、reserved `Other`、越界 recommendation、控制字符及过长内容。
- model-visible result 有固定上限；完整 typed details 也受 schema 长度上限约束。
- 简洁 `renderCall` / `renderResult`，避免默认 transcript 展开完整 schema。
- Tool 在 Loadout inventory 中正常出现；用户禁用后不得被 capability reconciler 擅自恢复。

### 不做

- 不做 Markdown/HTML preview、side-by-side pane、responsive preview donation layout。
- 不做独立 text-question type；需要纯自由输入时，普通对话更自然，或使用 `Other`。
- 不做 per-option note、question comment、form comment。
- 不做 partial submit、`needs_discussion` outcome、unanswered action row。
- 不做自动 timeout 或 AFK auto-continue；缺少回答时保持阻塞，直到用户回答、取消或 session abort。
- 不做 overlay/inline 切换、隐藏 overlay 快捷键、环境变量或 Settings 配置。
- 不做 option search；每题最多 5 项，搜索没有价值。
- 不做 i18n、public events、analytics metadata、session tree label。
- 不做 disk/session domain state、replay、snapshot 或恢复未提交表单。
- 不附带强制 Ask skill；正确调用门槛写进 tool prompt guidance。
- 不建立 Ask public SDK、通用 form framework 或 contribution abstraction。

## 3. 推荐 Tool contract

```json
{
  "context": "Repository uses SQLite and must remain deployable without a new service.",
  "questions": [
    {
      "id": "storage_backend",
      "question": "Which storage backend should this feature use?",
      "options": [
        {
          "label": "SQLite",
          "description": "No new infrastructure; best fit for current deployment."
        },
        {
          "label": "PostgreSQL",
          "description": "Better concurrent writes, but adds an external service."
        }
      ],
      "recommended": 0
    },
    {
      "id": "hardening",
      "question": "Which hardening items should ship now?",
      "options": [
        { "label": "Rate limiting" },
        { "label": "Audit logging" },
        { "label": "Key rotation" }
      ],
      "multi": true
    }
  ]
}
```

Tool result details：

```ts
interface AskAnswer {
  readonly id: string;
  readonly question: string;
  readonly selected: readonly {
    readonly index: number;
    readonly label: string;
  }[];
  readonly custom?: string;
}

interface AskToolDetails {
  readonly questionnaire: AskQuestionnaire;
  readonly answers: readonly AskAnswer[];
  readonly cancelled: boolean;
}
```

取消整个 questionnaire 时返回 `answers: []` 与 `cancelled: true`；已填写但未提交的 draft 不被解释为用户决定。

## 4. 用户可见行为

### 4.1 TUI

使用Settings风格tab bar：`☐ #N`表示未回答、`☑ #N`表示已回答，最后固定`≡ Review`。`↔`表示←/→切换panel，Question panel中的`↵ Select`选择answer，Review panel才允许Submit。首次由未选变为已选会自动进入下一panel；已回答后改选answer则留在当前panel。

40-cell reference：

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

Toggle answer整行使用answer color；cursor所在未toggle row整行使用cursor color，并把中性`)` slot替换成`→`。若两者同时命中，answer color优先。Question/options body与control hint之间保留一行padding，control hint固定在separator上一行。完整multi、Other与Review mockup见详细设计 8.2.1。

### 4.2 RPC/ACP fallback

- Single-select：一个 native `select()`，包含 automatic Other；Other 再调用 `input()`。
- Multi-select：重复 `select()` toggle offered options，最后选择 `Finish selection`；不解析任意逗号字符串。
- 完成后显示 summary，并提供 `Submit answers`、`Start over`、`Cancel`。
- Host dismiss 任一 dialog 视为取消整个 questionnaire。

### 4.3 非交互模式
- `onStart`在`loadoutController.load()`完成后检查当前session capability；无custom TUI且无`select/input` dialog时，从active tools移除 `ask`。
- 只strip，不自动restore，避免覆盖Loadout中的用户选择；`execute()`仍保留fail-closed backstop。
- 若capability snapshot与execute发生竞态，execute fail closed：返回/抛出明确错误，说明用户从未看到问题，模型应改用普通chat提问。

## 5. 调用纪律

建议 prompt guidance：

1. 先查代码、配置、文档和已有决定；能由工具取得的事实不得问用户。
2. 仅当多个方案有实质不同取舍、且选择依赖用户偏好或授权边界时使用 `ask`。
3. 多个方案都可接受时，优先选择最保守、标准、可逆方案继续；不要为微小偏好打断用户。
4. 一次 questionnaire 只处理一个 decision boundary；相关问题可合并，互不相关的问题分开。
5. 提供 2–5 个简短、互异 options；trade-off 放 description，不塞进 label。
6. 有推荐时填 `recommended`；不要通过 label 手写 `(Recommended)`。
7. `ask` 是澄清工具，不替代 Pi 的 permission/approval；答案不改变其他工具权限。
8. 用户取消代表未作决定；不得推断同意，也不得继续执行依赖该决定的不可逆步骤。

## 6. 参考实现比较与取舍

| 能力 | Claude Code | rpiv | pi-ask-user | SuPi | pi-basics 决策 |
|---|---|---|---|---|---|
| 1–4 related questions | 有 | 有 | 单题 | 1–10 | 保留 1–4 |
| Stable question id | 无，answer keyed by question text | question index/text | 单题 | 有 | 保留 id |
| 2–4/5 options | 2–4 | 2–4 | 未严格限制 | 2–12 | 2–5 |
| Single + multi | 有 | 有 | 有 | 有 | 保留 |
| Automatic Other | 有 | 有 | 可关闭 | 无任意 Other | 永远提供 |
| Recommendation | label convention | first option convention | 无 typed field | typed value(s) | typed index，不预选 |
| Text question | 无 | 无 | options 为空时支持 | 有 | 删除 |
| Review before submit | 内建 UI | Submit tab | 无 | 有 | 保留简化版 |
| Partial submit | 不作为推荐 contract | 允许 | 单题不适用 | `needs_discussion` | 删除 |
| Notes/comments | 新版 annotation | 有 | 可选 comment | 三层 comment | 删除 v1 |
| Preview/details | Markdown/HTML | Markdown pane | Markdown pane | plain details pane | 删除 v1 |
| RPC fallback | SDK host callback | select/input walker | select/input walker | TUI-only | 保留能力 fallback |
| Timeout | user setting | 无 | per-call | 无 | 删除 v1 |
| Search | UI implementation细节 | wrapping list | 有 | 无需 | 删除，max 5 |
| Overlay config/hide | 产品 UI | collapse key | 丰富配置 | inline form | 删除，固定 inline |
| Pure controller/reducer | 内部未知 | reducer/effects | component-local | headless controller | 保留最小 pure state |
| Bounded result | 100k reconstructed limit | schema小但 preview可大 | 未统一 | Pi truncateHead | 通过输入上限 + summary cap |
| Cancellation/abort | query cancellation | signal未接线 | 部分 listener/timer泄漏风险 | 显式 abort | 明确定义并测试 |
| Tool capability gating | requires interaction | strip/restore | execute fallback | TUI hard gate | strip-only，尊重 Loadout |

## 7. 为什么推荐这些取舍

### 7.1 选择 multi-question，而不是强制一题一 call

Claude Code 与 rpiv 的 1–4 题上限适合相关 requirement gathering，可减少 tool round-trip；SuPi 的 10 题更像 survey/form builder，超出 coding-agent clarification 的需要。Tool guidance仍限制一个 decision boundary，避免问卷滥用。

### 7.2 使用 id，不以 question text 当 key

Question text 是展示文案，可能包含标点或后续改写；stable id 更适合 typed result、测试、RPC parity 和未来 renderer。Option 数量最多 5，不再要求额外 machine value，避免模型同时维护 value/label 的重复负担。

### 7.3 Recommendation 只影响 UI focus

SuPi 未显式 recommendation 时自动选择第一项，容易让 Enter 变成隐性同意；Claude 的 `(Recommended)` label 是 prompt convention，不是稳定 schema。显式 index 最小且可验证，标记推荐但不把它当答案。

### 7.4 保留 automatic Other，删除通用 text questions与 comments

Other 是避免假二选一的必要 escape hatch。纯 text question 可直接用普通 chat；comments/notes需要额外 editor、结果语义和 review UI。出现真实需求前，不把 Ask 变成通用 form engine。

### 7.5 保留 RPC fallback，固定 inline TUI

Pi 的 RPC host可用 `select/input`，完全禁用会无谓降低环境适应性。Overlay、隐藏快捷键和 preview layout则主要是展示复杂度；inline custom component能保持上下文可见，也避开 terminal image overlay 问题。

### 7.6 不做 timeout

Ask 表示模型被用户决定阻塞。自动 timeout 后让模型自行判断，可能把“用户离开键盘”误作授权或偏好。v1仅允许明确 submit、cancel或 abort。

## 8. 与 pi-basics 的整合

- 目录：`packages/pi-basics/src/modules/ask/`。
- Extension factory先建立 `AskFeature` 并注册 `ask`，再进入 lifecycle start；Loadout inventory因此能发现 `tool:ask`。
- `AskFeature` 只保存当前 pending interaction的 session id与 abort settle callback，不保存已提交答案。
- `onStart`先让Loadout应用用户配置，再调用`ask.start(runtime)`做capability strip并注册captured-session cleanup；session replacement/shutdown会终止未完成 interaction。
- Tool result history自然记录已提交问答；Ask不需要 Todo式 snapshot/replay。
- 不进入 Settings、Shell、module registry或公开 package exports。

## 9. Review 决策点

| 决策 | 推荐 | 可选替代 |
|---|---|---|
| Tool 名称 | `ask` | `ask_user` / `ask_user_question` |
| 问题数量 | 1–4 related questions | 一题一 call / 最多10题 |
| Question identity | required stable `id` | question text key |
| Option shape | label + optional description | value + label + details |
| 推荐项 | 0-based `recommended` index，focus only | first option + label suffix / preselect |
| 自定义答案 | automatic Other，不能关闭 | optional allowFreeform |
| Text question | 不做 | choice/text union |
| Notes/comments | 不做 v1 | per-option/question/form notes |
| Preview | 不做 v1 | Markdown side pane |
| 完成策略 | all answered + Review + Submit | partial submit / immediate final-answer commit |
| TUI | fixed inline custom component | overlay + toggle/config |
| RPC | select/input fallback | TUI-only |
| Timeout | 无 | configurable auto-cancel/continue |
| Cancellation | discard draft，explicit cancelled | partial answers retained |
| Capability | post-Loadout start-time strip-only | per-turn mutation / automatic restore |

## 10. 完成定义

- 模型能提交 1–4 个相关问题，每题 2–5 个 options。
- stable id、duplicate/reserved/length/recommendation validation全部 fail closed。
- TUI支持 single、multi、Other、返回编辑与最终 review。
- RPC fallback不依赖模糊数字解析或自由格式 multi parser。
- 非交互 session中工具不暴露；Loadout disabled不会被恢复。
- recommendation不构成用户答案；multi空集合必须由用户明确确认。
- cancel不返回 partial decisions；abort/session replacement无悬挂 Promise、timer或 listener。
- result text与details边界明确且有长度上限。
- 不新增 package dependency、配置格式、持久化格式、public API或通用 form abstraction。

详细设计见 [`pi-basics-ask-design.md`](./pi-basics-ask-design.md)，实施步骤见 [`pi-basics-ask-implementation.md`](./pi-basics-ask-implementation.md)。

## 11. 研究基线

本方案比较以下 revision：

- `references/rpiv-mono`：`c393580781ef8bb4912288333057b902b92b1ea1`
- `references/pi-ask-user`：`1ad2adf7010c4ac5068668b6999bc1eb98a864a7`
- `references/supi`：`05aa1b038afbe62b516ab834b064f0e55e9e7598`

Claude Code事实优先采用官方文档：

- <https://code.claude.com/docs/en/agent-sdk/user-input.md>
- <https://code.claude.com/docs/en/tools-reference.md>
- <https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/command-development/references/interactive-commands.md>

Claude Code内部 schema/prompt细节另参考公开 reconstructed source；该来源不是 Anthropic 官方 source release，详细设计中会明确标记，不把它当唯一事实来源。
