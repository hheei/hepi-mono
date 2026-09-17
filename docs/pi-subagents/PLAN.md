# Pi Subagent Extension — Development Specification

## 1. Project Goal

實作一個 Pi subagent extension，讓主 Pi 可以建立及管理多個真正獨立的 Pi child sessions。

核心使用方式：

```text
Main Pi
  │
  ├── spawn child A → RPC background
  ├── spawn child B → RPC background
  └── spawn child C → RPC background

User wants to inspect B
  │
  ▼
attach
  │
  ▼
B opens as native Pi TUI in Herdr/cmux

User exits B TUI
  │
  ▼
detach
  │
  ▼
B continues in RPC background
```

本 extension 不是 workflow engine，也不是自製 multi-agent UI。

它的核心職責只有：

```text
subagent lifecycle
+
Pi session continuity
+
RPC ↔ native TUI switching
+
parent ↔ child communication
+
minimal recovery
```

---

# 2. Core Design Principle

最重要的抽象是：

> **Subagent 的 identity 是 Pi session，而不是 process、RPC connection 或 terminal pane。**

因此：

```text
RPC process A
     │
     │ attach
     ▼
TUI process B
     │
     │ detach
     ▼
RPC process C
```

只要使用同一個：

```text
Subagent ID
+
Pi Session
```

它們就是同一個 logical subagent。

原設計已明確要求 session 負責 identity、persistence、conversation continuity 與 RPC/TUI handoff，而不是 realtime IPC。

---

# 3. What This Project Is Not

第一版不要發展成完整 orchestration framework。

明確不做：

```text
custom transcript viewer
Fleet inspector
workflow DSL
workflowScript
mission system
scheduler
review-loop engine
council
task DAG
planner hierarchy
cost-based interruption
automatic worktree management
terminal screen scraping
large lifecycle event ledger
```

也不要重新實作 Pi：

```text
TUI
session system
RPC protocol
streaming renderer
conversation storage
```

能直接使用 Pi / Herdr / cmux primitive 的地方，就直接使用。

---

# 4. Architecture

整體架構：

```text
                         Main Pi
                            │
                    Stable Subagent API
                            │
                     SubagentManager
                    /        |        \
                   /         |         \
                  ▼          ▼          ▼
           RuntimeController │       Registry
             /        \      │
            /          \     │
       RpcRuntime    TuiRuntime
                        │
                   HostAdapter
                   /         \
                Herdr        cmux

                   ParentChannel
                    ▲       │
                    │       ▼
                  child ↔ parent

                Shared Pi Session
```

核心 module 建議：

```text
src/
├── manager/
│   └── subagent-manager.ts
│
├── runtime/
│   ├── rpc-runtime.ts
│   ├── tui-runtime.ts
│   └── runtime-controller.ts
│
├── hosts/
│   ├── host-adapter.ts
│   ├── herdr.ts
│   └── cmux.ts
│
├── communication/
│   └── parent-channel.ts
│
├── agents/
│   ├── discovery.ts
│   └── definitions.ts
│
├── registry/
│   └── registry.ts
│
└── extension.ts
```

實際 file split 可以根據實作簡化，不要求機械地照此結構。

---

# 5. Execution Mode and Presentation Host

這兩個概念必須分開。

## Execution mode

```ts
type ExecutionMode = "rpc" | "tui";
```

### RPC

用途：

```text
background execution
machine-readable control
prompt
steer
follow-up
status
abort
```

正常 subagent 預設在 RPC mode。

---

### TUI

用途：

```text
human inspection
human intervention
native transcript
native Pi editor
native tool rendering
native shortcuts
```

TUI 必須使用真正的：

```bash
pi --session <same-session>
```

不要自己 render child conversation。

---

## Presentation host

```ts
type HostKind = "herdr" | "cmux";
```

Presentation host 只在：

```text
mode = tui
```

時有意義。

正常組合：

```text
RPC
mode = rpc
host = none

TUI
mode = tui
host = herdr | cmux
```

不要設計：

```ts
backend = "rpc" | "herdr" | "cmux";
```

