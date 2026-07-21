# pi-basics Plan Mode 实作方案

> Archived plan: retained for implementation history. Current behavior is defined by source, tests, and `packages/pi-basics/README.md`.

> 输入：[`high-level.md`](./high-level.md) 与 [`design.md`](./design.md)。本文件描述实施顺序、文件变更、focused tests、smoke scenario 和验收；不是已完成声明。

## 1. 实作原则

- 不注册 Plan-specific tool；completion 由 `agent_end` 解析 canonical `<proposed_plan>` block。
- 复用现有 Ask interaction，不复制 TUI/RPC question renderer，不改变 `ask` tool 的 model-facing schema。
- 不调用 `setActiveTools()`，不新增 `tool_call` security gate，不修改 Goal、Todo、Loadout permission policy。
- Plan 正文只保存在 Pi `pi-basics-plan` custom message artifact；state entry 只保存 phase、entry id、URL 和 Ask bookkeeping。
- 任何 Ask、URL、session、compaction、new-session failure 都必须显式处理；不得猜测用户选择或自动重试可能已提交的 session action。
- Plan URL 必须来自真实 `sessionFile + custom message entryId`；不存在 URL 时不伪造 URI，也不自动 Ask。
- 不新增 package、dependency、disk plan directory、browser server、review loop、handoff abstraction 或 public SDK。

## 2. 预期改动清单

### 修改

- Phase 0 确认的真实 `packages/pi-basics` extension entry：建立 `PlanFeature`，并注入 Ask interaction callback。
- `packages/pi-basics/src/modules/ask/index.ts`：增加 module-private/programmatic `requestAsk()` seam；现有 `ask` tool execute 复用同一 interaction runner。
- `packages/pi-basics/README.md`：记录 `/plan [prompt]`、`/plan edit`、`/plan show`、Ask actions、Plan URL、new/compact/exit 和 prompt-only permission limitation。
- 现有 entry/lifecycle integration tests：增加 Plan registration/lifecycle；真实 path 由 Phase 0 决定。

### 新增

- `packages/pi-basics/src/modules/plan/model.ts`
- `packages/pi-basics/src/modules/plan/persistence.ts`
- `packages/pi-basics/src/modules/plan/feature.ts`
- `packages/pi-basics/src/modules/plan/index.ts`
- `packages/pi-basics/test/modules/plan/model.test.ts`
- `packages/pi-basics/test/modules/plan/persistence.test.ts`
- `packages/pi-basics/test/modules/plan/feature.test.ts`
- 必要时 `packages/pi-basics/test/modules/ask/integration.test.ts` 扩展 programmatic Ask seam

### 明确不修改

- `packages/pi-basics/src/runtime/tool-activation.ts`：Plan 不拥有 tool mask。
- Goal、Todo、Statusbar renderer、`pi-extcore`、`pi-loadout`、`pi-ssh`、`pi-inturl`。
- package manifest：无新 dependency。

## 3. Phase 0：Review Gate 与 host capability reconciliation

实现前确认：

1. Plan Mode 不注册任何 tool，唯一 completion signal 是严格 `<proposed_plan>` block。
2. 首次 completion 自动调用 existing Ask，选项恰为 Refine / Implement (new) / Implement (compact)；initial Ask 不含 Exit。
3. Refine 后不自动 Ask；`/plan` selector 才能触发 Implement (new) / Implement (compact) / Exit；Esc 回到 refine。
4. `/plan [prompt]`、`/plan`、`/plan edit`、`/plan show` 是唯一 command shape。
5. Ask context、question 和实施 prompt 都包含 plan URL。
6. Plan 不调用 `setActiveTools()`，权限只由 prompt 引导，不宣称 sandbox。
7. `ctx.newSession()`、`ctx.compact()`、`sessionManager.getSessionFile()`、current branch custom message entry id 在当前 Pi peer API 可用。
8. `pi.sendMessage()` 后可以从 current branch 定位 matching `pi-basics-plan` custom message entry；否则停在 URL seam 设计，不用随机 ID 或裸路径补洞。

当前 source list 中 package manifest 指向的 `src/index.ts` 与 README 不可见。必须先定位真实 extension entry、Ask lifecycle owner 和 session composition；若 baseline 不完整，先单独恢复并验证，不用旧 docs 猜测/重建用户文件。

