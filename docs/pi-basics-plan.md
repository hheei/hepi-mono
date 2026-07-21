# `pi-basics` 開發計畫

> 狀態：設計／規劃階段，尚未開始實作。  
> 第一個交付：以 `/hepi setting` 開啟符合 [`tui_design_language.md`](./tui_design_language.md) 的設定 TUI。

## 1. 目標與邊界

建立一個長期維護的 Pi 基礎功能 Plugin：

- 套件：`packages/pi-basics`
- npm name：`@hheei/pi-basics`
- 唯一 Pi entry：`src/index.ts`
- 第一個功能模組：Settings TUI
- 第一個命令：`/hepi setting`
- 後續預留：`/hepi continue`、`/hepi goal`、`/hepi advisor`、`/hepi plan`、`/hepi btw`、`/hepi todo`、`/hepi snapcompact`、`/hepi loadout`
- 後續 UI 擴充：Editor modifier、Footer、Status、Widget、Overlay

### 明確決策

1. **不再開發 `pi-extcore`**。它視為 deprecated 參考來源，不列入本計畫的實作依賴、修改項目或驗收項目。
2. **不整合現有 `pi-loadout`、`pi-ssh`、`pi-inturl`**。它們不需要為 `pi-basics` 改寫，也不需要在第一版被 Settings TUI 顯示。
3. `pi-basics` 可以借鑒 `pi-extcore` 的設定 contract、storage adapter、panel layout、editor modifier 等思想，但必須在自身內建立清楚、獨立的 API。
4. `pi-basics` 要提供 API，讓未來功能模組或其他 extension 可以選擇性使用；API 不應反向依賴既有 extension package。
5. 必須有明確的 `test/` 測試文件夾，測試與 source 一起規劃，不在實作後補測試。
6. 不修改 Pi 安裝目錄，也不 fork Pi core。

## 2. 設計原則

- terminal-native：Unicode 單線圓角框、等寬字體、有限語義色彩。
- 不使用陰影、漸層、大面積背景或 GUI 式 widget 堆疊。
- 狀態不能只依賴顏色；要同時使用結構、indicator、文字或按鍵提示。
- 所有 layout 以 terminal cell 寬度計算，不能使用 `string.length` 對齊。
- UI component 只透過 Pi TUI render component 輸出，不直接寫 stdout。
- domain state、UI state、storage state 分開。
- module 之間透過公開 contract 溝通，不直接讀取彼此的 mutable state。
- 先完成第一個真正可用的 Settings module，再依需求增加其他 module；不建立大量空殼功能。

## 3. `pi-basics` 架構

```text
packages/pi-basics/
├── package.json
├── README.md
├── src/
│   ├── index.ts                    # Pi entry；註冊 /hepi 與內建 modules
│   ├── command/
│   │   ├── hepi-command.ts         # /hepi dispatcher
│   │   └── command-types.ts         # command/module contract
│   ├── runtime/
│   │   ├── registry.ts              # module、provider、contribution registry
│   │   ├── context.ts               # HePi runtime context
│   │   └── lifecycle.ts             # session_start/shutdown 管理
│   ├── api/
│   │   ├── index.ts                 # 對其他 module/extension 的公開 API
│   │   ├── modules.ts               # registerHePiModule()
│   │   ├── settings.ts              # registerHePiSettings()
│   │   ├── panels.ts                # createHePiPanel()/panel contracts
│   │   └── contributions.ts         # 未來 editor/footer/status API
│   ├── modules/
│   │   └── setting/
│   │       ├── index.ts             # Settings module entry
│   │       ├── model.ts             # 純資料、selection、mode state
│   │       ├── controller.ts        # provider snapshot、save queue、rollback
│   │       ├── component.ts         # Pi Component 與 input routing
│   │       ├── layout.ts             # wide/narrow layout
│   │       ├── render.ts             # tabs、rows、description、keymap
│   │       └── value-editor.ts       # committed/draft editor
│   ├── ui/
│   │   ├── border.ts                # rounded border language
│   │   ├── text.ts                  # visible width、truncate、wrap、viewport
│   │   └── keymap.ts                # key hint formatter
│   └── errors.ts                    # UI 可讀錯誤轉換
└── test/
    ├── helpers.ts                   # fake theme、fake host、render helpers
    ├── fixtures/
    │   └── settings.ts              # provider/field fixtures
    ├── api/
    │   ├── modules.test.ts
    │   └── settings.test.ts
    ├── modules/
    │   └── setting/
    │       ├── model.test.ts
    │       ├── controller.test.ts
    │       ├── component.test.ts
    │       ├── layout.test.ts
    │       └── value-editor.test.ts
    └── ui/
        ├── render.test.ts
        └── text.test.ts
```