因為 Herdr/cmux 並不是 agent execution backend。

原設計對 execution mode 與 presentation host 的區分已有相同要求。

---

# 6. Subagent Data Model

持久資料保持最小。

```ts
interface SubagentRecord {
  id: string;

  sessionId: string;
  sessionPath?: string;

  cwd: string;

  state:
    | "starting"
    | "running"
    | "idle"
    | "done"
    | "stopped"
    | "failed";

  mode: "rpc" | "tui";

  agent?: string;

  createdAt: number;

  usage?: UsageSummary;
}
```

Usage：

```ts
interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  turns?: number;
}
```

不要把以下資訊視為 durable identity：

```text
PID
RPC connection
Herdr pane ID
cmux surface ID
socket handle
```

這些都是 runtime attachment。

可以存在 memory 中：

```ts
interface RuntimeState {
  process?: ChildProcess;
  rpc?: RpcClient;

  attachment?: {
    host: "herdr" | "cmux";
    id: string;
  };
}
```

但不需要依賴它們進行跨 restart recovery。

---

# 7. Persistent Registry

不要另外維護：

```text
events.jsonl
lifecycle ledger
process history
handoff history
```

Pi session 已經保存真正重要的 conversation state。

Extension 只需要知道：

```text
有哪些 subagents
每個對應哪個 Pi session
是否仍應保持 active
目前是 RPC 還是 TUI
```

因此 persistence 可以非常小。

優先使用 Pi 已有 extension/session persistence primitive；不要先建立自己的 database。

概念上只需要：

```text
Subagent registry
```

而不是：

```text
Subagent event store
```

---

# 8. Parent-facing Tool API

主 agent 只應看到少量 semantic tools。

建議：

```text
spawn_subagent
send_subagent
get_subagent
list_subagents
stop_subagent
```

之後如果發現：

```text
get_subagent
list_subagents
```

可以自然合併，也可以再收斂。

---

## 8.1 No `spawn_subagents`

不要建立：

```text
spawn_subagents([...])
```

Pi 本身已支援 parallel tool calls。

需要三個 children 時，主 agent 在同一輪直接：

```text
spawn_subagent(task=A)
spawn_subagent(task=B)
spawn_subagent(task=C)
```

由 Pi 的 parallel tool execution 處理。

因此：

> **parallelism 是 orchestration behavior，不是 runtime API。**

這是一個重要設計邊界。

---

# 9. `spawn_subagent`

Model-facing schema 應保持很小。

概念：

```ts
spawn_subagent({
  task: string,
  agent?: string,
  cwd?: string
})
```

不要讓 LLM 每次都選：

```text
model
thinking
max_tokens
max_turns
extensions
skills
tool allowlist
```

這些應主要由 agent definition / config 決定。

---

# 10. Agent Definitions

Agent definition 可以直接採用目前 Pi subagent 生態已經形成的模式。

Discovery：

```text
.pi/agents/*.md
.agents/agents/*.md
~/.pi/agent/agents/*.md
```

Agent file：

```markdown
---
name: reviewer
description: Review code for correctness and unnecessary complexity
model: openai/gpt-...
thinking: high
tools:
  - read
  - grep
  - bash
extensions: false
skills: false
max_turns: 40
---

Review the requested change...
```

建議支援：

```text
name
display_name
description

model
thinking

tools
exclude_tools

extensions
exclude_extensions

skills
preload_skills

max_turns
max_tokens

hidden
```

基本語義可以盡量與：

```text
pi-subagents-lite
pi-subagents
```

保持一致，避免再創一套 agent definition dialect。

---

# 11. Model and Tool Resolution

核心原則：

> **Agent runtime configuration 與 model-facing tool parameters 分離。**

例如：

```text
reviewer.md
    ↓
model = strong model
thinking = high
tools = read/grep/bash
```

主 Pi 只需要：

```text
spawn_subagent(
  agent = reviewer,
  task = ...
)
```

而不是：

```text
spawn_subagent(
  task,
  model,
  thinking,
  max_tokens,
  max_turns,
  tools,
  ...
)
```

