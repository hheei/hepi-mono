# 内存性能治理与轻量化架构设计规范 (Memory & Performance Optimization Specification)

## 1. 概述与核心原则

### 1.1 背景与现状
在大模型辅助开发的长会话（数千轮对话、多次工具调用、数周持续开发）中，随着会话文件膨胀，系统会出现 **JavaScript 堆内存耗尽崩溃（4GB OOM Crash）**，并在 GC 停顿期间造成 TUI 界面冻结。

核心瓶颈分析：
1. **全量历史无界水化**：会话加载时将全量历史 JSONL 解析为普通 JavaScript 对象常驻 V8 老生代堆，即使 97%+ 的条目已属于被压缩淘汰的冷历史；
2. **高频全量祖先遍历**：`pi-ext-memory` 的 `consolidation-trigger` 在每轮调用 `getBranch()` 获取全量祖先历史进行折叠；
3. **Compaction 系统提示词冗余堆积**：每次 Compaction 完整拷贝 90KB+ 的 systemMessage，数十次压缩堆积数 MB 垃圾；
4. **UI 缺乏展示硬上限与捕获膨胀**：旧版 `pi-ext-ui` 在 `details.__piExtUiCapturedCalls` 中塞入巨型嵌套调用结果并持久化到 JSONL，导致单条记录膨胀数百 KB；且 TUI 在 Level 2 展开时若不设硬上限，试图排版几十 MB 的输出会直接引发 V8 堆溢出或界面冻死；
5. **跨沙箱错误擦除**：QuickJS 沙箱中 `return`、`text()` 和 `console.log()` 的序列化路径将 Error 擦除为 `{}`；
6. **子进程启动盲等**：子进程在终端内发生早期崩溃时盲等 20 秒。

### 1.2 核心设计原则（做减法、严控边界、绝无写入放大）

1. **唯一持久化事实来源（Single Source of Truth, No Write Amplification）**：
   - **绝不在 UI 或中间层自建第二套磁盘落盘系统**（坚决剔除 `Transient Spooling Buffer`、`artifacts/batch-*.json` 碎档机制）；
   - 持久化的唯一权威是会话的 `.jsonl`；工具的大输出若超限，由工具自身写入指定的文件（例如 `bash` 的 `full_output_path`），UI 层仅记录文件路径指针与轻量摘要。
2. **绝不阻断用户退出（No Exit Blocking）**：
   - 彻底摒弃反人类的「销毁阻断对话框（Quarantine Protocol）」；用户输入 `/exit` 或按 `Ctrl+C` 时，生命周期必须立刻、幂等、干净地释放资源退出，绝不因为后台临时状态未写盘而强行卡住 TUI。
3. **源头截断与分级展示硬上限（In-Memory Bounded Payloads）**：
   - **不进堆**：工具在向模型或宿主返回前，必须严格控制在内存中的大小；
   - **TUI 分级展示硬窗口**：
     - **Level 0（收拢）**：1 行紧凑摘要（<= 120 字符）；
     - **Level 1（常规展开）**：关键前瞻信息与首尾截断（<= 20 行或 <= 16KB）；
     - **Level 2（深入检视）**：受硬性保护上限约束（最大 <= 500 行或 <= 64KB）。**绝对禁止在 TUI 内存中排版渲染数十 MB 的完整结果**；超出部分必须以明确的指示行提示用户：`... (truncated, full content: <path>)`。
4. **UI 捕获纯内存化与生命周期自动回收**：
   - `ToolExecutionTracker` 只保留活跃会话期间的嵌套调用轻量摘要（<= 16KB 截断预览），完全基于内存 WeakMap / Session Map；
   - 彻底废除 `tool_result` 向 JSONL 注入 `__piExtUiCapturedCalls` 的污染行为；
   - 监听器与缓存绑定 `registerExtensionLifecycle`，在 `session_shutdown` 时统一 `clear()` 释放，零磁盘垃圾、零内存残留。

---

