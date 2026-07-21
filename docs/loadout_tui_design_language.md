# Loadout TUI 設計語言規範

## 1. 介面定位

此介面用於瀏覽及管理目前設定範圍內的：

- MCP Servers
- Tools
- Skills

整體採用 terminal-native 的設計語言，以 Unicode 線框、等寬字體、鍵盤操作及有限的語義色彩建立資訊層級。

核心原則：

- 不模仿傳統桌面 GUI。
- 不使用陰影、漸層或大面積背景裝飾。
- 使用單線 Unicode 邊框。
- 以縮排、符號和空白表達階層。
- 所有主要操作均可由鍵盤完成。
- Selection、Active、Disabled 等狀態不能只依賴顏色。
- 所有尺寸和對齊均以 terminal cell 為單位。
- Unicode 圖示應使用文字顯示形式，避免被終端渲染成雙寬 emoji。

---

## 2. 參考畫面

```text
 ╭─────────╮╭──────────╮
 │⚙ Set... ││⚙ Loadout │
─┴─────────┴╯          ╰───────────────────────────────────────────────
✎ Project · /Users/supercgor/Documents/dev/hepi-mono/.pi/config.json

> _                                ╭─ Description ────────────────────╮
                                   │ tool-3 (tool) · 1772 tokens      │
⌘ MCP Servers (N)                  │                                  │
  ● mcp-1                          │ Tool description here .........  │
  ● mcp-2                          │ ...............................  │
  ...                              │ ..................               │
  ● mcp-3                          │                                  │
⚒ Tools (N)                        │ Origin: build-in                 │
  ● tool-1                         │ Status: ◎ inherit                │
  ● tool-2                         │                                  │
→ ◎ tool-3                         │ Instruction:                     │
  ● tool-4                         │ tool instruction for model here. │
  ● tool-5                         │ ................................ │
✦ Skills (N)                       │ ................................ │
  ● skill-1                        │                                  │
  ● skill-2                        ╰──────────────────────────────────╯

↑/↓ navigate · ←/→ tab · ↵ toggle · ⇥ global · ⎋ close
───────────────────────────────────────────────────────────────────────
```

---

## 3. 整體畫面結構

畫面依序分為五個水平區域：

1. 頂部頁籤。
2. Scope 與設定來源。
3. 搜尋欄。
4. 主內容區。
5. 底部操作提示。

```text
┌ Top tabs ────────────────────────────────────────────────┐
│ Scope · configuration source                            │
│                                                        │
│ Search                    Description                   │
│ Grouped item list         Selected item details         │
│                                                        │
│ Keyboard hints                                          │
└ Bottom separator ───────────────────────────────────────┘
```

主內容區採左右雙欄：

- 左欄：分類列表及選中狀態。
- 右欄：目前選中項目的唯讀 Description panel。
- Description panel 不接受 focus。
- 左欄是主要導航區。

---

## 4. 頂部頁籤

### 4.1 頁籤結構

每個頁籤格式為：

```text
[icon] [label]
```

例如：

```text
⚙ Settings
⚙ Loadout
```

規則：

- 圖示位於文字前。
- 圖示與標題之間保留一格。
- 左右各保留一格內邊距。
- 頁籤高度固定為兩行。
- 相鄰頁籤緊貼，不保留空格。
- 頁籤寬度由內容決定，不平均分配整行。

### 4.2 Active 頁籤

Active 頁籤底部開放，直接連接主內容區：

```text
╭──────────╮
│⚙ Loadout │
╯          ╰────────────────────────
```

規則：

- 不繪製 Active 頁籤的底部水平線。
- 左右邊框向下接入主分隔線。
- Active 頁籤可使用 accent color。
- 即使無顏色，仍能由開放底部識別。

### 4.3 Inactive 頁籤

Inactive 頁籤保持完整封閉：

```text
╭─────────╮
│⚙ Set... │
╰─────────╯
```

規則：

- 顯示完整上下左右邊框。
- 使用 normal 或 dim 樣式。
- 超出最大寬度時以 `...` 截斷標題。

### 4.4 頁籤操作

```text
←/→ tab
```

