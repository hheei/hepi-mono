# pi-ext-tools 自動摺疊長工具計畫

## 1. 使用者目標

在互動式 TUI 中，`grep`、`read`、`write` 等長輸出工具完成後，現在要等下一個 agent turn 才會依既有 Trace 規則摺疊。這會讓上一回合的大量輸出持續佔用畫面，降低目前回合的可讀性。

新增一個設定，控制已標記為長輸出的工具：

| 模式 | 行為 |
| --- | --- |
| `auto` | 工具完成後等待 15 秒，再自動摺疊；同時保留現有 Trace collapse 規則 |
| `pertrace` | 完全保留目前規則，只在既有 prior Trace / global expansion 規則下摺疊 |
| `off` | `neverCollapsed`：停用本功能與既有 prior Trace 的**外層 frame 自動摺疊**；不改變既有 body row cap，但使用者仍可透過全域 expand 展開完整 body |
| `on` | 工具完成後立即摺疊，不等待 15 秒 |

> `off` 的正式語義是 `neverCollapsed`：它是最高優先級的**自動 frame policy**，明確停用 timer 與既有 prior Trace frame collapse；它不會移除既有 `maxBodyLines` body cap。使用者透過全域 expand 的顯式操作仍具有更高優先級，可以強制所有工具展開完整 body。`pertrace` 是既有 prior Trace 行為；沒有設定時使用 `auto`，`auto` / `on` 則增加完成後 frame collapse。

第一版不讓使用者自行編輯工具清單。長工具由 concrete extension 在 `ToolTui.frame()` 呼叫時明確宣告，初始 allowlist 建議為 `grep`、`read`、`write`、`find`、`edit`、`bash`；若某工具的 body 本來就是短摘要，則不應標記為長工具。`apply_patch` 不在此 allowlist，其既有 renderer collapse 行為維持不變。

## 2. 研究結果

### 2.1 現有 pi-ext-core frame lifecycle

`packages/pi-ext-core/src/tool-tui.ts` 已經是所有 `pi-ext-tools` tool renderer 的共同邊界：

- `ToolTui.frame()` 包裝 tool 的 `execute`、`renderCall`、`renderResult`。
- `ToolTraceController` 追蹤 `agent_start` 形成的 Trace、tool completion、latest result，以及 `context.invalidate`。
- `registerToolTuiTrace()` 在 `agent_start` / 非 startup `session_start` 推進 Trace，並在 `session_shutdown` 清理 registration。
- `ToolFrameSection` 負責 header 與 call-phase body。
- `ToolBodySection` 負責 result body、paired rails、typed footer，以及目前的 `maxBodyLines`。
- 目前既有 collapse 條件是 `!context.expanded && historical`。historical 由 tool 是否位於 prior Trace 判定。
- explicit global expand 必須先於所有自動 policy：顯式展開時永遠輸出完整 frame。
- `off` 停用 timer 與 historical **frame** auto-collapse；`pertrace` 保持 historical frame 行為；`auto` / `on` 對已宣告的長工具增加 completed-result frame collapse。
- 目前 collapsed result 只回傳 footer；header 由 call slot 的 collapsed `ToolFrameSection` 保留。這已接近「header + footer」的目標，但沒有 timer-triggered per-tool state。

因此，timer 不應由 grep/read/write 各自實作，也不應透過修改 model-visible `content` 達成；應由 core 的 shared frame state 觸發 invalidate，再由同一個 frame policy 決定 call/result 各自輸出。

本功能的 lifecycle ownership 也必須明確：`registerToolTuiTrace()` 負責 shared trace session reset；`pi-ext-tools` 是 collapse mode 的唯一 owner。session replacement/shutdown 必須清除 records、timer 與 invalidate callback，並使舊 generation callback 失效。其他 consumer 不得靜默覆寫 mode。

### 2.2 現有 pi-ext-tools settings contract

`packages/pi-ext-tools/src/fff/settings.ts` 已使用 `@hheei/pi-ext-core` 的 settings contract：

