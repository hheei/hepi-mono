# Graph Report - hepi-mono  (2026-07-21)

## Corpus Check
- 1753 files · ~955,513 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2179 nodes · 3634 edges · 178 communities (160 shown, 18 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.69)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `81a77274`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Codex Skill Picker
- SSH Session Management
- SSH Tool Registration
- Extcore TUI Components
- Extcore Settings Providers
- Codex Interaction Tests
- Loadout State UI
- Extcore Settings Panel
- Package Architecture Docs
- Shared Settings Storage
- Inturl Path Shortcuts
- Settings Table UI
- model.ts
- `pi-basics` 開發計畫
- `pi-basics` Loadout 實作 TODO
- includes
- package.json
- 4. Extension 可以修改到什么程度
- model.ts
- `pi-basics` Loadout 實作計畫（核心共識已確認）
- SettingsController
- render.test.ts
- render.ts
- HePiRegistry
- Extension Development Guide
- index.ts
- settings.ts
- compilerOptions
- panels.ts
- settings.ts
- session-manager.ts
- rendering.test.ts
- modules.ts
- hepi-command.ts
- helpers.ts
- index.ts
- editor.ts
- index.ts
- text.ts
- output-tail-sink.ts
- contributions.ts
- index.ts
- storage.ts
- 12. 逐步執行順序
- component.ts
- pi-basics Ask 高层方案（Review Gate）
- HePiMaybePromise
- 08｜测试基础设施与覆盖策略
- ValueEditor
- errors.ts
- 7. Phase D：Tool execution与feature lifecycle
- ssh-exec.ts
- pi-dev.mjs
- Loadout TUI 設計語言規範
- 待决策项
- TUI 設計語言規範
- 06｜Settings TUI：model、controller、component 与渲染
- 09｜分阶段实施与交付编排
- 10｜原计划 TODO 逐项执行清单
- controller.ts
- references.ts
- panel.test.ts
- stream-output.ts
- 17. 顏色語義
- `pi-basics` Loadout 逐步實作參考
- 03｜架构与目录骨架
- 07｜Runtime、lifecycle 与 module 边界
- ssh-exec.test.ts
- ssh-mount.ts
- pi-basics Ask 详细设计
- 01｜目标与边界
- 02｜设计原则落地
- 04｜公开 API、Settings contract 与 storage
- 05｜`/hepi` dispatcher
- 7.4 Transition rules
- 12. Description panel 內容結構
- 10. Loadout TUI
- 3. 已固定的產品規則
- 9. Loadout controller
- 11｜第一版交付验收
- 12｜明确不做与越界检查
- 16. 顏色層級
- 6. 設定列表
- 13. 空資料與缺失欄位
- 15. 底部操作提示
- 4. 頂部頁籤
- 5. Scope 與設定來源
- 7. 左側分類列表
- 6. Pure model algorithm
- 7. Storage 實作
- 7. Description panel
- 6. Phase C：RPC/ACP fallback
- 11. Description panel
- 6. 搜尋欄
- 8. Selection 與狀態符號
- 11. Shared shell 與 command
- 13. Edit mode 操作
- 14. Focus 與狀態
- 4. 頂部頁籤
- 8. 響應式佈局
- @hheei/pi-basics
- 5. Phase B：TUI component
- 14. Toggle 行為
- 16. 響應式行為
- 9. Item 標籤溢出
- 5. Domain contract
- 8. Inventory 與 runtime adapter
- 11. 寬模式 Edit mode
- 15. 底部操作提示
- 3. 邊框語言
- 9. Value 類型
- @hheei/__PACKAGE_SLUG__
- createGlobalJsonSettingsStorage
- createProjectJsonSettingsStorage
- createSessionBackedStorage
- readableError
- layoutSettings
- renderSettingsTui
- renderRoundedPanel
- renderKeymap
- createHorizontalViewport
- wrapText
- 7. 为什么推荐这些取舍
- 7. 實作階段
- FakeEditor
- 8. TUI component
- 9. RPC/ACP fallback
- 4. Phase A：Normalized model与validation
- 8. Phase E：Package integration smoke
- Phase 1｜Pure model
- Phase 5｜Loadout renderer
- Phase 4｜Loadout controller
- 12. Result contract
- 14. Reference取舍
- 16. Test contract
- Phase 2｜Scope-aware storage
- Phase 3｜Inventory 與 runtime adapters
- Phase 7｜Shared shell
- MaybePromise
- 10. Execution lifecycle
- 3. pi-basics 整合边界
- 4. Tool identity与prompt surface
- 6. Normalized model
- 4. 用户可见行为
- 9. Cleanup
- 2. 需求模型
- Phase 9｜Verification
- 11. Tool visibility与Loadout
- 5. 外部参数schema
- BoundedInput
- panel.test.ts
- askWithDialogFallback
- helpers.ts
- storage.ts
- controller.ts
- component.test.ts
- component.test.ts
- integration.test.ts
- ValueEditor
- model.test.ts
- component.ts
- inventory.ts
- panel.test.ts
- panel.ts
- index.ts
- pi-basics Todo 实作方案
- 6. Phase C：Tool、command 与 prompt
- 7. Phase D：Widget
- 5. Phase B：Snapshot、replay 与 active runtime state
- 8. Phase E：Lifecycle 与 pi-basics entry
- 10. Verification plan
- 4. Phase A：Domain model

## God Nodes (most connected - your core abstractions)
1. `SettingsController` - 33 edges
2. `SessionManager` - 31 edges
3. `LoadoutController` - 27 edges
4. `Loadout TUI 設計語言規範` - 21 edges
5. `HePiSettingsProvider` - 20 edges
6. `SettingsState` - 20 edges
7. `TUI 設計語言規範` - 20 edges
8. `pi-basics Ask 详细设计` - 19 edges
9. `createGoalFeature()` - 19 edges
10. `pi-basics Todo 详细设计` - 18 edges