### 分層責任

| 層 | 責任 | 不應負責 |
|---|---|---|
| `index.ts` | 建立 runtime、註冊 `/hepi`、註冊內建 Settings module | 實作設定欄位與 render 細節 |
| `command/` | 解析 `/hepi <subcommand>`、路由 module、檢查 TUI mode | 直接讀寫設定 storage |
| `runtime/` | 管理 registration、module lifecycle、共用 context | 具體功能行為 |
| `api/` | 提供其他 module/extension 可使用的穩定 contract | 持有單一功能的 domain state |
| `modules/setting/` | provider list、search、navigation、edit、save、rollback | 了解其他 extension 的 domain logic |
| `ui/` | cell width、邊框、文字 viewport、keymap 格式 | 保存設定或 session state |
| `test/` | 純 model、renderer、component、API 與 controller 測試 | 依賴實際 terminal 才能執行的不可重現測試 |

## 4. 公開 API 設計

`pi-basics` 自己提供 API，不依賴 `@hheei/pi-extcore`。第一版公開 API 只保留真正需要的能力：

```ts
export interface HePiModule {
  id: string;
  label: string;
  icon?: string;
  commands: readonly string[];
  open: (args: string, ctx: HePiCommandContext) => Promise<void>;
}

export interface HePiSettingsProvider {
  id: string;
  title: string;
  description?: string;
  groups: readonly HePiSettingGroup[];
  panels?: readonly HePiSettingsSubpanel[];
  storage: HePiSettingsStorage;
  onLoad?: (state: HePiSettingsState, ctx: HePiContext) => void | Promise<void>;
  onChange?: (change: HePiSettingChange, ctx: HePiContext) => void | Promise<void>;
  onClose?: (state: HePiSettingsState, ctx: HePiContext) => void | Promise<void>;
}
```

### API 原則

- `registerHePiModule()`、`registerHePiSettings()` 是 registration API，不直接建立 UI。
- Settings provider 只描述欄位、storage 和 change callback；不依賴 Settings TUI component。
- 所有 API 可由其他 module import，但不要求其他 module 改成 `pi-basics` 的內部目錄結構。
- package 可透過 `src/api/index.ts` 提供 named exports；`src/index.ts` 仍保留 Pi default extension entry。
- registry 可使用 module-level/global registry 作為載入橋接，但實際設定 state 必須屬於當前 Pi session/context，不使用跨 session 的全域 mutable state。
- API 需要有 provider id/module id collision 檢查，重複註冊應明確報錯或採取 deterministic replace policy，不能靜默覆蓋。

### 可借鑒、但不複製的思想

- 設定欄位可使用 group、field、default、options、format、parse。
- storage 可分為 global JSON、project JSON、session-backed 三種 adapter。
- panel 可使用 `render(width) -> string[]`、`handleInput()`、`invalidate()`。
- editor/footer 未來可使用 modifier/contribution chain。

這些只代表設計方向；不引入 `pi-extcore` dependency，也不修改 `pi-extcore` 來支援本計畫。