這能：

```text
減少 tool schema
減少 token overhead
避免主 agent 隨意改 runtime policy
讓 agent definition 可重用
```

---

# 12. Parent → Child Communication

Parent 必須可以主動控制 child。

至少支援：

```text
steer
follow-up
status
latest summary
```

`send_subagent` 可以作為 semantic wrapper。

例如：

```ts
send_subagent({
  id,
  message,
  mode?: "steer" | "follow_up" | "auto"
})
```

第一版如果希望更簡單，可以只暴露：

```text
message
```

backend 根據 child 當前狀態決定：

```text
running → steer / queue
idle    → prompt/follow-up
```

---

## Parent steering 的目的

不是讓 parent 不斷 micromanage child。

而是當：

```text
child misunderstood task
child starts exploring wrong direction
new information changes task
parent needs clarification incorporated
```

時可以修正。

---

# 13. Child → Parent Communication

Child 需要一個獨立 semantic capability。

名稱建議：

```text
contact_parent
```

比 `report_to_parent` 更一般。

例如：

```ts
contact_parent({
  reason:
    | "progress_update"
    | "important_finding"
    | "need_decision"
    | "blocked",

  message: string
})
```

不要把這個能力綁定：

```text
RPC
TUI
Herdr
cmux
```

它是 subagent capability。

---

# 14. Parent Reply

當 child：

```text
contact_parent({
  reason: "need_decision",
  message: "Should I change API X or preserve compatibility?"
})
```

Parent 可以：

```text
send_subagent(...)
```

回覆同一個 child。

不一定需要額外：

```text
reply_parent_request
```

tool。

如果日後需要 correlated request/reply，再增加 request ID。

第一版保持：

```text
child reports
parent may steer/reply
```

即可。

---

# 15. Parent Channel

ParentChannel 負責跨 process communication。

它不應依賴：

```text
terminal screen
cmux read-screen
Herdr pane output
session JSONL polling
```

概念：

```text
Child Pi
  │
  │ contact_parent()
  ▼
ParentChannel
  │
  ▼
Main Pi extension
```

transport 可以是：

```text
Unix socket
local IPC
other simple cross-process transport
```

具體 transport 由實作者選擇。

要求：

```text
child 只能找到自己的 parent
message 必須帶 child identity
不同 parent Pi sessions 不應互相串線
```

---

# 16. Runtime Lifecycle

正常 lifecycle：

```text
spawn
  │
  ▼
RPC
  │
  ├── background work
  │
  ├── parent steer
  │
  ├── child report
  │
  │
  └── attach
        │
        ▼
       TUI
        │
        ├── human interacts directly
        │
        └── exit
             │
             ▼
           detach
             │
             ▼
            RPC
```

唯一真正終止 agent 的操作是：

```text
stop
```

---

# 17. Attach

Attach 是：

```text
RPC → native Pi TUI
```

流程：

```text
user selects child
       │
       ▼
press attach shortcut
       │
       ▼
mark attach requested
       │
       ▼
wait safe boundary
       │
       ▼
shutdown RPC runtime
       │
       ▼
HostAdapter.attach()
       │
       ▼
pi --session <same-session>
       │
       ▼
native Pi TUI
```

---

# 18. Safe Attach Boundary

不要在 child 正在一半 tool execution 時直接切。

優先等待：

```text
turn_end
```

也就是完成目前 semantic turn：

```text
assistant response
    ↓
tool calls
    ↓
tool results
    ↓
remaining assistant response
    ↓
turn_end
```

之後再：

```text
RPC stop
→ native TUI start
```

這和原設計的 safe handoff 原則一致。

第一版不需要 configurable：

```text
turn / settled
```

除非實作後發現 `turn_end` 不足夠。

先選最簡單可行的 semantic boundary。

---

# 19. Native TUI

Attach 後必須直接啟動：

```bash
pi --session <same-session>
```

不要實作：

```text
custom transcript viewer
custom Pi renderer
RPC event mirror
fake child editor
```