## Surprising Connections (you probably didn't know these)
- `register()` --references--> `type`  [EXTRACTED]
  packages/pi-ssh/src/index.ts → package.json
- `wrappedThreeColumnTableExample()` --calls--> `renderWrappedTableRows()`  [EXTRACTED]
  docs/examples/tui-panels.ts → packages/pi-extcore/src/tui/panels.ts
- `twoColumnListWithSidePanelExample()` --calls--> `renderTwoColumnListWithSidePanel()`  [EXTRACTED]
  docs/examples/tui-panels.ts → packages/pi-extcore/src/tui/panels.ts
- `registerExtension()` --calls--> `formatExtensionLabel()`  [EXTRACTED]
  templates/extension/src/index.ts → packages/pi-extcore/src/package.ts
- `safe path shortcuts` --semantically_similar_to--> `skill path expansion`  [INFERRED] [semantically similar]
  packages/pi-inturl/README.md → packages/pi-codex-dollar/README.md

## Import Cycles
- 3-file cycle: `packages/pi-basics/src/api/modules.ts -> packages/pi-basics/src/api/settings.ts -> packages/pi-basics/src/api/panels.ts -> packages/pi-basics/src/api/modules.ts`

## Hyperedges (group relationships)
- **Shared extension settings architecture** — packages_pi_extcore_readme_shared_extension_settings_core, packages_pi_codex_dollar_readme_extension_settings, packages_pi_inturl_readme_shared_settings_integration, packages_pi_loadout_readme_pi_loadout_extension, packages_pi_ssh_readme_shared_ssh_settings [EXTRACTED 1.00]
- **Input path and skill reference transforms** — packages_pi_codex_dollar_readme_skill_path_expansion, packages_pi_inturl_readme_safe_path_shortcuts, packages_pi_inturl_readme_path_traversal_protection [INFERRED 0.85]

## Communities (178 total, 18 thin omitted)

### Community 0 - "Codex Skill Picker"
Cohesion: 0.17
Nodes (19): EXTENSION_DIR, formatSkillItem(), formatSourceLabel(), getSkillEntries(), getSkillSuggestions(), normalizeSkillDescription(), normalizeSourceLabel(), packageDirs() (+11 more)

### Community 1 - "SSH Session Management"
Cohesion: 0.18
Nodes (3): sanitizeHostForSocket(), SessionManager, executeSshExec()

### Community 2 - "SSH Tool Registration"
Cohesion: 0.09
Nodes (24): clampInt(), createManager(), createSshHostsPanel(), DEFAULT_SETTINGS, ensureTrailingSlash(), errorMessage(), errorResult(), formatDisplayPath() (+16 more)

### Community 3 - "Extcore TUI Components"
Cohesion: 0.07
Nodes (29): HePiSettingsState, createSettingsComponent(), SettingsComponentOptions, createSettingsController(), createSettingsLayout(), SettingsLayout, SettingsLayoutMode, SettingsListItem (+21 more)

### Community 4 - "Extcore Settings Providers"
Cohesion: 0.13
Nodes (36): piExtcore(), SettingsPanelInput, SettingsPanelPane, createGeneralPaneGroups(), createPaneState(), createProviderState(), loadProviderState(), loadProviderStates() (+28 more)

### Community 5 - "Codex Interaction Tests"
Cohesion: 0.09
Nodes (19): ANSI_ESCAPE_PATTERN, backspaceEditor, baseEditor, baseEditorSymbol, defaultDollarSettings, editor, editorWithBaseMetadata, keybindingEditor (+11 more)

### Community 6 - "Loadout State UI"
Cohesion: 0.09
Nodes (25): createLoadoutFooterLines(), formatLoadoutGroupDescription(), formatLoadoutPresetDescription(), formatLoadoutStatusLabel(), isSettingsListExtraLine(), LoadoutDescriptionTheme, LoadoutFooterOptions, LoadoutFooterPane (+17 more)

### Community 7 - "Extcore Settings Panel"
Cohesion: 0.16
Nodes (26): createGroupSettingItem(), createPlainSettingItems(), createSettingItems(), formatFooter(), keycap(), resolveSettingDescription(), SettingsPanelOptions, summarizeGroup() (+18 more)

### Community 8 - "Package Architecture Docs"
Cohesion: 0.06
Nodes (36): ext-settings.json storage, extension settings, inline skill picker, pi-codex-dollar extension, pi-loadout integration, prompt highlighting, $skill-name autocomplete, skill ordering (+28 more)

### Community 9 - "Shared Settings Storage"
Cohesion: 0.12
Nodes (21): SavedSettingsEntry, asSettingsState(), createAgentExtensionSettingsStorage(), createAgentJsonSettingsStorage(), createExtensionSettingsStorage(), createJsonSettingsStorage(), isNodeError(), isRecord() (+13 more)

### Community 10 - "Inturl Path Shortcuts"
Cohesion: 0.07
Nodes (58): ActiveRuntime, createGoalFeature(), ErrorCandidate, escapedObjective(), GOAL_PARAMETERS, GOAL_REPLAY_WARNING(), goalContext(), GoalFeature (+50 more)

### Community 11 - "Settings Table UI"
Cohesion: 0.22
Nodes (3): padRight(), SettingsTable, SettingsTableOptions

### Community 12 - "model.ts"
Cohesion: 0.14
Nodes (23): filterLoadoutItems(), groupLoadoutItems(), KIND_ORDER, LoadoutConfiguredStatus, LoadoutDisplayStatus, LoadoutEffectiveStatus, LoadoutGroup, LoadoutKind (+15 more)

### Community 13 - "`pi-basics` 開發計畫"
Cohesion: 0.04
Nodes (46): 10. 明確 TODO list, 11. 驗收標準, 12. 明確不做, 13. 待確認但不阻塞第一版的決策, 1. 目標與邊界, 2. 設計原則, 3. `pi-basics` 架構, 4. 公開 API 設計 (+38 more)