## 5. `/hepi` 命令設計

### 第一版

- `pi.registerCommand("hepi", ...)` 只註冊一次。
- `/hepi setting` 開啟 Settings module。
- `/hepi setting <provider-id>` 預留直接選定 provider 的參數，但第一版可先不實作跳轉。
- `/hepi`、未知 subcommand、非 TUI mode 都提供清楚提示。
- 不建立 `/hepi-setting`、`/hepi-settings` 等平行命令。

### 未來

`/hepi continue`、`/hepi goal`、`/hepi advisor` 等均由同一個 dispatcher 路由至 module；每個 module 只提供自己的 handler，不自行註冊同名根 command。

現有 `/loadout`、其他既有 extension command 不在本計畫整合範圍內。未來若要提供 `/hepi loadout`，另建獨立 adapter/module task。

## 6. Settings TUI 設計

### 6.1 Shell 與 tab

- 頂部是 module tab；第一版至少有 `⚙ Settings`。
- Settings provider tab 只顯示已透過 `registerHePiSettings()` 註冊且有內容的 provider。
- Active tab 以開放底部、`accent` 和結構共同表達，不只靠顏色。
- 未來 `⏣ Loadout`、`◌ Goal` 等 tab 由 module registry 動態提供，不在第一版硬編碼。
- Tab/Shift+Tab 的方向在 component 中明確實作；以實機輸入測試 Pi/TUI 的 key encoding。

### 6.2 Provider 面板

- provider 順序固定，預設按 title 排序。
- provider `groups` 映射到設定列表；provider `panels` 映射到自訂 submenu。
- provider storage、`onLoad`、`onChange`、`onClose` 由 provider 擁有。
- Settings TUI 不知道任何其他 extension 的 domain 名稱或資料結構。
- 若第一版需要通用 General 設定，將其作為 `pi-basics` 自己註冊的 provider，而不是特殊硬編碼分支。

### 6.3 寬模式

```text
 ╭─────────╮╭──────────╮
 │⚙ Set... ││⏣ Loadout │
─╯         ╰┴──────────┴───────────────────────────────

> type to search                 ╭ Description ────────╮
                                 │ Key: setting-1      │
→ setting-1            true      │                     │
  setting-2            false     │ setting-description │
                                 │ here. Must wrap ... │
                                 │                     │
                                 │ Value: true         │
                                 ╰─────────────────────╯

↑/↓ navigate · ←/→ tab · ↵ edit/toggle · ⎋ close
────────────────────────────────────────────────────────
```

- list 不加外框；Description panel 才使用 `╭╮╰╯─│`。
- list 固定 indicator、key viewport、value 欄起始位置。
- selected 長 key 只在 key viewport 內水平滾動。
- Description 固定高度，word wrap 後超出以 `...` 截斷。
- panel 全部使用 `dim`；編輯中的 draft value 和游標才使用 `highlight`。

### 6.4 窄模式

- 完全隱藏 Description panel、Key metadata 和 description。
- list 使用完整寬度。
- list 下方固定兩行 `Value:` 與 `> draft` 區域。
- 編輯時只讓 Value editor 使用水平 viewport，不能增加區域高度。
- 所有 render line 使用 `visibleWidth()`、`truncateToWidth()` 驗證。

### 6.5 狀態機與輸入

```text
Navigation
  ↑/↓       移動選取
  ←/→       切換 tab
  Enter     boolean toggle；其他型別進入 Edit
  Esc       關閉面板

Edit
  text      修改 draft
  ←/→       移動文字游標
  Home/End  移到首尾
  Enter     parse/validate 後提交
  Esc       丟棄 draft，回到 Navigation
```

必須維持兩份值：

- `committedValue`：列表永遠顯示此值。
- `draftValue`：只在 editor 顯示，提交成功後才更新 provider state。

提交失敗時保留 committed value、顯示錯誤、不關閉面板、不移動 selection，並保留 draft 讓使用者修正或取消。