## 4. Phase A：Pure parser、URL 与 state model

### A1. `model.ts`

实现：

```ts
export const PLAN_MESSAGE_TYPE = "pi-basics-plan";
export type PlanPhase = "inactive" | "planning" | "ready" | "refining";

export interface ParsedPlan {
  readonly plan: string;
}

export function extractProposedPlan(text: string): ParsedPlan | undefined;
export function planUrl(sessionFile: string | undefined, entryId: string | undefined): string | undefined;
export function planStatusText(phase: PlanPhase): string | undefined;
export function buildPlanModePrompt(): string;
export function buildRefinementPrompt(planUrl: string): string;
export function buildImplementationPrompt(planUrl: string, plan: string): string;
```

Parser：

- opening/closing tag 必须独占行、lowercase、唯一、配对；body trim 后非空。
- reject multiple/nested/malformed/unclosed blocks；不从 prose/heading/Markdown fence 猜测完成。
- body 做 bounded length validation；上限与 README/test 共用单一 constant。
- `planUrl()` 只接受 non-empty session file + entry id，使用 Node `pathToFileURL()`；不接受 `session://`、裸 path 或随机 fallback。
- prompt 明确 source-file permission 是 guidance，不是假定 runtime gate；refinement 必须输出完整 replacement block。

### A2. `persistence.ts`

```ts
export const PLAN_MODE_CUSTOM_TYPE = "pi-basics-plan-mode";

type PlanBoundary =
  | { readonly version: 1; readonly phase: "inactive" }
  | {
      readonly version: 1;
      readonly phase: "planning" | "ready" | "refining";
      readonly planEntryId?: string;
      readonly planUrl?: string;
      readonly requestedAction?: "new" | "compact";
      readonly initialAskPending: boolean;
    };

export function encodePlanBoundary(value: unknown): PlanBoundary | undefined;
export function decodePlanBoundary(value: unknown): PlanBoundary | undefined;
export function restorePlanMode(branch: readonly unknown[], onMalformed?): RestoredPlan;
export function appendPlanBoundary(pi, boundary: PlanBoundary): void;
export function latestPlanArtifact(branch, entryId): { plan: string; entryId: string } | undefined;
```

Rules：

- strict record/version/known-key/phase/ID/URL/requested-action validation；newest malformed matching boundary fail closed，不回放旧 active state。
- artifact 必须是 current branch 中 `type:"custom_message"`、`customType:PLAN_MESSAGE_TYPE` 的 entry；content 只接受 string 或明确 single text content。
- boundary 的 `planEntryId` 必须指向对应 artifact；URL 必须由同一 session file + entry ID 重算并匹配。
- initial Ask 的 new/compact answer 只能写 `ready + requestedAction`；agent-end 无 command context，严禁直接调用 `newSession()`。`/plan edit`、`/plan <prompt>`、Refine 都清除 pending action 后进入 refining。
- append-only tree/reload 只取 current branch；old branch artifact 不可泄漏。

### A3. Tests

`model.test.ts`：

- valid single block trim；empty、multiple、nested、unclosed、wrong-case、inline tag、prose-only 全部不触发。
- body upper bound、URL encoding、missing session file/entry id、absolute session path转换。
- prompt 包含 no-new-tool、single marker、refine no auto Ask、URL、new/compact/exit semantics；不承诺 tool gate。

`persistence.test.ts`：

- legal inactive/planning/ready/refining boundaries；unknown key、wrong version、bad phase、invalid ID/URL、array/null reject。
- latest boundary determines state；malformed latest does not replay older plan。
- matching custom message artifact restores plan；missing/wrong-type/wrong-entry content fails closed。
- old branch artifact ignored；new revision points to latest artifact；initialAskPending persists exactly。

### A4. Phase check

```bash
bun test packages/pi-basics/test/modules/plan/model.test.ts \
  packages/pi-basics/test/modules/plan/persistence.test.ts
bunx biome check packages/pi-basics/src/modules/plan/model.ts \
  packages/pi-basics/src/modules/plan/persistence.ts \
  packages/pi-basics/test/modules/plan/model.test.ts \
  packages/pi-basics/test/modules/plan/persistence.test.ts
```

