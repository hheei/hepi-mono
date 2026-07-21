# `pi-basics` Loadout 實作 TODO

> 實作依據：[`pi-basics-loadout-implementation.md`](./pi-basics-loadout-implementation.md)  
> 核心決策：[`pi-basics-loadout-plan.md`](./pi-basics-loadout-plan.md)

## 使用規則

- 依 phase 順序執行；除非明列可並行，不跳 phase。
- 每個 checkbox 完成時附上檔案、focused test 與實際輸出。
- 先寫能失敗的 observable regression test，再改實作。
- `MCP-*` 任務在取得 public MCP bridge 前保持阻塞；`pi-mcp-adapter` 2.11.0 的 proxy/directTools 不算 bridge，不以 fake production fallback 代替。
- 不修改 `packages/pi-loadout`、`pi-extcore`、Pi 安裝目錄或 sibling OMP source。
- 不動無關 dirty/untracked files。

## Phase 0｜Baseline 與 contract

### Baseline

- [ ] `BASE-01` 重新執行 `bun test packages/pi-basics/test`，記錄 baseline pass/fail。
- [ ] `BASE-02` 記錄目前 hardcoded Settings/Loadout tab tests 與 placeholder assertions。
- [ ] `BASE-03` 使用 LSP references 檢查 `createSettingsModule`、`createSettingsComponent`、`renderSettings`、`HePiModule`。
- [ ] `BASE-04` 確認 project root 使用 `ctx.cwd`，project path 為 `<ctx.cwd>/.pi/setting.json`。
- [ ] `BASE-05` 確認 Global 缺 key 與 project-only 缺 key 都預設 active。
- [ ] `BASE-06` 決定/確認 storage 跨 process conflict 策略；不得默認忽略。

### MCP placeholder contract

- [x] `MCP-01` 確認 `mcp:<name>` 只作 placeholder identity，不實作 server parent gate。
- [x] `MCP-02` 確認 placeholder 可進入 model/storage/search/render/status resolution。
- [x] `MCP-03` 確認 placeholder toggle 不讀寫 `mcp.json`。
- [x] `MCP-04` 確認 placeholder toggle 不呼叫 MCP connect/close。
- [x] `MCP-05` 確認 direct MCP tools 若已註冊，按普通 `tool:<Pi registered tool name>` 控制。
- [ ] `MCP-06` 未來另案設計 public MCP bridge、parent gate、child hide/restore。 **DEFERRED**

### Phase 0 gate

- [ ] `GATE-0` Baseline、paths、default semantics、storage conflict 已確認。
- [x] `GATE-MCP` 本階段 MCP scope 已縮減為 placeholder；不等待 public bridge。

## Phase 1｜Pure model

### Files

- [ ] `MODEL-01` 建立 `src/modules/loadout/model.ts`。
- [ ] `MODEL-02` 建立 `test/fixtures/loadout.ts`。
- [ ] `MODEL-03` 建立 `test/modules/loadout/model.test.ts`。

### Types and identity

- [ ] `MODEL-04` 定義 `LoadoutScope`、`LoadoutKind`、`LoadoutKey`。
- [ ] `MODEL-05` 定義 configured/effective/display status。
- [ ] `MODEL-06` 定義 `LoadoutItem` 與 `LoadoutResolvedItem`。
- [ ] `MODEL-07` 驗證 `mcp:`、`tool:`、`skill:` key parsing/formatting。
- [ ] `MODEL-08` 映射 `SourceInfo.scope`: user/global、project/project、temporary/project。
- [ ] `MODEL-09` 將同 kind/name 的 global/project definition 合併為同 key。
- [ ] `MODEL-10` project metadata shadow global metadata，但保留 `hasGlobalDefinition=true`。

### Status resolution

- [ ] `MODEL-11` Global missing/true -> active；false -> disabled。
- [ ] `MODEL-12` Project global-capable missing -> inherit。
- [ ] `MODEL-13` Project global-capable true/false -> explicit active/disabled。
- [ ] `MODEL-14` Project-only missing/true -> active；false -> disabled。
- [ ] `MODEL-15` Inherit + Global active -> `◎ inherit`。
- [ ] `MODEL-16` Inherit + Global disabled -> `○ disabled`，無 inherit文字。
- [ ] `MODEL-17` Global/project-only toggle 為二態。
- [ ] `MODEL-18` Project global-capable toggle 為 missing -> true -> false -> missing。
- [ ] `MODEL-19` 畫面相同的 inherited-disabled 與 explicit-disabled 仍產生不同下一 transition。

