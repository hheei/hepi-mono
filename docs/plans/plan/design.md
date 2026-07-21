# pi-basics Plan Mode 详细设计

> Archived plan: retained for implementation history. Current behavior is defined by source, tests, and `packages/pi-basics/README.md`.

> 状态：提案。按最新决策，Plan Mode 不注册任何新 tool，不改 active-tool 权限；完成计划由 assistant message marker 识别，用户动作复用既有 Ask interaction。

## 1. Runtime contract

```ts
type PlanPhase = "inactive" | "planning" | "ready" | "refining";
type RequestedPlanAction = "new" | "compact";

interface ActivePlan {
  readonly sessionId: string;
  readonly runtime: HePiRuntimeContext;
  phase: PlanPhase;
  planEntryId?: string;
  planUrl?: string;
  requestedAction?: RequestedPlanAction;
  initialAskPending: boolean;
  disposed: boolean;
}
```

语义：

- `planning`：调查、澄清、等待第一个完整 plan。
- `ready`：第一个完整 plan 已保存，initial Ask 已经触发或无法触发；不自动再 Ask。
- `refining`：用户选择 Refine 或执行 `/plan edit`；模型可以输出 replacement plan，但完成后不自动 Ask。
- `inactive`：Plan Mode 结束；历史 artifact 保留，不再作为 active plan 使用。

Plan Mode 不拥有 source-file mutation policy。Prompt 是 v1 唯一行为引导；不调用 `setActiveTools()`、不监听/阻止 `tool_call`、不扩展 `ToolActivationCoordinator`。这必须在 README 和 status 中明确为“非 sandbox”。

## 2. Completion marker

### 2.1 Canonical assistant output

模型完成计划时，prompt 要求最后 assistant message 包含唯一 block，tags 必须各自位于行首/行尾：

```xml
<proposed_plan>
# Plan title

...
</proposed_plan>
```

`extractProposedPlan(text)` 只接受：

- 一个 block；
- opening/closing tag 独占一行，大小写严格为 lowercase；
- body trim 后非空；
- body bounded（建议复用现有 Goal summary 的长度治理，最终上限由 Phase 0 Review 锁定）；
- 没有嵌套 block、额外 opening/closing tag 或 unclosed tag。

没有合法 block 的 assistant response 是普通 planning/refinement response，不保存、不 Ask。多个、malformed、empty、unclosed block 也不猜测。

这是 model-visible protocol，不是 tool schema；不注册 `plan_mode_complete`，不自动从“Here is the plan”这类 prose 推断完成。

### 2.2 Plan artifact

解析成功后通过现有 Pi message API 写入 custom message：

```ts
const PLAN_MESSAGE_TYPE = "pi-basics-plan";

pi.sendMessage({
  customType: PLAN_MESSAGE_TYPE,
  content: plan,
  display: true,
  details: { version: 1 },
}, { triggerTurn: false });
```

`CustomMessageEntry` 本身是 plan 的唯一 durable artifact；不把 plan body 复制进 custom state。发送后从 current `sessionManager.getBranch()` 找到最新 matching custom message 的真实 `entry.id`，不能假造 id。

如果 host 的 `sendMessage` 与 branch append 不提供可定位 entry，Plan artifact 仍可显示但不能满足 URL contract；实现必须通知并保持 ready/refining，不自动 Ask/implement。

### 2.3 Plan URL

使用已存在 SessionManager API：

```ts
function planUrl(ctx: ExtensionContext, entryId: string): string | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  return `${pathToFileURL(sessionFile).href}#${encodeURIComponent(entryId)}`;
}
```

- `getSessionFile()` 缺失、entry 不在 current branch 或 `pathToFileURL` 失败时返回 `undefined`。
- 不使用 `pi-inturl`、`pi-extcore` 或新 web server；`file://...#entry-id` 是可复制的 session artifact URL，不宣称浏览器能直接渲染 fragment。
- Plan URL 必须显示在 `/plan show`，并附到 Ask questionnaire `context` 和实施 prompt。
- URL 失败不可降级为 `session://`、随机 UUID 或裸文件路径。

## 3. Automatic Ask interaction

### 3.1 Existing Ask seam

当前 `ask` 已拥有 TUI component、RPC `select/input` fallback、AbortSignal、session cleanup 和 single-active guard。增加 module-private service seam，不注册新工具：

```ts
interface AskInteractionHost {
  requestAsk(
    questionnaire: AskQuestionnaire,
    runtime: HePiRuntimeContext,
  ): Promise<AskInteractionResult>;
}
```

