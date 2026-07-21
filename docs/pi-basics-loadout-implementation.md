# `pi-basics` Loadout 逐步實作參考

> 主計畫：[`pi-basics-loadout-plan.md`](./pi-basics-loadout-plan.md)  
> 執行清單：[`pi-basics-loadout-todo.md`](./pi-basics-loadout-todo.md)  
> UI 規範：[`loadout_tui_design_language.md`](./loadout_tui_design_language.md)  
> MCP 參考實作：[nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)

## 1. 文件用途

本文件把已確認的 Loadout 設計拆成可依序實作、測試及驗收的工作。每一步都列出目標檔案、行為、測試與停止條件。

這不是現有 `packages/pi-loadout` 的搬運工作。實作位置是 `packages/pi-basics`，但可參考舊 package 的工具/skill discovery 與 runtime filtering 行為；不得 import `pi-loadout` 或 `pi-extcore`。

## 2. 最新 baseline

目前已確認：

- `packages/pi-basics` package tests：59 pass，0 fail。
- Settings component 已硬編碼 `[⚙ Settings] [⏣ Loadout]` 視覺 tab。
- Loadout tab 目前只顯示 `Loadout is not implemented.`。
- `←`、`→`、`Tab`、`Shift+Tab` 目前全部切 module tab。
- Settings controller 已有 save queue、optimistic rollback、pending-save flush 與 aggregate cleanup。
- 現有 global/project storage factory 只是 backend pass-through，不能直接承載新格式。
- `HePiModule` 仍是 `open()` command contract，不是可嵌入 shell 的 view contract。

實作前不得破壞現有 Settings 行為與 59 個測試。

## 2.1 pi-mcp-adapter 研究結論

研究版本：`pi-mcp-adapter` 2.11.0，入口 `index.ts`；其 package manifest 宣告 peer `@earendil-works/pi-coding-agent`，但 package 本身不是可供其他 extension 注入的 MCP manager API。

已確認行為：

- 預設只向 Pi 註冊一個 `mcp` proxy tool；`tool-registrar.ts` 明確寫明 MCP tools 不直接註冊。
- `directTools` 才會把 cache/config 解析出的特定 MCP tools 在 extension load 時註冊成 Pi tools；這不是 runtime server enable/disable API。
- adapter 內部 `McpServerManager` 有 `connect(name, definition)`、`close(name)`、`closeAll()`、`getConnection()`、`getAllConnections()`，但這些 state 被 `index.ts` closure 持有，沒有 export 給 `pi-basics`。
- `McpLifecycleManager` 只提供 reconnect/idle shutdown callback；沒有通用 inventory-changed subscription。
- `/mcp` panel 的 toggle 是調整 server 的 `directTools`（all/none/subset），不是啟用/停用 MCP server，也不是 `mcp:<server>` loadout state。
- adapter 讀取/合併的 MCP config 是 `~/.config/mcp/mcp.json`、Pi agent dir `mcp.json`、`.mcp.json`、`.pi/mcp.json`；優先序為 shared global、Pi global、shared project、Pi project。它不是 `setting.json` storage。
- adapter 的 config writer 使用 temp file + rename，且會保留未修改欄位；這可作 atomic JSON write 參考，但不能直接共用，因為 Loadout 需要另一個 `pi-loadout` section contract。
- metadata cache 可以讓未連線 server 的工具仍可搜尋/描述；因此 Loadout inventory 不能把「未連線」誤判成「server disabled」。

結論：此 repo 可作 MCP config discovery、metadata cache、target server `connect/close`、atomic write 的參考；但不能直接滿足 Loadout 所需的 `listServers + setServerEnabled + onChanged` adapter contract。需要 pi-mcp-adapter upstream 新增 public bridge，或由同一 extension integration 明確注入 wrapper；禁止讀取其 private closure 或自行複製 MCP manager。

## 2.2 `packages/pi-loadout` 可直接复用的部分

`packages/pi-loadout` 本身没有 MCP 专用逻辑；grepping `packages/pi-loadout/src` 与 tests 未发现 `mcp`、MCP manager 或 `mcp.json` 操作。它的控制模型是纯 runtime active-set：

```ts
const all = pi.getAllTools();
const active = pi.getActiveTools();
pi.setActiveTools(nextToolNames);
```

证据：`packages/pi-loadout/src/index.ts:260-272,388-415,534-539,726-747`。

因此可以安全参考以下行为：