### Inventory/filter/selection

- [ ] `MODEL-20` 固定 group 順序 MCP Servers、Tools、Skills。
- [ ] `MODEL-21` disabled MCP parent 過濾 child tools，但保留 server row。
- [ ] `MODEL-22` re-enabled parent 恢復 child tools並套用 child state。
- [ ] `MODEL-23` 搜尋匹配 name/kind/origin/status/description/instruction。
- [ ] `MODEL-24` 搜尋隱藏空 group並計算 filtered/total count。
- [ ] `MODEL-25` inventory/scope/search變動時以 key 保留 selection。
- [ ] `MODEL-26` selected child消失時移到下一可見 item。
- [ ] `MODEL-27` 無結果時 selection undefined。

### Verification

- [ ] `MODEL-28` model 不 import fs、Pi API、TUI。
- [ ] `MODEL-29` 執行 `bun test packages/pi-basics/test/modules/loadout/model.test.ts`。
- [ ] `GATE-1` Pure model tests 全過。

## Phase 2｜Scope-aware storage

### Files/API

- [ ] `STORE-01` 建立 `src/modules/loadout/storage.ts`。
- [ ] `STORE-02` 建立 `test/modules/loadout/storage.test.ts`。
- [ ] `STORE-03` 定義 injectable global/project paths。
- [ ] `STORE-04` 定義 `load()` 與 `update(scope,key,value)`。
- [ ] `STORE-05` global update 拒絕 undefined；project undefined 刪 key。

### Read behavior

- [ ] `STORE-06` missing file -> 空 root/map。
- [ ] `STORE-07` parse malformed JSON 時報錯且不寫檔。
- [ ] `STORE-08` missing `pi-loadout` -> 空 map。
- [ ] `STORE-09` non-object `pi-loadout` -> 明確錯誤。
- [ ] `STORE-10` non-boolean loadout value -> 明確 key error。
- [ ] `STORE-11` preserve unknown top-level section。
- [ ] `STORE-12` preserve unknown loadout key。

### Write behavior

- [ ] `STORE-13` 每 path 建立 in-process save queue。
- [ ] `STORE-14` queue operation 內重新讀最新檔案。
- [ ] `STORE-15` read-modify-write 只改 `pi-loadout` section。
- [ ] `STORE-16` project inherit 刪除 key，不寫 marker。
- [ ] `STORE-17` parent directory 不存在時建立。
- [ ] `STORE-18` temp file 建在 target 同目錄。
- [ ] `STORE-19` JSON 使用兩格 indent與結尾 newline。
- [ ] `STORE-20` rename 原子替換 target。
- [ ] `STORE-21` write/rename failure 清理 temp並保留原 target。
- [ ] `STORE-22` tests 只使用 temp paths，不碰真實 home/project setting。

### Verification

- [ ] `STORE-23` 執行 storage focused tests。
- [ ] `GATE-2` Storage tests 全過，partial JSON 無法被觀察到。

## Phase 3｜Inventory 與 runtime adapters

### Native Pi inventory

- [ ] `INV-01` 建立 `src/modules/loadout/inventory.ts`。
- [ ] `INV-02` 建立 `test/modules/loadout/inventory.test.ts`。
- [ ] `INV-03` `pi.getAllTools()` 轉成 tool items。
- [ ] `INV-04` `pi.getCommands()` 只收 `source=skill`、`skill:` prefix。
- [ ] `INV-05` 使用 `SourceInfo` 產生 source scope/origin。
### Native runtime

- [ ] `INV-10` 由完整 resolved snapshot 計算 active tool names。
- [ ] `INV-11` 每次 apply 一次呼叫 `pi.setActiveTools()`。
- [ ] `INV-12` 保存 active skill names供 event hook 使用。
- [ ] `INV-13` 使用 `formatSkillsForPrompt()` 過濾 system prompt skills。
- [ ] `INV-14` 不重新實作 skill XML formatter。
- [ ] `INV-15` direct MCP tools 若已由 adapter 註冊，作為 `tool:<name>` 控制 active/inactive。
- [ ] `INV-16` runtime-only toggle 不寫入、不修改 `mcp.json`。
- [ ] `INV-17` proxy 模式只把 `tool:mcp` 作為整體 tool；不宣稱能控制 proxy 內 child tools。

### MCP placeholder