- `←` 切換至前一頁籤。
- `→` 切換至後一頁籤。
- 切換後立即更新頁籤結構和主內容。
- 頁籤切換不應被誤解為左右 panel focus 切換。

---

## 5. Scope 與設定來源

### 5.1 基本格式

```text
✎ Project · /Users/supercgor/Documents/dev/hepi-mono/.pi/config.json
```

結構：

```text
[scope icon] [scope label] · [configuration source]
```

### 5.2 Scope

支援至少兩種範圍：

```text
Project
Global
```

建議格式：

```text
✎ Project · /path/to/project/.pi/config.json
✎ Global  · ~/.config/pi/config.json
```

規則：

- Scope label 使用正常或 accent 樣式。
- `·` 作為 scope 與來源之間的輕量分隔符。
- 路徑使用 secondary 或 dim 樣式。
- 整行不加邊框。
- Scope 切換後，列表、計數、狀態和 Description panel 全部重新載入。

### 5.3 Scope 操作

```text
⇥ global
```

- `Tab` 鍵以 `⇥` 表示。
- 在 Project scope 中按 `Tab` 切換至 Global。
- 在 Global scope 中再次按 `Tab` 返回 Project。
- Footer 文案可根據目標 scope 動態顯示：

```text
⇥ global
⇥ project
```

若希望 footer 保持固定，也可以統一使用：

```text
⇥ scope
```

### 5.4 路徑溢出

路徑過長時：

- 保持單行。
- 不推動終端右邊界。
- 優先保留檔名及最接近檔名的路徑段。
- 使用 `...` 進行中間截斷。

例如：

```text
✎ Project · /Users/.../hepi-mono/.pi/config.json
```

---

## 6. 搜尋欄

### 6.1 基本格式

空搜尋：

```text
> _
```

輸入中：

```text
> tool
```

規則：

- 使用 `>` 作為 prompt。
- Prompt 與文字之間保留一格。
- 不加獨立邊框。
- `_` 或 block cursor 表示目前可輸入位置。
- 搜尋欄只佔左側列表欄寬。
- 搜尋結果即時更新。

### 6.2 搜尋範圍

搜尋可匹配：

- Item name。
- Item type。
- Origin。
- Status。
- Description 中的關鍵字。
- Instruction 中的關鍵字。

顯示結果時：

- 保留符合項目的分類標題。
- 不符合且沒有可見子項目的分類可隱藏。
- 選中項目若被過濾掉，selection 移至第一個可見項目。
- Description panel 同步顯示新的選中項目。

### 6.3 計數規則

分類標題中的計數預設表示目前 scope 內的總數：

```text
MCP Servers (N)
Tools (N)
Skills (N)
```

若要顯示搜尋後數量，使用：

```text
Tools (2/8)
```

不要在同一介面中混用兩種計數語義。

---

## 7. 左側分類列表

### 7.1 固定分類順序

預設順序：

1. MCP Servers
2. Tools
3. Skills

分類標題格式：

```text
[group icon] [group label] ([count])
```

例如：

```text
⌘ MCP Servers (N)
⚒ Tools (N)
✦ Skills (N)
```

### 7.2 分類圖示

推薦映射：

```text
⌘  MCP Servers
⚒  Tools
✦  Skills
```

規則：

- 每個分類只使用一個固定圖示。
- 圖示不隨狀態改變。
- 圖示應使用單 cell 或經實測可穩定對齊的字符。
- `⚒` 建議搭配文字顯示選擇符 `U+FE0E`，避免 emoji 呈現。

### 7.3 分類標題樣式

- 分類標題使用 normal 或略強於 item 的字重。
- 分類標題本身預設不可選。
- 分類間不額外加水平線。
- 以縮排和空行建立區隔。
- 分類標題與第一個 child 之間不插入空行。

### 7.4 Item 結構

一般 item：

```text
  ● tool-1
```

選中 item：

```text
→ ● tool-1
```

結構：

```text
[selection indicator] [status indicator] [item label]
```

規則：

- Selection indicator 固定寬度。
- 未選中項目保留相同縮排。
- 所有 status indicator 對齊。
- 所有 item label 從相同位置開始。

---

## 8. Selection 與狀態符號