- `createJsonSettingsStorage()` 將 global/project 設定存放於 `ext_settings.json`。
- `SettingsProvider` / `SettingGroup` / `SettingField` 負責註冊設定 UI 與驗證。
- `packages/pi-ext-tools/src/fff/lifecycle.ts` 在 extension lifecycle 中註冊 provider。
- 既有 settings provider 對 malformed 或缺失值採用明確 default，不自動讀取舊 `settings.json`。

新設定應沿用這個 contract，而不是在 `tool-tui.ts` 直接讀檔或建立第二套設定來源。建議使用專用 top-level group `toolTui`，欄位 `collapseMode`，避免與既有 `fff`、`bash`、`edit`、`targets`、`eval` 群組混用。

建議 JSON 形狀：

```json
{
  "toolTui": {
    "collapseMode": "auto"
  }
}
```

這個設定屬於 `pi-ext-tools` 的產品政策；core 只接受 consumer 傳入的 mode，不應依賴 `pi-ext-tools` 的設定檔或工具名稱。

### 2.3 Pi / upstream contract research

官方 Pi extension/tool rendering contract 的相關討論顯示，工具 renderer 的 `expanded`、`renderCall`、`renderResult` 是 host lifecycle 的既有邊界；目前沒有可供 extension 直接呼叫的通用 per-tool `setToolExpanded(toolCallId, false)` contract。相關 issue 也把「per-tool collapse」列為需要 host API 或 tool-result metadata 才能支援的功能：

