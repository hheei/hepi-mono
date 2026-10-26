# Pi Ext Addon

`@hheei/pi-ext-addon` 是 Pi host 的可選增強集合，提供獨立、opt-in 的功能擴展。

## 包含功能

1. **Dollar Skill References (`dollar-skill`)**：
   * `$skill-name` 自動補全、輸入展開為 skill 檔案路徑與原子編輯器移動/刪除。
   * 預設關閉（opt-in），配置項位於 `dollar-skill`。
2. **Auto Session Title (`auto-title`)**：
   * 在首個穩定對話輪次後自動生成簡潔會話標題，亦可手動透過 `/auto-title` 觸發。
   * 預設關閉（opt-in），配置項位於 `auto-title`。
3. **Codemode Syntax Guard (`codemode-syntax-guard`)**：
   * 見下節。

## Codemode Syntax Guard

`codemode` 的腳本在 QuickJS 中執行。QuickJS 的編譯錯誤只有 `SyntaxError: <message>` 加上 `codemode.js:LINE:COL`，沒有原始碼行與 caret；當錯誤落在數百字元的長行（例如整段 patch 文字）上時，模型無法定位問題。

本守衛在 `tool_call` 階段用 **與 pi-codemode runtime 完全相同的 wrapper** 在宿主 V8 中編譯腳本：

```
(async (tools, console) => {<code>
})
```

wrapper 前綴與腳本首行共用，因此 V8 回報的行號就是模型看到的行號（首行 `// @options:` 註解在兩邊都只是註解）。

### 契約

| 行為 | 說明 |
|---|---|
| 只處理 `codemode` 且 `parentToolCallId === undefined` | 巢狀呼叫由父腳本自行回報 |
| `event.input` 必須是 record 且 `code` 為非空字串 | 其餘一律放行，交給 `parseCodemodeSource` 報它自己的錯誤 |
| 只在 `error instanceof SyntaxError` 時 block | QuickJS 專屬限制（如 parser 遞迴深度）必須留給工具 |
| 永不設定 `terminate` | 一次拼字錯誤不得終止整個 turn |
| block 原因只加原始碼行與 caret | 訊息主體仍是 QuickJS 原樣的 `SyntaxError: <message>`，不追加建議文字 |

### 輸出格式

```
SyntaxError: Unexpected identifier 'node'

  3 | -Run with `node --test x` ok.
    |            ^^^^
```

只補上 `line | source` 與 caret，不追加任何建議或教學文字，保持與原版訊息一樣精簡。

### 已知邊界

* **假陰性（可執行程式被誤攔）**：需要 V8 語法比 QuickJS-NG 更窄。實測 100+ 個語法構造（新語法、嚴格模式違規、sloppy 特性、模板、邊界字元）為 0 例。若未來出現，方向是「誤攔」，屬回歸，必須由測試兜住。
* **假陽性（不可執行程式被放行）**：存在且不可消除。深度約 1000–2000 的巢狀括號 V8 可編譯但 QuickJS 編譯期 stack overflow；QuickJS 版本固定在 wasm 內，未來語法漂移同理。退化為今天的行為，仍由工具報錯。
* **管不到**：`@options` 行格式（純註解，語法上恆合法）、執行期錯誤（未知工具、`text()` 參數型別、VM 逾時、輸出上限）。

### Handler 順序

`emitToolCall` 在第一個 `block` 處 `return`，後續 handler 看不到該呼叫。若有 handler 需要改寫 `codemode` 的 `event.input`，必須註冊在守衛之前。

## 設定

所有功能均在 `/ext-settings` 中獨立提供設定面板與開關。
每個 Pi session 在 lifecycle cleanup 時清理對應的 hook 與資源。