### Community 14 - "`pi-basics` Loadout 實作 TODO"
Cohesion: 0.18
Nodes (11): Baseline, MCP placeholder contract, Phase 0｜Baseline 與 contract, Phase 0 gate, Phase 10｜最後同步, Phase 6｜Loadout component, Phase 8｜Root、lifecycle、events, `pi-basics` Loadout 實作 TODO (+3 more)

### Community 15 - "includes"
Cohesion: 0.05
Nodes (39): noUnusedImports, noUnusedVariables, files, ignoreUnknown, includes, formatter, enabled, indentStyle (+31 more)

### Community 16 - "package.json"
Cohesion: 0.05
Nodes (36): @biomejs/biome, @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui, description, devDependencies, @biomejs/biome, @earendil-works/pi-ai (+28 more)

### Community 17 - "4. Extension 可以修改到什么程度"
Cohesion: 0.06
Nodes (31): 1.1 终端渲染流程, 1. 总体渲染模型, 2.1 Editor 的默认视觉结构, 2. `TEXT`：主输入编辑器如何渲染, 3.1 第一行：`<path> (git)`, 3.2 第二行：token、cache、context、model, 3.3 第三行：`<loadout>`, 3. Footer 的三层结构 (+23 more)

### Community 18 - "model.ts"
Cohesion: 0.10
Nodes (17): HePiSettingGroup, createSettingsModel(), cycleOption(), fieldForSelection(), providerHasContent(), settingFieldItemId(), settingGroupItemId(), settingPanelItemId() (+9 more)

### Community 19 - "`pi-basics` Loadout 實作計畫（核心共識已確認）"
Cohesion: 0.13
Nodes (15): 10. 暫不實作項目, 1. 目前結論, 3.1 檔案位置, 3.2 Project path 與 trust, 3. 建議 storage contract, 4. Effective precedence, 5. MCP adapter 邊界, 6.1 已確定的按鍵分工建議 (+7 more)

### Community 20 - "SettingsController"
Cohesion: 0.10
Nodes (13): HePiSettingField, HePiSettingsProvider, HePiSettingsRegistry, HePiSettingValue, applyChange(), cloneState(), PendingChange, readableError() (+5 more)

### Community 21 - "render.test.ts"
Cohesion: 0.14
Nodes (16): Editor, EditorFactory, Owner, StatusbarFeature, buildStatusbarSnapshot(), contextMeter(), formatContextLimit(), METER_GLYPHS (+8 more)

### Community 22 - "render.ts"
Cohesion: 0.16
Nodes (28): editHints, ellipsizedDescription(), fieldValue(), finish(), formatSettingValue(), navigationHints(), renderDescription(), renderDraft() (+20 more)

### Community 23 - "HePiRegistry"
Cohesion: 0.09
Nodes (17): activeModuleRegistry(), moduleRegistries, placeholderFields, registerHePiModule(), createSettingsModule(), createHePiRuntimeContext(), HePiRuntimeContext, HePiRuntimeContextOptions (+9 more)

### Community 24 - "Extension Development Guide"
Cohesion: 0.08
Nodes (23): Agent Workflow, Development Commands, Extension Development Guide, Extension Entry Point, Forking Existing Extensions, Local Testing in Pi, Package Checklist, Settings Panel (+15 more)

### Community 25 - "index.ts"
Cohesion: 0.39
Nodes (7): createLoadoutInventory(), createMcpPlaceholder(), mergeLoadoutInventory(), skillItem(), sourceScope(), toolItem(), LoadoutSourceScope

### Community 26 - "settings.ts"
Cohesion: 0.08
Nodes (21): HePiMaybePromise, HePiPanel, HePiSettingsSubpanel, createGlobalJsonStorage(), createHePiSettingsRegistry(), createProjectJsonStorage(), createSessionStorage(), defaultSettingsRegistry (+13 more)

### Community 27 - "compilerOptions"
Cohesion: 0.08
Nodes (23): bun, ES2022, node, compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module (+15 more)

### Community 28 - "panels.ts"
Cohesion: 0.16
Nodes (19): advance(), answersFromState(), AskAction, AskAnswerDraft, askDetails(), AskMode, AskOption, AskSelection (+11 more)

### Community 29 - "settings.ts"
Cohesion: 0.20
Nodes (17): applyPathShortcutExpansion(), createPathShortcutToolPanel(), createPathShortcutToolPanelComponent(), DEFAULT_PATH_SHORTCUT_SETTINGS, enabledToolsFromState(), expandPathShortcut(), expandTmpPath(), parseToolNames() (+9 more)

### Community 30 - "session-manager.ts"
Cohesion: 0.12
Nodes (15): clampPositiveInt(), DEFAULT_MOUNT_DIR, DEFAULT_PLUGIN_DIR, envNumber(), envString(), HostFailureState, isMissingBinaryError(), MountProbe (+7 more)

### Community 31 - "rendering.test.ts"
Cohesion: 0.12
Nodes (15): createEditor(), fixtureRoot, loadoutSorted, commands, noopTheme(), all, ANSI_ESCAPE, ANSI_ESCAPE_PATTERN (+7 more)

### Community 32 - "modules.ts"
Cohesion: 0.06
Nodes (34): HePiContribution, HePiEditorContribution, HePiFooterContribution, HePiStatusContribution, createHePiModuleRegistry(), defaultModuleRegistry, getHePiModule(), HePiModule (+26 more)

### Community 33 - "hepi-command.ts"
Cohesion: 0.04
Nodes (46): 10. Prompt design, 11. `/todos` command, 12.1 Ownership, 12.2 Layout, 12.3 Runtime ownership, 12. Widget, 13. Lifecycle, 14. Concurrency 与 mutation ordering (+38 more)

### Community 34 - "helpers.ts"
Cohesion: 0.14
Nodes (12): advancedGroup, booleanField, delayedSaveProvider, emptyProvider, enumField, failedSaveProvider, generalGroup, numberField (+4 more)

### Community 35 - "index.ts"
Cohesion: 0.20
Nodes (3): createToolActivationCoordinator(), ToolActivationCoordinator, host()