- Pi issue [#3114](https://github.com/badlogic/pi-mono/issues/3114)：討論長工具輸出的 collapse、`expanded` 與缺少 per-tool collapse API。
- Pi issue [#3071](https://github.com/earendil-works/pi/issues/3071)：討論 render-only tool middleware，說明 execution ownership 與 rendering ownership 的邊界。
- Pi issue [#2934](https://github.com/badlogic/pi-mono/issues/2934)：指出不合法 renderer component 會直接導致 TUI crash，說明 renderer 必須維持有效 component、寬度與 lifecycle contract。

本 repo 的 `ToolTui` 已自行擁有 shared frame，因此本功能可以在 extension-owned wrapper 內實現，不需要修改 Pi host；但仍必須把它視為 render state policy，而不是把結果內容截斷或偷偷重送 tool result。

### 2.4 UI/UX 約束

`DESIGN.md` 的 Tools contract 規定：

- 每個 tool frame 有 header、paired rails、tool-owned body、typed footer。
- collapse 後保留 status header 與 tool-owned metrics footer。
- header、rails、footer 不計入 body row cap。
- model-visible `content` 不因 TUI collapse 而修改。
- 所有行必須 ANSI-safe、Unicode/cell-width-safe。
- `bash` command header 是單行 compact metadata，不得因 command 內含換行而增加 frame 高度；長度超過 terminal width 時使用 dim trailing `…` 截斷。

因此本功能的「摺疊」定義為：

```text
status header
blank line
typed footer
```

實際 frame 仍由 host 的 call/result slot 組合；core 必須確保 collapsed presentation 的可見內容總共只保留 header 與 footer 這兩個 semantic rows（中間 blank line 是否由 host/container 固定插入，需在測試中固定，不得因工具 renderer 而產生 body rails 或額外輸出）。不應把 body 的第一行、最後一行或 raw model content 當作 footer。

## 3. 建議設計

### 3.1 Core public contract

在 `packages/pi-ext-core/src/tool-tui.ts` 擴充既有 `ToolTui` contract：

```ts
type ToolCollapseMode = "auto" | "pertrace" | "off" | "on";

type ToolTuiPresentation = {
  readonly longOutput?: boolean;
  readonly singleLineHeader?: boolean;
  // existing fields...
};

interface ToolTui {
  beginTrace(): void;
  resetSession(): void;
  setToolCollapseMode(mode: ToolCollapseMode, owner: symbol): void;
  // existing methods...
}
```

只保留一個配置入口與兩個明確的 presentation flags：

- `singleLineHeader: true` 是通用的 cell-width-safe header contract；`bash` 使用它確保 command header 在 current、partial、historical、collapsed、`off` 所有 phase 都只佔一個 logical row。
- `longOutput: true` 表示此 frame 參與 `auto` / `on`；core 不認識 grep/read/write 等工具名稱。
- `pertrace` 使用現有 Trace 行為。
- `auto` 是沒有設定時的預設值：保留 per-trace 行為，並讓標記為 `longOutput` 的 completed tool 在 15 秒後自動摺疊。
- `auto` 使用固定 15,000ms；不提供 `delayMs` 設定，避免增加尚未提出的產品選項。
- `on` 完成後立即摺疊標記為 `longOutput` 的工具。

- `off` 停用所有自動 frame collapse，包含既有 prior Trace collapse；但不改變既有 body row cap，`context.expanded === true` 仍可顯示完整 body。

`setToolCollapseMode(mode, owner)` 只接受已註冊的 policy owner；第一版由 `pi-ext-tools` 建立一個 module-local owner token，core 不依賴 extension 名稱。`registerToolTuiTrace()` 擁有 trace lifecycle，並在每次 session replacement/shutdown 呼叫 `resetSession()`：清除 timer、清空/失效 records、斷開 invalidate callback、遞增 generation。舊 callback 必須通過 generation 與 record identity 檢查，不能影響新 session。

`pi-ext-tools` 在 lifecycle start 讀取 settings 後設定 mode；session end 後 shared mode 回到 `auto`。已 frame 的 tool wrapper 讀取 shared policy，因此 reload/session replacement 後不會保留舊 policy state。

`ToolFrameSection` 在 `singleLineHeader` 下必須先將 CR/LF 及其他 line separator 替換為單一空格，再以 `truncateToWidth()` 輸出單一 row；這是 current header 的 contract，不是 collapsed-only 行為。輸入中的 ANSI 必須遵守既有安全 rendering contract。

### 3.2 Timer ownership 與 state machine

每個已完成且標記為 `longOutput` 的 tool record 最多持有一個 timer。timer 在 `execute()` 成功完成時建立；render 只讀取 record state，不負責開始倒數：

```text
running -> completed
              |
              | mode=on: collapse now
              | mode=auto: collapse after 15s
              | mode=pertrace/off: existing policy only
              v
           collapsed
```

必要新增 state：

- `ToolRecord` 的 `timer?: ReturnType<typeof setTimeout>`
- `ToolRecord` 的 `timerCollapsed?: boolean`
- timer callback 捕獲的 record identity 與 session generation
- shared policy mode

不需要額外建立另一個 per-tool state machine；timer callback 必須同時確認 session generation 仍有效且 `tools.get(toolCallId) === record`，再呼叫 record 的 `invalidate()`。

1. `execute()` 成功完成後才建立 timer，partial `renderCall` 或 streaming update 不建立。
2. `on` 在 `execute()` 成功完成時直接將 record 標記為 `timerCollapsed`；`auto` 建立固定 15,000ms timer。
3. `renderResult()` 只負責讀取 collapse state 與呼叫既有 renderer；不能因 render 次數重設 timer。
4. timer callback 只更新 record 並呼叫已註冊的 `invalidate()`；不修改 result content、details 或 model context。
5. `renderResult()` 只在 record 已完成且非 expanded 時套用 collapsed result/footer；collapsed path 不呼叫長 body renderer。
6. `pertrace` 保持現有 historical frame 判斷；`off` 不執行 historical frame collapse。
7. session shutdown、非 startup `session_start`、reload 與 extension disposal 清除所有 timer；cleanup 必須 idempotent。
8. 新 agent turn 沿用既有 `beginTrace()` 清理 prior records 與 pending timer；session replacement 後的 timer callback 仍需通過 record identity/session generation guard。

### 3.3 Header/footer rendering

將目前 `historical` 和新的 `timerCollapsed` 統一成 collapse decision：

```text
context.expanded === true -> false
mode=off                  -> false
otherwise                 -> historical || timerCollapsed
```

只在以下條件成立時套用 collapse：

- `context.expanded === false`
- tool result 已完成
- record 被 policy 標記為 collapsed
- frame 有可渲染的 header/footer

collapsed call phase：

- `ToolFrameSection` 只 render header。
- 不 render call body、preview 或 rails。

collapsed result phase：

- 先 restore completion metadata。
- 呼叫 typed footer（若有）並套用 error/warning/duration fallback。
- 不呼叫 `renderResult` body renderer；collapsed footer 不得依賴 body renderer。
- footer 不解析 `result.content`，也不修改 model-visible result。

`context.expanded === true` 是使用者顯式操作，具有最高優先級，必須勝過 `neverCollapsed`、`auto`、`on`、historical 與 timer collapse；renderer 應立即顯示完整 body。`off` / `neverCollapsed` 只停用自動摺疊，不阻止全域 expand。這需要把 user expansion 與 policy state 分開，不可單純把 `collapsed` 寫死在 record。

### 3.4 pi-ext-tools settings integration

新增 `createToolTuiSettingsProvider()` 或併入既有 FFF lifecycle，但建議獨立 provider，因為 collapse 是跨 grep/read/write 的 TUI policy，不是 FFF enhancement。

Provider 建議：

- id：`pi-ext-tools.tool-tui`
- group：`toolTui`
- field：`collapseMode`
- type：`enum`
- options：`auto`、`pertrace`、`off`、`on`
- `off` 代表 core 的 never-collapsed frame mode，停用所有自動 frame collapse，但仍允許使用者透過全域 expand 顯式展開
- 預設值：`auto`，讓沒有設定時啟用長工具的 15 秒自動摺疊
- description 必須說明 `auto` 的 15 秒、`on` 的立即行為，以及只作用於標記為長輸出的工具

`pi-ext-tools/src/extension.ts` 在 lifecycle start 時讀取 merged global/project settings，解析出 mode，配置 core ToolTUI。設定在 `/reload` 或新 session 生效；不應讓 settings page 的暫存 draft 直接改寫既有 tool render records。

若現有 settings lifecycle 尚未提供能同步更新 shared ToolTUI 的 API，plan 的實作順序應是先建立明確的 session-scoped configure API，再接 provider；不要讓 provider callback 直接 mutate module global。

### 3.5 長工具宣告

各 concrete tool registration 在 `tui.frame(tool, presentation)` 內宣告：

```ts
const tool = tui.frame(definition, {
  longOutput: true,
  // existing summary/footer/maxBodyLines...
});
```

`bash` 同時需要這個長工具宣告與獨立的單行 command header contract；它的長指令不能只靠 collapse 在 15 秒後才處理，partial/current render 也必須立即 cut 成一行。

第一版建議標記：

- `longOutput`：`grep`、`read`、`write`、`find`、`edit`、`bash`

第一版矩陣：

| Tool | `longOutput` | collapsed footer | 備註 |
| --- | --- | --- | --- |
| `grep` | yes | typed metrics footer | 新 policy owner |
| `read` | yes | typed metrics footer | 新 policy owner |
| `write` | yes | typed mutation footer | 新 policy owner |
| `edit` | yes | typed mutation footer | 新 policy owner |
| `find` | yes | typed metrics footer | 新 policy owner |
| `bash` | yes | typed exit/duration footer | `singleLineHeader` |
| `ls` | no | existing behavior | 需另行產品決策 |
| `bash_job` | no | existing behavior | 需另行產品決策 |
| `apply_patch` | no | existing behavior | 不屬於長輸出 |

只有矩陣中標記為 `yes` 的 registration 才傳入 `longOutput: true`；未列入工具維持既有 renderer 行為。

## 4. 實作範圍

### Core

- 擴充 `ToolTuiPresentation` 或等價 frame policy contract。
- 加入 session-scoped collapse policy 與 per-tool record。
- 加入 timer/disposer/cancellation/generation guard。
- 讓 `ToolFrameSection` / `ToolBodySection` 共享 collapsed decision。
- 保持 ANSI/cell-width-safe header/footer rendering。
- 不引入工具名稱判斷、不讀 `ext_settings.json`、不修改 model-visible result。

### pi-ext-tools

- 新增 tool-TUI settings provider、解析與 `auto` fallback。
- lifecycle start/reload 時配置 core policy。
- 為初始長工具清單加上 `longOutput: true`；`apply_patch` 維持既有 registration，不加入新 policy。
- 補充設定說明與 `ext_settings.json` 範例。

### Documentation

- 更新 `DESIGN.md` 的 Tools contract，加入 15 秒 auto collapse、四模式與「header + footer only」定義。
- 更新 `packages/pi-ext-core/README.md` 或 core development doc，記錄 policy ownership、cleanup、expanded precedence。
- 本 plan 在實作完成後轉為 architecture/feature doc 或保留為歷史計畫，避免只把 contract 留在 plan。

## 5. 測試計畫

### Core focused tests

在 `packages/pi-ext-core/test/tool-tui.test.ts` 或既有 ToolTui 測試新增：

- mode decision、timer、record identity/session generation、cleanup，以及 `context.expanded` precedence。
- `singleLineHeader` 的 current/partial/historical/off 測試，包含 bash 多行、超長、ANSI/CJK command。
- collapsed frame 只保留 header/footer，且不輸出 body rails/body rows。

1. `pertrace`：沒有新增 timer，既有 prior Trace collapse 行為保持不變。
2. `off`：即使 tool 位於 prior Trace 或 timer 到期，仍保持完整 header 與既有 body presentation；不移除 `maxBodyLines` cap。顯式 global expand 仍可顯示完整 body。
3. `auto`：沒有設定時的預設模式；completed `longOutput` tool 在 14.9 秒仍完整，15 秒後只有 header/footer。
4. `on`：completed `longOutput` tool 下一次 render 立即只有 header/footer。
5. 未標記 `longOutput`：任何 mode 都不受新增的 timer/on collapse 影響。
6. `context.expanded === true`：無論 mode，使用者顯式 expand 後都不被任何自動 policy 收回。
7. partial/streaming：不啟動 timer、不丟掉 live body。
8. error/cancel：保留 error footer，timer 不產生 stale mutation。
9. session reset / timer race：覆蓋 timer callback 先於 reset、reset 先於 timer callback、session replacement 後同名 `toolCallId`、以及 timer 在首次 render 前到期；舊 record 不得觸發新 session render。
10. 同一 extension 多個 concurrent tool call：每個 timer 獨立，不能互相摺疊。
11. collapsed `renderResult()` 不呼叫 body renderer，footer 仍保留 error/warning/duration。
12. collapsed output 的 visible rows 僅包含 header/footer contract，且不包含 body rails/body rows。
13. `bash` 的 `singleLineHeader` 在 current、partial、historical、collapsed、`off` 所有 phase 都只輸出一行，且 visible width 不超過 terminal width。
14. `singleLineHeader` 對 summary override、pattern/path、remote label 同樣先 normalize line separators，再驗證 ANSI/CJK 與窄 terminal 寬度。

15. `visibleWidth()` 驗證中文、ANSI、窄 terminal 下 header/footer 不超寬。

Fake timer 必須以 Vitest timer API 控制；測試要檢查 `invalidate` 次數、cleanup、首次 render 前到期與 collapsed body renderer 未呼叫，而不是 sleep 真實 15 秒。

### pi-ext-tools tests

1. settings parser 對四種值、缺失值、invalid value 的 `auto` fallback/validation。
2. provider group/id/options/description 符合 settings registry contract。
3. global/project settings merge 的 precedence。
4. 初始長工具 registration 會傳 `longOutput: true`；短工具不會。
5. mode change 只在 lifecycle/reload contract 指定的時點生效。
6. grep/read/write 的 collapsed view 都保留 typed footer；`apply_patch` 不由新 long-output policy 接管。
7. model-visible `content` 與 `details` 在 collapse 前後完全不變。

### 手動 TUI verification

在 terminal width 80、136、200 分別執行：

- 產生超過 20 行的 `grep` / `read` / `write` output。
- 驗證 `auto` 15 秒前後的 frame。
- 驗證 `on`、`pertrace`、`off`，以及無設定時的 `auto` 預設。
- 驗證 Ctrl+O 展開後不會被 timer 再收回。
- 驗證新回合、`/reload`、session replacement 後沒有 stale render 或 crash。
- 使用 `visibleWidth`/crash snapshot 確認每一行不超出 terminal width。

## 6. 風險與決策

### 6.1 `off` 語義

`off` 是使用者設定值；在說明文件中可稱為 `neverCollapsed`，但 runtime 只保留 `off` mode，不建立額外 alias。它停用所有自動 frame collapse：

- 不建立 auto timer。
- 不執行 `on` 的 immediate collapse。
- 不執行既有 prior Trace collapse。
- 使用者透過全域 expand 的顯式操作仍優先於任何自動 policy，並顯示完整 frame。

完整優先順序是：`context.expanded === true` > `off` 的自動停用效果 > `auto/pertrace/on` 的自動判定。

### 6.2 Timer 與 host render lifecycle

Pi host 只會在 renderer 被要求重繪時重新取得 component。Timer 必須持有 core-owned `invalidate` callback；不能只改 boolean 而期待畫面自行更新。若 host 的 `context.invalidate` 只對目前 component 有效，timer callback 必須驗證 record identity，避免跨 session 使用 stale callback。

### 6.3 Expanded state precedence

自動摺疊不應覆蓋使用者明確展開。若 Pi host 的 `context.expanded` 是全域 toggle 而非 per-tool state，core 必須以「render 時 expanded 優先」的方式處理，不要另造一個與 host toggle 衝突的 UI shortcut。

### 6.4 完成後 timer 是否應 reset

一個 tool call 只能有一個 auto timer。partial updates、footer repaint 或 repeated render 不得重新計時；只有 result completion 時建立一次 timer。新的 agent turn 只會走既有 Trace transition，不應為舊工具重新開始 15 秒倒數。

## 7. 建議實作順序

1. 先在 core 為現有 `ToolTui` 建立可測試的 collapse decision function 和 per-record timer ownership。
2. 以 `pertrace` policy 跑完既有 tests，確認既有 Trace 行為零變更；再驗證沒有設定時的 `auto` fallback。
3. 加入 `on` / `auto`，完成 fake-timer regression tests。
4. 接入 `pi-ext-tools` settings provider，先只解析和配置，不改工具清單。
5. 為 grep/read/write 等工具加 `longOutput` 宣告，補 renderer-specific tests。
6. 更新 `DESIGN.md`、core docs、README/settings example。
7. 執行 focused Biome、core/tools tests、package builds、typecheck；最後做窄/寬 terminal 手動驗證。

## 8. 驗收條件

- 沒有設定時使用 `auto`；標記長工具在 result 完成 15 秒後自動摺疊。
- `pertrace` 下現有所有 tool trace 行為不變。
- `off` / `neverCollapsed` 下任何 tool trace 都不會因 prior Trace 或 timer 觸發外層 frame collapse；body 仍遵守既有 `maxBodyLines` presentation，顯式 global expand 可顯示完整 body。
- `auto` 下，標記長工具在 result 完成 15 秒後可見內容只剩 header/footer。
- `on` 下，標記長工具完成後下一次 render 即只剩 header/footer。
- `off` / `neverCollapsed` 下不會因 prior Trace 或 timer 自動摺疊外層 frame；body 保持既有 presentation，顯式 global expand 仍可強制所有工具展開。
- collapse 不修改 model-visible result，不修改 persistent tool details，不影響 Ctrl+O 展開。
- 所有 timer 在 session replacement、reload、shutdown 後清除，沒有 stale invalidate 或跨 session mutation。
- 所有 header/footer 在窄終端 ANSI/CJK 寬度下不會造成 TUI crash。
- `bash` 的多行、超長 command 在所有 phase 都只輸出一行，且 visible width 不超過 terminal width。
