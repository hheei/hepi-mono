# 原版 pi Theme 設計語言

這份文件整理官方 pi 內建 `dark` / `light` theme 與 interactive TUI 元件的實際使用方式，作為本專案統一介面風格的基準。

參考來源：

- `@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json`
- `@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json`
- `dist/modes/interactive/theme/theme.js`
- interactive message、tool、selector、editor、footer 元件

## 1. 核心原則

### 1.1 用語義 token，不直接在元件內決定顏色

元件只表達意圖，例如 `accent`、`muted`、`toolErrorBg`、`mdHeading`。具體色值由 theme 決定。這讓 dark/light theme 可以替換，而不用改元件結構。

### 1.2 背景色是少數例外，不是通用卡片底色

官方只為幾種有明確語義的區塊提供背景：

- user message
- extension/custom message
- tool pending/success/error
- selected row

assistant 普通文字、footer、selector 的一般列、thinking 內容都保持 terminal 背景，不額外包卡片。

### 1.3 狀態用色彩，選取用位置與文字

選中項目通常同時使用：

- accent 色
- `→ ` 游標/箭頭
- 必要時 `✓` 表示目前值

不要只依賴背景色表示選中，也不要為每個選項建立獨立彩色 badge。

### 1.4 低裝飾、單層容器、保留空白

官方元件通常是：

1. spacer
2. 一條全寬 border
3. 內容
4. 一條全寬 border

間距使用 1 行 spacer 與 0/1 格水平 padding。卡片、圓角、陰影、漸層都不是核心語言。

## 2. Token 分層

### 2.1 Core UI

| Token | 用途 | 視覺角色 |
| --- | --- | --- |
| `text` | 一般正文 | 最高頻、保持穩定對比 |
| `accent` | logo、選中項、游標、重要標題 | 主要互動焦點 |
| `muted` | 次要正文、tool output、selector description | 可讀但退後 |
| `dim` | footer、hint、極次要資訊 | 最低優先級 |
| `border` | 一般分隔線 | 結構，不搶焦點 |
| `borderAccent` | 強調中的邊框 | 互動或焦點結構 |
| `borderMuted` | editor 一般邊框 | 非互動內容的低對比結構 |
| `success` | 完成、成功、可用 | 正向狀態 |
| `warning` | 警告、中高 context 使用量 | 需注意但未失敗 |
| `error` | 失敗、取消、危險 | 明確錯誤 |

官方 dark theme 的基準色大致是：正文 `#d4d4d4`、accent `#8abeb7`、一般 border `#5f87ff`、muted `#808080`、dim `#666666`。light theme 對應為深色文字、低飽和 teal/blue/green/red。

### 2.2 區塊背景

| Token | 使用方式 |
| --- | --- |
| `userMessageBg` | 整個 user message 的背景；搭配 `userMessageText` |
| `customMessageBg` | extension message 的背景；搭配 label/text |
| `toolPendingBg` | tool 尚未完成時的背景 |
| `toolSuccessBg` | tool 成功完成後的背景 |
| `toolErrorBg` | tool 出錯後的背景 |
| `selectedBg` | 通用可選列表的 selected row 背景；官方部分 selector 主要仍以 accent/arrow 表示 |

背景應使用低飽和、低對比色。背景的任務是辨識區塊/狀態，不是吸引注意。

### 2.3 Markdown

| Token | 用途 |
| --- | --- |
| `mdHeading` | heading |
| `mdLink` / `mdLinkUrl` | link text / URL |
| `mdCode` | inline code |
| `mdCodeBlock` / `mdCodeBlockBorder` | code block 內容 / fence |
| `mdQuote` / `mdQuoteBorder` | quote 內容 / 左側結構線 |
| `mdHr` | horizontal rule |
| `mdListBullet` | list bullet |

Markdown 不是另一套品牌色，而是正文內的語法階層。code、quote、link 要能辨識，但不能壓過正文。

### 2.4 Tool diff 與 syntax

`toolDiffAdded` / `toolDiffRemoved` 使用 success/error 語義；context 使用 muted。syntax token 只服務程式碼可讀性，不應拿來裝飾一般 UI。

### 2.5 Thinking 與 mode

編輯器邊框是 model mode 的狀態指示：

- `thinkingOff` 到 `thinkingMax`：由低存在感逐步增加辨識度
- `bashMode`：編輯器進入 `!` shell 模式時使用

這是「同一個元件的狀態邊框」，不是整個頁面換色。footer 同時以文字顯示 model 與 thinking level。

## 3. 各介面元素的官方用法

### 3.1 User message

- 用 `Box` 包住整段內容。
- `userMessageBg` 作整塊背景。
- 內容用 `userMessageText`。
- 水平 padding 通常 1，垂直 padding 1。
- 不另外加 user label、頭像或多層框線。

**規則：** user input 是明確的視覺區塊；不需要再用粗體、accent、第二層卡片強調。

### 3.2 Assistant message

- 一般 assistant markdown 沒有背景。
- 內容前後用少量 spacer 分開。
- thinking 以 `thinkingText` 顯示，並使用 italic；隱藏 thinking 時只留一個 muted/italic label。
- 失敗、abort、輸出超過上限使用 `error`，且放在內容之後。
- 有 tool call 時不額外插入 assistant message 的 transcript frame。

**規則：** assistant 是主要閱讀流；保持 terminal 背景與正常正文對比，避免把每段回答做成卡片。

### 3.3 Tool execution

