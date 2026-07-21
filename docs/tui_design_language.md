# TUI 設計語言規範

## 1. 設計定位

此介面採用 terminal-native 的設計語言，以 Unicode 線框、等寬字體、有限色彩層級和鍵盤操作為核心。

設計原則：

- 不模仿傳統 GUI。
- 不使用陰影、漸層或大面積背景填色。
- 以單線 Unicode 邊框建立區域層級。
- 以空白而非過多分隔線區分內容。
- 所有主要操作均可由鍵盤完成。
- Active、Selected、Edit 等狀態不能只依賴顏色表達。
- 所有排版以 terminal cell 為單位。
- 圖示和 Unicode 字符必須確認在目標字體中的顯示寬度。

---

## 2. 整體畫面結構

畫面由三個主要區域構成：

1. 頂部頁籤區。
2. 主內容區。
3. 底部操作提示區。

寬畫面：

```text
 ╭─────────╮╭──────────╮
 │⚙ Set... ││⏣ Loadout │
─╯         ╰┴──────────┴───────────────────────────────

> type to search                 ╭ Description ────────╮
                                 │ Key: setting-1      │
→ setting-1            true      │                     │
  setting-2            false     │ setting-description │
  setting-3            true      │ here. Must wrap ... │
  a-very-long-                   │                     │
                                 │ Value: true         │
                                 ╰─────────────────────╯

↑/↓ navigate · ←/→ tab · ↵ edit/toggle · ⎋ close
────────────────────────────────────────────────────────
```

窄畫面：

```text
 ╭─────────╮╭──────────╮
 │⚙ Set... ││⏣ Loadout │
─╯         ╰┴──────────┴────────────────

> type to search

→ setting-1            ABCDE
  setting-2            false
  setting-3            true

Value:
> ABCDE

↑/↓ navigate · ←/→ tab · ↵ edit/toggle · ⎋ close
─────────────────────────────────────────
```

---

## 3. 邊框語言

### 3.1 基本字符

統一使用 Unicode rounded box-drawing characters：

```text
╭ ╮
╰ ╯
─ │
```

### 3.2 使用規則

- 一律使用單線邊框。
- 優先使用圓角。
- 不混用圓角、直角和雙線邊框。
- 邊框只用於：
  - 頁籤。
  - Description panel。
  - 模態窗口。
  - 具備明確獨立語義的容器。
- 主列表本身不加邊框。
- 左側列表與右側 Description panel 之間以空白分隔，不加垂直線。

---

## 4. 頂部頁籤

### 4.1 Active 頁籤

Active 頁籤底部開放，直接連接主內容區：

```text
 ╭─────────╮
 │⚙ Set... │
─╯         ╰────────────────────────────
```

規則：

- Active 頁籤不顯示底部水平線。
- 頁籤左右邊框向下連接至主分隔線。
- Active 頁籤與主內容區視為同一平面。
- 可使用 accent color 進一步強調。
- 即使無色彩，仍可由開放底部識別 active 狀態。

### 4.2 Inactive 頁籤

Inactive 頁籤保持完整封閉：

```text
╭──────────╮
│⏣ Loadout │
╰──────────╯
```

規則：

- 顯示完整上下左右邊框。
- 顏色比 Active 頁籤弱。
- 與相鄰頁籤緊貼，不保留額外空格。

### 4.3 頁籤內容

頁籤內容格式：

```text
[icon] [label]
```

例如：

```text
⚙ Settings
⏣ Loadout
```

規則：

- 圖示位於標題前。
- 圖示與標題之間保留一格。
- 頁籤左右各保留一格內邊距。
- 頁籤寬度由內容決定。
- 超出最大寬度時使用 `...` 截斷。
- `←/→` 用於切換頁籤。

---

## 5. 搜尋欄

搜尋欄使用 terminal prompt 形式：

```text
> type to search
```

規則：

- 使用 `>` 作為提示符。
- 提示符與文字之間保留一格。
- 不加獨立邊框。
- 未輸入時顯示 placeholder。
- 開始輸入後 placeholder 完全消失。
- 搜尋結果即時更新。
- 在 Edit mode 中，整個搜尋欄使用 dim 樣式。

---

## 6. 設定列表

### 6.1 列表行結構

每一行由三部分構成：

```text
[indicator] [key viewport] [value]
```

例如：

```text
→ setting-1            true
  setting-2            false
  setting-3            true
```

### 6.2 選中指示

- 使用 `→` 表示目前選中項目。
- 未選中行在相同位置保留空白。
- Indicator 區域寬度固定。
- 所有 Key 從同一列開始。

### 6.3 Key 欄

- Key 左對齊。
- Key 欄佔主要寬度。
- Key 與 Value 之間保留空白。
- 不顯示 `Key:` 前綴。
- 未選中時，過長 Key 直接截斷。
- 不使用 `...`。
- 不換行。
- 不影響 Value 欄位置。

例如：

```text
  a-very-long-         value
```