- [ ] `MCP-07` 建立 placeholder MCP fixture/inventory item。
- [ ] `MCP-08` 測試 placeholder storage/status/toggle，不觸碰 MCP runtime。
- [ ] `MCP-09` 驗證 direct MCP tools 走普通 native tool active-set 路徑。
- [ ] `MCP-10` 驗證 proxy 模式只控制整體 `tool:mcp`，不推導 child tools。

### Verification

- [ ] `INV-18` 執行 native inventory/runtime focused tests。
- [ ] `MCP-11` 執行 placeholder MCP focused tests。
- [ ] `GATE-3` Native inventory/runtime 通過；MCP placeholder tests 通過。

## Phase 4｜Loadout controller

### Files/state

- [ ] `CTRL-01` 建立 `src/modules/loadout/controller.ts`。
- [ ] `CTRL-02` 建立 `test/modules/loadout/controller.test.ts`。
- [ ] `CTRL-03` 定義 scope/query/selection/scroll/inventory/resolved/pending/error state。
- [ ] `CTRL-04` load 並行取得 storage與 inventory。
- [ ] `CTRL-05` load 後 resolve placeholder items、filter visible inventory、apply tools/skills。

### User state

- [ ] `CTRL-06` `setScope()` 保留 query並 reconcile selection。
- [ ] `CTRL-07` `setQuery()` 即時 filter並 reconcile selection。
- [ ] `CTRL-08` `moveSelection()` 跳過 group title。
- [ ] `CTRL-09` `setScrollTop()` clamp visible bounds。

### Toggle transaction

- [ ] `CTRL-10` 所有 toggle 經單一 serial queue。
- [ ] `CTRL-11` toggle 以 configured status 計算 next storage value。
- [ ] `CTRL-12` optimistic state 設定 `pendingKey`。
- [ ] `CTRL-13` storage failure時不呼叫 runtime adapter。
- [ ] `CTRL-14` storage成功後 apply native tool/skill runtime；placeholder MCP 不呼叫 runtime。
- [ ] `CTRL-15` placeholder item toggle 後只 reload model，不做 MCP inventory refresh。
- [ ] `CTRL-16` runtime failure時回寫 previous storage value。
- [ ] `CTRL-17` rollback成功後恢復 previous model/effective state。
- [ ] `CTRL-18` rollback failure顯示 combined error並 reload disk/runtime truth。
- [ ] `CTRL-19` success清除 pending/error。
- [ ] `CTRL-20` pending item重複 Enter不產生第二個 transition。

### Refresh/close

- [ ] `CTRL-21` 未來 runtime resource event 序列化 refresh。 **DEFERRED for MCP**
- [ ] `CTRL-22` refresh保留 scope/query/selectedKey。
- [ ] `CTRL-23` inventory item消失後 selection正確移動。
- [ ] `CTRL-24` refresh不刪除 unknown/stale storage key。
- [ ] `CTRL-25` close阻止新 toggle。
- [ ] `CTRL-26` close等待 pending toggle/refresh。
- [ ] `CTRL-27` close unsubscribe adapter listener。
- [ ] `CTRL-28` close不清除 disk state。

### Verification

- [ ] `CTRL-29` 執行 controller focused tests。
- [ ] `GATE-4` Failure/rollback/close每條路徑都有 observable test。

## Phase 5｜Loadout renderer

### Files/layout

- [ ] `RENDER-01` 建立 `src/modules/loadout/render.ts`。
- [ ] `RENDER-02` 建立 `test/modules/loadout/render.test.ts`。
- [ ] `RENDER-03` 第一版復用現有 Settings layout geometry。
- [ ] `RENDER-04` 只有實際幾何不相容時才抽通用 layout。

### Header/list

- [ ] `RENDER-05` render `✎ Global|Project · path`。
- [ ] `RENDER-06` path 過長時中間截斷並保留尾端。
- [ ] `RENDER-07` render inline search cursor。
- [ ] `RENDER-08` 固定 MCP/Tools/Skills group順序。
- [ ] `RENDER-09` group count統一為 filtered/total。
- [ ] `RENDER-10` group title不可選。
- [ ] `RENDER-11` list row固定 selection/status/name columns。
- [ ] `RENDER-12` selected long name使用 horizontal viewport。
- [ ] `RENDER-13` 只在有更多 item時顯示上下箭頭。

### Status/description

