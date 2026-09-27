# pi-ext-tools 自動摺疊長工具計畫

## 1. 使用者目標

在互動式 TUI 中，`grep`、`read`、`write`、`bash` 等長輸出工具完成後，現在要等下一個 agent turn 才會依既有 Trace 規則摺疊。這會讓目前回合的大量輸出持續佔用終端高度，降低可讀性。

新增一個設定，控制已標記為長輸出的工具（`longOutput: true`）：

| 模式 | 行為 |
| --- | --- |
| `auto` | 工具完成後等待 15 秒，再自動摺疊；執行期間支援完整串流（streaming），同時保留現有 Trace collapse 規則（預設值） |
| `on` | 工具完成後立即摺疊，不等待 15 秒；**且在此模式下 `bash` 等工具不需要串流輸出**，避免終端高度劇烈展開又瞬間縮合引起的畫面閃爍（flicker）與效能浪費 |
| `pertrace` | 完全保留目前規則，只在既有 prior Trace / global expansion 規則下於下一回合摺疊 |
| `off` | `neverCollapsed`：停用本功能與既有 prior Trace 的**外層 frame 自動摺疊**；不改變既有 body row cap，但使用者仍可透過全域 expand（Ctrl+O）展開完整 body |

> `off` 的正式語義是 `neverCollapsed`：它是最高優先級的**自動 frame policy**，明確停用 timer 與既有 prior Trace frame collapse；它不會移除既有 `maxBodyLines` body cap。使用者透過全域 expand 的顯式操作具有更高優先級，可以強制所有工具展開完整 body。`pertrace` 是既有 prior Trace 行為；沒有設定時預設使用 `auto`。

第一版不讓使用者自行編輯工具清單。長工具由 concrete extension 在 `ToolTui.frame()` 呼叫時明確宣告 `longOutput: true`，初始 allowlist 為 `grep`、`read`、`write`、`find`、`edit`、`bash`；若某工具的 body 本來就是短摘要（如 `ls`、`apply_patch`），則不應標記為長工具，其既有行為維持不變。

## 2. 研究結果

### 2.1 現有 pi-ext-core frame lifecycle

`packages/pi-ext-core/src/tool-tui.ts` 是所有 `pi-ext-tools` tool renderer 的共同邊界：

- `ToolTui.frame()` 包裝 tool 的 `execute`、`renderCall`、`renderResult`。
- `ToolTraceController` 追蹤 `agent_start` 形成的 Trace、tool completion、latest result，以及 `context.invalidate`。
- `registerToolTuiTrace()` 在 `agent_start` / 非 startup `session_start` 推進 Trace，並在 `session_shutdown` 清理 registration。
- `ToolFrameSection` 負責 header 與 call-phase body。
- `ToolBodySection` 負責 result body、paired rails、typed footer，以及目前的 `maxBodyLines`。
- 目前既有 collapse 條件是 `!context.expanded && historical`。historical 由 tool 是否位於 prior Trace 判定。
- explicit global expand 必須先於所有自動 policy：顯式展開時永遠輸出完整 frame。
- 目前 collapsed result 只回傳 footer；header 由 call slot 的 collapsed `ToolFrameSection` 保留。

### 2.2 效能、閃爍與 on 模式下 bash 串流的關鍵分析

在終端 TUI 渲染架構下：
1. **靜態長工具（`grep`、`read`、`write`、`find`、`edit`）**：
   - 在 `on` 模式下，`execute()` 返回完成時，該 record 立即被標記為 `timerCollapsed = true`。
   - Pi host 隨後首次呼叫完成態的 `renderResult(result, { isPartial: false, expanded: false })` 時，**直接走折疊分支（Header + Footer），完全不呼叫長 body renderer**。
   - **絕不能**先渲染一次展開的完整 body 再於下一幀折疊。直接走折疊路徑不仅跳過大量 ANSI 染色與分行計算（效能最高），而且完全消除了終端高度突增又縮回造成的抖動與 `clear-on-shrink` 白閃/殘影。