### Community 36 - "editor.ts"
Cohesion: 0.18
Nodes (14): createSkillPickerEditor(), getPickerState(), HIGHLIGHT_BASE_EDITOR, HIGHLIGHT_WRAPPED, isEditorLike(), CustomEditorConstructor, DollarSkillToken, EditorCursor (+6 more)

### Community 37 - "index.ts"
Cohesion: 0.16
Nodes (17): twoColumnListWithSidePanelExample(), wrappedThreeColumnTableExample(), autoColumnWidth(), autoTwoColumnWidth(), maxVisibleWidth(), padRight(), renderRowsWithSidePanel(), renderTwoColumnListWithSidePanel() (+9 more)

### Community 38 - "text.ts"
Cohesion: 0.36
Nodes (13): renderSkillPickerLines(), clamp(), highlightAccent(), padRight(), styleDescription(), styleInactiveRow(), styleScrollInfo(), styleSelectedRow() (+5 more)

### Community 39 - "output-tail-sink.ts"
Cohesion: 0.24
Nodes (8): countNewlines(), findUtf8TailStart(), isUtf8ContinuationByte(), OutputTailSink, readStreamTail(), TailDump, TailEntry, utf8SequenceWidth()

### Community 40 - "contributions.ts"
Cohesion: 0.22
Nodes (4): copyMaps(), LoadoutController, normalize(), readable()

### Community 41 - "index.ts"
Cohesion: 0.21
Nodes (12): dollarSkillAutocomplete(), BranchEntry, loadoutActiveSkillNames(), LoadoutState, parseLoadoutActiveSkillNames(), applyDollarSkillCompletion(), extractDollarSkillToken(), DEFAULT_DOLLAR_SETTINGS (+4 more)

### Community 42 - "storage.ts"
Cohesion: 0.29
Nodes (6): Data, Editor composition, Footer bridge, Lifecycle, Pi Basics Statusbar — design, Rail renderer

### Community 43 - "12. 逐步執行順序"
Cohesion: 0.17
Nodes (12): 12. 逐步執行順序, Step 0｜固定 MCP placeholder contract, Step 10｜最後文件同步, Step 1｜Pure model, Step 2｜Storage, Step 3｜Inventory/runtime adapters, Step 4｜Controller, Step 5｜Renderer (+4 more)

### Community 44 - "component.ts"
Cohesion: 0.33
Nodes (5): Cleanup and safety, Installation, Modules, Pi Basics Statusbar — implementation, Verification

### Community 45 - "pi-basics Ask 高层方案（Review Gate）"
Cohesion: 0.17
Nodes (12): 10. 完成定义, 11. 研究基线, 1. 一句话方案, 2. 推荐功能范围, 3. 推荐 Tool contract, 5. 调用纪律, 6. 参考实现比较与取舍, 8. 与 pi-basics 的整合 (+4 more)

### Community 46 - "HePiMaybePromise"
Cohesion: 0.19
Nodes (16): aborted(), cancelled(), checkAbort(), collectQuestion(), customAnswer(), DialogOptions, DialogUI, hasDialogUI() (+8 more)

### Community 47 - "08｜测试基础设施与覆盖策略"
Cohesion: 0.18
Nodes (10): 08｜测试基础设施与覆盖策略, Controller, Model, Pi integration, Renderer/component, 必测行为, 执行规则, 目录与 helpers (+2 more)

### Community 48 - "ValueEditor"
Cohesion: 0.40
Nodes (4): Goal, Ownership, Pi Basics Statusbar — high level, Visible contract

### Community 49 - "errors.ts"
Cohesion: 0.25
Nodes (7): formatUiError(), HePiParseError, HePiStorageError, HePiUiError, messageOf(), toUiError(), UiErrorKind

### Community 50 - "7. Phase D：Tool execution与feature lifecycle"
Cohesion: 0.18
Nodes (11): 7. Phase D：Tool execution与feature lifecycle, D10. Phase check, D1. Tool schema与constants, D2. Active runtime/pending shape, D3. Tool registration, D4. Execute path, D5. Start-time capability reconciliation, D6. Result builder (+3 more)

### Community 51 - "ssh-exec.ts"
Cohesion: 0.24
Nodes (10): runCleanupSshProcess(), clampTimeoutSeconds(), envTimeoutSeconds(), ExecuteSshExecOptions, managerLikeSpawn(), remainingTimeoutMs(), runSshProcess(), SshExecArgs (+2 more)

### Community 52 - "pi-dev.mjs"
Cohesion: 0.20
Nodes (8): aliases, args, child, packageEntry(), rawArgs, resolveExtension(), root, separatorIndex

### Community 53 - "Loadout TUI 設計語言規範"
Cohesion: 0.20
Nodes (10): 10.1 導航, 10.2 垂直滾動, 10. 列表導航與滾動, 18. 排版與空白, 19. 建議狀態模型, 1. 介面定位, 20. 核心互動原則, 2. 參考畫面 (+2 more)

### Community 54 - "待决策项"
Cohesion: 0.20
Nodes (9): 13｜不阻塞第一版的待决策项, Agent 规则, Footer owner, `/hepi setting <provider-id>` 是否直接跳转, public API subpath export, Settings 第一层是否显示 General, Shift+Tab key encoding, 待决策项 (+1 more)

### Community 55 - "TUI 設計語言規範"
Cohesion: 0.20
Nodes (10): 10.1 暫存值模型, 10. Edit mode, 12. 窄模式 Edit mode, 17. 排版規則, 18. Unicode 按鍵符號, 19. 核心互動原則, 1. 設計定位, 2. 整體畫面結構 (+2 more)

### Community 56 - "06｜Settings TUI：model、controller、component 与渲染"
Cohesion: 0.22
Nodes (8): 06｜Settings TUI：model、controller、component 与渲染, Controller 行为, Layout/render, Model 状态, Navigation/Edit 行为, 实现顺序, 目标, 验收