Boolean 直接切換；enum/options 可 cycle 或使用 submenu；文字、數字、路徑使用 draft editor。`parse` 是唯一型別轉換入口，必須處理 `NaN`、無效 enum 和 parser exception。

### 6.6 Search、group 與 scroll

- search bar 可由 module option 關閉，但 Settings 第一版預設開啟。
- 搜尋即時更新；群組標題不作為結果列，但群組內命中項目要能在收合群組時顯示。
- 空結果顯示 `No results found`。
- 超出可視範圍才顯示 `↑`/`↓`，邊界不顯示錯誤方向。
- 搜尋、selection、tab 切換後以 item id 保留 selection identity，不只保存 index。

### 6.7 Footer keymap

- Navigation：`↑/↓ navigate · ←/→ tab · ↵ edit/toggle · ⎋ close`
- Edit：`↵ confirm · ⎋ cancel`
- keymap 由 component render，不能依賴 Pi 內建 SettingsList 的提示。
- hint 保持正常亮度；寬度不足時從低優先級提示開始移除。
- 未來可由 module 設定 `showKeymap` 和 `keyMapItems`；第一版先固定 Settings 的兩種狀態。

## 7. Runtime 與 module 邊界

### Module registry

`runtime/registry.ts` 只處理：

- module/provider registration。
- id collision 檢查。
- deterministic ordering。
- 根 command 查詢可用 module。
- session 生命週期 callback 的註冊與清理。

它不處理：

- 任一 module 的實際 state。
- 設定檔格式細節。
- UI render。
- 其他 module 的 fallback 行為。

### 未來模組規劃

| 未來功能 | 建議位置 | 初步整合點 |
|---|---|---|
| `continue` | `src/modules/continue` | command + session lifecycle |
| `goal` | `src/modules/goal` | command + session-backed state |
| `advisor` | `src/modules/advisor` | command + prompt/context hook |
| `plan` | `src/modules/plan` | command +文件／session output |
| `btw` | `src/modules/btw` | input/command behavior |
| `todo` | `src/modules/todo` | command + widget/status |
| `snapcompact` | `src/modules/snapcompact` | compaction/session hooks |
| `loadout` | `src/modules/loadout` | 未來獨立 adapter/module |
| Editor 修改 | `src/contributions/editor` | editor modifier chain |
| Footer 修改 | `src/contributions/footer` | single owner/contribution renderer |

限制：

- 每項功能先獨立實作，不因「可能共用」而提前搬進 shared。
- `setFooter()`、`setEditorComponent()` 是全域替換插槽，必須由 runtime/contribution 層協調。
- 所有 watcher、timer、socket、child process 在 `session_start` 啟動，在 `session_shutdown` 清理。

## 8. 測試策略與文件夾

`packages/pi-basics/test/` 是第一級正式測試文件夾，所有新 module 都必須有對應測試；不要把測試散落在 `src/` 或只依賴手動驗收。

### 測試層級

1. **純函數／model tests**：selection、filter、group collapse、value parse、state transition。
2. **renderer tests**：寬／窄模式、每行 cell width、截斷、wrap、tabs、keymap。
3. **component tests**：輸入事件、requestRender、Navigation/Edit transition、Esc/Enter 行為。
4. **controller tests**：provider load、save queue、optimistic state、rollback、callback ordering。
5. **API tests**：module/provider registration、collision、ordering、public API 不依賴既有 package。
6. **Pi integration tests**：只測 command registration 與 TUI mode guard；不把整個 Pi interactive loop 複製進 test。

### 測試要求