2. **串流工具（`bash`）**：
   - `bash` 在執行過程中通常會透過 `onUpdate` 逐塊推播即時輸出。
   - 如果在 `on` 模式下依然允許串流，終端會先被撐開數十行，進程退出瞬間又立刻被砍成 2 行（Header + Exit Footer），使用者根本來不及看清末尾日誌，且會造成嚴重的終端畫面閃爍與高度跳躍。
   - **因此明確規定：在 `on` 模式下，標記為 `longOutput` 的工具（如 `bash`）不啟用串流輸出（`onUpdate` 不向宿主 UI 派發 live partial output）**。
   - 執行期間只維持 Compact Header（如 running 提示）；完成後直接呈現 Header + Exit Footer，實現全生命週期高度穩定、零閃爍、極致效能。
   - 在 `auto`、`pertrace`、`off` 模式下，`bash` 維持正常的 live streaming 串流輸出；其中 `auto` 模式在命令完成後提供 15 秒閱讀時間，之後再平滑收起。

### 2.3 生命周期與定時器嚴密管理

為防止並發 tool call、中途中斷或測試運行中殘留未決的 Node.js 定時器（Timer Leak）：
- 所有 15 秒定時器由 session 統一的定時器池/清理器管理（可綁定 `AbortSignal` 與 `DisposerRegistry`）。
- 定時器必須在以下事件中**冪等清除**：
  1. 新回合推進（`agent_start` / `beginTrace`）；
  2. 使用者取消/中止（`signal.aborted`）；
  3. 會話重置、切換分支或熱重載（`session_start`、`session_tree`、`/reload`、`resetSession`）；
  4. 擴充被 dispose。
- 定時器 callback 必須通過 session generation 與 record identity 驗證，過期 callback 靜默失效，不允許觸發跨 session 重繪。

### 2.4 現有 pi-ext-tools settings contract

`packages/pi-ext-tools/src/fff/settings.ts` 已使用 `@hheei/pi-ext-core` 的 settings contract：
- `createJsonSettingsStorage()` 將 global/project 設定存放於 `ext_settings.json`。
- `SettingsProvider` / `SettingGroup` / `SettingField` 負責註冊設定 UI 與驗證。
- 新設定使用專用 group `toolTui`，欄位 `collapseMode`。
- 在 `/ext-settings` 介面呈現時，使用通俗易懂的名稱與說明：
  - **Group Label**: `Tool Output`
  - **Field Label**: `Auto-collapse`
  - **Options**: `auto`, `on`, `pertrace`, `off`
  - **Default**: `auto`
  - **Description**: 各模式解析置於說明文字中：
    - `auto`: 工具完成後等待 15 秒自動摺疊（保留串流輸出，預設值）；
    - `on`: 工具完成後立即摺疊（抑制 `bash` 等串流輸出，避免終端跳躍）；
    - `pertrace`: 下一回合開始時摺疊（既有 Trace 行為）；
    - `off`: 停用外層 frame 自動摺疊（遵守 `maxBodyLines` 上限）。

## 3. 建議設計

### 3.1 Core public contract

在 `packages/pi-ext-core/src/tool-tui.ts` 擴充 `ToolTui` 介面：

```ts
type ToolCollapseMode = "auto" | "pertrace" | "off" | "on";

type ToolTuiPresentation = {
  readonly longOutput?: boolean;
  readonly maxBodyLines?: number;
  readonly footer?: ToolFooterRenderer<unknown>;
  readonly warning?: (result: AgentToolResult<unknown>) => boolean;
  readonly summary?: ToolSummaryRenderer<unknown, unknown>;
  readonly summarySeparator?: string;
  readonly remotePathSummary?: boolean;
};

interface ToolTui {
  beginTrace(): void;
  resetSession(): void;
  setToolCollapseMode(mode: ToolCollapseMode): void;
  getToolCollapseMode(): ToolCollapseMode;
  // existing frame and execution methods...
}
```