原因：

Pi native TUI 已經處理：

```text
transcript
thinking
tool rendering
markdown
editor
autocomplete
commands
history
shortcuts
```

原文檔也明確要求 native UI 保持 native，而不是複製 Pi TUI。

---

# 20. Detach

Detach 定義為：

```text
TUI → RPC
```

在 child native Pi TUI 中，使用者正常退出：

```text
/quit
/exit
Ctrl+D
Pi 原生 Ctrl+C exit behavior
```

都視為：

> **detach**

而不是 stop。

流程：

```text
Pi TUI process exits
        │
        ▼
child still marked active
        │
        ▼
same session
        │
        ▼
start RPC
```

---

# 21. Closing the Pane

如果使用者直接：

```text
close cmux pane
close Herdr pane
```

導致 child Pi TUI process 結束：

```text
TUI process exited
       │
       ▼
child != stopped
       │
       ▼
detach
       │
       ▼
RPC resumes
```

這不是：

```text
fallback
error recovery
unexpected special state
```

而是正常 detach semantic。

因此不需要：

```text
desiredMode
actualMode
fallbackMode
attachmentLost
```

等細分 state。

---

# 22. Stop

Stop 與 detach 必須嚴格不同。

## Detach

由 child TUI 自己退出：

```text
TUI → RPC
```

child 還活著。

---

## Stop

由 parent 明確觸發：

```text
RPC/TUI → stopped
```

child 不再執行。

建議主要 UX 是：

```text
Main Pi
  │
select subagent
  │
press stop shortcut
  │
  ▼
stop child
```

可以同時保留：

```text
stop_subagent
```

給 main agent 使用。

---

# 23. Stop Ordering

一定要：

```text
1. mark stopped
2. terminate runtime
```

不要：

```text
1. kill TUI
2. then mark stopped
```

否則 process-exit handler 可能把它當 detach，又重新啟動 RPC。

正確：

```text
record.state = stopped
      │
      ▼
terminate RPC/TUI
      │
      ▼
exit handler sees stopped
      │
      ▼
do nothing
```

---

# 24. Unexpected Runtime Exit

## TUI exits

只要：

```text
state != stopped
```

統一：

```text
detach → RPC
```

包括：

```text
normal /quit
Ctrl+D
pane closed
TUI crash
host closed pane
```

---

## RPC exits unexpectedly

如果 child：

```text
state == running | idle
```

而 RPC process 意外消失：

```text
resume same Pi session in RPC
```

不要嘗試恢復舊 PID/process。

---

# 25. Main Pi Restart

Recovery 保持 minimum。

Main Pi 重開：

```text
load persisted registry
       │
       ▼
find active child records
       │
       ▼
verify session exists
       │
       ▼
start same session in RPC
```

全部 active children 都先恢復為：

```text
RPC
```

不要自動重開 TUI pane。

這樣：

```text
Main Pi restart
→ children return to background
```

行為 deterministic。

---

# 26. Extension Reload

Extension reload 同樣處理：

```text
load registry
→ active children
→ restore RPC
```

不要維護：

```text
old process topology
old pane topology
old TUI attachment topology
```

session 才是 durable state。

---

# 27. Recovery Principle

整個 recovery 可以概括成：

```text
Pi session
    = durable conversation

Subagent registry
    = durable child identity/state

process / pane
    = disposable runtime attachment
```

這是所有 recovery 邏輯的基礎。

---

# 28. Host Adapter

Host adapter 只負責：

```text
can I open a native TUI here?
open it
observe when attachment ends
optionally close it
```

interface 可以非常小：

```ts
interface HostAdapter {
  readonly kind: "herdr" | "cmux";

  available(): boolean;

  attach(options: {
    session: SessionRef;
    cwd: string;
    title?: string;
  }): Promise<HostAttachment>;
}
```

```ts
interface HostAttachment {
  id: string;
  host: "herdr" | "cmux";
}
```

必要時：

```ts
detach?(attachment: HostAttachment): Promise<void>;
```

---

# 29. Herdr