完成条件：pure files 无 Pi registration、TUI、session I/O、shell 或 compaction import；URL builder 只做纯转换。

## 5. Phase B：Ask programmatic seam

### B1. Reuse existing interaction

Ask module增加最小 module-private API：

```ts
interface AskFeature {
  start(runtime: HePiRuntimeContext): void | Promise<void>;
  dispose(sessionId: string): void | Promise<void>;
  requestAsk(
    questionnaire: AskQuestionnaire,
    runtime: HePiRuntimeContext,
  ): Promise<AskInteractionResult>;
}
```

`requestAsk()`：

- 使用与现有 `ask` tool execute 相同的 `createAskComponent`/RPC fallback、AbortController、one-active guard、session check 和 teardown。
- 不调用 `pi.registerTool()`；不改变 `ASK_PARAMETERS`、tool name、Loadout visibility、result details 或 existing model contract。
- PlanFeature 在 `agent_end` 只调用 callback；callback result 用 stable question id `plan_next_action` 映射。
- Ask context 必须包含 `Plan URL: ...`；在 TUI/RPC 都展示同一 URL。
- Cancel/abort/UI unavailable 返回未决状态，不产生 action。

### B2. Tests

扩展 `ask/integration.test.ts`：

- programmatic request 与 tool request 使用同一 runner；不新增 registered tool。
- questionnaire context/URL 原样抵达 TUI/RPC host。
- active guard、abort、session replacement、Esc/cancel 只 settle 一次。
- Plan action labels/ID 稳定；不存在模糊数字或逗号 multi parser。

## 6. Phase C：PlanFeature 与 command flow

### C1. Registration

`createPlanFeature(pi, ask, options?)` 只注册：

- `/plan` command；
- `before_agent_start`、`agent_end`、`agent_settled`（如仅用于 stale menu cleanup）、session/tree/switch/fork/shutdown lifecycle hooks。

它**不**注册 `plan_mode_complete`、`plan_mode_question` 或任何 tool；不注册 `tool_call` hook；不调用 `setActiveTools()`。

`agent_end`：

```text
if phase planning/refining:
  parse latest assistant text
  if no valid block: leave state
  append pi-basics-plan custom message
  locate entry id + generate URL
  append boundary with latest artifact
  if phase was planning && initialAskPending:
    mark ask consumed
    requestAsk(context includes URL)
    Refine -> refining
    Implement(new|compact) -> ready + requestedAction, notify “run /plan to continue”
```

`agent_end` receives `ExtensionContext`, so it can never invoke `newSession()`. `refining` 中合法 replacement plan 只更新 artifact/URL，绝不 requestAsk。所有 async callback 在 await 后重新验证 session id、phase 和 artifact id。

### C2. Command handlers

- `/plan <prompt>`：inactive 先 append planning；发送 planning prompt。ready/refining 清除 requested action，发送 refinement prompt并保持/进入 refining。
- `/plan`：inactive 进入；ready/refining 若有 requested action，先在 command context 执行它；否则显示 selector。selector 只有 `Implement (new)`、`Implement (compact)`、`Exit`。Esc/undefined 只关闭，保持 refining。
- `/plan edit`：清除 requested action，append/retain refining boundary，发送 refinement prompt；不 Ask。
- `/plan show`：发送 display-only custom message或通知，包含完整 plan 和 URL；不 trigger turn。

### C3. Implement actions

**new**（只由 `/plan` 的 `ExtensionCommandContext` 调用）：

1. append inactive boundary。
2. 调用 `ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile(), withSession })`。
3. `withSession` 发送包含 URL + canonical plan 的 implementation prompt。
4. 新 session failure/cancel 不删除 artifact；恢复 refining boundary并通知。

**compact**（只由 `/plan` command context 调用）：

1. append inactive boundary。
2. 调用 `ctx.compact({ customInstructions, onComplete, onError })`；该 API 不返回 Promise。
3. 仅 `onComplete` 在 current session 发送包含 URL + canonical plan 的 implementation prompt；`onError` 恢复 refining 并通知。
4. success/error/stale callback使用单一 settled guard；不自动重跑 compact。

**exit**：append inactive，清 status/transient runtime；不删除历史 artifact，不触发 model。

### C4. Feature tests

使用现有 Goal feature test style 的 in-memory Pi/session harness：