现有 `ask` tool execute 与 Plan auto-choice 共用 `requestAsk` 的实现。PlanFeature 从 entry 注入 callback，避免 Plan import Ask component 或创建第二个 UI。

### 3.2 Initial questionnaire

首次合法 plan 且 `phase === "planning" && initialAskPending` 时：

```ts
const questionnaire = {
  context: `Plan URL: ${planUrl}`,
  questions: [{
    id: "plan_next_action",
    question: "What should we do with this plan?",
    options: [
      { label: "Refine", description: "Continue planning and revise this plan." },
      { label: "Implement (new)", description: "Start implementation in a new session." },
      { label: "Implement (compact)", description: "Compact current context, then implement here." },
    ],
  }],
};
```

- `planUrl` 必须在 context 中出现；question/plan preview 也显示同一 URL。
- 不添加 `Exit` 到 initial Ask；用户取消就是不作决定，留在 ready。
- `initialAskPending` 在调用前置为 false，避免 agent/session race 重复弹 Ask；Ask cancel/error 不改变 plan artifact。
- Ask result 必须通过 `id` 匹配，不能按 option text 模糊解析。

### 3.3 Action transitions

**Refine**：

1. phase `ready → refining`；更新 durable boundary。
2. 发送 refinement instruction，包含 plan URL，并要求模型在需要时输出完整 replacement `<proposed_plan>`。
3. 不自动 Ask。新的合法 block 追加为新 `pi-basics-plan` artifact，更新 `planEntryId/planUrl`，保持 `refining`。
4. 后续 `/plan` 才显示 implement (new)/implement (compact)/exit。

**Implement (new) / Implement (compact)**：

- Ask runs from `agent_end` with `ExtensionContext`; Pi exposes `newSession()` only to `ExtensionCommandContext`. Therefore Ask cannot directly execute either session action.
- Ask result durable-records `requestedAction: "new" | "compact"`, retains `ready`, and tells user to run `/plan`.
- The next `/plan` handler is command-capable. It first executes `requestedAction` without opening a second selector; then clears the pending action. This is the only automatic action bridge.
- A user entering `/plan` with no requested action receives selector: Implement (new) / Implement (compact) / Exit. Selecting it runs through the same command handler.
- Before `newSession()` or `compact()`, append inactive boundary. Failure to start a new session restores a refining boundary with plan URL. `ctx.compact()` is callback-only: `onComplete` sends implementation prompt, `onError` restores refining and notifies; callback completion is guarded so no error/success race sends twice, and compaction is never retried automatically.
- Implementation prompt contains plan URL plus canonical plan. `newSession({ parentSession, withSession })` sends that prompt through replacement command context; compact sends on current session only after `onComplete`.

**Exit**：

- durable phase 切 `inactive`，清 status/transient runtime；不删除历史 plan artifact。
- “give up”表示不再 active、不实施、不自动 Ask；用户仍可通过 session history 查看旧结果。

## 4. Commands and Esc

```ts
/plan [prompt]
/plan
/plan edit
/plan show
```

| Command | inactive | planning | ready/refining |
|---|---|---|---|
| `/plan <prompt>` | enter + send prompt | send planning prompt | send refinement prompt，clears requested action and保持 refining |
| `/plan` | enter | 显示 active 提示 | requested action存在时直接执行；否则 selector：Implement (new)、Implement (compact)、Exit |
| `/plan edit` | enter + send edit prompt | send edit prompt | clears requested action，保持/进入 refining，发送 edit prompt |
| `/plan show` | no plan notice | no completed plan notice | display latest plan + URL |

`/plan` selector 使用 existing `ctx.ui.select`/Ask host；`Esc`、dismiss、`undefined` result 都只关闭 selector，phase 保持 `refining`，不调用 implement/exit。没有 UI 时 `/plan` 显示可用命令提示，不自动选择。

不注册 `/plan implement`、`/plan exit`、`/plan tools`、`/plan approve`、`--plan`、快捷键或 aliases。

## 5. Prompt contract

`buildPlanModePrompt()` 注入短规则：

1. Plan Mode 用于调查、澄清和写 implementation plan；不会自动执行。
2. 先读代码、配置、文档和已有决定；不要询问可由工具发现的事实。
3. 不要修改 source files、运行依赖安装、提交、迁移或其他 implementation action；这些是 prompt contract，不是 runtime sandbox。
4. 只有方案完整时才在最后 assistant message 输出唯一 `<proposed_plan>` block；body 必须包含目标、范围、文件/符号、数据流、边界/失败行为、tests/verification 和 assumptions。
5. Refine instruction 要求修改计划时输出新的完整 block，不输出 delta；不要自动调用 Ask。
6. 不要生成 `plan_mode_complete`、`plan_mode_question` 或任何不存在的 Plan tool。
7. 实施 prompt 必须引用 plan URL，并说明 Plan Mode 已结束、正常工具权限已恢复。