Herdr 是較 agent-aware 的 host。

Adapter 可以使用 Herdr：

```text
workspace
tab
pane
agent state
socket/CLI
```

但 core 不要依賴 Herdr-specific semantics。

Core 只應看到：

```text
host.attach(session)
```

---

# 30. cmux

cmux 更接近 terminal workspace primitive。

Adapter 可以使用：

```text
workspace
pane
surface
terminal launch
```

但同樣：

```text
SubagentManager
```

不應理解：

```text
CMUX_SURFACE_ID
workspace ref
pane layout
surface routing
```

這些全部藏在 adapter。

---

# 31. Host Selection

預設：

```text
Herdr
  ↓
cmux
  ↓
none
```

或者 config：

```json
{
  "hostPreference": ["herdr", "cmux"]
}
```

如果沒有可用 host：

```text
attach shortcut disabled
```

不要：

```text
spawn random terminal
open system Terminal.app
invent third fallback UI
```

---

# 32. Human Shortcuts

至少考慮兩個 human actions：

```text
attach selected subagent
stop selected subagent
```

Attach：

```text
RPC → TUI
```

Stop：

```text
RPC/TUI → stopped
```

快捷鍵具體值不要硬編進 architecture，可由 Pi extension keybinding/config 處理。

---

# 33. Status

Parent 應可以查：

```text
agent type
state
mode
task/description
latest summary
usage
elapsed time
```

例如：

```text
worker-3
running · rpc
"Implement parser refactor"
12 turns · 42k input · 6k output
latest: updating tests after parser change
```

不要把 internal runtime state 全部暴露給 LLM：

```text
RPC_STOPPING
TUI_STARTING
HANDOFF_PENDING
socket reconnecting
pane allocation
```

這些只是 implementation detail。

---

# 34. Latest Summary

`get_subagent` 可以返回：

```text
state
current/last known activity
latest meaningful report
latest assistant summary/output tail
usage
```

目的：

> 讓 parent 可以了解 child 在做什麼，而不用 terminal scraping。

優先使用 Pi semantic/session/RPC information。

不要讀 terminal screen 來生成 status。

---

# 35. Usage / Cost Tracking

記錄：

```text
input tokens
output tokens
cache read
cache write
cost
turns
```

用途：

```text
observability
debugging
model comparison
finding abnormal context usage
UI stats
```

明確不做：

```text
stop if cost > X
stop if token count > X
automatically downgrade model
automatically interrupt long child
```

> **Cost metadata is observational only.**

主 agent 不應因為某個 child 「看起來跑太久」就被 framework 自動殺掉。

---

# 36. Concurrency

不要自己發明 orchestration-level parallel API。

Pi 已經可以 parallel tool call：

```text
spawn_subagent(A)
spawn_subagent(B)
spawn_subagent(C)
```

Runtime 只需要正確支援：

```text
multiple simultaneously active SubagentRecord
multiple RpcRuntime instances
independent sessions
independent ParentChannel identities
```

如果需要 concurrency cap，可以後續作為 runtime safety/config feature。

但不要因此建立：

```text
parallel workflow
batch run
runs.all
```

等更高階 abstraction。

---

# 37. Worktree

資料模型可以預留：

```text
cwd
worktreePath
```

但第一版：

> **不實作 managed worktree isolation。**

不要自動：

```text
create branch
create worktree
apply patch
remove worktree
manage ownership
```

未來有明確需求再加入。

---

# 38. Streaming

Subagent manager 不需要 token relay。

RPC streaming：

```text
RPC runtime internal concern
```

TUI streaming：

```text
Pi native TUI concern
```

Manager 需要知道的是：

```text
turn completed
agent state
tool activity
latest report
usage
completion
```

不要建立：

```text
partial transcript synchronization
token stream multiplexer
custom streaming renderer
```

---

# 39. Terminal Scraping

禁止把：

```text
cmux read-screen
Herdr pane read
```

當核心 agent protocol。

可以作：

```text
debugging
diagnostics
host compatibility
```

但不應用來：