- toggle 只改变当前 session 的 active tools，不修改 MCP config 或 `mcp.json`。
- persisted state 是该 extension 自己的 loadout/session state，不是 MCP server configuration。
- 如果 MCP adapter 以 `directTools` 注册了 Pi native tools，`pi-loadout` 的 `pi.setActiveTools()` 可以控制这些已注册 tool 的 active/inactive 状态。
- 如果 adapter 使用默认 `mcp` proxy，Pi 只有一个 `mcp` tool；`pi-loadout` 只能整体关闭 `tool:mcp`，不能在 proxy 内关闭单个 MCP server/tool。

Loadout 实作应采用双层边界：

```text
tool:<Pi registered tool name>
  -> runtime-only active-set control, no mcp.json mutation

mcp:<server-name>
  -> only when a public MCP bridge exists; otherwise do not claim server disable
```

这允许先实现不触碰 `mcp.json` 的 direct-tool 控制；不得把它描述成 MCP server disconnect，也不得因 `mcp:<server>` UI row 而假装拥有 parent gate。

## 3. 已固定的產品規則

### 3.1 Scope 與按鍵

- `←/→`：切換 Settings/Loadout module tab。
- `Tab`：只在 Loadout 中切換 Global/Project。
- `↑/↓`：移動 Loadout selection。
- `Enter`：toggle item。
- `Esc`：關閉 shared shell。
- Settings tab 中 `Tab` 第一版不做任何操作。

### 3.2 Storage

```text
Global:  ~/.pi/agent/setting.json
Project: <ctx.cwd>/.pi/setting.json
```

兩個檔案都使用：

```json
{
  "pi-loadout": {
    "mcp:mcp-1": true,
    "tool:read": false,
    "skill:librarian": true
  }
}
```

- Global 缺 key：預設 active。
- Project 中 global-capable item 缺 key：推導 inherit。
- Inherit 永不保存；回到 inherit 時刪除 project key。
- Project-only item 沒有 inherit；缺 key 時預設 active。
- 其他 top-level section、未知 loadout key 必須保留。

### 3.3 顯示

| 情況 | configured | effective | 顯示 |
|---|---|---|---|
| Global active | active | active | `● active` |
| Global disabled | disabled | disabled | `○ disabled` |
| Project explicit active | active | active | `● active` |
| Project explicit disabled | disabled | disabled | `○ disabled` |
| Project inherit + Global active | inherit | active | `◎ inherit` |
| Project inherit + Global disabled | inherit | disabled | `○ disabled`，不顯示 inherit |
| Project-only active | active | active | `● active` |
| Project-only disabled | disabled | disabled | `○ disabled` |

Project inherit + Global disabled 與 project explicit disabled 在 UI 中完全一致；controller 必須保留差異，確保下一次 toggle 正確。

### 3.4 Toggle transition

Global 或 project-only：

```text
active -> disabled -> active
```

Project 中 global-capable item：

```text
inherit -> active -> disabled -> inherit
```

實際 project map transition：

```text
missing -> true -> false -> delete key
```

### 3.5 MCP placeholder

- `mcp:<server>` 是 placeholder identity，不是 Pi native tool。
- MCP placeholder 可列出、搜尋、顯示 metadata、保存 Global/Project boolean。
- toggle 只更新 Loadout state；不呼叫 MCP manager，不修改 `mcp.json`，不改 `pi.setActiveTools()`。
- direct MCP tools 若已註冊，按普通 `tool:<Pi registered tool name>` 控制 active-set。
- 本階段不實作 MCP parent gate、child hide/restore、connect/close、server events。

## 4. 建議目標檔案

只建立實際需要的檔案：

```text
packages/pi-basics/src/
├── modules/
│   ├── loadout/
│   │   ├── model.ts          # types、status resolution、toggle、filter、selection
│   │   ├── storage.ts        # global/project setting.json read-modify-write
│   │   ├── inventory.ts      # Pi tools/skills inventory + MCP adapter contract
│   │   ├── controller.ts     # load、toggle queue、runtime apply、rollback、refresh
│   │   ├── render.ts         # scope/search/groups/description/footer
│   │   ├── component.ts      # input routing、selection、scroll
│   │   └── index.ts          # controller/component factory
│   └── shell/
│       ├── component.ts      # active tab、←/→、Esc、child delegation
│       └── index.ts          # shared shell module；commands setting/loadout
├── ui/
│   └── tabs.ts               # 從 Settings render 抽出的 tab bar renderer
└── index.ts                  # 建立 Settings + Loadout + shell；lifecycle cleanup

packages/pi-basics/test/
├── fixtures/loadout.ts
├── modules/loadout/
│   ├── model.test.ts
│   ├── storage.test.ts
│   ├── inventory.test.ts
│   ├── controller.test.ts
│   ├── render.test.ts
│   └── component.test.ts
└── modules/shell/component.test.ts
```