### Community 57 - "09｜分阶段实施与交付编排"
Cohesion: 0.22
Nodes (8): 09｜分阶段实施与交付编排, Agent 执行协议, Phase 0：自有 contract, Phase 1：Settings model/controller, Phase 2：Settings TUI, Phase 3：`/hepi setting` 整合, Phase 4：未来功能, 目标

### Community 58 - "10｜原计划 TODO 逐项执行清单"
Cohesion: 0.22
Nodes (8): 10｜原计划 TODO 逐项执行清单, Command 与边界, Model/controller, Package 与 runtime, Settings API, TUI, 使用方式, 测试与验证

### Community 59 - "controller.ts"
Cohesion: 0.15
Nodes (11): ActiveAsk, AgentToolResultLike, ASK_PARAMETERS, ASK_PROMPT_GUIDELINES, AskFeature, askOption, askQuestion, createAskFeature() (+3 more)

### Community 60 - "references.ts"
Cohesion: 0.31
Nodes (7): expandDollarSkillReferences(), highlightDollarSkillReferences(), getSkillPathMap(), SkillCommand, fallbackSkillPath, fixtureRoot, secondFallbackSkillPath

### Community 61 - "panel.test.ts"
Cohesion: 0.20
Nodes (10): 10. Final verification, 11. 验收矩阵, 12. 完成定义, 1. 实作原则, 2. 预期改动清单, 3. Phase 0：Review Gate, pi-basics Ask 实作方案, 不修改 (+2 more)

### Community 62 - "stream-output.ts"
Cohesion: 0.36
Nodes (4): OutputSource, pipeReadable(), pipeStreamsToSink(), StreamingRedactor

### Community 63 - "17. 顏色語義"
Cohesion: 0.25
Nodes (8): 17. 顏色語義, `accent`, `active`, `dim`, `disabled`, `inherit`, `normal`, `secondary`

### Community 64 - "`pi-basics` Loadout 逐步實作參考"
Cohesion: 0.25
Nodes (8): 13. 每一步交付格式, 14. 明確停止條件, 1. 文件用途, 2.1 pi-mcp-adapter 研究結論, 2.2 `packages/pi-loadout` 可直接复用的部分, 2. 最新 baseline, 4. 建議目標檔案, `pi-basics` Loadout 逐步實作參考

### Community 65 - "03｜架构与目录骨架"
Cohesion: 0.25
Nodes (7): 03｜架构与目录骨架, 分层检查, 实现步骤, 目标, 目标目录, 非目标, 验收与命令

### Community 66 - "07｜Runtime、lifecycle 与 module 边界"
Cohesion: 0.25
Nodes (7): 07｜Runtime、lifecycle 与 module 边界, Context 与 lifecycle, Future boundary, Registry 不得负责, Registry 只能负责, 目标, 验收

### Community 67 - "ssh-exec.test.ts"
Cohesion: 0.29
Nodes (3): MountProbeResult, readBytes(), runFakeProcess()

### Community 68 - "ssh-mount.ts"
Cohesion: 0.15
Nodes (13): 1. 一句话方案, 2. 推荐功能范围, 3. 用户可见行为, 4. 来源化提示词, 5. 与参考实现的取舍, 6. 与 pi-basics 的相容方式, 7. Review 决策点, 8. 完成定义 (+5 more)

### Community 69 - "pi-basics Ask 详细设计"
Cohesion: 0.22
Nodes (9): 13.1 `renderCall`, 13.2 `renderResult`, 13. Transcript rendering, 15. Failure matrix, 17. Non-goals升级条件, 18. 设计完成条件, 1. 目标, 2. 架构位置 (+1 more)

### Community 70 - "01｜目标与边界"
Cohesion: 0.29
Nodes (6): 01｜目标与边界, 交付范围, 完成标准, 执行步骤, 目标, 硬性边界

### Community 71 - "02｜设计原则落地"
Cohesion: 0.29
Nodes (6): 02｜设计原则落地, 任务步骤, 必须遵守, 目标, 非目标, 验收

### Community 72 - "04｜公开 API、Settings contract 与 storage"
Cohesion: 0.29
Nodes (6): 04｜公开 API、Settings contract 与 storage, 关键约束, 实现步骤, 最小 contract, 目标, 验收

### Community 73 - "05｜`/hepi` dispatcher"
Cohesion: 0.29
Nodes (6): 05｜`/hepi` dispatcher, 实现步骤, 目标, 行为契约, 非目标, 验收

### Community 74 - "7.4 Transition rules"
Cohesion: 0.22
Nodes (9): 7.1 State, 7.2 Initial state, 7.3 Actions, 7.4 Transition rules, 7. Interaction state, Cancel/abort, Multi-select, Navigation (+1 more)

### Community 75 - "12. Description panel 內容結構"
Cohesion: 0.33
Nodes (6): 12.1 Summary line, 12.2 Description, 12.3 Origin, 12.4 Status, 12.5 Instruction, 12. Description panel 內容結構

### Community 76 - "10. Loadout TUI"
Cohesion: 0.33
Nodes (6): 10.1 Render ownership, 10.2 Header/body/footer, 10.3 Search, 10.4 Description, 10.5 Pending/error, 10. Loadout TUI

### Community 77 - "3. 已固定的產品規則"
Cohesion: 0.33
Nodes (6): 3.1 Scope 與按鍵, 3.2 Storage, 3.3 顯示, 3.4 Toggle transition, 3.5 MCP placeholder, 3. 已固定的產品規則

### Community 78 - "9. Loadout controller"
Cohesion: 0.33
Nodes (6): 9.1 State, 9.2 Load, 9.3 Toggle transaction, 9.4 Refresh, 9.5 Close, 9. Loadout controller

### Community 79 - "11｜第一版交付验收"
Cohesion: 0.33
Nodes (5): 11｜第一版交付验收, 失败处理, 必须通过, 目标, 验收步骤

### Community 80 - "12｜明确不做与越界检查"
Cohesion: 0.33
Nodes (5): 12｜明确不做与越界检查, Review 检查, 处理方式, 目标, 禁止改动