- [ ] `RENDER-14` `●` 只顯示 active。
- [ ] `RENDER-15` `◎` 只顯示 inherit + effective active。
- [ ] `RENDER-16` `○` 顯示 disabled，包括 inherited-disabled。
- [ ] `RENDER-17` inherited-disabled Description 不含 inherit字樣。
- [ ] `RENDER-18` Description summary顯示 name/kind/token count。
- [ ] `RENDER-19` Description/Instruction 固定高度 wrap + ellipsis。
- [ ] `RENDER-20` 無 description/instruction 使用規範 fallback。
- [ ] `RENDER-21` narrow mode完全隱藏 Description。

### Footer/error

- [ ] `RENDER-22` Loadout footer含 navigate/tab/toggle/scope/close。
- [ ] `RENDER-23` scope hint依目前 scope顯示 global/project。
- [ ] `RENDER-24` constrained width依 priority移除 hint。
- [ ] `RENDER-25` error顯示於 footer上方，不新增第四 status。
- [ ] `RENDER-26` pending保持 optimistic target symbol。

### Width tests

- [ ] `RENDER-27` wide 72/100/120/200 cell width invariant。
- [ ] `RENDER-28` narrow 60/48/30 cell width invariant。
- [ ] `RENDER-29` width 1..110 每行不溢出。
- [ ] `RENDER-30` ANSI/Unicode/combining/wide name不破壞對齊。
- [ ] `GATE-5` Renderer tests 全過。

## Phase 6｜Loadout component

- [ ] `COMP-01` 建立 `src/modules/loadout/component.ts`。
- [ ] `COMP-02` 建立 `test/modules/loadout/component.test.ts`。
- [ ] `COMP-03` `Tab` 只切 Global/Project。
- [ ] `COMP-04` `↑/↓` 只移動可選 item。
- [ ] `COMP-05` `Enter` 呼叫 controller toggle。
- [ ] `COMP-06` printable input更新 search。
- [ ] `COMP-07` Backspace更新 search。
- [ ] `COMP-08` 不攔截 `←/→`。
- [ ] `COMP-09` 不攔截 `Esc`。
- [ ] `COMP-10` pending時忽略重複 Enter。
- [ ] `COMP-11` inventory refresh後 requestRender。
- [ ] `COMP-12` invalidate觸發 serialized refresh。
- [ ] `COMP-13` 執行 component focused tests。
- [ ] `GATE-6` Input routing 無 domain transition duplication。

## Phase 7｜Shared shell

### Tab renderer/shell

- [ ] `SHELL-01` 新增 `src/ui/tabs.ts`。
- [ ] `SHELL-02` 從 Settings render搬移 tab bar renderer。
- [ ] `SHELL-03` 新增 `src/modules/shell/component.ts`。
- [ ] `SHELL-04` 新增 `src/modules/shell/index.ts`。
- [ ] `SHELL-05` shell唯一保存 active tab。
- [ ] `SHELL-06` `←/→` 只切 Settings/Loadout。
- [ ] `SHELL-07` `Esc` 只由 shell close一次。
- [ ] `SHELL-08` shell delegated input不重送 intercepted key。
- [ ] `SHELL-09` tab切換保留 Settings state。
- [ ] `SHELL-10` tab切換保留 Loadout scope/query/selection。

### Settings cutover

- [ ] `SHELL-11` 移除 Settings component local `activeTab`。
- [ ] `SHELL-12` 移除 Settings `switchMainTab()`。
- [ ] `SHELL-13` Settings 不再攔截 left/right/Tab/Shift+Tab。
- [ ] `SHELL-14` Settings render不再輸出 hardcoded tab header。
- [ ] `SHELL-15` 移除 `Loadout is not implemented.` placeholder。
- [ ] `SHELL-16` Settings footer與 edit behavior保持不變。

### Module contract

- [ ] `SHELL-17` internal shell module commands為 `setting`、`loadout`。
- [ ] `SHELL-18` `/hepi setting` initial tab settings。
- [ ] `SHELL-19` `/hepi loadout` initial tab loadout。
- [ ] `SHELL-20` 不修改 public `HePiModule` interface。
- [ ] `SHELL-21` 保留 public `createSettingsModule()` standalone behavior。

### Tests

- [ ] `SHELL-22` 新增 shell component tests。
- [ ] `SHELL-23` 更新 Settings component tests移除 Tab切 main tab expectation。
- [ ] `SHELL-24` 更新 render tests由 shell驗證 tab geometry。
- [ ] `SHELL-25` Settings 既有 regression tests全過。
- [ ] `GATE-7` `←/→` 與 Loadout `Tab` contract有獨立 tests。