```text
determine child semantic state
extract result
build parent report
reconstruct session
```

原設計同樣明確把 screen scraping 排除在核心 protocol 之外。

---

# 40. Suggested State Machine

只需要相對簡單：

```text
                 spawn
                   │
                   ▼
               STARTING
                   │
                   ▼
                 RPC
                /   \
               /     \
          attach      complete
             │           │
             ▼           ▼
            TUI         DONE
             │
           detach
             │
             ▼
            RPC
```

任何 active runtime：

```text
parent stop
    │
    ▼
 STOPPED
```

Failure：

```text
RPC unexpected exit
→ restart RPC if active session is recoverable

TUI exit
→ detach → RPC
```

不需要把每個 transition 暴露成 public enum。

---

# 41. Public State

建議：

```ts
type SubagentState =
  | "starting"
  | "running"
  | "idle"
  | "done"
  | "stopped"
  | "failed";
```

Mode 單獨：

```ts
type ExecutionMode =
  | "rpc"
  | "tui";
```

不要創建：

```text
detached
fallback
handoff_pending
rpc_recovering
tui_lost
```

除非未來真的出現需要 user-facing differentiation 的情況。

---

# 42. RuntimeController

主要 orchestration logic 集中在：

```ts
class RuntimeController {
  spawn(...)
  send(...)
  stop(...)

  attach(...)
  detach(...)

  recover(...)
}
```

其中：

```text
spawn
→ create session/runtime

send
→ semantic child input

attach
→ RPC → TUI

detach
→ TUI → RPC

stop
→ mark stopped + terminate

recover
→ active session → RPC
```

---

# 43. RpcRuntime Responsibilities

負責：

```text
launch Pi RPC
connect RPC client
prompt
steer
follow-up
abort
observe turn lifecycle
observe child state
collect usage
shutdown cleanly
```

不負責：

```text
pane creation
native UI
parent reporting policy
agent definition discovery
persistent registry
```

---

# 44. TuiRuntime Responsibilities

負責：

```text
select HostAdapter
launch native Pi on same session
observe process/attachment end
convert TUI exit into detach
```

不負責：

```text
parse transcript
mirror output
derive semantic result from screen
```

---

# 45. ParentChannel Responsibilities

負責：

```text
child → parent reports
parent identity isolation
message delivery
optional parent → child coordination support
```

它和：

```text
RpcRuntime
TuiRuntime
Herdr
cmux
```

全部解耦。

---

# 46. Agent Definition Resolver

負責：

```text
discover .md definitions
resolve precedence
parse frontmatter
resolve effective model
resolve thinking
resolve tools/extensions/skills
validate config
```

不要讓 `spawn_subagent` 自己包含大量 config resolution logic。

---

# 47. Recommended First Version

## Phase 1 — Core RPC

完成：

```text
agent definitions
spawn_subagent
get_subagent
list_subagents
send_subagent
stop_subagent

RPC runtime
Pi session persistence
minimal registry

usage/cost tracking
child → parent communication
parent steering
```

Acceptance：

```text
Main Pi can launch several child sessions concurrently.
Each runs independently.
Parent can inspect state.
Parent can steer.
Child can contact parent.
Parent can stop a child.
```

---

## Phase 2 — Recovery

完成：

```text
main Pi restart recovery
extension reload recovery
RPC crash recovery
```

Acceptance：

```text
Active child session survives parent restart conceptually.
New RPC process resumes same session.
Stopped children never restart.
```

---

## Phase 3 — Native TUI Attach

完成：

```text
Herdr detection
cmux detection
HostAdapter

attach shortcut
RPC → TUI handoff
safe turn boundary
```

Acceptance：

```text
User selects background child.
Press attach.
Same Pi session opens as native Pi TUI.
Conversation remains continuous.
```

---

## Phase 4 — Detach

完成：

```text
TUI process exit detection
/quit / exit / Ctrl+D semantics
pane closure
TUI crash handling
TUI → RPC
```

Acceptance：

```text
Exiting child TUI never kills logical subagent.
Same session resumes as RPC automatically.
```