### Community 81 - "16. 顏色層級"
Cohesion: 0.33
Nodes (6): 16. 顏色層級, `accent`, `dim`, `highlight`, `normal`, `secondary`

### Community 82 - "6. 設定列表"
Cohesion: 0.33
Nodes (6): 6.1 列表行結構, 6.2 選中指示, 6.3 Key 欄, 6.4 選中 Key 的水平顯示, 6.5 Value 欄, 6. 設定列表

### Community 83 - "13. 空資料與缺失欄位"
Cohesion: 0.40
Nodes (5): 13.1 空分類, 13.2 無 Description, 13.3 無 Instruction, 13.4 無 Selection, 13. 空資料與缺失欄位

### Community 84 - "15. 底部操作提示"
Cohesion: 0.40
Nodes (5): 15.1 固定格式, 15.2 按鍵符號, 15.3 Action 文案, 15.4 窄畫面退化, 15. 底部操作提示

### Community 85 - "4. 頂部頁籤"
Cohesion: 0.40
Nodes (5): 4.1 頁籤結構, 4.2 Active 頁籤, 4.3 Inactive 頁籤, 4.4 頁籤操作, 4. 頂部頁籤

### Community 86 - "5. Scope 與設定來源"
Cohesion: 0.40
Nodes (5): 5.1 基本格式, 5.2 Scope, 5.3 Scope 操作, 5.4 路徑溢出, 5. Scope 與設定來源

### Community 87 - "7. 左側分類列表"
Cohesion: 0.40
Nodes (5): 7.1 固定分類順序, 7.2 分類圖示, 7.3 分類標題樣式, 7.4 Item 結構, 7. 左側分類列表

### Community 88 - "6. Pure model algorithm"
Cohesion: 0.40
Nodes (5): 6.1 Resolve configured status, 6.2 Resolve effective/display status, 6.3 MCP gate, 6.4 Selection reconciliation, 6. Pure model algorithm

### Community 89 - "7. Storage 實作"
Cohesion: 0.40
Nodes (5): 7.1 API, 7.2 Read, 7.3 Write, 7.4 Test injection, 7. Storage 實作

### Community 90 - "7. Description panel"
Cohesion: 0.40
Nodes (5): 7.1 基本結構, 7.2 顏色規則, 7.3 內容順序, 7.4 Description 摘要, 7. Description panel

### Community 91 - "6. Phase C：RPC/ACP fallback"
Cohesion: 0.22
Nodes (9): 6. Phase C：RPC/ACP fallback, C1. Capability API, C2. Strict option wire values, C3. Single flow, C4. Multi flow, C5. Final review, C6. Abort handling, C7. Fallback tests (+1 more)

### Community 92 - "11. Description panel"
Cohesion: 0.50
Nodes (4): 11.1 基本結構, 11.2 Panel 行為, 11.3 顏色層級, 11. Description panel

### Community 93 - "6. 搜尋欄"
Cohesion: 0.50
Nodes (4): 6.1 基本格式, 6.2 搜尋範圍, 6.3 計數規則, 6. 搜尋欄

### Community 94 - "8. Selection 與狀態符號"
Cohesion: 0.50
Nodes (4): 8.1 Selection, 8.2 Status, 8.3 隱藏項目提示, 8. Selection 與狀態符號

### Community 95 - "11. Shared shell 與 command"
Cohesion: 0.50
Nodes (4): 11.1 不擴充 public module API, 11.2 Existing public API, 11.3 Lifecycle, 11. Shared shell 與 command

### Community 96 - "13. Edit mode 操作"
Cohesion: 0.50
Nodes (4): 13.1 文字輸入, 13.2 確認, 13.3 取消, 13. Edit mode 操作

### Community 97 - "14. Focus 與狀態"
Cohesion: 0.50
Nodes (4): 14.1 Navigation mode, 14.2 Edit mode, 14.3 Description panel, 14. Focus 與狀態

### Community 98 - "4. 頂部頁籤"
Cohesion: 0.50
Nodes (4): 4.1 Active 頁籤, 4.2 Inactive 頁籤, 4.3 頁籤內容, 4. 頂部頁籤

### Community 99 - "8. 響應式佈局"
Cohesion: 0.50
Nodes (4): 8.1 寬模式, 8.2 窄模式, 8.3 窄模式 Value 溢出, 8. 響應式佈局

### Community 100 - "@hheei/pi-basics"
Cohesion: 0.50
Nodes (3): @hheei/pi-basics, Load and use, Non-goals

### Community 101 - "5. Phase B：TUI component"
Cohesion: 0.25
Nodes (8): 5. Phase B：TUI component, B1. Component boundary, B2. Single-settle lifecycle, B3. Render question screen, B4. Row-aware viewport, B5. Input routing, B6. Component tests, B7. Phase check

### Community 102 - "14. Toggle 行為"
Cohesion: 0.67
Nodes (3): 14.1 操作, 14.2 切換失敗, 14. Toggle 行為

### Community 103 - "16. 響應式行為"
Cohesion: 0.67
Nodes (3): 16.1 寬模式, 16.2 窄模式, 16. 響應式行為

### Community 104 - "9. Item 標籤溢出"
Cohesion: 0.67
Nodes (3): 9.1 未選中, 9.2 選中, 9. Item 標籤溢出

### Community 105 - "5. Domain contract"
Cohesion: 0.67
Nodes (3): 5.1 Key 規則, 5.2 Scope mapping, 5. Domain contract

### Community 106 - "8. Inventory 與 runtime adapter"
Cohesion: 0.67
Nodes (3): 8.1 Native Pi inventory, 8.2 MCP placeholder inventory, 8. Inventory 與 runtime adapter

### Community 107 - "11. 寬模式 Edit mode"
Cohesion: 0.67
Nodes (3): 11.1 左側樣式, 11.2 Description panel 樣式, 11. 寬模式 Edit mode