`layout.ts` 第一版先復用現有 `createSettingsLayout()` 的寬/窄幾何。只有 Loadout 實際需要不同幾何時，才抽成通用 layout；不要預先重構。

## 5. Domain contract

建議在 `modules/loadout/model.ts` 定義 internal types；第一版不加入 public `api/`：

```ts
export type LoadoutScope = "global" | "project";
export type LoadoutKind = "mcp" | "tool" | "skill";
export type LoadoutKey = `${LoadoutKind}:${string}`;
export type LoadoutConfiguredStatus = "active" | "disabled" | "inherit";
export type LoadoutEffectiveStatus = "active" | "disabled";
export type LoadoutSourceScope = "global" | "project";

export interface LoadoutItem {
  readonly key: LoadoutKey;
  readonly name: string;
  readonly kind: LoadoutKind;
  readonly sourceScope: LoadoutSourceScope;
  readonly hasGlobalDefinition: boolean;
  readonly origin: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly tokenCount?: number;
  readonly parentMcpKey?: `mcp:${string}`;
}

export interface LoadoutResolvedItem extends LoadoutItem {
  readonly configuredStatus: LoadoutConfiguredStatus;
  readonly effectiveStatus: LoadoutEffectiveStatus;
  readonly displayStatus: "active" | "disabled" | "inherit";
}
```

### 5.1 Key 規則

- key 必須由 kind + runtime identity 組成。
- MCP server 使用 config/server name。
- Tool 使用 `ToolInfo.name`。
- Skill 使用去除 `skill:` command prefix 後的名稱。
- 同 kind/name 的 user/project resource 視為同 key。
- Project view 若同 key 同時有 global/project definition，顯示 project metadata，但 `hasGlobalDefinition=true`，仍可 inherit global state。
- 只有 project definition 的 key，`hasGlobalDefinition=false`，使用二態。

### 5.2 Scope mapping

Pi `SourceInfo.scope`：

```text
user      -> global
project   -> project
temporary -> project
```

Built-in/synthetic tool 若 metadata 不完整，由 inventory adapter 明確 fallback 為 global；fallback 只放一處，不散落於 renderer/controller。

## 6. Pure model algorithm

`model.ts` 必須是無 I/O 純函數。

### 6.1 Resolve configured status

```text
scope=global:
  globalMap[key] === false -> disabled
  otherwise                -> active

scope=project, item has global definition:
  projectMap has true  -> active
  projectMap has false -> disabled
  projectMap missing   -> inherit

scope=project, project-only item:
  projectMap[key] === false -> disabled
  otherwise                 -> active
```

### 6.2 Resolve effective/display status

```text
configured active   -> effective active, display active
configured disabled -> effective disabled, display disabled
configured inherit + global active   -> effective active, display inherit
configured inherit + global disabled -> effective disabled, display disabled
```

### 6.3 MCP gate

先 resolve MCP server，再 resolve child tools：

```text
parent effective disabled -> child 不進 visible inventory
parent effective active   -> child 按自身 storage state resolve
```

Storage 中不存在於 inventory 的 child key仍保留，不刪除。

### 6.4 Selection reconciliation

Inventory/scope/search 改變後：

1. 以 `selectedKey` 保留 identity。
2. selected item 仍可見：保持 selection。
3. 不可見：選同 group 的下一個 item。
4. group 無 item：選下一個可見 group 的第一個 item。
5. 無結果：selection = undefined，Description 顯示 `No item selected.`。

## 7. Storage 實作

### 7.1 API

`storage.ts` 建議提供：

```ts
interface LoadoutStoragePaths {
  readonly globalPath: string;
  readonly projectPath: string;
}

interface LoadoutStoredState {
  readonly global: Readonly<Record<LoadoutKey, boolean>>;
  readonly project: Readonly<Record<LoadoutKey, boolean>>;
}

interface LoadoutStorage {
  load(): Promise<LoadoutStoredState>;
  update(scope: LoadoutScope, key: LoadoutKey, value: boolean | undefined): Promise<void>;
}
```