### 8.1 Selection

```text
→
```

表示目前由鍵盤選中的 item。

規則：

- 只允許一個可見 item 顯示 `→`。
- Selection 不等於 enabled 或 active。
- Selection 移動不會自動改變 item 狀態。
- 選中行可以使用 accent 或 highlight 樣式。

### 8.2 Status

介面只有三種 item status：

```text
●  active
◎  inherit
○  disabled
```

字符定義：

- `●`：`U+25CF BLACK CIRCLE`，表示項目在目前 scope 明確啟用。
- `◎`：`U+25CE BULLSEYE`，只表示 `inherit`，即沿用上層或預設配置。
- `○`：`U+25CB WHITE CIRCLE`，表示項目在目前 scope 明確停用。

規則：

- `◎` 不可用於 disabled、inactive 或其他語義。
- `○` 只表示 disabled。
- 不存在 unavailable、error、warning、pending 等其他 item status。
- 顏色只作輔助，符號和狀態文字必須保持一致。
- 同一狀態在 MCP Servers、Tools、Skills 中使用相同符號。
- Description panel 中的 Status 必須與左側列表完全一致。

例如：

```text
Status: ● active
Status: ◎ inherit
Status: ○ disabled
```

### 8.3 隱藏項目提示

當列表只展示部分項目時，可使用：

```text
  ...
```

規則：

- `...` 表示中間有項目被省略。
- 此行不可選。
- 不使用 status indicator。
- 不影響項目總計數。
- 若列表支援正常垂直滾動，優先使用滾動而非永久插入 `...`。

---

## 9. Item 標籤溢出

### 9.1 未選中

- 超出可用欄寬時直接截斷。
- 不換行。
- 不推動 Description panel。
- 可不顯示省略號，以減少噪音。

### 9.2 選中

- 選中項目的 label 可在固定 viewport 中水平滾動。
- Selection indicator 和 status indicator 保持固定。
- Description panel 顯示完整 item name。
- 取消選中後，label 恢復顯示開頭。

---

## 10. 列表導航與滾動

### 10.1 導航

```text
↑/↓ navigate
```

- `↑` 選擇前一個可選 item。
- `↓` 選擇後一個可選 item。
- 分類標題及 `...` 行預設跳過。
- 導航跨越分類邊界時保持連續。
- 到達首尾時可停止，不循環。

### 10.2 垂直滾動

- Selection 離開可視區域時，自動調整 scroll offset。
- 優先保持選中項目位於列表中段。
- 列表可不顯示 scrollbar，以維持低噪音。
- 若顯示 scrollbar，置於左欄最右側，不侵入 Description panel 間距。

---

## 11. Description panel

### 11.1 基本結構

```text
╭─ Description ────────────────────╮
│ tool-1 (tool) · 1772 tokens      │
│                                  │
│ Tool description here .........  │
│ ...............................  │
│ ..................               │
│                                  │
│ Origin: build-in                 │
│ Status: ● active                 │
│                                  │
│ Instruction:                     │
│ tool instruction for model here. │
│ ................................ │
│ ................................ │
│                                  │
╰──────────────────────────────────╯
```

### 11.2 Panel 行為

- Description panel 為唯讀。
- 不接受 focus。
- 不參與 `←/→` 或 `↑/↓` 導航。
- 內容跟隨左側 selection 即時更新。
- 不顯示 scrollbar。
- 不支援 panel 內文字選擇或展開。
- Panel 高度跟隨主內容可用高度。
- Panel 寬度保持穩定，不因內容改變。

### 11.3 顏色層級

Description panel 的基礎內容使用 dim 或 secondary 樣式：

- 邊框：dim / secondary。
- 一般標籤：dim。
- Description body：dim。
- Instruction body：dim。
- Metadata：dim。

可使用 accent 強調：

- `Description` 標題。
- 當前 item name。
- Item type。
- Token count。
- Status symbol。

不得讓多種 accent 同時競爭注意力。推薦只保留：

1. Panel title accent。
2. Selected item summary accent。
3. Status semantic color。

---

## 12. Description panel 內容結構

### 12.1 Summary line

格式：

```text
[item name] ([type]) · [token count] tokens
```