- 使用 Bun test，與 monorepo 現有測試風格一致。
- `test/helpers.ts` 提供 fake theme、fake host、render text、fake provider/storage。
- 每個 TUI test 至少驗證一個窄寬度與一個寬寬度案例。
- 每個非平凡 state transition 都有一個可失敗的 regression test。
- 不把 ANSI snapshot 當唯一驗收；同時檢查去除 ANSI 後的可見文字與 cell width。
- 遇到 Unicode 圖示時測試實際 visible width，不假設 JS 字元數等於 terminal cell 數。

## 9. 分階段實作

### Phase 0：自有 contract

- 建立 `pi-basics` package、public API、runtime registry 和 `test/` 基礎 helpers。
- 決定 settings provider、storage、module registration 的最小型別。
- 不修改 `pi-extcore`，不修改既有 extension package。

### Phase 1：Settings model/controller

- 完成 provider snapshot、selection identity、Navigation/Edit state。
- 完成 committed/draft 雙值模型、parse/validate、async save queue 和 rollback。
- 先寫 model/controller tests，再接 TUI。

### Phase 2：Settings TUI

- 完成 shell、provider tabs、search、group、wide/narrow layout、Description panel、footer keymap。
- 完成 renderer/component/value-editor tests。

### Phase 3：`/hepi setting` 整合

- 加入單一 `/hepi` dispatcher。
- 加入非 TUI mode guard。
- 更新 `scripts/pi-dev.mjs` alias、README 和手動驗收流程。

### Phase 4：逐一加入未來功能

每個 future module 獨立建立 source、public contract 和 `test/modules/<name>/`；不一次建立所有空殼 command。

## 10. 明確 TODO list

### Package 與 runtime

- [ ] 建立 `packages/pi-basics/package.json`，使用 `@hheei/pi-basics`、`main: src/index.ts`、`pi.extensions`。
- [ ] 建立 `packages/pi-basics/README.md`，記錄 `/hepi setting`、載入方式與 public API。
- [ ] 建立 `packages/pi-basics/src/index.ts`，只負責初始化 runtime、註冊 command 和 Settings module。
- [ ] 建立 `src/runtime/registry.ts`、`context.ts`、`lifecycle.ts`。
- [ ] 建立 `src/api/index.ts`，明確區分 public API 與 internal implementation。
- [ ] 更新 `scripts/pi-dev.mjs`，加入 `basics`/`pi-basics` alias。

### Settings API

- [ ] 定義自有 `HePiSettingsProvider`、`HePiSettingGroup`、`HePiSettingField`、`HePiSettingsState`。
- [ ] 定義 global/project/session storage adapter，不引用 `pi-extcore` 的型別或實作。
- [ ] 實作 `registerHePiSettings()` 與 provider collision 檢查。
- [ ] 實作 provider snapshot、state merge、default value 與 change routing。
- [ ] 實作 provider-level async save queue、optimistic update、rollback。
- [ ] 提供其他 module 可使用的 settings API 文件與最小範例。

### Settings model/controller

- [ ] 定義 selection identity、Navigation/Edit mode 和 draft state 型別。
- [ ] 實作 boolean toggle、option cycle、文字／數字 parse/validate、Esc rollback。
- [ ] 實作 parser exception、`NaN`、無效 option 的錯誤處理。
- [ ] 實作只顯示已註冊且有內容 provider 的 tab/filter 規則。

### TUI renderer

- [ ] 建立 rounded border、active/inactive tab renderer。
- [ ] 建立固定 indicator/key/value 欄位與 selected key viewport。
- [ ] 建立寬模式 Description panel，固定高度、wrap、ellipsis。
- [ ] 建立窄模式 Value 區域與水平 editor viewport。
- [ ] 實作 search、collapsed group、No results found、上下 scroll arrows。
- [ ] 實作 Navigation/Edit 兩組 footer keymap。
- [ ] 所有 render line 通過 `visibleWidth`、`truncateToWidth` 和窄終端檢查。
- [ ] 確認 `⚙`、`⏣`、`→`、`↑`、`↓` 的實際 terminal cell width。

### Command 與未來擴充