`undefined` 只允許 project，用於刪 key；global update 收到 undefined 應報錯。

### 7.2 Read

每個檔案：

1. `ENOENT` -> 空 object。
2. JSON parse error -> 報錯，不覆蓋檔案。
3. `pi-loadout` 缺失 -> 空 map。
4. `pi-loadout` 非 object -> 報錯。
5. entry 非 boolean -> 報錯並指出 key。
6. 保留完整原始 object，供 update read-modify-write。

### 7.3 Write

每個 path 使用獨立 in-process queue：

1. 進 queue 後重新讀最新檔案。
2. clone root object。
3. 只修改 `pi-loadout[key]`。
4. project inherit：delete key。
5. 使用同目錄 temp file。
6. 寫入 `JSON.stringify(root, null, 2) + "\n"`。
7. rename temp -> target。
8. 失敗時移除 temp；原 target 保持不變。

第一版不自行發明跨 process lock。已知限制：不同 process 同時改同一 section 時可能 last-writer-wins；開始 storage 實作前需再次確認是否接受，或改用 Pi 已有 lock API。

### 7.4 Test injection

Production path 固定；tests 透過 `LoadoutStoragePaths` 注入 temp paths。不得在 tests 修改真實 `~/.pi/agent/setting.json`。

## 8. Inventory 與 runtime adapter

### 8.1 Native Pi inventory

- `pi.getAllTools()` 提供已註冊 tools。
- `pi.getCommands()` 中 `source === "skill"` 且 `name` 以 `skill:` 開頭的項目提供 skills。
- direct MCP tools 若已註冊，與其他 Pi tools 一樣處理；不得從 `mcp:<server>` 推導 child tools。

### 8.2 MCP placeholder inventory

本階段只需要可選的 placeholder provider/fixture 提供：

```ts
interface McpPlaceholderItem {
  readonly key: `mcp:${string}`;
  readonly name: string;
  readonly origin?: string;
  readonly description?: string;
}
```

placeholder 行為：

- 可進入 Global/Project model、storage、search、render、status resolution。
- toggle 只更新 Loadout persistence/model。
- 不連線、不斷線、不修改 `mcp.json`、不改 `pi.setActiveTools()`。
- 不需要 child relationship、connection state、refresh event 或 MCP rollback。

未來 parent-gate phase 才新增 public bridge contract；本階段 acceptance 不包含 MCP server runtime 行為。


## 9. Loadout controller

### 9.1 State

```ts
interface LoadoutControllerState {
  readonly scope: LoadoutScope;
  readonly query: string;
  readonly selectedKey?: LoadoutKey;
  readonly scrollTop: number;
  readonly inventory: readonly LoadoutItem[];
  readonly resolved: readonly LoadoutResolvedItem[];
  readonly pendingKey?: LoadoutKey;
  readonly error?: string;
}
```

### 9.2 Load

1. 並行讀 global/project storage 與 inventory。
2. normalize/dedupe inventory。
3. 保留 `mcp:<name>` placeholder items，不推導 child tools。
4. resolve tool/skill/placeholder statuses。
5. 選第一個可見 item。
6. apply完整 native tools/skills effective state；placeholder 不進 runtime apply。

### 9.3 Toggle transaction

所有 toggle 經 controller queue；同一時間只 commit 一個：

1. 根據 configured status 計算 next storage value。
2. 保存 previous storage value與 previous model snapshot。
3. optimistic 更新 UI，設 `pendingKey`。
4. `storage.update()`。
5. native tool/skill 才 apply runtime；placeholder MCP 只完成 model/storage。
6. 成功：清除 pending/error。
7. runtime failure：把 storage rollback 到 previous value，再 reload model。
8. rollback 也失敗：顯示 combined error，重新 load disk/runtime；不得宣稱回到舊狀態。

Storage 失敗時不得呼叫 runtime adapter。

### 9.4 Refresh

inventory reload 或手動 invalidate：

- debounce/serialize 成 controller refresh；不要重疊 load。
- 保留 scope、query、selectedKey。
- item 消失後 reconcile selection。
- 不把消失 item 的 storage key 刪除。
### 9.5 Close

- 阻止新 toggle。
- 等待 pending toggle/refresh。
- 不清除 disk state。
- cleanup failure 交給既有 lifecycle aggregate error 路徑。