例如：

```text
tool-1 (tool) · 1772 tokens
```

規則：

- Item name 優先完整顯示。
- Type 使用括號。
- Token count 使用整數。
- Metadata 以 `·` 分隔。
- 若 token count 不適用，省略該段：

```text
mcp-1 (mcp)
```

### 12.2 Description

- Summary line 後保留一個空行。
- Description 採固定行數摘要。
- 使用 word wrap。
- 超出可用行數時在最後一行顯示 `...`。
- 不因 Description 長度改變後續 metadata 的位置。

### 12.3 Origin

格式：

```text
Origin: build-in
```

可用值例如：

```text
build-in
project
global
plugin
external
```

若產品內部正式名稱是 `built-in`，介面應統一使用該拼法，不混用 `build-in`。

### 12.4 Status

格式：

```text
Status: ● active
Status: ◎ inherit
Status: ○ disabled
```

規則：

- Status symbol 與左側列表一致。
- Status text 只允許 `active`、`inherit`、`disabled`。
- `inherit` 表示狀態由上層或預設配置決定。
- `◎` 只可搭配 `inherit`。
- `○` 只可搭配 `disabled`。
- 不以顏色取代 status text。

### 12.5 Instruction

格式：

```text
Instruction:
tool instruction for model here.
................................
```

規則：

- `Instruction:` 獨佔一行。
- 內容從下一行開始。
- 採固定行數摘要。
- 使用 word wrap。
- 超出長度時在最後一行顯示 `...`。
- Instruction 區域不支援滾動。

---

## 13. 空資料與缺失欄位

### 13.1 空分類

空分類可顯示：

```text
⚒ Tools (0)
  No tools
```

其中 `No tools` 使用 dim。

若介面空間不足，也可只顯示：

```text
⚒ Tools (0)
```

### 13.2 無 Description

```text
No description provided.
```

### 13.3 無 Instruction

```text
Instruction:
None
```

### 13.4 無 Selection

若搜尋後沒有任何結果：

```text
No matching items
```

Description panel 顯示：

```text
No item selected.
```

---

## 14. Toggle 行為

### 14.1 操作

```text
↵ toggle
```

- `Enter` 切換目前 item 的狀態。
- 可切換的狀態集合只包含：
  - `● active`
  - `◎ inherit`
  - `○ disabled`
- 不進入獨立編輯模式。
- 切換成功後 selection 保持不變。
- 左側 status indicator 立即更新。
- Description panel 中的 Status 同步更新。
- 切換順序應由實作固定，不可因分類或 item 而改變。
- 不得在切換過程中產生第四種狀態。

### 14.2 切換失敗

切換失敗時：

- 恢復原 status。
- 不移動 selection。
- 在底部提示區上方顯示短暫錯誤訊息。
- 錯誤訊息屬於 transient feedback，不是 item status。
- 不以 modal 中斷一般導航，除非需要使用者確認。

---

## 15. 底部操作提示

### 15.1 固定格式

```text
↑/↓ navigate · ←/→ tab · ↵ toggle · ⇥ global · ⎋ close
```

每個提示由以下結構組成：

```text
[key symbol] [action]
```

提示之間使用：

```text
 · 
```

### 15.2 按鍵符號

統一使用：

```text
↑ ↓     上下導航
← →     頁籤切換
↵       Enter
⇥       Tab
⎋       Escape
```

### 15.3 Action 文案

使用小寫英文：

```text
navigate
tab
toggle
global
close
```

Scope 目標可動態改變：

```text
⇥ global
⇥ project
```

### 15.4 窄畫面退化

空間不足時，依次縮短：

完整：

```text
↑/↓ navigate · ←/→ tab · ↵ toggle · ⇥ global · ⎋ close
```

縮短：

```text
↑/↓ nav · ←/→ tab · ↵ toggle · ⇥ global · ⎋ close
```

最小：

```text
↑/↓ · ←/→ · ↵ · ⇥ · ⎋
```

底部操作提示應維持正常亮度，不因主內容狀態而 dim。

---

## 16. 響應式行為

### 16.1 寬模式

當終端寬度足夠：