## 2. 目标架构四大核心切面

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        架构治理四大核心切面                              │
├────────────────────────────┬───────────────────────────────────────────┤
│ 1. 活跃上下文回溯与按需流读 │ 沿 parentId 回溯定位 Compaction，冷历史按需流读 │
├────────────────────────────┼───────────────────────────────────────────┤
│ 2. 增量折叠与检查点闭包     │ 记忆折叠增量快照，Compaction 引用去重与导出闭包│
├────────────────────────────┼───────────────────────────────────────────┤
│ 3. UI 分级展示硬上限与纯内存│ Level 2 最大 64KB 截断，Tracker 纯内存生命周期 │
├────────────────────────────┼───────────────────────────────────────────┤
│ 4. 沙箱全路径投影与子进程探测│ stringifyWithErrors 根除 {}，1.5s 快速失败    │
└────────────────────────────┴───────────────────────────────────────────┘
```

---

### 2.1 切面一：分支祖先感知的活跃上下文与历史解耦（`SessionManager`）

#### 现存缺陷
- `loadEntriesFromFile` 一次性将全部历史反序列化为 JS 对象常驻内存，数千轮长对话直接吃掉 1GB+ 堆空间。
- `getEntries()` 被各处高频调用进行浅拷贝，导致反复产生大量短期对象引发 GC 冻结。
- 多分支切换时，容易因物理末尾查找 Compaction 而跨分支误判。

#### 治理方案
1. **轻量行索引（Index-only Cold History）**：
   - 启动加载时，仅扫描 JSONL 的换行符与基础元数据（`id`, `parentId`, `type`, 文件偏移量 `offset`, 长度 `length`），内存开销约每条 60 字节，50,000 条历史仅佔用 ~3 MiB；
   - 冷历史不进行 JSON 反序列化，常驻堆内存大幅下降 90%+。
2. **祖先链活跃上下文回溯（Ancestry-Based Compaction Resolution）**：
   - 从当前激活分支的目标 `leafEntryId` 开始，**沿 `parentId` 向上回溯**，定位属于当前分支的最新 `compaction` 节点；
   - 仅将该 Compaction 的 `firstKeptEntryId` 至 `leafEntryId` 之间的活跃条目（通常 < 300 条）反序列化进 V8 活跃上下文；
   - 沿祖先链同步提取并累加最新的分支级配置（model, thinking level, system prompt）。
3. **冷历史按需读取（On-Demand Deserialization）**：
   - 当调用 `om_recall_evidence` 或特定命令需要查看冷历史时，直接使用文件描述符在指定 `offset` 处读取 `length` 字节并反序列化单条记录，用后即抛。
4. **热路径解耦**：
   - 保持 `getEntries()` 公共契约向下兼容，但在 Agent 循环、消息组装、上下文计算等内部热路径中全面改用 `getActiveEntries()`。

---

### 2.2 切面二：增量折叠快照与 Compaction 检查点去重（`pi-ext-memory`）

#### 现存缺陷
- 每次 Compaction 完整拷贝 90KB 的 `systemMessage`，数十次压缩产生大量重复数据。
- `pi-ext-memory` 的 `consolidation-trigger` 每轮调用 `getBranch()` 重新遍历自会话起点以来的所有祖先条目。

#### 治理方案
1. **Compaction 检查点前驱引用（Checkpoint Dedup）**：
   - Compaction 记录中的系统配置与工具清单，改用记录前驱有效检查点的 `checkpointEntryId`，不再重复写全量字符串；
   - **分支导出闭包保证（Export Closure Property）**：在执行分支导出、克隆（`/fork`）时，检查 `checkpointEntryId` 是否存在于被导出的祖先路径中；若脱离祖先链，则就地将完整检查点物化展开，确保导出的会话文件独立可恢复。
2. **记忆增量折叠快照（Folded Ledger Snapshot）**：
   - 在每个 Compaction 节点保存当前已折叠状态的快照元数据；
   - 随后的每轮对折叠触发器仅获取自上次快照以来的增量活跃分支条目（通常 < 100 条）进行折叠运算，彻底废止每轮全量 `getBranch()`。
3. **原子记忆单元预算裁剪**：
   - 统一收敛至 `resolveMemoryBudget`，按 Observation / Reflection 的重要性评分以整条记录为单位进行淘汰，严禁暴力截断字符串破坏引用 ID。

---

### 2.3 切面三：UI 分级展示硬上限与纯内存生命周期（`pi-ext-ui`）

#### 现存缺陷
- 若工具产生数 MB 到数十 MB 的输出（如 cat 大文件或大量日志），TUI 在 Level 2 展开时若试图排版渲染，直接造成 V8 堆溢出或 UI 冻死；
- 之前旧设计试图在 UI 层搞「流式分块写工件文件（spooling to artifacts）」和「退出阻断全屏对话框」，造成严重的写入放大与体验恶化。

#### 治理方案
1. **展示分级硬上限保护（Render Window Hard Caps）**：
   - **Level 0（收拢）**：状态图标 + 1 行精简摘要（<= 120 字符）；
   - **Level 1（折叠预览）**：最多渲染 20 行 / 16KB 文本，两端带截断提示；
   - **Level 2（深入展开）**：**硬性保护上限为 500 行 / 64KB**。
     - 若工具输出超过 64KB，末尾追加显式提示行：`▎ ... [Output truncated: showing 64KB of ${totalSize}. Full output saved at ${filePath || "session log"}]`；
     - **坚决不为 UI 展示自建工件落盘系统**；外部工具自带文件（如 `bash` 输出落到 `full_output_path`），UI 仅渲染受控安全窗口。
2. **纯内存 Tracker 与生命周期自动清理**：
   - `ToolExecutionTracker` 仅在内存保存當前活跃的父子調用關聯，參數只保留 16KB 截斷預覽；
   - 徹底移除 `pi.on("tool_result")` 向 JSONL 注入 `__piExtUiCapturedCalls` 的行為；
   - 綁定 `registerExtensionLifecycle`，在 `session_shutdown` 時自動調用 `clear()` 釋放，絕不在磁碟留下任何暫態碎檔。
3. **無條件快速退出**：
   - 移除任何攔截 `/exit`、`Ctrl+C` 的對話框機制。退出就是退出，同步釋放記憶體句柄。

---

### 2.4 切面四：沙箱全路徑錯誤投影與子進程快速失敗（`codemode` & `pi-subagents`）

#### 现存缺陷
- QuickJS 沙箱中 `return`、`text()`、`console.log()` 三條輸出路徑均調用原生 `JSON.stringify`，將 Error 對象抹平為 `{}`。
- 子進程崩潰時盲等 20 秒，且失敗時句柄若未妥善持有會導致無法確認關閉。

#### 治理方案
1. **沙箱全路徑 Error 投影**：
   - 在 `prelude-source.js` 中定義 `stringifyWithErrors`（帶有 `errorReplacer`），全面替換：
     1. `serialize(value)`（腳本最後表達式 `return`）；
     2. `outputText(value)`（調用 `text(...)`）；
     3. `format(value)`（調用 `console.log/info/warn/error(...)`）；
   - 遞歸展開 Error 的 `name`、`message`、`stack`、`code`，徹底根除跨沙箱 `{}` 診斷遺失。
2. **子進程 1.5 秒快速探測與狀態確認**：
   - 面板啟動第一時間在註冊表登記句柄；
   - 1.5 秒內若探測到提早退出，調用 `cleanup()` 並以 `observe()` 確認面板真實消失，隨後拋出含真實 `stderr` 的具體錯誤，不再盲等 20 秒。
3. **QuickJS Worker 串行與單實例確認**：
   - 交互模式下施加單併發 Worker 鎖，傳入 `memoryLimitBytes = 32 * 1024 * 1024`（32 MiB）；
   - 執行完畢顯式 `await worker.terminate()` 確認銷毀，防止 WASM 記憶體疊加。

---

## 3. 落地實施路線圖 (Phased Implementation Plan)

### 階段一：已完成項（即時止痛與清理）
- [x] **移除無主代碼**：刪除 `packages/pi-ext-ui/src/turn-copy.ts` 及其單元測試。
- [x] **Tracker 生命週期化與消除磁碟污染**：重構 `tracker.ts`，移除 `tool_result` 向 session entry 注入 `__piExtUiCapturedCalls` 的行為；監聽器納入 DisposerRegistry，在 `session_shutdown` 時自動 `clear()`。
- [x] **Payload-parser 簡化**：移除 13 個手寫正則，改為單一鍵值對解析。

### 階段二：UI 分級展示硬上限（防 TUI 凍結與 V8 堆溢出）
- [x] **ToolView Level 2 渲染窗口截斷**：在 `renderSections` 或 `diff-view` 中設定 500 行 / 64KB 硬上限；超出時追加指向完整輸出路徑的友好提示行。
- [x] **單元測試驗證**：傳入 5MB 模擬輸出，驗證 Level 2 渲染行數與字元數嚴格受控在 64KB 內，TUI 不凍結。

### 階段三：沙箱錯誤全路徑投影與子進程快速失敗
- [ ] **QuickJS 沙箱全路徑 Error 投影**：在 `pi-codemode` 的 `prelude-source.js` 中啟用 `stringifyWithErrors`；在 `pi-subagents` 端安全收窄 `projectErrorForSandbox`。
- [x] **子進程早期退出探測**：在 `SubagentManager` 實現 1.5 秒存活探測 + `observe()` 驗證，替換 20 秒盲等。
- [ ] **單元測試驗證**：測試 `return err`、`text(err)`、`console.log(err)` 均能輸出清楚的 message 與 stack。

### 階段四：會話索引與 Compaction 瘦身（長會話持久化治理）
- [x] **Compaction 檢查點去重**：`systemMessage` 優先引用前驅有效檢查點 ID；分支導出時執行閉包物化。
- [x] **記憶增量折疊快照**：`pi-ext-memory` 引入折疊快照，每輪僅掃描活躍增量條目（< 100 條）。
- [ ] **SessionManager 祖先鏈回溯與輕量索引**：冷歷史維持行索引，活躍窗口由 leaf 節點向上回溯 Compaction 載入。
- [ ] **長會話壓測驗證**：模擬 3,000 輪會話，驗證常駐堆記憶體穩定在 <= 80 MiB，峰值物理記憶體 <= 300 MiB。

#### 階段四詳細設計：Compaction 檢查點去重與持久化契約

##### 1. JSONL 持久化格式
在會話的 `.jsonl` 記錄中，每次 Compaction 原先均會將數萬字元（50KB ~ 100KB）的完整 `systemMessage` 物件原樣寫盤。這導致長會話磁碟膨脹率高達 90% 以上。
新增欄位 `checkpointEntryId`：
- 若當前 Compaction 的 `systemMessage` 與祖先分支上已存在的某個檢查點（先前的 Compaction 節點或根節點 `message.role === "system"`）在內容、自訂章節及工具宣告上語意等價：
  - 磁碟 JSONL：**省略** `systemMessage` 欄位，僅記錄 `checkpointEntryId: "<ancestorEntryId>"`。每條 Compaction 磁碟大小由 ~75KB 縮減至 ~230B。
  - 記憶體實例：`entry.systemMessage` 指向祖先檢查點的物件引用，內存開銷為 0。
- 若提示詞發生變更（如切換模型或加載新規則）：作為新的基準檢查點（Checkpoint），保留完整的 `systemMessage` 寫盤，不記錄 `checkpointEntryId`。後續 Compaction 轉為指向該新檢查點。

##### 2. 水化（Hydration）生命周期
- **冷啟動 / 擴展就緒**：`SessionManager` 構建完成時（或擴展的 `startSession` 鉤子中），`hydrateCompactionCheckpoints` 會遍歷 `fileEntries`，依循 `checkpointEntryId` 將祖先的 `systemMessage` 引用賦值回 `entry.systemMessage`。
- **分支切換 / 分叉載入**：`_buildIndex` 完成後自動執行水化，確保無論會話如何載入，記憶體中的 Projection 與 Context 能直接獲取首部長系統提示詞。

##### 3. 分支導出與閉包物化（Materialization on Fork/Rewrite）
- 當執行 `_rewriteFile()`（例如分支剪裁、獨立導出或分叉）時：
  - 若 `checkpointEntryId` 指向的祖先條目**仍在當前導出閉包內**：繼續保持輕量持久化，磁碟省略 `systemMessage`。
  - 若祖先條目**已脫離當前閉包**（例如裁剪了歷史、或跨兄弟分支導出）：
    - 系統在刪除 `checkpointEntryId` 指針之前，**主動防禦性物化 `systemMessage`**（自祖先或內存恢復）。
    - 寫盤時展開完整的 `systemMessage`，確保獨立的分叉會話在任何無擴展環境下均能自給自足（Self-contained）。

##### 4. 前向與後向相容性保證
- **無擴展 / 上游 Pi**：Pi 的 `sessionEntryToContextMessages` 實作僅在 `entry.systemMessage` 存在時將其提取；而 `buildContextEntries` 僅使用最新一次 Compaction 的系統訊息，對舊 Compaction 缺失 `systemMessage` 完全相容。
- **生命周期安全**：`installCompactionCheckpointDedup` 採用引用計數（Reference Counting），支援多個 ExtensionRunner 重疊啟動與清理，只有在引用計數歸零時才還原原型方法。