## Phase 8｜Root、lifecycle、events

- [ ] `ROOT-01` `src/index.ts` 建立 Settings/Loadout factories。
- [ ] `ROOT-02` built-in runtime只註冊 shared shell module。
- [ ] `ROOT-03` 註冊 Settings controller cleanup。
- [ ] `ROOT-04` 註冊 Loadout controller cleanup。
- [ ] `ROOT-05` session replacement不洩漏 MCP listener。
- [ ] `ROOT-06` `before_agent_start`套用 current active skills。
- [ ] `ROOT-07` session shutdown等待 pending loadout operation。
- [ ] `ROOT-08` 非 TUI guard仍在 `/hepi` dispatcher，module不建立 component。
- [ ] `ROOT-09` duplicate/unknown command行為不變。
- [ ] `ROOT-10` integration test `/hepi setting` initial tab。
- [ ] `ROOT-11` integration test `/hepi loadout` initial tab。
- [ ] `ROOT-12` integration test左右切 tab不重建 controllers。
- [ ] `ROOT-13` integration test shutdown flush/unsubscribe。
- [ ] `GATE-8` Root/lifecycle integration tests全過。

## Phase 9｜Verification

### Automated

- [ ] `VERIFY-01` `bun test packages/pi-basics/test/modules/loadout`。
- [ ] `VERIFY-02` `bun test packages/pi-basics/test/modules/shell packages/pi-basics/test/modules/setting`。
- [ ] `VERIFY-03` `bun test packages/pi-basics/test`。
- [ ] `VERIFY-04` `bun run typecheck`。
- [ ] `VERIFY-05` `bun run check`。

### Runtime smoke

- [ ] `SMOKE-01` `bun run pi:dev -- basics` 正常啟動。
- [ ] `SMOKE-02` `/hepi setting` 開 Settings tab。
- [ ] `SMOKE-03` `/hepi loadout` 開 Loadout tab。
- [ ] `SMOKE-04` `←/→` 切 tab，state不丟失。
- [ ] `SMOKE-05` Loadout `Tab` 切 Global/Project。
- [ ] `SMOKE-06` Global toggle寫 global file。
- [ ] `SMOKE-07` Project三態循環寫 true/false/delete。
- [ ] `SMOKE-08` inherit + global disabled顯示與 explicit disabled一致。
- [ ] `SMOKE-09` 約 120 cols wide layout正常。
- [ ] `SMOKE-10` 60x30 narrow layout正常。
- [ ] `SMOKE-11` MCP placeholder toggle 不修改 `mcp.json`。
- [ ] `SMOKE-12` direct MCP native tool 可 inactive/active，若 adapter 已註冊該 tool。
- [ ] `SMOKE-13` proxy 模式只驗證整體 `tool:mcp`，不驗證 child server/tool。
### Data safety

- [ ] `SAFE-01` 真實 setting.json 其他 section 未被覆蓋。
- [ ] `SAFE-02` malformed JSON 不被自動修復/覆蓋。
- [ ] `SAFE-03` save failure UI rollback 有實機證據。
- [ ] `SAFE-04` MCP runtime failure + storage rollback。 **DEFERRED：本階段不做 MCP runtime 操作**

## Phase 10｜最後同步

- [ ] `DOC-01` 更新 `packages/pi-basics/README.md`：`/hepi loadout`、keys、paths、scope。
- [ ] `DOC-02` 更新主計畫狀態與已完成 phase。
- [ ] `DOC-03` 在本 checklist 每個完成項附證據。
- [ ] `DOC-04` 記錄未驗證 terminal/MCP限制。
- [ ] `DOC-05` 確認沒有修改 `packages/pi-loadout`、`pi-extcore` 或 Pi core。
- [ ] `DOC-06` 確認沒有 fake fallback；MCP placeholder 只限於明確記錄的 placeholder contract。
- [ ] `DONE` 所有 gates、automated checks、runtime smoke與 MCP acceptance有證據。

## 阻塞記錄模板

```text
Task:
Blocked by:
Evidence/path:
What was tried:
Decision needed:
Unblocked when:
```

## 完成證據模板

```text
Task:
Changed files:
Observable behavior:
Focused command:
Result:
Runtime smoke:
Remaining risk:
```