- [ ] 實作單一 `/hepi` dispatcher。
- [ ] 實作 `/hepi setting`，非 TUI mode 顯示明確錯誤。
- [ ] 實作 module registration API，但不加入未指定功能的空殼 command。
- [ ] 為未來 Editor/Footer contribution 保留邊界，不在第一版接管 Pi editor/footer。
- [ ] 確認 `pi-basics` source 與 API 不 import `pi-loadout`、`pi-ssh`、`pi-inturl`、`pi-extcore`。

### 測試文件夾與測試

- [ ] 建立 `packages/pi-basics/test/`、`test/helpers.ts`、`test/fixtures/`。
- [ ] 建立 `test/api/`，測試 module/provider registration、collision 和排序。
- [ ] 建立 `test/modules/setting/`，測試 model、controller、component、layout、value editor。
- [ ] 建立 `test/ui/`，測試 visible width、truncate、wrap、border、tabs、keymap。
- [ ] 為 selection identity、search、group collapse 寫 regression tests。
- [ ] 為 boolean toggle、draft commit/cancel、parse error 寫 regression tests。
- [ ] 為 save queue、rollback、callback ordering 寫 integration tests。
- [ ] 使用 `bun test packages/pi-basics/test` 執行 package tests。
- [ ] 使用 `bun run typecheck`、`bun test`、`bun run check` 驗證。
- [ ] 使用 `bun run pi:dev -- basics` 手動驗收 `/hepi setting`。
- [ ] 在窄終端、寬終端、無色彩／不同字體環境驗收排版。

## 11. 驗收標準

完成第一個交付時，必須同時滿足：

1. `packages/pi-basics` 可被 Pi 正常載入。
2. `/hepi setting` 能在 TUI mode 開啟；JSON/print mode 不會建立 terminal component。
3. 已透過 `registerHePiSettings()` 註冊的 providers 能被切換，未註冊 provider 不出現。
4. 寬模式顯示右側 Description panel；窄模式隱藏 panel 並顯示兩行 Value 區域。
5. Boolean Enter 直接切換；非 Boolean Enter 進入 Edit，第二次 Enter 才提交，Esc 取消。
6. Edit 中列表維持 committed value，draft 只在 editor 顯示。
7. Search、scroll、group collapse、async save error 都不會遺失 selection 或設定。
8. 主要狀態不只依賴顏色；active/selected/edit 有結構、符號或文字提示。
9. `test/` 內的 model、renderer、component、controller、API 測試全部通過。
10. `pi-basics` 不依賴、修改或要求現有 `pi-extcore`、`pi-loadout`、`pi-ssh`、`pi-inturl`。
11. `bun run typecheck`、`bun test`、`bun run check` 全部通過。

## 12. 明確不做

- 不開發、修改或延長 `pi-extcore`；只借鑒其中可用思想。
- 不整合或改寫現有 `pi-loadout`、`pi-ssh`、`pi-inturl`。
- 不 fork 或直接修改 Pi 安裝目錄的 `interactive-mode`、`footer`、`editor`。
- 不在第一個 PR 同時實作 `continue`、`goal`、`advisor`、`plan`、`todo` 等所有功能。
- 不把所有 future domain logic 搬進 `pi-basics` shared。
- 不使用跨 session 的全域 mutable state 保存設定。
- 不為尚未有第二個實作者的功能建立複雜 plugin SDK。

## 13. 待確認但不阻塞第一版的決策

- Settings module 的第一層 tab 是否顯示 `General`，或只顯示 `HePiSettingsProvider`。
- `/hepi setting` 是否接受 provider id 直接跳轉。
- `Shift+Tab` 在目標 Pi/TUI 版本的 key encoding。
- 未來 public API 是否以 package subpath export（例如 `@hheei/pi-basics/api`）提供。
- Footer 最終是維持 status contribution，還是由 `pi-basics` 成為唯一 custom footer owner。