`before_agent_start` 只在 planning/refining 时注入 prompt。ready 不自动启动 agent；`/plan`/`/plan edit` 才触发下一 turn。

## 6. Persistence and replay

### 6.1 Boundary

```ts
type PlanBoundary =
  | { readonly version: 1; readonly phase: "inactive" }
  | {
      readonly version: 1;
      readonly phase: "planning" | "ready" | "refining";
      readonly planEntryId?: string;
      readonly planUrl?: string;
      readonly requestedAction?: RequestedPlanAction;
      readonly initialAskPending: boolean;
    };
```

- custom type：`pi-basics-plan-mode`。
- strict keys/version/phase/ID/URL/requested action validation；malformed newest matching boundary fail closed，不回放更早 active state。
- plan body只从 boundary 指定的 `planEntryId` 在 current branch 找 `pi-basics-plan` custom message 并读取；entry 缺失、非 message、URL 不一致时显示 warning 并降为 planning/inactive。
- Ask选择 implementation 时保留 `ready + requestedAction`；只有 command handler消耗/清除它。`/plan edit`、`/plan <prompt>` 和 Ask Refine 都必须清除它后进入 refining。
- revision 每次追加新的 plan artifact 和 boundary；session append-only，不修改旧 message。
- compaction/tree/fork/reload 只扫描 current branch；旧 branch 的 plan 不可泄漏。
### 6.2 Agent-end ordering

```text
agent_end
  -> latest assistant text
  -> strict proposed_plan parse
  -> append/display pi-basics-plan custom message
  -> locate current entry id
  -> derive file:// URL
  -> append ready/refining boundary
  -> if initialAskPending: requestAsk(context includes URL)
```

任何一步 persistence/URL failure：不触发 implement，不猜测用户选项；保存可恢复的 planning/refining state并通知。

## 7. Pi integration

- `PlanFeature` 注册 command、`before_agent_start`、`agent_end`、`session_start`、`session_shutdown` 与现有 tree/switch/fork lifecycle hooks；不注册 tool/tool_call gate。
- PlanFeature 只持有当前 runtime；cleanup 以 captured session id guarded，stale cleanup 不能清新 session status。
- `ctx.ui.setStatus("plan", "Plan · active" | "Plan · ready" | "Plan · refine")`；Statusbar 直接消费该 status。
- 不修改 `ToolActivationCoordinator`；Plan Mode 与 Goal/Todo/Ask execution 可共存。Goal 的自动行为不由 Plan 改写。
- Ask seam 的改动保留现有 `ask` tool contract、Loadout visibility、TUI/RPC behavior 和 result details；只增加 Plan 内部调用入口。

## 8. Failure matrix

| Failure | Result |
|---|---|
| no proposed block | ordinary reply，no artifact/Ask |
| multiple/malformed block | warning/ordinary planning，no Ask |
| Ask cancel/Esc | retain ready/refining，no inferred decision |
| no session file/entry URL | retain plan, no automatic Ask/implement |
| custom message append fails | preserve previous plan/phase，surface error |
| new session fails | artifact retained，restore refining |
| compact callback fails | no retry；artifact retained，surface error |
| stale session callback | ignore；new owner remains unchanged |
| `/plan show` without plan | notification only |
| `/plan` without UI | command hint only，never auto choose |

## 9. Acceptance

- 不注册任何新 tool；`pi.getAllTools()` 中不出现 Plan-specific tool。
- 首次 valid plan 只触发一次 Ask，且 context/question 含 stable plan URL。
- Ask refine 后不自动 Ask；新 plan 可被保存并由 `/plan show` 查看。
- `/plan` selector 只提供 new/compact/exit；Esc 返回 refine，不改变 artifact。
- new 使用 `ctx.newSession`；compact 使用 `ctx.compact`；两者 implementation prompt 都带 URL 与 plan。
- `/plan edit` 和 `/plan [prompt]` 遵循 command matrix；`/plan show` 不触发 model turn。
- reload/tree/fork/compaction 后 current branch 可恢复 latest plan artifact/URL；malformed state fail closed。
- 权限只由 prompt 引导，README 明确不提供 runtime sandbox；不修改 coordinator 或 Goal/Loadout policy。