- `pi.registerTool` 从未被调用；registered tools 不出现 Plan-specific name。
- commands 仅为 `plan`；`/plan`、`/plan edit`、`/plan show`、`/plan <prompt>` matrix正确。
- initial valid block append 一个 artifact、生成真实 URL、只触发一次 Ask；context 含 URL。
- agent-end Ask Refine 进入 refining；Ask Implement(new|compact) 仅持久化 requested action，且 agent-end 不调用 session actions。
- 下一次 `/plan` command 消耗 requestedAction 并调用 newSession/compact；后续 replacement block 不自动 Ask。
- Ask cancel、URL unavailable、append failure、new/compact failure 不猜测 action、不删除 artifact。
- `/plan` selector actions；Esc 返回 refining；Exit 只结束 active state。
- `/plan show` 显示 latest artifact/URL且不启动 agent。
- `agent_end` no/malformed/multiple marker 不触发 Ask。
- reload/tree/fork/session replacement/stale callback 使用 current branch 与 session guard。
- no `setActiveTools`、no `tool_call` gate、no Goal/Todo state mutation。

### C5. Phase check

```bash
bun test packages/pi-basics/test/modules/ask/integration.test.ts \
  packages/pi-basics/test/modules/plan/feature.test.ts
bunx biome check packages/pi-basics/src/modules/ask/index.ts \
  packages/pi-basics/src/modules/plan
```

## 7. Phase D：Entry、README 与 Pi smoke

### D1. Entry integration

Phase 0 找到真实 entry 后：

1. 先创建 AskFeature，再把 `ask.requestAsk` callback 注入 PlanFeature。
2. 在现有 lifecycle owner 中注册 Plan command/hooks；不建立第二个 session owner。
3. registry cleanup capture session id，stale cleanup 不清新 runtime。
4. 不改 Loadout baseline、active tools、Goal continuation、Todo state 或 Statusbar renderer。

Integration checks：

- extension startup 注册 `/plan` 但没有新增 tool。
- Plan status 能被现有 statusbar 消费。
- Ask disabled/unavailable 时 initial completion 保留 artifact，不伪造 action。

### D2. README

只记录真实 contract：

- `/plan [prompt]`、`/plan`、`/plan edit`、`/plan show`；
- canonical `<proposed_plan>` completion marker；
- initial Ask 三个 options；Refine 后手动 `/plan`；Esc 行为；
- plan URL 形式与 URL unavailable fallback；
- Implement(new)/compact 使用的 Pi session APIs；
- prompt-only permissions，明确没有 runtime sandbox，也没有新增 Plan tool。

### D3. Manual smoke

在 isolated Pi dev loadout：

1. 启动 `pi-basics`，确认 tool registration 不新增 Plan tool。
2. `/plan Inspect adding a validation rule`，确认 status 为 active。
3. 让模型只调查；输出合法 `<proposed_plan>`，确认 plan artifact、entry URL 与 initial Ask context。
4. 选 Refine，确认发送 refinement prompt；输出 replacement plan 后不再次 Ask。
5. `/plan` 打开 new/compact/exit；Esc 后仍可 refine。
6. `/plan show` 显示最新 plan + URL且不触发 turn。
7. 测试 Implement(new) 新 session；另测 Implement(compact) compaction callback 后 current session implement。
8. session reload/tree branch 后确认 latest artifact/URL恢复。
9. 在无 session file 或无 Ask UI fixture 中确认不自动猜测 action。

## 8. Final acceptance

- 全部 Plan Mode 行为不依赖新增 tool；registered tool set 与改动前相同。
- initial completion 自动 Ask 一次，context/question 含 plan URL，三个 action semantics正确。
- Refine 后不自动 Ask；`/plan` selector、`/plan edit`、`/plan show`、Esc semantics正确。
- new/compact 走 Pi 原生 session APIs；failure 不丢 artifact、不重放 ambiguous action。
- Plan content 以 custom message artifact 单一保存，state 不复制正文；URL 使用真实 session file + entry id。
- 权限仅 prompt-guided，README 不夸大为 sandbox；不修改 coordinator、Goal、Todo、Loadout policy。
- Ask existing tool contract、TUI/RPC fallback 和 lifecycle tests 全部保持通过。