### Community 108 - "15. 底部操作提示"
Cohesion: 0.67
Nodes (3): 15.1 Navigation mode, 15.2 Edit mode, 15. 底部操作提示

### Community 109 - "3. 邊框語言"
Cohesion: 0.67
Nodes (3): 3.1 基本字符, 3.2 使用規則, 3. 邊框語言

### Community 110 - "9. Value 類型"
Cohesion: 0.67
Nodes (3): 9.1 Boolean Value, 9.2 非 Boolean Value, 9. Value 類型

### Community 123 - "7. 为什么推荐这些取舍"
Cohesion: 0.29
Nodes (7): 7.1 选择 multi-question，而不是强制一题一 call, 7.2 使用 id，不以 question text 当 key, 7.3 Recommendation 只影响 UI focus, 7.4 保留 automatic Other，删除通用 text questions与 comments, 7.5 保留 RPC fallback，固定 inline TUI, 7.6 不做 timeout, 7. 为什么推荐这些取舍

### Community 124 - "7. 實作階段"
Cohesion: 0.29
Nodes (7): 7. 實作階段, Phase 0：scope 與 placeholder contract, Phase 1：純 domain/state, Phase 2：scope-aware JSON storage, Phase 3：resource/runtime integration, Phase 4：Loadout TUI, Phase 5：`/hepi loadout` integration

### Community 126 - "8. TUI component"
Cohesion: 0.33
Nodes (6): 8.1 Rendering mode, 8.2.1 Tabbed panel layout（40-cell reference）, 8.2 Visual hierarchy, 8.3 Row-aware viewport, 8.4 Input, 8. TUI component

### Community 127 - "9. RPC/ACP fallback"
Cohesion: 0.33
Nodes (6): 9.1 Capability gate, 9.2 Single-select, 9.3 Multi-select, 9.4 Final review, 9.5 Abort, 9. RPC/ACP fallback

### Community 128 - "4. Phase A：Normalized model与validation"
Cohesion: 0.33
Nodes (6): 4. Phase A：Normalized model与validation, A1. 建立外部/内部类型, A2. Text validation helpers, A3. Pure state reducer, A4. Model tests, A5. Phase check

### Community 129 - "8. Phase E：Package integration smoke"
Cohesion: 0.33
Nodes (6): 8. Phase E：Package integration smoke, E1. Focused package tests, E2. Type diagnostics, E3. TUI smoke, E4. RPC smoke, E5. Loadout smoke

### Community 130 - "Phase 1｜Pure model"
Cohesion: 0.33
Nodes (6): Files, Inventory/filter/selection, Phase 1｜Pure model, Status resolution, Types and identity, Verification

### Community 131 - "Phase 5｜Loadout renderer"
Cohesion: 0.33
Nodes (6): Files/layout, Footer/error, Header/list, Phase 5｜Loadout renderer, Status/description, Width tests

### Community 132 - "Phase 4｜Loadout controller"
Cohesion: 0.33
Nodes (6): Files/state, Phase 4｜Loadout controller, Refresh/close, Toggle transaction, User state, Verification

### Community 133 - "12. Result contract"
Cohesion: 0.40
Nodes (5): 12.1 Submitted, 12.2 Cancelled, 12.3 Aborted/error, 12.4 Output bounds, 12. Result contract

### Community 134 - "14. Reference取舍"
Cohesion: 0.40
Nodes (5): 14.1 Claude Code, 14.2 rpiv-ask-user-question, 14.3 pi-ask-user, 14.4 SuPi Ask, 14. Reference取舍

### Community 135 - "16. Test contract"
Cohesion: 0.40
Nodes (5): 16.1 Model, 16.2 Component, 16.3 RPC fallback, 16.4 Integration, 16. Test contract

### Community 136 - "Phase 2｜Scope-aware storage"
Cohesion: 0.40
Nodes (5): Files/API, Phase 2｜Scope-aware storage, Read behavior, Verification, Write behavior

### Community 137 - "Phase 3｜Inventory 與 runtime adapters"
Cohesion: 0.40
Nodes (5): MCP placeholder, Native Pi inventory, Native runtime, Phase 3｜Inventory 與 runtime adapters, Verification

### Community 138 - "Phase 7｜Shared shell"
Cohesion: 0.40
Nodes (5): Module contract, Phase 7｜Shared shell, Settings cutover, Tab renderer/shell, Tests

### Community 139 - "MaybePromise"
Cohesion: 0.21
Nodes (9): AskComponentOptions, Block, createAskComponent(), requestRender(), ASK_LIMITS, AskInteractionResult, AskQuestionnaire, AskState (+1 more)

### Community 141 - "10. Execution lifecycle"
Cohesion: 0.50
Nodes (4): 10.1 Execute顺序, 10.2 One-active guard, 10.3 Session cleanup, 10. Execution lifecycle

### Community 142 - "3. pi-basics 整合边界"
Cohesion: 0.50
Nodes (4): 3.1 使用现有能力, 3.2 不使用的能力, 3.3 注册顺序, 3. pi-basics 整合边界

### Community 143 - "4. Tool identity与prompt surface"
Cohesion: 0.50
Nodes (4): 4.1 Description, 4.2 Prompt snippet, 4.3 Prompt guidelines, 4. Tool identity与prompt surface

### Community 144 - "6. Normalized model"
Cohesion: 0.50
Nodes (4): 6.1 Identity, 6.2 Text safety, 6.3 Runtime validation, 6. Normalized model

### Community 145 - "4. 用户可见行为"
Cohesion: 0.50
Nodes (4): 4.1 TUI, 4.2 RPC/ACP fallback, 4.3 非交互模式, 4. 用户可见行为

### Community 146 - "9. Cleanup"
Cohesion: 0.50
Nodes (4): 9.1 README, 9.2 Changelog, 9.3 Remove scaffolding, 9. Cleanup

### Community 147 - "2. 需求模型"
Cohesion: 0.50
Nodes (4): 2.1 Item identity, 2.2 狀態, 2.3 Inherit 的顯示規則, 2. 需求模型