### 6.4 選中 Key 的水平顯示

當選中的 Key 超出欄寬時：

- Key 在固定 viewport 內水平滾動。
- 只移動 Key 內容。
- Indicator 和 Value 欄保持固定。
- 取消選中後恢復顯示 Key 開頭。

### 6.5 Value 欄

- Value 欄從固定列開始。
- Value 左對齊。
- 不因 Key 長度移動。
- Boolean 值使用小寫：

```text
true
false
```

- Value 超出欄寬時直接截斷。
- 不允許 Value 推動其他欄位。

---

## 7. Description panel

### 7.1 基本結構

```text
╭ Description ────────╮
│ Key: setting-1      │
│                     │
│ setting-description │
│ here. Must wrap ... │
│                     │
│ Value: true         │
╰─────────────────────╯
```

### 7.2 顏色規則

Description panel 一律使用 dim 顏色，包括：

- Panel 邊框。
- `Description` 標題。
- `Key:` 標籤。
- Key 內容。
- Description 文字。
- `Value:` 標籤。
- 非編輯狀態下的 Value。

唯一例外：

- 在 Edit mode 中，正在編輯的 Value 文字和游標使用 highlight。
- Description panel 其餘內容仍保持 dim。
- Panel 邊框不因 Edit mode 改變顏色。

### 7.3 內容順序

內容固定按照以下順序排列：

1. Key。
2. 空行。
3. Description。
4. 空行。
5. Value。

### 7.4 Description 摘要

- Description 使用固定行數。
- 根據面板內部寬度 word wrap。
- 超出固定行數時截斷。
- 最後一行尾部顯示 `...`。
- 不提供 scrollbar。
- 不接受 focus。
- 不因內容增加而改變面板高度。

---

## 8. 響應式佈局

### 8.1 寬模式

畫面足以同時顯示列表和 Description panel 時：

- 左側顯示搜尋欄和設定列表。
- 右側顯示 Description panel。
- Description panel 不接受 focus。
- Value 編輯器顯示於 Description panel 的 `Value:` 後方。

### 8.2 窄模式

畫面不足以顯示 Description panel 時：

- 完全隱藏 Description panel。
- 不顯示 Description。
- 不顯示 `Key: xxx`。
- 列表佔用完整可用寬度。
- 在列表下方顯示兩行 Value 區域：

```text
Value:
> ABCDE
```

位置順序：

1. 搜尋欄。
2. 列表。
3. Value 區域。
4. 底部操作提示。

### 8.3 窄模式 Value 溢出

未編輯時：

- 單行顯示。
- 超出寬度直接截斷。
- 不換行。

編輯時：

- 使用水平 viewport。
- 始終確保游標可見。
- 不增加區域高度。

---

## 9. Value 類型

Value 分為兩類：

1. Boolean。
2. 非 Boolean。

### 9.1 Boolean Value

包括：

```text
true / false
yes / no
on / off
```

操作：

- 按 `Enter` 直接切換。
- 不進入文字編輯模式。
- 左側列表和 Description/Value 區域立即同步更新。
- 選中項目保持不變。

### 9.2 非 Boolean Value

包括：

- 文字。
- 數字。
- 路徑。
- 枚舉文字。
- 其他需要輸入的值。

操作：

- 第一次按 `Enter`：進入 Edit mode。
- 第二次按 `Enter`：確認並提交。
- 按 `Esc`：取消並恢復原值。

---

## 10. Edit mode

### 10.1 暫存值模型

Edit mode 使用兩份值：

- Committed value：已提交值。
- Draft value：正在編輯的暫存值。

規則：

- 左側列表始終顯示 committed value。
- 編輯器顯示 draft value。
- 輸入期間不即時更新列表。
- 只有確認後，draft value 才寫入 committed value。

---

## 11. 寬模式 Edit mode

範例：

```text
> type to search                 ╭ Description ────────╮
                                 │ Key: setting-1      │
→ setting-1            ABCDE     │                     │
  setting-2            false     │ setting-description │
  setting-3            true      │ here. Must wrap ... │
                                 │                     │
                                 │ Value: new-value█   │
                                 ╰─────────────────────╯

↵ confirm · ⎋ cancel
────────────────────────────────────────────────────────
```

### 11.1 左側樣式

進入 Edit mode 後：

- 當前選中行整行 highlight。
- Indicator、Key 和 committed Value 均屬於 highlight 行。
- 其他列表行使用 dim。
- Search bar 使用 dim。
- 列表中的 committed Value 不因輸入而改變。

### 11.2 Description panel 樣式

Description panel 一律 dim：

- 邊框 dim。
- 標題 dim。
- Key dim。
- Description dim。
- `Value:` 標籤 dim。

正在編輯的部分：

```text
Value: new-value█
       └────────┘
       highlight
```

- 只有 draft value 和 `█` 游標 highlight。
- `Value:` 標籤保持 dim。
- Panel 邊框和其他元素保持 dim。
- 不額外繪製輸入 box。