- 左側列表和右側 Description panel 並排。
- Description panel 使用固定或受限寬度。
- 左側列表取得剩餘空間。
- 兩欄之間保留至少 2 cells。

推薦約束：

```text
Description width: 32–44 cells
List minimum width: 24 cells
Gap: 2–4 cells
```

### 16.2 窄模式

當無法同時滿足最小欄寬：

- 隱藏 Description panel。
- 左側列表佔滿主內容寬度。
- 保留 Scope、搜尋、列表和 footer。
- Selection 與 toggle 功能不受影響。

窄模式範例：

```text
 ╭─────────╮╭──────────╮
 │⚙ Set... ││⚙ Loadout │
─┴─────────┴╯          ╰────────────────────
✎ Project · /Users/.../.pi/config.json

> _

⌘ MCP Servers (N)
  ● mcp-1
  ● mcp-2
  ...
  ● mcp-3
⚒ Tools (N)
  ● tool-1
  ● tool-2
→ ◎ tool-3
  ● tool-4
  ● tool-5
✦ Skills (N)
  ● skill-1
  ● skill-2

↑/↓ nav · ←/→ tab · ↵ toggle · ⇥ global · ⎋ close
──────────────────────────────────────────────
```

此規範不要求在窄模式下重排完整 Description；需要詳細內容時可另行加入 detail overlay，但不屬於目前基礎設計。

---

## 17. 顏色語義

顏色應透過語義樣式管理，不直接散落於各元件。

### `accent`

適用於：

- Active tab。
- Selection indicator。
- Selected item label。
- Description panel title 或 summary line。

### `active`

適用於：

- `● active`。
- 明確啟用 item 的 status indicator。

### `inherit`

適用於：

- `◎ inherit`。
- 沿用上層或預設配置的 status indicator。

### `disabled`

適用於：

- `○ disabled`。
- 明確停用 item 的 status indicator。

### `normal`

適用於：

- 分類標題。
- 一般 item label。
- 搜尋 prompt。
- Footer 操作提示。

### `secondary`

適用於：

- Configuration path。
- Metadata label。
- Token count。
- Type。
- 次要符號。

### `dim`

適用於：

- Description body。
- Instruction body。
- 空值提示。
- Inactive tab。
- `...` 省略行。
- 不可用操作。

色彩只增強層級，不取代符號、文字或結構。

---

## 18. 排版與空白

- 使用等寬字體。
- 不使用 Tab 字符進行對齊。
- 使用空格控制 cell 對齊。
- 頁籤下方緊接 Scope 行。
- Scope 行與搜尋欄之間保留一個空行。
- 搜尋欄與第一個分類之間保留一個空行。
- 分類之間可不留空行，以保持資訊密度。
- 主內容底部與 footer 之間至少保留一個空行。
- Footer 下方使用完整水平線收尾。
- Description panel 內左右各保留一格 padding。

---

## 19. 建議狀態模型

介面至少需要保存：

```text
active_tab
scope
config_source
query
selected_item_id
list_scroll_offset
visible_groups
item_statuses
description_summary
instruction_summary
```

每個 item 至少包含：

```text
id
name
type
group
origin
status
description
instruction
token_count
toggleable
```

---

## 20. 核心互動原則

1. Active tab 由開放底部結構和 accent color 表達。
2. `←/→` 只用於切換頂部頁籤。
3. `⇥` 切換 Project / Global scope。
4. `↑/↓` 只在可選 item 之間導航。
5. 分類標題和 `...` 行不接受 selection。
6. `→` 表示 selection，不表示 active。
7. `●`、`◎`、`○` 分別表示 `active`、`inherit`、`disabled`，且沒有其他 item status。
8. `Enter` 切換選中 item 的狀態。
9. 左側 status 與 Description panel Status 必須同步。
10. Description panel 永遠唯讀且不接受 focus。
11. 搜尋結果保留分類結構。
12. Description 和 Instruction 只顯示固定長度摘要。
13. 寬度不足時隱藏 Description panel，不壓縮到不可讀。
14. Footer 操作提示保持單行並固定在底部。
15. 所有關鍵狀態均同時由結構、符號或文字表達，不只依賴顏色。