### Community 148 - "Phase 9｜Verification"
Cohesion: 0.50
Nodes (4): Automated, Data safety, Phase 9｜Verification, Runtime smoke

### Community 150 - "11. Tool visibility与Loadout"
Cohesion: 0.67
Nodes (3): 11.1 Start-time strip-only reconciliation, 11.2 Execute backstop, 11. Tool visibility与Loadout

### Community 151 - "5. 外部参数schema"
Cohesion: 0.67
Nodes (3): 5.1 TypeBox shape, 5.2 `prepareArguments`, 5. 外部参数schema

### Community 153 - "panel.test.ts"
Cohesion: 0.11
Nodes (18): SettingsPanelHost, ExtensionSettingsSubpanelCreateOptions, DEFAULT_LOADOUT_SETTINGS, GLOBAL_LOADOUT_PATH, LOADOUT_SETTING_GROUPS, LoadoutDiff, loadoutExtension(), LoadoutLogDetails (+10 more)

### Community 155 - "helpers.ts"
Cohesion: 0.24
Nodes (9): LoadoutControllerOptions, LoadoutControllerState, LoadoutRuntimeAdapter, LoadoutInventory, LoadoutItem, LoadoutResolvedItem, LoadoutScope, LoadoutStorage (+1 more)

### Community 156 - "storage.ts"
Cohesion: 0.14
Nodes (18): piBasicsExtension(), createLoadoutView(), LoadoutComponentOptions, symbols, createLoadoutController(), createLoadoutModule(), LoadoutModule, loadoutKey (+10 more)

### Community 157 - "controller.ts"
Cohesion: 0.07
Nodes (47): ActiveTodoRuntime, canonicalPositiveInteger(), createTodoFeature(), formatTaskLine(), formatTodoList(), formatTodoResult(), formatTodosCommand(), isStaleSessionContextError() (+39 more)

### Community 158 - "component.test.ts"
Cohesion: 0.25
Nodes (3): questionnaire, taggedTheme, theme

### Community 159 - "component.test.ts"
Cohesion: 0.25
Nodes (5): Editor, EditorArgs, EditorFactory, EventHandler, FooterFactory

### Community 164 - "component.ts"
Cohesion: 0.06
Nodes (44): engines, bun, flush(), actionLabel(), ANSI_COLORS, ansiColor(), ansiSvgLine(), AnsiSvgStyle (+36 more)

### Community 165 - "inventory.ts"
Cohesion: 0.32
Nodes (7): ProcessRunner, SshMountResult, validateHost(), validateSshExecArgs(), executeSshMount(), SshMountArgs, validateSshMountArgs()

### Community 168 - "panel.ts"
Cohesion: 0.25
Nodes (4): createEmptyPane(), createSettingsPanelComponent(), groups, theme

### Community 169 - "index.ts"
Cohesion: 0.09
Nodes (31): text(), EditorComponent, EditorComponentFactory, EditorHostContext, EditorKeybindings, EditorModifier, EditorModifierContext, EditorTheme (+23 more)

### Community 170 - "pi-basics Todo 实作方案"
Cohesion: 0.18
Nodes (11): 11. Acceptance criteria, 12. 明确延后, 1. 实作原则, 2. 预期改动清单, 3. Phase 0：Review Gate, 9. Phase F：Docs 与 package contract, F1. README, F2. 旧计划同步 (+3 more)

### Community 171 - "6. Phase C：Tool、command 与 prompt"
Cohesion: 0.25
Nodes (8): 6. Phase C：Tool、command 与 prompt, C1. 增加 TypeBox dependency, C2. Tool schema 与 normalization, C3. Tool execute flow, C4. Prompt contract（线上来源交叉验证）, C5. 直接 `/todos` command, C6. Integration tests（第一部分）, C7. Phase check

### Community 172 - "7. Phase D：Widget"
Cohesion: 0.33
Nodes (6): 7. Phase D：Widget, D1. Component, D2. Render selection, D3. Width safety, D4. Widget tests, D5. Phase check

### Community 173 - "5. Phase B：Snapshot、replay 与 active runtime state"
Cohesion: 0.40
Nodes (5): 5. Phase B：Snapshot、replay 与 active runtime state, B1. 建立 durable snapshot, B2. Runtime semantics, B3. State tests, B4. Phase check

### Community 174 - "8. Phase E：Lifecycle 与 pi-basics entry"
Cohesion: 0.40
Nodes (5): 8. Phase E：Lifecycle 与 pi-basics entry, E1. Feature instance, E2. 修改 root entry, E3. Lifecycle 与 Loadout tests, E4. Phase check

### Community 175 - "10. Verification plan"
Cohesion: 0.50
Nodes (4): 10. Verification plan, Focused tests, Package regression, Runtime smoke test

### Community 176 - "4. Phase A：Domain model"
Cohesion: 0.50
Nodes (4): 4. Phase A：Domain model, A1. 建立类型与 reducer, A2. Model tests, A3. Phase check

## Knowledge Gaps
- **912 isolated node(s):** `todoOperation`, `TODO_PARAMETERS`, `TODO_PROMPT_GUIDELINES`, `TodoAction`, `TodoOperation` (+907 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `text()` connect `index.ts` to `Extcore TUI Components`, `Loadout State UI`, `panel.ts`, `index.ts`, `render.ts`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Why does `flush()` connect `component.ts` to `Extcore TUI Components`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `todoOperation`, `TODO_PARAMETERS`, `TODO_PROMPT_GUIDELINES` to the rest of the system?**
  _912 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `SSH Tool Registration` be split into smaller, more focused modules?**
  _Cohesion score 0.08571428571428572 - nodes in this community are weakly interconnected._
- **Should `Extcore TUI Components` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Should `Extcore Settings Providers` be split into smaller, more focused modules?**
  _Cohesion score 0.13356562137049943 - nodes in this community are weakly interconnected._
- **Should `Codex Interaction Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._