---

## 12. 窄模式 Edit mode

範例：

```text
> type to search

→ setting-1            ABCDE
  setting-2            false
  setting-3            true

Value:
> new-value█

↵ confirm · ⎋ cancel
─────────────────────────────────────────
```

樣式規則：

- Search bar dim。
- 當前選中行整行 highlight。
- 其他列表行 dim。
- `Value:` 標籤保持正常或 secondary 樣式。
- `>`、draft value 和游標使用 highlight。
- 列表中的 committed Value 保持不變。
- 操作提示正常顯示，不 dim。

---

## 13. Edit mode 操作

### 13.1 文字輸入

Edit mode 中可支援：

- 普通字符輸入。
- Backspace。
- Delete。
- `←/→` 移動文字游標。
- Home / End。
- `Enter` 確認。
- `Esc` 取消。

在 Edit mode 中：

- `←/→` 不切換頁籤。
- `↑/↓` 不切換列表項目。
- 所有導航焦點鎖定於 Value editor。

### 13.2 確認

按 `Enter`：

- 驗證 draft value。
- 驗證成功後寫入 committed value。
- 左側列表更新。
- Description 或窄模式 Value 區域同步更新。
- 游標消失。
- 返回 Navigation mode。
- 選中項目保持不變。

### 13.3 取消

按 `Esc`：

- 丟棄 draft value。
- 恢復 committed value。
- 左側列表始終不變。
- 游標消失。
- 返回 Navigation mode。
- 不關閉介面。

---

## 14. Focus 與狀態

### 14.1 Navigation mode

可用操作：

```text
↑/↓ navigate
←/→ tab
↵ edit/toggle
⎋ close
```

### 14.2 Edit mode

可用操作：

```text
↵ confirm
⎋ cancel
```

底部操作提示保持正常亮度，不做 dim。

### 14.3 Description panel

- 永遠不接受一般 focus。
- 不支援滾動。
- 不支援鍵盤導航。
- 只作為目前選中項目的上下文資訊。
- 唯一可互動內容是 Edit mode 中的 Value editor。

---

## 15. 底部操作提示

### 15.1 Navigation mode

```text
↑/↓ navigate · ←/→ tab · ↵ edit/toggle · ⎋ close
```

### 15.2 Edit mode

```text
↵ confirm · ⎋ cancel
```

規則：

- 不顯示 `type to edit`。
- 不顯示不必要的按鍵說明。
- 操作提示始終保持正常亮度。
- 不因其他區域 dim 而變暗。
- 不足寬度時，可從右側開始移除低優先級提示。

---

## 16. 顏色層級

建議建立以下語義樣式，而非直接在各元件中硬編碼顏色：

### `accent`

適用於：

- Active tab。
- Selected indicator。
- 主要互動焦點。

### `highlight`

適用於：

- Edit mode 中的選中列表行。
- Draft value。
- 閃爍游標。

### `normal`

適用於：

- Navigation mode 中的一般列表行。
- 搜尋欄。
- 底部操作提示。

### `dim`

適用於：

- Description panel 全部內容。
- Inactive tab。
- Edit mode 中的搜尋欄。
- Edit mode 中未選中的列表行。
- 次要文字。

### `secondary`

可選，用於：

- Value 欄。
- `Value:` 等 metadata 標籤。
- 非主要但仍需保持可讀的資訊。

---

## 17. 排版規則

- 使用等寬字體。
- 不使用 Tab 字符對齊。
- 所有欄位以空格對齊。
- 邊框內左右各保留一格 padding。
- 列表項目固定一行。
- 搜尋欄與列表之間保留一個空行。
- 寬模式中列表與 Description panel 之間保留至少 2–4 cells。
- 窄模式 Value 區域固定佔兩行。
- 不在 Value 區域加入額外外框。

---

## 18. Unicode 按鍵符號

統一使用：

```text
↑ ↓     上下導航
← →     左右切換
↵       Enter
⎋       Escape
␠       Space
```

多個同類按鍵使用 `/` 連接：

```text
↑/↓
←/→
```

---

## 19. 核心互動原則

1. Active tab 由開放底部和 accent color 表達。
2. `←/→` 在 Navigation mode 中切換頁籤。
3. Description panel 一律 dim。
4. Boolean Value 按一次 `Enter` 直接切換。
5. 非 Boolean Value 按一次 `Enter` 進入 Edit mode。
6. Edit mode 中，左側列表只顯示 committed value。
7. Draft value 只顯示在：
   - 寬模式的 Description panel。
   - 窄模式的 Value 區域。
8. 第二次按 `Enter` 後才更新列表。
9. Edit mode 中，選中行 highlight，其他行和 Search bar dim。
10. 底部操作提示始終正常顯示。
11. Description panel 中只有正在編輯的 Value 和游標 highlight，其餘全部 dim。
12. 窄模式不顯示 Description、Key metadata 或說明文字。