## 10. Loadout TUI

### 10.1 Render ownership

Shared shell：

- 唯一 owner：tab bar、`←/→`、`Esc`。
- child view 不畫 tab bar。
- shell prepend tab bar，再 render active child。

Settings child：

- 移除 local `activeTab`。
- 移除 `switchMainTab()`。
- 不再攔截 `←/→/Tab/Shift+Tab`。
- 保留原 Settings navigation/edit/footer 行為。

Loadout child：

- `Tab` toggle scope。
- `↑/↓` navigation。
- `Enter` toggle。
- printable input/backspace search。
- 不處理 `←/→`、`Esc`；交給 shell。

### 10.2 Header/body/footer

依 UI 規範：

1. shared tabs。
2. `✎ Project|Global · path`。
3. 空行。
4. `> query█`。
5. 空行。
6. MCP Servers / Tools / Skills groups。
7. wide Description panel 或 narrow list-only。
8. transient error（若有）。
9. scope-aware footer。
10. bottom separator。

### 10.3 Search

匹配：name、kind、origin、display status、description、instruction。Search 時：

- 隱藏無結果 group。
- group title不可選。
- selection reconciliation 使用 key。
- counts 統一顯示 filtered/total，例如 `Tools (2/8)`；不要混用 total-only。

### 10.4 Description

Summary：

```text
name (kind) · N tokens
```

Metadata：

```text
Origin: ...
Status: ● active | ◎ inherit | ○ disabled
```

Project inherit + Global disabled 必須顯示：

```text
Status: ○ disabled
```

不得出現 inherit 字樣。

### 10.5 Pending/error

設計沒有第四個 status，因此 pending 不改 `●/◎/○`：

- pending item 保持 optimistic target symbol。
- Enter 在 pending 時忽略，或 controller queue；第一版建議忽略重複 Enter。
- failure rollback 後在 footer 上方顯示 `Error: ...`。

## 11. Shared shell 與 command

### 11.1 不擴充 public module API

第一版不修改 `HePiModule` contract。新增 internal shell module：

```text
id: shell
commands: ["setting", "loadout"]
```

`open()` 根據 `ctx.command` 決定 initial tab：

```text
/hepi setting -> settings
/hepi loadout -> loadout
```

切 tab 不重開 `ctx.ui.custom()`，不重建 controller，不遺失 search/selection/scope。

### 11.2 Existing public API

- `createSettingsModule()` 保留現有 standalone 能力與 exports。
- built-in `src/index.ts` 改註冊 shell module，而不是同時註冊兩個會各自開 custom UI 的 module。
- 修改 exported symbol 前，實作時必須先跑 LSP references。

### 11.3 Lifecycle

Session start：

1. 建立 placeholder Settings provider。
2. 建立 Settings controller factory。
3. 建立 Loadout storage/inventory/controller factory。
4. 註冊 shared shell module。
5. 註冊 shell/loadout cleanup。
6. 註冊 skill filtering event，讀取當前 session loadout state。

Session shutdown：

1. shell 阻止輸入/close。
2. Settings controller flush/close。
3. Loadout controller flush/unsubscribe/close。
4. existing registry reverse cleanup 收集錯誤。
## 12. 逐步執行順序

### Step 0｜固定 MCP placeholder contract

已研究 `https://github.com/nicobailon/pi-mcp-adapter`。本階段不找 private manager、不建立 bridge；先固定 `mcp:<name>` 的 placeholder identity、metadata、storage 與 no-op runtime semantics。

**可並行前置**：Step 1、Step 2。  
**停止條件**：若需求開始要求 server connect/close、child hide/restore 或 `mcp.json` 修改，另開 parent-gate decision，不擴大本階段。

### Step 1｜Pure model

檔案：

- 新增 `src/modules/loadout/model.ts`。
- 新增 `test/fixtures/loadout.ts`。
- 新增 `test/modules/loadout/model.test.ts`。

先完成普通 item identity、source merge、binary/tri-state、inherit/global-disabled display、placeholder MCP item、selection reconciliation。

完成條件：model tests 全過，model 不 import fs、Pi API、TUI。

### Step 2｜Storage

檔案：

- 新增 `src/modules/loadout/storage.ts`。
- 新增 `test/modules/loadout/storage.test.ts`。

先寫失敗測試：missing file、preserve unknown root/key、global true/false、project delete inherit、malformed JSON、invalid value、same-process queue、failed temp write/rename。

