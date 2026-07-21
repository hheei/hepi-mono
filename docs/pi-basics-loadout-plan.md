# `pi-basics` Loadout 實作計畫（核心共識已確認）

> 狀態：storage schema、Inherit 顯示、shared module tabs、runtime-only tool control、MCP placeholder 策略已確認；MCP server parent control 延後。
>
> 參考：[`loadout-design.png`](./loadout-design.png)、[`loadout_tui_design_language.md`](./loadout_tui_design_language.md)。  
> 逐步實作：[`pi-basics-loadout-implementation.md`](./pi-basics-loadout-implementation.md)。  
> TODO：[`pi-basics-loadout-todo.md`](./pi-basics-loadout-todo.md)。

## 1. 目前結論

這不是現有 `pi-loadout` 的小幅改 UI，而是 `pi-basics` 的新 module + storage + resource adapter：

- `packages/pi-basics` 目前只有普通設定值模型；沒有 Global/Project layered state、inherit metadata 或 scope-aware storage。
- 現有 `createGlobalJsonStorage()` 與 `createProjectJsonStorage()` 只是相同 backend 的 pass-through，不能自行解析路徑、區分 scope 或保證 atomic write（`packages/pi-basics/src/api/settings.ts:4-6,40-63,138-147`）。
- 現有 Settings controller 每 provider 只 load/save 一份 state，沒有 global + project 合併（`packages/pi-basics/src/modules/setting/controller.ts:35-69,123-169`）。
- 現有 TUI 的 toggle 只支援 boolean/option/edit，沒有 inherited override（`packages/pi-basics/src/modules/setting/component.ts:93-124`）。
- 現有 `pi-loadout` 只呼叫 `pi.setActiveTools()`；它改變 active tool list，不會把 MCP tools 從 registry 移除（`packages/pi-loadout/src/index.ts:534-539,738-747`）。
- `pi-mcp-adapter` 2.11.0（[upstream](https://github.com/nicobailon/pi-mcp-adapter)）預設只註冊單一 `mcp` proxy tool；`directTools` 是 load-time config/cache 行為，不是 server enable/disable 或 runtime inventory API。其 `McpServerManager` 被入口 closure 私有持有，不能直接被 `pi-basics` 使用。
- adapter 可參考四層 MCP config discovery、metadata cache、target `connect/close` 與 temp+rename writer，但目前沒有 public bridge。
- 本階段 **不做 MCP 特殊處理**：`mcp:<name>` 只作為可識別的 placeholder item；不讀寫 `mcp.json`、不 disconnect/connect server、不隱藏/恢復 child tools，也不把它當作 Pi native tool。
- `packages/pi-loadout` 的 runtime-only `pi.setActiveTools()` 模式只適用已註冊的 `tool:<Pi tool name>`；默认 proxy 只能整体控制 `tool:mcp`，不能控制 proxy 内部 child tools。

## 2. 需求模型

### 2.1 Item identity

Loadout GUI item key 使用以下 namespace：

```text
mcp:<server-name>   # MCP server logical identity，不是 Pi native tool name
tool:<tool-name>    # Pi ToolInfo.name
skill:<skill-name>  # skill name / command identity，需在實作前固定
```

`mcp:<server-name>` 關閉時，adapter 必須讓該 server 的工具從 inventory/registry 消失；重新啟用後重新連線並回傳工具，GUI 再次載入。僅把相關工具從 active set 移除不符合此要求。

### 2.2 狀態

Domain state 不直接等同於畫面符號，至少分成：

```text
ConfiguredStatus = active | disabled | inherit
EffectiveStatus   = active | disabled
```

Global item：只允許 `active | disabled`。

Project item：允許推導出的 `inherit` 以及明確 `active | disabled`；project storage 中缺少 key 即推導為 `inherit`，`inherit` 本身永不保存。

建議 toggle cycle：

```text
inherit -> active -> disabled -> inherit
```

Global item 及 project-only item：

```text
disabled -> active -> disabled
```

### 2.3 Inherit 的顯示規則

已確認畫面顯示 **effective state**：

- Project key 缺失時，runtime 推導 configured state 為 `inherit`；`inherit` 永不保存。
- Global active 時，Project 顯示 `◎ inherit`。
- Global disabled 時，Project 顯示 `○ disabled`，與 project explicit disabled 完全一致；列表及 Description 不顯示任何 inherit 提示。
- 即使畫面同為 `○ disabled`，controller 仍須保留「缺 project key」的推導結果；下一次 toggle 必須走 `inherit -> active`，不可誤走 explicit disabled 的 transition。

## 3. 建議 storage contract

### 3.1 檔案位置

已確認採兩個 scope file，file 本身已表達 scope，因此 `pi-loadout` section 內不再重複 `global`/`project`：

```text
Global:  ~/.pi/agent/setting.json
Project: <project-root>/.pi/setting.json
```

每個檔案使用：

```json
{
  "pi-loadout": {
    "mcp:mcp-1": true,
    "mcp:mcp-2": false,
    "tool:tool-1": true,
    "tool:tool-2": false,
    "skill:skill-1": true
  }
}
```

語義：

- Global section：每個已知 global item 的明確值；未存 key 預設 `active`，保持 Pi/現有 loadout「未配置即啟用」的行為。
- Project section：只寫 override；沒有 key 時 runtime 推導 `inherit`；有 key 才是明確 `true/false`。
- 永不寫入 inherit marker；回到 inherit 時直接刪除 project key。
- 讀取未知 key 時保留，不在 GUI save 時靜默刪除；這讓尚未載入的 MCP/skill 或未來 namespace 不會被破壞。
- save 必須是 scope-aware、read-modify-write，不能以目前 GUI snapshot 覆蓋另一 scope 或其他 settings section。
- 寫入至少需要 temp file + rename；是否要求 fsync、lock/retry、損壞檔案 backup 需確認。

### 3.2 Project path 與 trust

目前 repo 文件同時出現 `.pi/config.json`、`.pi/setting.json` 等說法，而 Pi `ExtensionContext` 只直接提供 `cwd`，沒有公開 setting file path（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:208-220`）。因此 adapter 必須先固定：

1. project root 如何由 `cwd` 決定（目前 cwd 是否已保證是 project root）。
2. project settings 實際檔名是否 `.pi/setting.json`。
3. untrusted project 是否允許寫入。
4. global/project 同時被外部 Pi SettingsManager 修改時的 conflict 行為。

## 4. Effective precedence

建議先採以下單一規則，避免 server、tool、skill 各自有不同 precedence：

```text
project explicit disabled > project explicit active > global disabled > global active > default active
project inherit      -> evaluate global
```

MCP 暫時不建立 parent gate；`mcp:<server>` 只保留 namespace 和 placeholder identity：

```text
mcp:<server-name>
  => 可列出/搜尋/顯示 placeholder metadata
  => 可保存 Global/Project boolean state
  => toggle 不觸碰 mcp.json、MCP manager 或 Pi active tool set
```

已註冊的 direct MCP tools 仍可作為普通 `tool:<Pi registered tool name>` 控制；這是 runtime-only active-set，不是 `mcp:<server>` 行為。

## 5. MCP adapter 邊界

本階段不複製 MCP client/manager，也不依賴 sibling OMP package；更不讀寫 `mcp.json`。

`mcp:<server>` 只是一個 placeholder item：

- inventory 可提供 stable key、名稱、origin、description 等 metadata。
- Global/Project storage 可保存 boolean state。
- toggle 是 no-op runtime semantics：只更新 Loadout state，不呼叫 MCP connect/close，不改 Pi active tool set。
- 不要求 child tool relationship、server connection event、registry removal 或 reconnect。

已註冊的 direct MCP tools 另行使用普通 `tool:<Pi registered tool name>` 路徑，由 `pi.setActiveTools()` 控制；這不等同 MCP server control。

未來若重新啟用 MCP parent gate，再新增 adapter contract、child hide/restore 與 server lifecycle phase；不納入本階段 acceptance。

## 6. TUI/module 方案

### 6.1 已確定的按鍵分工建議

- `↑/↓`：只在可選 item 間移動。
- `Enter`：toggle selected item。
- `Tab`：Project ↔ Global scope toggle；不切換左右 panel。
- `←/→`：只切換頂部 Settings/Loadout module tab。
- `Esc`：close。

Footer 應改成：

```text
↑/↓ navigate · ←/→ tab · ↵ toggle · ⇥ global/project · ⎋ close
```

窄畫面沿用 design language 的縮短規則。

### 6.2 目前架構缺口

最新 Settings component 已內建 Settings/Loadout 視覺 tab 與 `Loadout is not implemented.` placeholder，但 tab state、header 與 input routing 都由 Settings component 硬編碼；它不是可組合的 shared shell。現有 `HePiModule.open()` 仍是獨立 command entry（`packages/pi-basics/src/api/modules.ts:5-10`）。實作時要把現有 tab renderer/state 抽到 internal shell owner，`←/→` 留給 shell，`Tab` 改由 Loadout child切換 Global/Project；不擴充 public `HePiModule` contract。

## 7. 實作階段

以下只保留 phase 摘要；檔案、測試、gate 與 rollback 順序以 [`pi-basics-loadout-implementation.md`](./pi-basics-loadout-implementation.md) 和 [`pi-basics-loadout-todo.md`](./pi-basics-loadout-todo.md) 為準。

### Phase 0：scope 與 placeholder contract

- 已研究 [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) 2.11.0；目前只作 config/cache/manager 參考，不接 private state。
- 固定 `mcp:<name>` placeholder item 的 identity、metadata、storage 與 no-op runtime semantics。
- 已確認：分文件 schema、project 缺 key 推導 inherit、effective-state 顯示、shared module tabs、direct Pi tool runtime-only 控制。

### Phase 1：純 domain/state

- 建立 loadout item identity、scope、configured/effective status、precedence。
- 實作三態 transition；`mcp:<name>` 使用普通 item storage，不建立 parent gate。
- 純函數測試：Global 2-state、Project 3-state、inherit/global disabled、placeholder MCP item、未知 key preservation。

### Phase 2：scope-aware JSON storage

- 實作 `setting.json` section read-modify-write。
- project 只保存 delta；clear override 時刪 key，不寫 false/true 以外的 inherit marker。
- 加入 path resolution、malformed JSON、atomic replacement、並行修改/error rollback 測試。

### Phase 3：resource/runtime integration

- 先接 native Pi tool/skill runtime-only active-set，复用 `packages/pi-loadout/src/index.ts:260-272,388-415,534-539,726-747` 的行为；不得修改 `mcp.json`。
- `mcp:<name>` 僅作 placeholder inventory/storage item；toggle 不呼叫 MCP adapter、不改 server connection、不改 active tool set。
- direct MCP tools 若已註冊，按照普通 `tool:<name>` runtime-only 控制。
- 未來若要加入 MCP parent gate，另開 decision/phase，不納入本階段 acceptance。

### Phase 4：Loadout TUI

- 實作 design language 的 tabs/scope/source/search/list/description/footer。
- Global/project item visibility、counts、selection identity、scroll、wide/narrow layout。
- 寬畫面右側唯讀 Description；窄畫面隱藏 panel。
- 所有 render line 做 visible-width/truncate/wrap 驗證。

### Phase 5：`/hepi loadout` integration

- 接入 shared module-tab shell，註冊 Settings/Loadout tabs 與 `/hepi setting`、`/hepi loadout` 路由。
- session start/reload/resource changed 時重載 inventory 與 effective states。
- 只在實作完成後執行 focused tests、typecheck/check 和實際 TUI smoke test。

## 8. Acceptance scenarios

1. Global item 可在 `○/●` 間切換並只寫 global section。
2. Project item 初始無 project key；三次 toggle 依序得到 active、disabled、inherit，第三次會刪除 project key。
3. Project inherit + global active 的 effective state 正確。
4. Project inherit + global disabled 時顯示 `○ disabled`，與 project explicit disabled 完全一致；下一次 toggle 仍進入 active，不會誤判 transition。
5. Project explicit active/disabled 不受 global 後續變更影響。
6. `mcp:<name>` placeholder 可列出/搜尋/保存狀態，toggle 不修改 `mcp.json`、不連線/斷線。
7. direct MCP native tool 若已註冊，可按普通 `tool:<name>` runtime-only 控制；proxy 模式只控制整體 `tool:mcp`。
8. Global/project JSON section 互不覆蓋；未知 section/key 保留；project clear override 後回到 inherit。
9. malformed/並行寫入/adapter failure 不會把 UI optimistic state 留在錯誤值。
10. 寬、窄 terminal 都維持設計語言要求的 cell width 與 keyboard contract。

## 9. 共識記錄與剩餘問題

### 已確認

1. Global 使用 `~/.pi/agent/setting.json`，Project 使用 `<project-root>/.pi/setting.json`。
2. 兩個 scope file 都使用 `{"pi-loadout": {"mcp:x": true}}`；file 本身表達 scope。
3. Project 只保存 boolean delta；缺 key 時 runtime 推導 `inherit`，`inherit` 不保存。
4. Project inherit + Global active 顯示 `◎ inherit`；Global disabled 時顯示 `○ disabled`，不顯示任何 inherit 提示。
5. 即使 inherit/global-disabled 與 project explicit disabled 畫面完全一致，toggle 仍依內部推導狀態執行正確 transition。
6. TUI 採 shared module tabs；`←/→` 切 Settings/Loadout，`Tab` 切 Global/Project。
7. MCP 以 placeholder item 實作；不做 parent gate、child hide/restore 或 server reconnect。

### MCP bridge 狀態

本階段不接 `pi-mcp-adapter` private manager，也不等待 public bridge；MCP 以 placeholder item 實作。parent gate、child hide/restore、server reconnect 延後至另一次 decision/phase。

## 10. 暫不實作項目

MCP placeholder 不得讀寫 `mcp.json`；不建立 fake server disconnect，不把 placeholder state 宣稱成 MCP runtime state。
