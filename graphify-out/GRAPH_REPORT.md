# Graph Report - hepi-mono  (2026-07-23)

## Corpus Check
- 233 files · ~125,170 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2153 nodes · 3528 edges · 153 communities (128 shown, 25 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 50 edges (avg confidence: 0.68)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8511ec8c`
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
- modules.ts
- model.ts
- component.ts
- feature.ts
- includes
- package.json
- executor.ts
- model.ts
- Pi Basics BTW 可复用代码清单
- SettingsController
- index.ts
- render.ts
- HePiRegistry
- Extension Development Guide
- index.ts
- settings.ts
- compilerOptions
- panels.ts
- Pi Basics BTW Research
- 2. 本仓库：应直接 import 的代码
- 1. dbachelder/pi-btw
- modules.ts
- 2. narumiruna/pi-extensions
- 3. juicesharp/rpiv-mono
- index.ts
- editor.ts
- HePiSettingField
- 1. 总结结论
- 8. 推荐的实际 copy 顺序
- contributions.ts
- index.ts
- contributions.ts
- 12. 逐步執行順序
- component.ts
- pi-basics Ask 高层方案（Review Gate）
- HePiMaybePromise
- 3. narumiruna：逐函数沿用清单
- HePiSettingsRegistry
- controller.ts
- tui-replay.test.ts
- ssh-exec.ts
- pi-dev.mjs
- 3. 各介面元素的官方用法
- helpers.ts
- TUI 設計語言規範
- replayTui
- writeReplayArtifacts
- description.test.ts
- controller.ts
- references.ts
- subagents.ts
- stream-output.ts
- 17. 顏色語義
- rtk-command-environment.ts
- config.ts
- ssh-exec.test.ts
- ssh-mount.ts
- pi-basics Ask 详细设计
- ReplayComponent
- render.test.ts
- 04｜公开 API、Settings contract 与 storage
- 05｜`/hepi` dispatcher
- 7.4 Transition rules
- config.test.ts
- LoadoutItem
- 2. 本仓库：应直接 import 的代码
- feature.test.ts
- 1. 总结结论
- 8. 推荐的实际 copy 顺序
- 3. narumiruna：逐函数沿用清单
- .provider
- 6. 搜尋欄
- package.json
- @hheei/pi-basics
- 14. Toggle 行為
- config.ts
- lifecycle.test.ts
- 9. Value 類型
- @hheei/__PACKAGE_SLUG__
- pi-extension-plan.md
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
- 9. RPC/ACP fallback
- 4. Phase A：Normalized model与validation
- Phase 1｜Pure model
- Phase 4｜Loadout controller
- 10. Execution lifecycle
- 4. Tool identity与prompt surface
- Phase 3｜Inventory 與 runtime adapters
- askWithDialogFallback
- storage.ts
- controller.ts
- formatter
- vcs
- component.ts
- panel.test.ts
- 6. 修改边界与工程注意事项
- 6. Phase C：Tool、command 与 prompt
- correctness
- Phase 9｜Verification
- HePiSettingField
- renderLoadoutTui
- 6. Phase C — Feature, command, input and tool surface
- settings.ts
- component.test.ts
- index.test.ts
- model.ts
- replayPlan
- responsiveSplit
- toRecord
- output-metrics.ts
- component.ts
- build.ts
- BoundedInput
- source.ts
- Do's and Don'ts
- scripts
- test-output.ts
- create-extension.mjs
- 5. Domain contract
- 8. Inventory 與 runtime adapter
- package.json
- linter
- 5. `/hepi` 命令設計
- 7. Runtime 與 module 邊界
- 8. 測試策略與文件夾
- Active Tool Toggle
- HePiSettingsRegistry

## God Nodes (most connected - your core abstractions)
1. `SettingsController` - 35 edges
2. `LoadoutController` - 21 edges
3. `HePiSettingField` - 17 edges
4. `HePiSettingsProvider` - 17 edges
5. `HePiRegistry` - 17 edges
6. `SettingsModel` - 16 edges
7. `includes` - 16 edges
8. `applyTodo()` - 15 edges
9. `createPlanFeature()` - 14 edges
10. `compilerOptions` - 14 edges

## Surprising Connections (you probably didn't know these)
- `plain()` --indirect_call--> `stripAnsi()`  [INFERRED]
  packages/pi-basics/test/modules/ask/component.test.ts → packages/pi-basics/test/helpers.ts
- `createAutoTitleProvider()` --indirect_call--> `provider()`  [INFERRED]
  packages/pi-basics/src/index.ts → packages/pi-basics/test/ui/render.test.ts
- `createLoadoutInventory()` --indirect_call--> `tool()`  [INFERRED]
  packages/pi-basics/src/modules/loadout/inventory.ts → packages/pi-basics/test/modules/loadout/model.test.ts
- `createAutoTitleCoordinator()` --indirect_call--> `text()`  [INFERRED]
  packages/pi-basics/src/modules/auto-title/index.ts → packages/pi-basics/test/modules/setting/component.test.ts
- `SettingsComponentOptions` --references--> `SettingsController`  [EXTRACTED]
  packages/pi-basics/src/modules/setting/component.ts → packages/pi-basics/src/modules/setting/controller.ts

## Import Cycles
- None detected.

## Communities (153 total, 25 thin omitted)

### Community 0 - "Codex Skill Picker"
Cohesion: 0.10
Nodes (19): summary(), ActiveRuntime, createGoalFeature(), ErrorCandidate, escapedObjective(), GOAL_PARAMETERS, GOAL_REPLAY_WARNING(), goalContext() (+11 more)

### Community 1 - "SSH Session Management"
Cohesion: 0.18
Nodes (8): createSettingsComponent(), createSettingsController(), SettingsModule, SettingsModuleOptions, fields, setup(), text(), theme

### Community 2 - "SSH Tool Registration"
Cohesion: 0.06
Nodes (32): 10. 后续扩展的决策门, 11. 验证命令, 1. 一句话方案, 2.1 首版包含, 2.2 首版明确不包含, 2. 功能边界, 3.1 命令, 3.2 Overlay (+24 more)

### Community 3 - "Extcore TUI Components"
Cohesion: 0.14
Nodes (16): detectPonytailDeactivation(), INTENSITY_SET, isPonytailIntensity(), isRecord(), parsePonytailCommand(), PONYTAIL_INTENSITIES, PonytailCommand, PonytailIntensity (+8 more)

### Community 4 - "Extcore Settings Providers"
Cohesion: 0.21
Nodes (16): ActivePlan, PlanPhase, RequestedPlanAction, appendPlanBoundary(), decodePlanBoundary(), encodePlanBoundary(), findPlanArtifact(), keys() (+8 more)

### Community 5 - "Codex Interaction Tests"
Cohesion: 0.08
Nodes (23): HePiSettingsStorage, createAdvisorSettingsProvider(), ANSI_ESCAPE, AutoTitleAgentAdapter, AutoTitleAgentFactory, AutoTitleCoordinator, autoTitleDescription(), autoTitleFields() (+15 more)

### Community 6 - "Loadout State UI"
Cohesion: 0.12
Nodes (21): ActiveTodoRuntime, blockedBy, canonicalPositiveInteger(), createTodoFeature(), formatTaskLine(), formatTodoList(), formatTodoOperationResult(), formatTodoResult() (+13 more)

### Community 7 - "Extcore Settings Panel"
Cohesion: 0.67
Nodes (3): typebox, typebox, typebox

### Community 8 - "Package Architecture Docs"
Cohesion: 0.07
Nodes (31): BtwComponentController, BtwComponentOptions, BtwComponentStatus, createBtwComponent(), requestRender(), abortRequest(), ActiveRequest, ActiveRuntime (+23 more)

### Community 9 - "Shared Settings Storage"
Cohesion: 0.10
Nodes (26): BtwExecutionResult, createCompletionOptions(), errorText(), executeBtwTurn(), ExecuteBtwTurnOptions, BtwRequestToken, BtwTurn, budgetContext() (+18 more)

### Community 10 - "Inturl Path Shortcuts"
Cohesion: 0.10
Nodes (43): ActiveGoal, ActiveGoalResult, ActiveGoalState, ActiveGoalTransition, activeResult(), DurableGoalResult, DurableGoalTransition, GoalComplete (+35 more)

### Community 11 - "modules.ts"
Cohesion: 0.06
Nodes (29): HePiContribution, HePiEditorContribution, HePiFooterContribution, HePiStatusContribution, createHePiModuleRegistry(), defaultModuleRegistry, getHePiModule(), HePiMaybePromise (+21 more)

### Community 12 - "model.ts"
Cohesion: 0.17
Nodes (19): configuredValue(), defaultDescriptionRegistry, inheritsGlobalConfiguration(), KIND_ORDER, LoadoutConfiguredStatus, LoadoutDescriptionPanel, LoadoutDisplayStatus, LoadoutEffectiveStatus (+11 more)

### Community 13 - "component.ts"
Cohesion: 0.12
Nodes (12): COMMAND_DESCRIPTIONS, COMMAND_VALUES, piCavemanExtension(), BeforeAgentStartHandler, CommandHandler, Completions, Harness, HarnessOptions (+4 more)

### Community 14 - "feature.ts"
Cohesion: 0.19
Nodes (6): registerRtkCommand(), RtkFeature, shouldRequireRtkAvailabilityForCommandHandling(), shouldSkipCommandHandlingWhenRtkMissing(), RtkIntegrationConfig, RuntimeStatus

### Community 15 - "includes"
Cohesion: 0.25
Nodes (7): files, ignoreUnknown, quoteStyle, javascript, formatter, overrides, $schema

### Community 16 - "package.json"
Cohesion: 0.16
Nodes (15): createPlanConfirmationComponent(), defined(), Focus, levels, modes, PlanConfirmationComponentOptions, PlanConfirmationModel, PlanImplementationMode (+7 more)

### Community 17 - "executor.ts"
Cohesion: 0.21
Nodes (12): createRtkFeature(), ToolResultCompactionMetadata, fallbackResolution(), getResolverCommand(), parseRtkExecutablePath(), ResolverCommand, resolveRtkExecutable(), ResolveRtkExecutableOptions (+4 more)

### Community 18 - "model.ts"
Cohesion: 0.10
Nodes (15): HePiSettingGroup, HePiSettingsState, HePiSettingValue, PendingChange, createSettingsModel(), fieldForSelection(), providerHasContent(), settingPanelItemId() (+7 more)

### Community 19 - "Pi Basics BTW 可复用代码清单"
Cohesion: 0.17
Nodes (12): 4. rpiv：只抽取的窄代码块, 5. Firstp1ck：只抽取的窄代码块, 6. dbachelder：只作反例和未来参考, 7. 许可证和 attribution, 9. 实施前最终判断, Pi Basics BTW 可复用代码清单, 不采用, 不采用 (+4 more)

### Community 20 - "SettingsController"
Cohesion: 0.27
Nodes (12): aborted(), cancelled(), checkAbort(), collectQuestion(), customAnswer(), DialogOptions, DialogUI, hasDialogUI() (+4 more)

### Community 21 - "index.ts"
Cohesion: 0.25
Nodes (5): activeModuleRegistry(), registerHePiModule(), Editor, EditorFactory, FooterFactory

### Community 22 - "render.ts"
Cohesion: 0.13
Nodes (24): SettingsComponentOptions, createSettingsLayout(), SettingsLayout, SettingsLayoutMode, settingFieldItemId(), settingGroupItemId(), editHints, ellipsizedDescription() (+16 more)

### Community 23 - "HePiRegistry"
Cohesion: 0.27
Nodes (8): PlanConfirmationAction, PlanConfirmationResult, completePlan(), emit(), fixture(), Options, planEvent, selected()

### Community 24 - "Extension Development Guide"
Cohesion: 0.22
Nodes (8): Agent Workflow, Development Commands, Extension Development Guide, Extension Entry Point, Local Testing in Pi, Package Checklist, Start Here, TUI Guidelines

### Community 25 - "index.ts"
Cohesion: 0.12
Nodes (19): BUILTIN_PROMPT_SNIPPETS, createLoadoutInventory(), createLoadoutInventoryProvider(), createMcpPlaceholder(), estimateTokenCount(), LoadoutCommandInfo, LoadoutInventoryProvider, LoadoutInventorySource (+11 more)

### Community 26 - "settings.ts"
Cohesion: 0.11
Nodes (15): createGlobalJsonStorage(), createProjectJsonStorage(), createSessionStorage(), defaultSettingsRegistry, getHePiSettings(), HePiJsonStorageBackend, HePiSettingChange, HePiSettingOption (+7 more)

### Community 27 - "compilerOptions"
Cohesion: 0.08
Nodes (24): bun, ES2022, node, compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib (+16 more)

### Community 28 - "panels.ts"
Cohesion: 0.11
Nodes (29): advance(), answersFromState(), ASK_LIMITS, AskAction, AskAnswer, AskAnswerDraft, askDetails(), AskMode (+21 more)

### Community 29 - "Pi Basics BTW Research"
Cohesion: 0.33
Nodes (4): Baseline recommendation for Pi Basics, Executive comparison, Pi Basics BTW Research, Verification performed

### Community 30 - "2. 本仓库：应直接 import 的代码"
Cohesion: 0.12
Nodes (8): registerAdvisorCommand(), Active, AdvisorAdapterFactory, AdvisorFeature, createAdvisorFeature(), FakeAdapter, fixture(), Handler

### Community 31 - "1. dbachelder/pi-btw"
Cohesion: 0.40
Nodes (5): 1. dbachelder/pi-btw, Execution and context, Shape, State and behavior, Strengths and risks

### Community 32 - "modules.ts"
Cohesion: 0.33
Nodes (9): commandCompletions(), CommandContext, dispatchHePiCommand(), getSessionId(), notify(), parseHePiCommand(), registeredApis, registerHePiCommand() (+1 more)

### Community 33 - "2. narumiruna/pi-extensions"
Cohesion: 0.40
Nodes (5): 2. narumiruna/pi-extensions, Execution and context, Shape, Strengths and risks, UI, cancellation, and tests

### Community 34 - "3. juicesharp/rpiv-mono"
Cohesion: 0.40
Nodes (5): 3. juicesharp/rpiv-mono, Execution and context, Shape, Strengths and risks, UI and lifecycle

### Community 35 - "index.ts"
Cohesion: 0.40
Nodes (5): 4. Firstp1ck/npm-packages, Execution and context, Shape, Strengths and risks, UI and tests

### Community 36 - "editor.ts"
Cohesion: 0.06
Nodes (51): DEFAULT_STATUSBAR_FORMAT_TOKENS, FORMAT_VARIABLES, joinStatusbarFormat(), parseStatusbarFormat(), RenderedStatusbarFormat, renderStatusbarFormat(), StatusbarFormatPart, StatusbarFormatToken (+43 more)

### Community 37 - "HePiSettingField"
Cohesion: 0.29
Nodes (8): escapeXml(), FilteredSkillPrompt, filterLoadoutDisabledSkillsFromPrompt(), formatSkillsForPrompt(), PromptSkill, promptSkillKey(), replaceSkillsSection(), skill()

### Community 38 - "1. 总结结论"
Cohesion: 0.15
Nodes (4): ansi, provider(), styleTheme, theme

### Community 39 - "8. 推荐的实际 copy 顺序"
Cohesion: 0.20
Nodes (4): HePiSettingField, fields, RtkCompactionSetting, RtkModeSetting

### Community 40 - "contributions.ts"
Cohesion: 0.10
Nodes (14): createLoadoutView(), LoadoutComponentOptions, copyMaps(), createLoadoutController(), LoadoutController, LoadoutControllerOptions, LoadoutControllerState, LoadoutRuntimeHandler (+6 more)

### Community 41 - "index.ts"
Cohesion: 0.15
Nodes (12): AskComponentOptions, Block, createAskComponent(), formatAskReviewAnswer(), invariant(), requestRender(), visibleBlocks(), harness() (+4 more)

### Community 42 - "contributions.ts"
Cohesion: 0.40
Nodes (5): Documentation, Pi Basics, Plans, Repository Development, Source Of Truth

### Community 44 - "component.ts"
Cohesion: 0.36
Nodes (6): filterLoadoutItems(), groupLoadoutItems(), loadoutPackageSortKey(), parseLoadoutKey(), reconcileLoadoutSelection(), sortLoadoutItems()

### Community 45 - "pi-basics Ask 高层方案（Review Gate）"
Cohesion: 0.20
Nodes (18): boundary(), createPlanFeature(), PendingPlan, persist(), PlanMessage, PlanMessageEndEvent, PlanMessageEndResult, restored() (+10 more)

### Community 46 - "HePiMaybePromise"
Cohesion: 0.17
Nodes (19): createAutoTitleProvider(), moduleRegistries, piBasicsExtension(), createDollarSkillFeature(), createLoadoutModule(), LoadoutModule, loadoutKey, createLoadoutStorage() (+11 more)

### Community 47 - "3. narumiruna：逐函数沿用清单"
Cohesion: 0.36
Nodes (6): LoadoutScope, LoadoutStatusMaps, createLoadoutComponent(), LoadoutTuiOptions, requestRender(), statusSymbol

### Community 49 - "controller.ts"
Cohesion: 0.20
Nodes (10): HePiContext, HePiSettingsProvider, applyChange(), applyChanges(), changedValues(), cloneState(), readableError(), SettingsControllerOptions (+2 more)

### Community 50 - "tui-replay.test.ts"
Cohesion: 0.17
Nodes (7): Editor, EditorFactory, theme, outputLines(), ReplayKey, scrollbackLines(), stripAnsi()

### Community 51 - "ssh-exec.ts"
Cohesion: 0.17
Nodes (3): SettingsController, cycleOption(), RenderSettingsOptions

### Community 52 - "pi-dev.mjs"
Cohesion: 0.17
Nodes (9): aliases, args, child, packageEntry(), rawArgs, resolveExtension(), root, separatorIndex (+1 more)

### Community 54 - "helpers.ts"
Cohesion: 0.22
Nodes (4): fakeHost, fakeProvider(), fakeStorage(), FakeStorageOptions

### Community 55 - "TUI 設計語言規範"
Cohesion: 0.15
Nodes (14): ActiveAsk, AgentToolResultLike, ASK_PARAMETERS, ASK_PROMPT_GUIDELINES, askOption, askQuestion, createAskFeature(), dispose() (+6 more)

### Community 56 - "replayTui"
Cohesion: 0.22
Nodes (6): actionLabel(), handleInput(), handleModelResult(), ReplayArtifactOptions, ReplayHost, replayTui()

### Community 57 - "writeReplayArtifacts"
Cohesion: 0.28
Nodes (9): ansiSvgLine(), escapeXml(), finalFrameSvg(), formatReplay(), positiveInteger(), replayTimestamp(), staticAnsi(), viewFrame() (+1 more)

### Community 58 - "description.test.ts"
Cohesion: 0.18
Nodes (9): createLoadoutDescriptionRegistry(), DescriptionRegistry, getLoadoutDescriptionPanel(), registerLoadoutDescriptionPanel(), resolveLoadoutItems(), unregisterLoadoutDescriptionPanel(), item, state (+1 more)

### Community 59 - "controller.ts"
Cohesion: 0.15
Nodes (16): applyOpenAIResponsesCompat(), compatValues(), configFromState(), configFromValues(), createOpenAIResponsesCompatFeature(), createOpenAIResponsesCompatSettingsProvider(), fields, isJsonObject() (+8 more)

### Community 60 - "references.ts"
Cohesion: 0.24
Nodes (10): computeRewriteDecision(), RewriteDecision, shouldBypassRtkFindRewrite(), isAlreadyRtk(), normalizeOptions(), resolveRtkRewrite(), RtkRewriteProviderOptions, RtkRewriteProviderResult (+2 more)

### Community 61 - "subagents.ts"
Cohesion: 0.21
Nodes (9): CavemanDefaults, CavemanIntensity, CavemanMode, buildCavemanPrompt(), INTENSITY_RULES, AgentToolInput, injectSubagentPrompt(), isPiSubagentSession() (+1 more)

### Community 62 - "stream-output.ts"
Cohesion: 0.20
Nodes (9): CI workflow, Checks, Create a New Extension Package, Docs, hepi-mono, Install, Layout, Local Pi Testing (+1 more)

### Community 63 - "17. 顏色語義"
Cohesion: 0.32
Nodes (10): ACTIVATE_PATTERN, CavemanCommand, cavemanStatusLabel(), detectCavemanIntent(), INTENSITY_SET, isCavemanIntensity(), isRecord(), normalizeIntentText() (+2 more)

### Community 64 - "rtk-command-environment.ts"
Cohesion: 0.42
Nodes (8): applyRtkCommandEnvironment(), getTemporaryRtkHistoryDbPath(), hasInheritedRtkDbPath(), hasLeadingRtkDbPathAssignment(), quoteForShellEnv(), resolveTemporaryDirectory(), RTK_DB_PATH_ASSIGNMENT_PATTERN, RTK_DB_PATH_EXPORT_PATTERN

### Community 65 - "config.ts"
Cohesion: 0.52
Nodes (6): Json, legacyConfigPath(), loadRtkConfig(), readRoot(), saveRtkConfig(), settingsPath()

### Community 67 - "ssh-exec.test.ts"
Cohesion: 0.22
Nodes (14): finish(), footer(), groupOrder, icons, labels, LoadoutRenderSnapshot, LoadoutTheme, panelLines() (+6 more)

### Community 68 - "ssh-mount.ts"
Cohesion: 0.20
Nodes (10): Loadout Tab, MCP Servers, Loadout TUI Design Mockup, Project Context, Set Tab, Skills, Tool Detail Panel, Tool Origin (+2 more)

### Community 69 - "pi-basics Ask 详细设计"
Cohesion: 0.14
Nodes (13): Backgrounds, Colors, Do, Do's and Don'ts, Don't, Elevation & Depth, Implementation Notes, Layout (+5 more)

### Community 71 - "render.test.ts"
Cohesion: 0.17
Nodes (16): asRecord(), DEFAULT_CAVEMAN_DEFAULTS, defaultsFromRoot(), defaultsFromState(), errorMessage(), isMissingFile(), isRecord(), JsonObject (+8 more)

### Community 72 - "04｜公开 API、Settings contract 与 storage"
Cohesion: 0.09
Nodes (13): AskFeature, createHePiRuntimeContext(), HePiRuntimeContext, HePiRuntimeContextOptions, HePiLifecycleController, HePiLifecycleOptions, registerHePiLifecycle(), HePiCleanupFailure (+5 more)

### Community 73 - "05｜`/hepi` dispatcher"
Cohesion: 0.07
Nodes (33): asRecord(), createPonytailSettingsProvider(), DEFAULT_PONYTAIL_DEFAULTS, defaultsFromRoot(), defaultsFromState(), defaultsFromValues(), errorMessage(), isMissingFile() (+25 more)

### Community 75 - "config.test.ts"
Cohesion: 0.43
Nodes (4): createCavemanSettingsProvider(), isMissingPiBasics(), registerCavemanHePiSettings(), temporaryDirectories

### Community 76 - "LoadoutItem"
Cohesion: 0.33
Nodes (4): LoadoutInventory, LoadoutItem, LoadoutResolvedItem, theme

### Community 77 - "2. 本仓库：应直接 import 的代码"
Cohesion: 0.33
Nodes (6): 2.1 Session runtime 和 cleanup, 2.2 Custom UI 和 exactly-once settle, 2.3 文本、键盘和滚动原语, 2.4 Model/auth 和 stale result 模式, 2.5 测试设施, 2. 本仓库：应直接 import 的代码

### Community 79 - "1. 总结结论"
Cohesion: 0.40
Nodes (5): 1. 总结结论, 优先直接复用本仓库代码, 只能借鉴并重写, 可以从参考仓库 copy 后小改, 明确不要复制

### Community 80 - "8. 推荐的实际 copy 顺序"
Cohesion: 0.40
Nodes (5): 8. 推荐的实际 copy 顺序, Step 1：先不 copy 上游 UI, Step 2：copy narumiruna 的纯 message skeleton, Step 3：补 rpiv/Firstp1ck 的窄逻辑, Step 4：最后写 feature orchestration

### Community 81 - "3. narumiruna：逐函数沿用清单"
Cohesion: 0.50
Nodes (4): 3. narumiruna：逐函数沿用清单, A：可近乎原样作为逻辑起点, B：可 copy 后改写, C/D：不应直接带入

### Community 93 - "6. 搜尋欄"
Cohesion: 0.11
Nodes (19): assertDirectChildDirectory(), createSshfsFeature(), ensureDirectory(), findMountEntry(), isAbortError(), isMissingBinaryError(), MountEntry, MountProbe (+11 more)

### Community 95 - "package.json"
Cohesion: 0.17
Nodes (11): description, engines, bun, name, packageManager, private, type, version (+3 more)

### Community 100 - "@hheei/pi-basics"
Cohesion: 0.15
Nodes (13): Advisor, Ask, Automatic Titles, BTW, Dollar skill references, Goal, @hheei/pi-basics, Load and use (+5 more)

### Community 102 - "14. Toggle 行為"
Cohesion: 0.08
Nodes (21): actionForInput(), AtomicAction, AtomicKeybinding, AtomicSpan, bareSkillName(), createDollarSkillAtomicEditor(), CURSOR_LEFT_INPUTS, CursorEditor (+13 more)

### Community 103 - "config.ts"
Cohesion: 0.49
Nodes (8): dollarSkillSettingsPath(), isJsonObject(), JsonObject, loadDollarSkillConfig(), normalizeDollarSkillConfig(), normalizeMaxSuggestions(), readRoot(), saveDollarSkillConfig()

### Community 104 - "lifecycle.test.ts"
Cohesion: 0.12
Nodes (12): createStatusbarFeature(), Editor, EditorFactory, Owner, renderBarCursor(), StatusbarFeature, Editor, EditorArgs (+4 more)

### Community 110 - "9. Value 類型"
Cohesion: 0.12
Nodes (16): includes, !**/dist, !**/node_modules, packages/*/**/*.ts, !**/.pi, test/**/*.ts, !graphify-out, *.json (+8 more)

### Community 111 - "@hheei/__PACKAGE_SLUG__"
Cohesion: 0.50
Nodes (3): Development, @hheei/__PACKAGE_SLUG__, Usage

### Community 112 - "pi-extension-plan.md"
Cohesion: 0.17
Nodes (12): Assistant message, Bash execution, Components, Custom message, Editor, Footer and status, Selector, Settings list (+4 more)

### Community 123 - "7. 为什么推荐这些取舍"
Cohesion: 0.18
Nodes (11): Change Checklist, HEPI modules, Local Development, Pi Basics Development, Public Integration APIs, Responsibilities, Runtime Lifecycle, Settings providers (+3 more)

### Community 127 - "9. RPC/ACP fallback"
Cohesion: 0.06
Nodes (30): 1.1 用語義 token，不直接在元件內決定顏色, 1.2 背景色是少數例外，不是通用卡片底色, 1.3 狀態用色彩，選取用位置與文字, 1.4 低裝飾、單層容器、保留空白, 1. 核心原則, 2.1 Core UI, 2.2 區塊背景, 2.3 Markdown (+22 more)

### Community 128 - "4. Phase A：Normalized model与validation"
Cohesion: 0.13
Nodes (23): applyRewrittenCommandShellSafetyFixups(), buildBufferedPipelineCommand(), extractProducerRewritePlan(), LEADING_RTK_DB_PATH_EXPORT_PRELUDE_PATTERN, ParsedPipeline, parseSimpleTopLevelPipeline(), ProducerRewritePlan, ShellSafetyTarget (+15 more)

### Community 137 - "Phase 1｜Pure model"
Cohesion: 0.11
Nodes (23): @biomejs/biome, @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui, devDependencies, @biomejs/biome, @earendil-works/pi-ai, @earendil-works/pi-coding-agent (+15 more)

### Community 140 - "Phase 4｜Loadout controller"
Cohesion: 0.15
Nodes (11): AtomicEditorOwner, configFromState(), createDollarSkillSettingsProvider(), DollarSkillFeature, EditorFactory, enabledField, fields, maxSuggestionsField (+3 more)

### Community 141 - "10. Execution lifecycle"
Cohesion: 0.22
Nodes (8): Documentation, Package Boundaries, Pi Basics TUI, Repository Instructions, Scope, Tooling, TypeScript, Session-scoped runtime state

### Community 143 - "4. Tool identity与prompt surface"
Cohesion: 0.09
Nodes (46): ANCHORED_READ_LINE_PATTERNS, AnchoredReadLine, AnchorSafeReadLine, AnchorSafeReadParts, applyAnsiStripping(), applyConditionalTechnique(), applyNullableTechnique(), applyReadCompactionBanner() (+38 more)

### Community 148 - "Phase 3｜Inventory 與 runtime adapters"
Cohesion: 0.17
Nodes (14): ApplyPatchGuard, createApplyPatchGuardSettingsProvider(), GuardPatchMode, hasStreamingApplyPatchCommand(), isJsonObject(), JsonObject, modeField, modeFromState() (+6 more)

### Community 156 - "storage.ts"
Cohesion: 0.22
Nodes (8): Attribution, Command, Compatibility, Defaults, Development, @hheei/pi-caveman, Install, State And Lifecycle

### Community 157 - "controller.ts"
Cohesion: 0.07
Nodes (34): ACTIONS, applyTodo(), ApplyTodoResult, cloneState(), dependencyError(), findTask(), freshTaskState(), hasCycle() (+26 more)

### Community 159 - "formatter"
Cohesion: 0.50
Nodes (4): formatter, enabled, indentStyle, lineWidth

### Community 161 - "vcs"
Cohesion: 0.50
Nodes (4): vcs, clientKind, enabled, useIgnoreFile

### Community 164 - "component.ts"
Cohesion: 0.11
Nodes (21): ANSI_COLORS, ansiColor(), AnsiSvgStyle, applySgr(), asRecord(), assistantOutput(), createArtifactDirectory(), FormatReplayOptions (+13 more)

### Community 166 - "panel.test.ts"
Cohesion: 0.15
Nodes (8): convertInputText(), convertProseLine(), createTraditionalToSimplifiedSettingsProvider(), Fence, JsonObject, matchFence(), toSimplified, TraditionalToSimplifiedFeature

### Community 170 - "6. 修改边界与工程注意事项"
Cohesion: 0.39
Nodes (7): aggregateLinterOutput(), detectLinterType(), isLinterCommand(), Issue, LINTER_COMMAND_PATTERNS, parseIssues(), parseLine()

### Community 171 - "6. Phase C：Tool、command 与 prompt"
Cohesion: 0.18
Nodes (16): hasOwnKey(), loadRtkIntegrationConfig(), normalizeRtkIntegrationConfig(), saveRtkIntegrationConfig(), toBoolean(), toInteger(), toMode(), toSourceFilterLevel() (+8 more)

### Community 178 - "correctness"
Cohesion: 0.67
Nodes (3): noUnusedImports, noUnusedVariables, correctness

### Community 179 - "Phase 9｜Verification"
Cohesion: 0.17
Nodes (12): rules, noFloatingPromises, nursery, preset, style, suspicious, noEnum, noNamespace (+4 more)

### Community 181 - "HePiSettingField"
Cohesion: 0.20
Nodes (3): graphemeBoundaries(), ValueEditor, ValueEditorState

### Community 198 - "6. Phase C — Feature, command, input and tool surface"
Cohesion: 0.18
Nodes (13): bareSkillName(), cleanDescription(), createDollarSkillAutocompleteProvider(), dim(), DollarSkillCommand, DollarSkillToken, expandDollarSkillReferences(), extractDollarSkillToken() (+5 more)

### Community 203 - "settings.ts"
Cohesion: 0.12
Nodes (13): advancedGroup, booleanField, createSettingsFixture(), delayedSaveProvider, emptyProvider, enumField, failedSaveProvider, generalGroup (+5 more)

### Community 211 - "component.test.ts"
Cohesion: 0.28
Nodes (11): CHAIN_OPERATORS, matchesCommandPatterns(), normalizeCommandForDetection(), sliceFirstSegment(), compactDiff(), compactGitOutput(), compactLog(), compactStatus() (+3 more)

### Community 212 - "index.test.ts"
Cohesion: 0.20
Nodes (9): Attribution, Command, Companion Skills, Compatibility, Defaults, Development, @hheei/pi-ponytail, Install (+1 more)

### Community 215 - "model.ts"
Cohesion: 0.43
Nodes (6): compactPath(), detectPathPrefix(), detectPathSeparator(), joinPathSegments(), groupSearchResults(), SearchResult

### Community 225 - "toRecord"
Cohesion: 0.22
Nodes (12): isTextContentBlock(), mapTextContentBlocks(), TextContentBlock, toRecord(), ANSI_CSI_PATTERN, ANSI_OSC_PATTERN, ANSI_OSC_TERMINATED_PATTERN, stripAnsi() (+4 more)

### Community 227 - "component.ts"
Cohesion: 0.18
Nodes (11): scripts, check, check:fix, format, format:check, lint, new:extension, pi:dev (+3 more)

### Community 228 - "build.ts"
Cohesion: 0.31
Nodes (10): BUILD_COMMAND_PATTERNS, BuildStats, ERROR_START_PATTERNS, filterBuildOutput(), isBuildCommand(), isErrorStart(), isSkipLine(), isWarning() (+2 more)

### Community 230 - "source.ts"
Cohesion: 0.23
Nodes (12): COMMENT_PATTERNS, CommentPatterns, countCodeBraces(), detectLanguage(), filterAggressive(), filterMinimal(), filterSourceCode(), getCodePortion() (+4 more)

### Community 233 - "Do's and Don'ts"
Cohesion: 0.25
Nodes (7): formatUiError(), HePiParseError, HePiStorageError, HePiUiError, messageOf(), toUiError(), UiErrorKind

### Community 234 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, check, check:fix, format, format:check, lint, new:extension, pi:dev (+3 more)

### Community 240 - "test-output.ts"
Cohesion: 0.33
Nodes (8): aggregateTestOutput(), extractTestStats(), FAILURE_START_PATTERNS, isFailureStart(), isTestCommand(), TEST_COMMAND_PATTERNS, TEST_RESULT_PATTERNS, TestSummary

### Community 250 - "create-extension.mjs"
Cohesion: 0.22
Nodes (5): packageDir, packagesDir, root, slug, templateDir

### Community 254 - "5. Domain contract"
Cohesion: 0.40
Nodes (4): Boundaries, Hunt, Output, Tags

### Community 255 - "8. Inventory 與 runtime adapter"
Cohesion: 0.40
Nodes (4): Boundaries, Honesty boundary, Ponytail Gain, Scoreboard

### Community 259 - "package.json"
Cohesion: 0.22
Nodes (8): description, engines, bun, name, packageManager, private, type, version

### Community 262 - "linter"
Cohesion: 0.50
Nodes (4): types, linter, domains, enabled

### Community 263 - "5. `/hepi` 命令設計"
Cohesion: 0.40
Nodes (4): Companion Skills, Defaults, Modes, Ponytail Help

### Community 265 - "7. Runtime 與 module 邊界"
Cohesion: 0.40
Nodes (4): Boundaries, Examples, Format, Scoring

### Community 266 - "8. 測試策略與文件夾"
Cohesion: 0.50
Nodes (3): Boundaries, Output, Scan

## Knowledge Gaps
- **660 isolated node(s):** `Advisor`, `Load and use`, `Goal`, `Ask`, `BTW` (+655 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **25 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `visibleWidth` connect `editor.ts` to `LoadoutItem`, `controller.ts`, `HePiSettingField`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Why does `createAskFeature()` connect `TUI 設計語言規範` to `Codex Interaction Tests`, `index.ts`, `package.json`, `SettingsController`, `panels.ts`?**
  _High betweenness centrality (0.051) - this node is a cross-community bridge._
- **Why does `text()` connect `SSH Session Management` to `editor.ts`, `Codex Interaction Tests`, `render.ts`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **What connects `Advisor`, `Load and use`, `Goal` to the rest of the system?**
  _660 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Codex Skill Picker` be split into smaller, more focused modules?**
  _Cohesion score 0.10114942528735632 - nodes in this community are weakly interconnected._
- **Should `SSH Tool Registration` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._
- **Should `Extcore TUI Components` be split into smaller, more focused modules?**
  _Cohesion score 0.1422924901185771 - nodes in this community are weakly interconnected._