完成條件：只修改 `pi-loadout` section；target 永不出現 partial JSON。

### Step 3｜Inventory/runtime adapters

檔案：

- 新增 `src/modules/loadout/inventory.ts`。
- 新增 `test/modules/loadout/inventory.test.ts`。

先完成 Pi tools/skills inventory，再加入 MCP placeholder fixture/provider。不得建立 MCP bridge 或 fake server runtime。

完成條件：native tool/skill metadata 穩定產生；`mcp:<name>` placeholder 可進入 inventory/model；direct MCP tools 按普通 native tool 路徑處理。

### Step 4｜Controller

檔案：

- 新增 `src/modules/loadout/controller.ts`。
- 新增 `test/modules/loadout/controller.test.ts`。

測試 load、scope、search、toggle queue、storage failure、native runtime failure + storage rollback、rollback failure、refresh selection、close pending operation；placeholder MCP 不測試 bridge failure。

完成條件：任何 failure 後 UI/disk/runtime state 都有可證明結果；沒有 silent catch。

### Step 5｜Renderer

檔案：

- 新增 `src/modules/loadout/render.ts`。
- 新增 `test/modules/loadout/render.test.ts`。

先以純 controller fixture 渲染，不接 keyboard。覆蓋 wide/narrow、group counts、status symbol、scope path、Description、error/footer、每行 width。

完成條件：width 1..110 不溢出；Project inherit/global-disabled 沒有 inherit 提示。

### Step 6｜Component

檔案：

- 新增 `src/modules/loadout/component.ts`。
- 新增 `test/modules/loadout/component.test.ts`。

覆蓋 Tab scope、navigation、Enter cycle、search/backspace、pending Enter、selection after child removal、invalidate/refresh。

完成條件：component 只做 input routing；domain transition 全在 controller/model。

### Step 7｜Shared shell

檔案：

- 新增 `src/ui/tabs.ts`，搬移 tab renderer。
- 新增 `src/modules/shell/component.ts`。
- 新增 `src/modules/shell/index.ts`。
- 修改 Settings render/component，移除 hardcoded shell state。
- 新增 `test/modules/shell/component.test.ts`。
- 更新既有 Settings component/render/integration tests。

完成條件：`←/→` 只切 module tab；Loadout `Tab` 只切 scope；Settings regression 全過；切 tab 保留兩個 child state。

### Step 8｜Root/lifecycle/commands

檔案：

- 修改 `src/index.ts`。
- 視需要修改 `src/runtime/lifecycle.ts`，但不要把 loadout domain 放進 runtime。
- 新增/更新 integration tests。

完成條件：`/hepi setting`、`/hepi loadout` 開同一 shell 不同初始 tab；shutdown flush 兩個 controller；非 TUI guard 仍在 command 層。

### Step 9｜Runtime smoke

1. `bun test packages/pi-basics/test/modules/loadout`。
2. `bun test packages/pi-basics/test/modules/shell packages/pi-basics/test/modules/setting`。
3. `bun test packages/pi-basics/test`。
4. `bun run typecheck`。
5. `bun run check`。
6. `bun run pi:dev -- basics`。
7. 實機 `/hepi setting`、左右切 Loadout、Tab 切 scope。
8. 實機 `/hepi loadout` 直接開 Loadout。
9. 確認 `mcp:<name>` placeholder toggle 不修改 `mcp.json`。

### Step 10｜最後文件同步

確認實作成功後才更新：

- `packages/pi-basics/README.md`。
- `docs/pi-basics-loadout-plan.md` 狀態。
- `docs/pi-basics-loadout-todo.md` checkbox 與證據。

不得在 smoke test 前把計畫標記完成。

## 13. 每一步交付格式

```text
Step:
Changed:
Behavior:
Focused tests:
Smoke test:
Blocked/Unverified:
Preserved unrelated work:
```

## 14. 明確停止條件

遇到以下情況停止該 Step，不用 placeholder 繞過：

- 需求要求 MCP server connect/close、child tool hide/restore 或 registry removal。
- 需求要求修改 `mcp.json`。
- project root/setting path 與實際 Pi runtime 不符。
- storage 缺乏可接受的並行寫入策略。
- shared shell 需要破壞公開 `HePiModule` API 才能工作。
- runtime rollback 後 disk/runtime state 無法判定。

停止時先更新 todo 的阻塞證據，再回到 contract 層達成共識。