**架構精簡原則（遵循 AGENTS.md）**：
- **不引入推測性抽象**：刪除原計劃中的 `owner: symbol`。`ToolTui` 在 session 內單純由 `pi-ext-tools` 配置與使用，直接提供 `setToolCollapseMode(mode)` 即可，不增加無呼叫方的多權限防護包裝。
- **不污染 Core 通用 Presentation**：原計劃中的 `singleLineHeader` 改為通用欄位 `headerLine: "wrap" | "truncate"`（預設 `wrap`），由需要它的工具自己選擇；`bash` 因為 body 只渲染 output、無法還原 command，選用 `truncate`。core 仍然不硬編碼任何具體工具名稱。
- `longOutput: true`：明確標記該工具參與自動摺疊策略；core 不硬編碼任何具體工具名稱。

### 3.2 狀態機、Timer 與串流抑制

每個工具執行的狀態流轉如下：

```text
[Start Execution]
       |
       +---> mode === 'on' && longOutput:
       |        不發送 live onUpdate 串流，僅保持 running header
       |
       +---> otherwise:
                正常發送 live onUpdate 串流
       |
[execute() Completed]
       |
       +---> mode === 'on' && longOutput:
       |        直接標記 timerCollapsed = true
       |        首次 renderResult 即為 Collapsed (Header + Footer)，不呼叫 body renderer
       |
       +---> mode === 'auto' && longOutput:
       |        保持展開狀態，註冊 15,000ms 定時器
       |        15 秒到期後呼叫 invalidate() 切換為 timerCollapsed = true
       |
       +---> mode === 'pertrace':
       |        保持展開狀態，直到下一回合 beginTrace() 依 historical 規則摺疊
       |
       +---> mode === 'off':
                永不自動摺疊外層 frame (neverCollapsed)
```

**關鍵細節**：
1. **串流抑制（Stream Suppression）**：
   - 在 `tui.frame` 包裝的 `execute` 內部：
     ```ts
     const forwardUpdate = (update: AgentToolResult<TDetails>): void => {
       trace.update(toolCallId, update);
       if (collapseMode === "on" && presentation.longOutput) {
         // on 模式下不向宿主 UI 派發 live partial update
         return;
       }
       onUpdate?.(update);
     };
     ```
   - 這樣既保證了 trace 內部狀態正常記錄，又阻止了宿主 UI 產生滾動的中間態行。
2. **零二次重繪（Zero Double-Render）**：
   - 在 `on` 模式下，`execute()` 返回前 `record.timerCollapsed` 就已經是 `true`。
   - 宿主收到的第一個完成態 render 事件直接落入 `collapsed` 分支，只輸出 Header + Footer。
3. **Timer 資源清理**：
   - `resetSession()` 與 `beginTrace()` 立即呼叫 `clearTimeout` 清空所有記錄中的 timer。
   - 所有定時器在非瀏覽器環境下可標記 `.unref()`，避免阻塞進程正常關閉。

### 3.3 摺疊判定與優先級

Frame 的最終摺疊決策公式：

```text
context.expanded === true -> 展開完整 body (最高優先級，使用者顯式操作)
mode === 'off'            -> 展開 (neverCollapsed，遵守既有 maxBodyLines cap)
otherwise                 -> historical || timerCollapsed
```

- **Call Phase（`renderCall`）**：
  - 若處於 collapsed 狀態，`ToolFrameSection` 僅輸出 status header，不輸出 call preview 或 rails。
- **Result Phase（`renderResult`）**：
  - 若處於 collapsed 狀態，直接調用 typed footer（或 error/warning fallback），輸出 `Text(theme.fg("dim", summary))`。
  - **堅決不調用**工具自帶的 `renderResult` body renderer，節省 CPU 與字串操作開銷。

### 3.4 bash 長指令 Header 的具體實現

`bash` 的 header 由 `tool-tui.ts` 既有的 bash 分支產生（該分支已擁有 command 內容）：