---

## Phase 5 — UX Refinement

考慮：

```text
compact subagent status widget
agent picker
usage display
notifications
better latest-summary display
host-specific polish
```

不要在前面 phases 完成之前先做 dashboard。

---

# 48. Acceptance Scenarios

## Scenario A — Normal background child

```text
Main asks worker to investigate bug
→ spawn_subagent
→ child runs RPC
→ reports important finding
→ completes
```

Expected：

```text
no terminal pane required
parent remains usable
result/session retained
usage recorded
```

---

## Scenario B — Parallel children

```text
Main emits three spawn_subagent tool calls in parallel
```

Expected：

```text
3 independent Pi sessions
3 independent RPC runtimes
no special batch API
```

---

## Scenario C — Human inspection

```text
child is running in RPC
user selects it
press attach
```

Expected：

```text
wait safe boundary
RPC exits cleanly
native Pi TUI opens
same session continues
```

---

## Scenario D — Normal child exit

Inside child TUI:

```text
/quit
```

Expected：

```text
TUI closes
child remains active
same session resumes in RPC
```

---

## Scenario E — Pane closed

User closes cmux/Herdr pane.

Expected：

```text
TUI process ends
treated as detach
same session resumes RPC
```

---

## Scenario F — Parent stop

User selects child in main Pi and presses stop shortcut.

Expected：

```text
mark stopped first
terminate child runtime
do not restart
```

---

## Scenario G — Main Pi restart

```text
Main Pi crashes/restarts
```

Expected：

```text
registry reloads
active persisted child sessions discovered
children restart in RPC
no automatic TUI reopening
```

---

## Scenario H — RPC crash

```text
child RPC process unexpectedly dies
```

Expected：

```text
if child active:
    resume same session in new RPC process

if child stopped:
    do nothing
```

---

# 49. Explicit Non-Goals for V1

Do not add these unless a concrete requirement appears:

```text
managed worktrees
nested subagent delegation
workflow engine
missions
schedules
automatic reviewer
council
cost budgets
automatic kill policies
custom transcript viewer
screen scraping
full lifecycle event archive
distributed/remote agents
```

---

# 50. Implementation Heuristics

When implementing a feature, ask in this order:

### 1.

Can Pi already provide it through:

```text
session
RPC
AgentSession
extension API
lifecycle events
```

If yes, use Pi.

### 2.

Is it purely terminal presentation?

Use:

```text
Herdr
cmux
```

through HostAdapter.

### 3.

Is it parent/child semantic communication?

Use:

```text
ParentChannel
```

not terminal IPC.

### 4.

Is it durable conversation state?

Use:

```text
Pi session
```

not custom event storage.

### 5.

Is it only runtime attachment state?

Keep it ephemeral.

---

# 51. Final Mental Model

實作者應該始終以這張圖理解系統：

```text
                         Main Pi
                            │
                     subagent tools
                            │
                     SubagentManager
                            │
                     logical child
                            │
                       Pi Session
                      /          \
                     /            \
             background          visible
                 RPC               TUI
                                    │
                               HostAdapter
                               /         \
                            Herdr        cmux
```

Communication：

```text
Main Pi
   │
   │ steer / send
   ▼
Subagent

Subagent
   │
   │ contact_parent
   ▼
Main Pi
```

Lifecycle：

```text
spawn
  ↓
RPC
  ↓ attach
TUI
  ↓ exit / pane close
detach
  ↓
RPC

parent stop
  ↓
STOPPED
```

Persistence：

```text
Pi session
    = conversation

registry
    = child identity/state

process/pane
    = disposable attachment
```

Parallelism：

```text
Pi parallel tool calling
    ↓
spawn_subagent × N
```

而不是：

```text
spawn_subagents
parallel workflow API
```

---

# 52. One-Sentence Product Definition

> **A Pi extension that manages multiple persistent child Pi sessions, runs them efficiently in background RPC mode, and lets the user attach any child as a real native Pi TUI without changing that child's identity or conversation.**

這一句應該成為所有實作取捨的基準。