- 外層先留 1 行空間。
- 有 tool renderer 時使用 `Box`，水平/垂直 padding 通常 1。
- pending、success、error 只切換背景 token。
- tool 名稱使用 `toolTitle` + bold。
- fallback output 使用 `toolOutput`，通常是 muted/灰色。
- tool 內容需要可收合時，狀態仍由背景與提示文字表達，不新增多色標籤。

**規則：** tool 是工作狀態區塊，不是訊息氣泡；成功與 pending 的差異主要在背景，錯誤才提高語義強度。

### 3.4 Bash execution

- 使用上下兩條全寬 border。
- command header 使用 `bashMode` + bold，例如 `$ command`。
- 執行中 spinner 也使用 bashMode。
- 輸出使用 muted。
- `!!`、不送入 context 的 command 可降為 dim border。
- 完成、錯誤、取消等狀態用文字與 status token 補充。

**規則：** shell 是 editor/tool flow 的特殊 mode，保持同色上下框線，避免把每行輸出染成 status color。

### 3.5 Selector / model selector

- 上下 border 使用 `border`。
- 標題使用 accent + bold。
- 搜尋/輸入保持一般文字。
- 選中列使用 `→ `、accent 的 label/text。
- 未選中 provider、description、scroll info 使用 muted。
- 目前項目可用 `✓` + success。
- error 使用 error；無結果使用 muted，而不是紅色。

**規則：** selector 的視覺焦點只有一個。選中態優先使用箭頭與 accent，provider 等 metadata 必須退後。

### 3.6 Settings list

官方 `SettingsList` 的角色分配：

- selected label：accent
- selected value：accent
- normal value：muted
- description：dim
- cursor：accent `→ `
- hint：dim

這建立了清晰的資訊階層：設定名稱 > 當前值 > 描述 > 操作提示。

### 3.7 Editor

- 一般 editor border 使用 `borderMuted`。
- thinking level 改變時，只替換 editor border color。
- bash mode 使用 `bashMode` border。
- autocomplete 遵循 selector theme。
- editor 內文保持 `text`，不要把輸入內容染成 accent。

**規則：** border 是 mode/status indicator；輸入文字本身不因 mode 改色。

### 3.8 Footer / status line

Footer 是低優先級資訊：

- working directory、git branch、extension status：`dim`
- token/cost/context stats：整體 `dim`
- context > 70%：warning
- context > 90%：error
- model name 位於右側，與左側統計對齊
- extension status 以單行排列並截斷

**規則：** footer 不應與主要內容競爭；只有需要採取行動的 context 警告才提升顏色。

### 3.9 Custom / extension message

- 預設使用 `customMessageBg`。
- label 使用獨立 `customMessageLabel` + bold，例如 `[type]`。
- 正文使用 `customMessageText`。
- 只有 extension 自己提供 renderer 時才允許自己決定更細的樣式。

## 4. 色彩決策規則

### 使用 accent

- 當前選擇
- 主要互動焦點
- mode/editor 狀態邊框
- 關鍵標題或游標

### 使用 muted

- metadata
- tool output
- description
- thinking 內容
- link URL、scroll info

### 使用 dim

- footer
- keyboard hint
- 次要狀態
- 非主要 command 的 border

### 使用 success / warning / error

只表示狀態，不表示分類：

- success：成功、目前值、完成
- warning：可繼續但需注意
- error：失敗、取消、超限、危險

不要用 success 表示「一般可用」的裝飾，不要用 error 作為普通 empty state。

## 5. 形狀、間距與密度

- 以全寬單線 border 作結構。
- 一個資訊區塊最多一層背景容器。
- 預設水平 padding 0 或 1；主要 message/tool 為 1。
- 元件之間以 1 行 spacer 分組。
- 不使用圓角、陰影、漸層、浮動大卡片。
- 不讓字級承擔所有階層；優先使用色彩角色、粗體、italic、空白。
- 狹窄終端必須 truncate/wrap，不能讓內容突破寬度。

## 6. 對本專案的落地要求

1. 先建立一個共用 semantic theme adapter，所有 concrete extension UI 只使用 token，不直接寫 hex。
2. 先統一 token 命名與使用規則，再調整各模組 layout；不要一邊改元件一邊新增顏色。
3. 所有 panel 先判斷它是 message、tool、selector、editor、footer 還是 status；只能選一個主角色。
4. panel 的背景只允許對應到 user/custom/tool/selected 四類語義。
5. 選中 row 一律採用 accent + `→ `；目前值可加 success `✓`，不要每個 row 使用不同色。
6. description/hint/footer 統一落到 dim；metadata/tool output 統一落到 muted。
7. error/warning/success 只在狀態發生時出現，不能當一般品牌色。
8. 所有自訂元件都要支援 theme reload/invalidate；不要把舊 theme 的 ANSI 結果永久 bake 在 component tree。
9. 任何新的色彩 token 必須先說明其語義與使用邊界；若只是另一個元件需要不同色，優先檢查是否應重用既有 token。

## 7. 快速檢查表

- 這個顏色是在表達語義，還是在補救 layout？
- 這個背景是否真的代表 message/tool/selection 狀態？
- 選中態是否仍可只靠箭頭 + accent 理解？
- 正文是否仍是最高頻、最穩定的顏色？
- muted 與 dim 是否有清楚的優先級差異？
- error/warning 是否只在需要注意時出現？
- 是否出現巢狀卡片、過多 border、過多 badge 或多套 accent？
- 窄 terminal 下是否能 wrap/truncate？
- theme hot reload 後是否所有已 render 元件都更新？