- 多行 command 的換行符號（`\r?\n`）會以 `; ` 串接成單一 logical line，讓讀者仍能分辨原本的行邊界；行尾是 `\`
  續行或已是 `;` 時不重複插入分隔符。
- `bash` 在 `frame()` 中聲明 `headerLine: "truncate"`，因此超寬 command 由 `singleLineHeader()` 以 dim `…` 截斷，
  header 永遠佔用一行；timeout suffix 會預留寬度而保持可見。
- 其他工具不聲明 `headerLine`，維持既有「未折疊 header 會換行」契約，`grep` 的 path 在窄終端仍完整可見。

### 3.5 Settings 整合

在 `pi-ext-tools` 中新增 `createToolTuiSettingsProvider()`：

```ts
{
  id: "pi-ext-tools.tool-tui",
  group: "toolTui",
  title: "Tool Output",
  fields: [
    {
      id: "collapseMode",
      label: "Auto-collapse",
      type: "enum",
      options: [
        { value: "auto", label: "auto" },
        { value: "on", label: "on" },
        { value: "pertrace", label: "pertrace" },
        { value: "off", label: "off" }
      ],
      default: "auto",
      description: "Controls automatic folding of long output tools (grep, read, write, find, edit, bash).\n- auto: Collapse 15s after completion (streaming enabled, default)\n- on: Collapse immediately upon completion (suppresses streaming output)\n- pertrace: Collapse on next agent turn\n- off: Never auto-collapse outer frame"
    }
  ]
}
```

- 預設值為 `auto`。
- `pi-ext-tools` 在 session 啟動與 `/reload` 時讀取設定並呼叫 `tui.setToolCollapseMode(mode)`。

### 3.6 長工具標記矩陣

在 `packages/pi-ext-tools/src/` 的工具註冊中：

| Tool | `longOutput: true` | `on` 模式下抑制串流 | 備註 |
| --- | --- | --- | --- |
| `grep` | yes | N/A (無串流) | 標記長工具 |
| `read` | yes | N/A (無串流) | 標記長工具 |
| `write` | yes | N/A (無串流) | 標記長工具 |
| `edit` | yes | N/A (無串流) | 標記長工具 |
| `find` | yes | N/A (無串流) | 標記長工具 |
| `bash` | yes | **yes (抑制 onUpdate)** | 標記長工具，內聚處理單行 header |
| `ls` | no | no | 短輸出，維持既有行為 |
| `bash_job` | no | no | 維持既有行為 |
| `apply_patch`| no | no | 維持既有行為 |

## 4. 實作範圍

### 1. Core (`packages/pi-ext-core`)
- 在 `tool-tui.ts` 擴充 `ToolCollapseMode` 與 `ToolTuiPresentation.longOutput`。
- 實作 `setToolCollapseMode` 與 `getToolCollapseMode`。
- 在 `ToolTraceController` 中增加 `timer`、`timerCollapsed` 追蹤與定時器清理邏輯。
- 在 `execute` 包裝層中加入 `on` 模式串流抑制邏輯。
- 在 `renderCall` / `renderResult` 中實作統一的 collapse 決策，collapsed 態嚴格略過 body renderer。

### 2. Tools (`packages/pi-ext-tools`)
- 新增 `ToolTuiSettingsProvider` 並納入擴充 lifecycle 初始化。
- 在 `bash.ts` 中規整 command header，確保多行與超長指令安全截斷為單行。
- 為 `grep`、`read`、`write`、`find`、`edit`、`bash` 加上 `longOutput: true`。

### 3. 文檔與規範
- 更新 `DESIGN.md`，記載四種模式、15 秒自動折疊、`on` 模式抑制串流、以及純 Header + Footer 呈現契約。
- 更新相關 README 與 settings 說明。

## 5. 測試計畫

### Core 聚焦單元測試 (`packages/pi-ext-core/test/tool-tui.test.ts`)
1. **`auto` 模式**：
   - 標記 `longOutput` 的工具完成後，在 14.9 秒前維持展開；在 Vitest fake timer 前進到 15 秒時觸發 `invalidate`，變為 collapsed。
2. **`on` 模式**：
   - 工具完成後第一次 render 立即為 collapsed；驗證 body renderer 完全未被調用。
   - 工具執行中的 `onUpdate` 串流被成功抑制，不向外派發。
3. **`pertrace` 模式**：
   - 完成後不建立 timer，保持展開；直到下一個 `beginTrace()` 才被判定為 historical 並折疊。
4. **`off` 模式**：
   - 即使經過 15 秒或調用 `beginTrace()`，依然不發生外層 frame 折疊。
5. **使用者顯式展開優先級**：
   - `context.expanded === true` 時，無論處於何種模式或定時器是否到期，始終渲染完整 body。
6. **未標記 `longOutput` 的工具**：
   - 在任何模式下都不觸發 timer 或 `on` 模式即刻折疊。
7. **生命週期與清理安全**：
   - `resetSession()`、`beginTrace()` 或 session abort 時，正在等待的 15 秒定時器被徹底清理，無 dangling timer。
   - 舊 session 的定時器到期不會對新 session 的 record 產生任何副作用。

### Tools 聚焦測試 (`packages/pi-ext-tools/test/`)
1. **Settings 解析**：驗證合法模式解析及非缺失值 fallback 為 `auto`。
2. **`bash` 單行 Header**：驗證含有多行換行符號（`\n`, `\r\n`）與超長 CJK 字元的命令被正確壓為單行且以 `…` 截斷。
3. **`bash` 在 `on` 模式下無串流**：整合驗證 `bash` 在 `on` 模式下執行期間不會觸發 host 的 partial UI update。
4. **模型可見內容不變性**：驗證 TUI 折疊僅影響終端顯示，返回給 LLM 的 content 和 details 完全一致。

## 6. 驗收條件

- 沒有設定時預設為 `auto`；標記長輸出的工具在完成 15 秒後自動折疊為 Header + Footer。
- `on` 模式下，長輸出工具完成時直接呈現折疊狀態，完全不呼叫長 body renderer，且 `bash` 執行期間無串流輸出，終端無畫面跳躍與閃爍。
- `pertrace` 模式下完全繼承既有跨 turn 折疊邏輯。
- `off` 模式下停用所有外層 frame 自動折疊，長輸出保持在畫面中（遵守既有 `maxBodyLines` cap）。
- 快捷鍵全域展開（Ctrl+O）在所有模式下均可強制展開完整內容，不受自動折疊政策覆蓋。
- 所有定時器在 session 重置、切換分支、重載或中止時徹底清除，無未決資源洩漏。
- `bash` 的多行指令在所有狀態下均壓為單一 logical header line（換行以 `; ` 表示），長度超過終端寬度時以 dim `…` 截斷，永遠不換行、不隨 command 行數或長度增加 frame 高度。

## 7. 實作結果備註

實作與本計畫最終一致的差異如下，均已反映在上文：

1. **bash header 收斂位置**：計畫原本把換行規整放在 `bash.ts` 的 header formatter。實際上 header 內容由
   `tool-tui.ts` 既有的 bash 分支產生（`bash.ts` 只提供 `longOutput` 與 `headerLine` 標記），因此規整留在該分支，
   其他工具的「未折合 header 會換行」既有契約不變。
2. **換行以 `; ` 表示**：單純用空格串接會失去原本的行邊界，改用 `; `，並在行尾已是 `\` 或 `;` 時不重複插入。
3. **`headerLine` 欄位**：計畫曾刪除 `singleLineHeader`，最終以通用選項 `headerLine: "wrap" | "truncate"` 加回，
   `bash` 選用 `truncate`，讓整個 frame 永遠只佔 header 一行。
4. **設定生效時機**：除 session 啟動與 `/reload` 讀取保存值外，`SettingsProvider.onChange` 會立即呼叫
   `setToolCollapseMode`，讓設定面板存檔後即時生效。
