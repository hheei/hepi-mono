# Graph Report - .  (2026-07-22)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1893 nodes · 4009 edges · 102 communities (83 shown, 19 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 90 edges (avg confidence: 0.76)
- Token cost: 26,511 input · 686 output

## Graph Freshness
- Built from commit: `e94ff238`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Terminal Panel Rendering
- Goal Feature Lifecycle
- TUI Replay Testing
- HePi Module Registry
- Plan Confirmation Flow
- Status Bar Formatting
- Starship Built-in Modules
- Settings Panel Extension
- Starship Format Parsing
- Repository File Patterns
- Settings Registry Controller
- Editor Modifier System
- Package Dependencies
- Settings Storage Panels
- Settings Panel Rendering
- Settings Component Tests
- Git Worktree Status
- Settings State Model
- Loadout Status Feature
- Loadout Status Model
- Starship Configuration Loading
- Project Design Documents
- Auto Title Feature
- SSH Mount Sessions
- TypeScript Build Config
- Questionnaire State Machine
- SSH Extension Commands
- Installed Package Status
- Feature Design Documents
- Loadout Runtime Controller
- Todo State Validation
- Settings Field Definitions
- Loadout TUI Rendering
- Lifecycle Registry
- Command Test Harness
- Loadout Inventory Sources
- Dollar Skill Editor
- Settings JSON Storage
- Side Panel Layout
- Todo Feature Commands
- Todo Widget Runtime
- Skill Discovery Index
- Editor Picker Tests
- SSH Session Management
- Plan UI Tests
- SSH Command Execution
- Question Fallback Dialog
- Todo Snapshot Integration
- Ask Feature Runtime
- Rendering Test Fixtures
- Format Parser
- Loadout Settings Model
- Loadout TUI Helpers
- Traditional Text Conversion
- Dollar Skill References
- Skill Picker Rendering
- Output Tail Buffer
- Architecture Planning Documents
- Runtime Lifecycle Controller
- Settings Table Component
- Bounded Text Input
- Development CLI Script
- Loadout Storage Controller
- Path Shortcut Expansion
- Starship CLI Commands
- Loadout Settings Storage
- UI Error Handling
- Extension Registration Tests
- Loadout Interface Design
- Tool Activation Coordination
- Process Output Streaming
- TypeScript Project Config
- Loadout Footer Rendering
- SSH Execution Tests
- Settings Panel Tests
- Extension Scaffolding Script
- Ask Component Feature
- Fake Editor Testing
- Ask Parameter Normalization
- Settings Responsive Layout
- Runtime Tool Policy
- Project Development Guide
- Pi TUI Design
- Tool Toggle Navigation
- Project Development Plan
- Original Todo Checklist
- Historical Plan Index
- Global Settings Storage
- Project Settings Storage
- Session Backed Storage
- Readable Error Messages
- Dialog Ask Fallback
- Loadout TUI Renderer
- Plan Replay
- Settings Layout
- Settings TUI Renderer
- Rounded Panel Rendering
- Keymap Rendering
- Responsive Split Layout
- Horizontal Viewport
- Text Wrapping

## God Nodes (most connected - your core abstractions)
1. `SettingsController` - 33 edges
2. `truncateToWidth()` - 31 edges
3. `SessionManager` - 31 edges
4. `piBasicsExtension()` - 27 edges
5. `LoadoutController` - 27 edges
6. `visibleWidth` - 26 edges
7. `createGoalFeature()` - 25 edges
8. `HePiRuntimeContext` - 24 edges
9. `HePiSettingsProvider` - 21 edges
10. `padToWidth()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Extension Development Guide` --semantically_similar_to--> `hepi-mono README`  [INFERRED] [semantically similar]
  docs/extension-development.md → README.md
- `Loadout TUI Design Language` --semantically_similar_to--> `Semantic terminal-native UI`  [INFERRED] [semantically similar]
  docs/loadout_tui_design_language.md → DESIGN.md
- `createGroupedTogglePicker()` --indirect_call--> `renderList()`  [INFERRED]
  legacy/pi-extcore/src/tui/grouped-toggle-picker.ts → packages/pi-basics/src/modules/setting/render.ts
- `CI workflow` --references--> `hepi-mono README`  [INFERRED]
  .github/workflows/ci.yml → README.md
- `Pi Basics Goal Detailed Design` --conceptually_related_to--> `Session-scoped runtime state`  [INFERRED]
  docs/pi-basics-goal-design.md → AGENTS.md

## Import Cycles
- 3-file cycle: `packages/pi-basics/src/api/modules.ts -> packages/pi-basics/src/api/settings.ts -> packages/pi-basics/src/api/panels.ts -> packages/pi-basics/src/api/modules.ts`

## Hyperedges (group relationships)
- **HEPI repository documentation contract** — agents, readme, docs_extension_development, docs_pi_basics_development [INFERRED 0.85]
- **Goal durable execution architecture** — goal_single_branch_objective, goal_durable_state_machine, goal_settled_scheduler, tool_activation_coordinator [EXTRACTED 1.00]
- **Loadout UI and runtime contract** — loadout_layered_state, loadout_mcp_placeholder, hepi_shared_shell, semantic_terminal_ui [INFERRED 0.85]
- **Pi Basics phased delivery and acceptance contract** — docs_pi_basics_tasks_06_settings_tui, docs_pi_basics_tasks_08_testing, docs_pi_basics_tasks_09_phases, docs_pi_basics_tasks_11_acceptance [INFERRED 0.85]
- **Interactive module architecture** — docs_pi_basics_tasks_06_settings_tui, docs_pi_tui_rendering_and_extension_customization, docs_plans_ask_design, docs_plans_plan_design [INFERRED 0.75]
- **Scope boundaries deferred decisions and historical planning** — docs_pi_basics_tasks_12_non_goals, docs_pi_basics_tasks_13_deferred_decisions, docs_plans_readme, docs_plans_ask_high_level, docs_plans_plan_high_level [INFERRED 0.75]
- **Session Scoped TUI Visual Surfaces** — statusbar_status_rail, todo_above_editor_widget, btw_transient_overlay, tui_cell_width_safety [INFERRED 0.85]
- **Branch Derived State Patterns** — todo_branch_snapshot_replay, rpiv_todo_tool_result_replay, btw_session_message_snapshot [INFERRED 0.85]
- **Pi Extension Lifecycle Controls** — todo_lifecycle_owner, advisor_active_tool_policy, ask_user_question_questionnaire_state, statusbar_editor_factory_decorator [INFERRED 0.75]
- **Loadout Resource Groups** — docs_loadout_design_mcp_servers, docs_loadout_design_tools, docs_loadout_design_skills [EXTRACTED 1.00]

## Communities (102 total, 19 thin omitted)

### Community 0 - "Terminal Panel Rendering"
Cohesion: 0.06
Nodes (56): Block, finishLine(), panelLines(), shortDescription(), finish(), Focus, levels, modes (+48 more)

### Community 1 - "Goal Feature Lifecycle"
Cohesion: 0.06
Nodes (58): ActiveRuntime, createGoalFeature(), ErrorCandidate, escapedObjective(), GOAL_PARAMETERS, GOAL_REPLAY_WARNING(), goalContext(), GoalFeature (+50 more)

### Community 2 - "TUI Replay Testing"
Cohesion: 0.05
Nodes (47): flush(), Editor, EditorFactory, theme, actionLabel(), ANSI_COLORS, ansiColor(), ansiSvgLine() (+39 more)

### Community 3 - "HePi Module Registry"
Cohesion: 0.06
Nodes (34): HePiContribution, HePiEditorContribution, HePiFooterContribution, HePiStatusContribution, createHePiModuleRegistry(), defaultModuleRegistry, getHePiModule(), HePiModule (+26 more)

### Community 4 - "Plan Confirmation Flow"
Cohesion: 0.09
Nodes (39): createPlanConfirmationComponent(), PlanConfirmationAction, PlanConfirmationComponentOptions, PlanConfirmationResult, ActivePlan, assistantText(), boundary(), createPlanFeature() (+31 more)

### Community 5 - "Status Bar Formatting"
Cohesion: 0.07
Nodes (37): DEFAULT_STATUSBAR_FORMAT_TOKENS, FORMAT_VARIABLES, joinStatusbarFormat(), parseStatusbarFormat(), RenderedStatusbarFormat, renderStatusbarFormat(), StatusbarFormatPart, StatusbarFormatToken (+29 more)

### Community 6 - "Starship Built-in Modules"
Cohesion: 0.09
Nodes (25): BUILT_IN_CONFIG, activityModule, brandModule, contextModule, costModule, directoryModule, compactPrState(), gitBranchModule (+17 more)

### Community 7 - "Settings Panel Extension"
Cohesion: 0.11
Nodes (39): piExtcore(), SettingsPanelHost, SettingsPanelInput, SettingsPanelPane, createGeneralPaneGroups(), createPaneState(), createProviderState(), loadProviderState() (+31 more)

### Community 8 - "Starship Format Parsing"
Cohesion: 0.08
Nodes (42): activePalette(), ModuleConfig, ownPalette(), StarshipConfig, chunksForValue(), conditionalVisible(), FormatNode, FormatSyntaxError (+34 more)

### Community 9 - "Repository File Patterns"
Cohesion: 0.05
Nodes (39): !**/dist, !**/node_modules, packages/*/**/*.ts, !**/.pi, test/**/*.ts, *.json, *.md, packages/*/**/*.json (+31 more)

### Community 10 - "Settings Registry Controller"
Cohesion: 0.10
Nodes (15): HePiContext, HePiSettingsProvider, HePiSettingsRegistry, HePiSettingValue, applyChange(), cloneState(), PendingChange, readableError() (+7 more)

### Community 11 - "Editor Modifier System"
Cohesion: 0.09
Nodes (29): EditorComponent, EditorComponentFactory, EditorHostContext, EditorKeybindings, EditorModifier, EditorModifierContext, EditorTheme, EditorTui (+21 more)

### Community 12 - "Package Dependencies"
Cohesion: 0.06
Nodes (35): @biomejs/biome, @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui, packages/*, typebox, @types/bun, @types/node (+27 more)

### Community 13 - "Settings Storage Panels"
Cohesion: 0.09
Nodes (18): HePiMaybePromise, HePiPanel, HePiSettingsSubpanel, createGlobalJsonStorage(), createHePiSettingsRegistry(), createProjectJsonStorage(), createSessionStorage(), defaultSettingsRegistry (+10 more)

### Community 14 - "Settings Panel Rendering"
Cohesion: 0.15
Nodes (26): createGroupSettingItem(), createPlainSettingItems(), createSettingItems(), formatFooter(), keycap(), resolveSettingDescription(), SettingsPanelOptions, summarizeGroup() (+18 more)

### Community 15 - "Settings Component Tests"
Cohesion: 0.10
Nodes (16): createSettingsComponent(), createSettingsController(), fakeHost, fakeProvider(), fakeStorage(), fakeTheme(), testContext(), fields (+8 more)

### Community 16 - "Git Worktree Status"
Cohesion: 0.11
Nodes (22): settingsFilePath(), gitStatusEqual(), isChanged(), isConflict(), parseGitStatusPorcelain(), parseGitWorktree(), readGitStatus(), readGitWorktree() (+14 more)

### Community 17 - "Settings State Model"
Cohesion: 0.10
Nodes (14): HePiSettingsState, createSettingsModel(), fieldForSelection(), mergeSettingsState(), providerHasContent(), settingPanelItemId(), SettingsMode, SettingsModel (+6 more)

### Community 18 - "Loadout Status Feature"
Cohesion: 0.13
Nodes (25): listHePiSettings(), createStatusbarFeature(), moduleRegistries, piBasicsExtension(), createLoadoutView(), LoadoutComponentOptions, createLoadoutController(), LoadoutRuntimeHandlers (+17 more)

### Community 19 - "Loadout Status Model"
Cohesion: 0.14
Nodes (25): configuredValue(), filterLoadoutItems(), groupLoadoutItems(), KIND_ORDER, LoadoutConfiguredStatus, LoadoutDisplayStatus, LoadoutEffectiveStatus, LoadoutGroup (+17 more)

### Community 20 - "Starship Configuration Loading"
Cohesion: 0.14
Nodes (26): AtomicFileSystem, atomicSaveConfigDocument(), BUILT_IN_FORMAT, BUILT_IN_FORMAT_DOCUMENT, BUILT_IN_MODULES, BUILT_IN_PALETTE, cloneBuiltInConfig(), ConfigDiagnostic (+18 more)

### Community 21 - "Project Design Documents"
Cohesion: 0.08
Nodes (25): Repository Instructions, Pi Basics Terminal UI Design, Loadout TUI Design Language, Pi Basics Development, Pi Basics Goal Detailed Design, Pi Basics Goal High-Level Plan, Pi Basics Goal Implementation Plan, Pi Basics Loadout Implementation (+17 more)

### Community 22 - "Auto Title Feature"
Cohesion: 0.14
Nodes (20): createAutoTitleProvider(), AGENT_PATH, ANSI_ESCAPE, autoTitleFields(), autoTitleModelOptions(), AutoTitleRuntime, AutoTitleSettingsOptions, AutoTitleStorageOptions (+12 more)

### Community 23 - "SSH Mount Sessions"
Cohesion: 0.18
Nodes (3): sanitizeHostForSocket(), SessionManager, executeSshExec()

### Community 24 - "TypeScript Build Config"
Cohesion: 0.08
Nodes (23): bun, ES2022, node, **/dist/**, **/node_modules/**, packages/*/**/*.ts, **/.pi/**, test/**/*.ts (+15 more)

### Community 25 - "Questionnaire State Machine"
Cohesion: 0.14
Nodes (21): advance(), answersFromState(), ASK_LIMITS, AskAction, AskAnswerDraft, askDetails(), AskMode, AskOption (+13 more)

### Community 26 - "SSH Extension Commands"
Cohesion: 0.13
Nodes (19): createManager(), DEFAULT_SETTINGS, ensureTrailingSlash(), errorMessage(), errorResult(), formatDisplayPath(), mountResult(), register() (+11 more)

### Community 27 - "Installed Package Status"
Cohesion: 0.15
Nodes (21): InstalledPackage, InstalledPackageInfo, npmPackageName(), packageNameForSource(), readInstalledPackageInfo(), readPackagesFromSettings(), resolveSourcePath(), buildExtensionStatusIconAliases() (+13 more)

### Community 28 - "Feature Design Documents"
Cohesion: 0.10
Nodes (22): Questionnaire State Reducer, RPC Select Input Fallback, BTW Session Message Snapshot, Transient BTW Overlay, Pi Basics Statusbar High Level, Pi Basics Statusbar Implementation, Pi Basics Todo Detailed Design, Pi Basics Todo High Level Plan (+14 more)

### Community 29 - "Loadout Runtime Controller"
Cohesion: 0.22
Nodes (4): copyMaps(), LoadoutController, normalize(), readable()

### Community 30 - "Todo State Validation"
Cohesion: 0.18
Nodes (18): ACTIONS, applyTodo(), ApplyTodoResult, cloneState(), dependencyError(), findTask(), hasCycle(), hasOnlyKeys() (+10 more)

### Community 31 - "Settings Field Definitions"
Cohesion: 0.10
Nodes (15): HePiSettingField, HePiSettingGroup, SettingsProviderSnapshot, advancedGroup, booleanField, delayedSaveProvider, emptyProvider, enumField (+7 more)

### Community 32 - "Loadout TUI Rendering"
Cohesion: 0.16
Nodes (17): LoadoutControllerState, LoadoutItem, LoadoutKind, LoadoutResolvedItem, finish(), footer(), groupOrder, icons (+9 more)

### Community 33 - "Lifecycle Registry"
Cohesion: 0.11
Nodes (6): HePiCleanupFailure, HePiIdentified, HePiLifecycleRegistration, HePiRegistrationKind, HePiRegistry, fakePi

### Community 34 - "Command Test Harness"
Cohesion: 0.11
Nodes (13): name(), ExecResult, FooterFactory, builtinTool(), createCustomSelectorHarness(), createMockContext(), createMockPi(), driveCustomSelector() (+5 more)

### Community 35 - "Loadout Inventory Sources"
Cohesion: 0.18
Nodes (18): BUILTIN_PROMPT_SNIPPETS, createLoadoutInventory(), createMcpPlaceholder(), estimateTokenCount(), LoadoutCommandInfo, LoadoutInventory, LoadoutInventorySource, LoadoutInventoryValue (+10 more)

### Community 36 - "Dollar Skill Editor"
Cohesion: 0.15
Nodes (17): createSkillPickerEditor(), getPickerState(), HIGHLIGHT_BASE_EDITOR, HIGHLIGHT_WRAPPED, isEditorLike(), DEFAULT_DOLLAR_SETTINGS, DollarExtensionSettings, CustomEditorConstructor (+9 more)

### Community 37 - "Settings JSON Storage"
Cohesion: 0.17
Nodes (15): SavedSettingsEntry, asSettingsState(), createAgentJsonSettingsStorage(), createExtensionSettingsStorage(), createJsonSettingsStorage(), isNodeError(), isRecord(), isSettingsFile() (+7 more)

### Community 38 - "Side Panel Layout"
Cohesion: 0.18
Nodes (15): autoColumnWidth(), autoTwoColumnWidth(), maxVisibleWidth(), padRight(), renderRowsWithSidePanel(), renderTwoColumnListWithSidePanel(), renderWrappedTableRows(), RowsWithSidePanelOptions (+7 more)

### Community 39 - "Todo Feature Commands"
Cohesion: 0.18
Nodes (18): blockedBy, canonicalPositiveInteger(), createTodoFeature(), formatTaskLine(), formatTodoList(), formatTodoResult(), formatTodosCommand(), isStaleSessionContextError() (+10 more)

### Community 40 - "Todo Widget Runtime"
Cohesion: 0.13
Nodes (7): ActiveTodoRuntime, TaskState, createTodoWidget(), renderTodo(), TodoWidget, Harness, identityTheme

### Community 41 - "Skill Discovery Index"
Cohesion: 0.19
Nodes (18): EXTENSION_DIR, formatSkillItem(), formatSourceLabel(), getSkillEntries(), getSkillSuggestions(), normalizeSkillDescription(), normalizeSourceLabel(), packageDirs() (+10 more)

### Community 42 - "Editor Picker Tests"
Cohesion: 0.11
Nodes (16): ANSI_ESCAPE_PATTERN, backspaceEditor, baseEditor, baseEditorSymbol, editor, editorWithBaseMetadata, keybindingEditor, navigationEditor (+8 more)

### Community 43 - "SSH Session Management"
Cohesion: 0.13
Nodes (14): clampPositiveInt(), DEFAULT_MOUNT_DIR, DEFAULT_PLUGIN_DIR, envNumber(), envString(), HostFailureState, isMissingBinaryError(), MountProbe (+6 more)

### Community 44 - "Plan UI Tests"
Cohesion: 0.14
Nodes (14): PlanThinkingLevel, assertVisibleWidth(), stripAnsi(), harness(), plain(), questionnaire, taggedTheme, theme (+6 more)

### Community 45 - "SSH Command Execution"
Cohesion: 0.15
Nodes (16): ProcessResult, ProcessRunner, SshMountResult, clampTimeoutSeconds(), envTimeoutSeconds(), ExecuteSshExecOptions, managerLikeSpawn(), remainingTimeoutMs() (+8 more)

### Community 46 - "Question Fallback Dialog"
Cohesion: 0.21
Nodes (14): aborted(), cancelled(), checkAbort(), collectQuestion(), customAnswer(), DialogOptions, DialogUI, hostError() (+6 more)

### Community 47 - "Todo Snapshot Integration"
Cohesion: 0.19
Nodes (10): TODO_PARAMETERS, TODO_PROMPT_GUIDELINES, Task, latestTodoSnapshot(), snapshotFromBranchEntry(), snapshotFromState(), stateFromSnapshot(), TodoSnapshot (+2 more)

### Community 48 - "Ask Feature Runtime"
Cohesion: 0.18
Nodes (12): hasDialogUI(), ActiveAsk, AgentToolResultLike, ASK_PARAMETERS, ASK_PROMPT_GUIDELINES, askOption, askQuestion, createAskFeature() (+4 more)

### Community 49 - "Rendering Test Fixtures"
Cohesion: 0.15
Nodes (12): fixtureRoot, commands, noopTheme(), all, ANSI_ESCAPE, ANSI_ESCAPE_PATTERN, lines, many (+4 more)

### Community 50 - "Format Parser"
Cohesion: 0.47
Nodes (3): FormatParser, FUNCTIONAL, parseFormat()

### Community 51 - "Loadout Settings Model"
Cohesion: 0.13
Nodes (14): DEFAULT_LOADOUT_SETTINGS, GLOBAL_LOADOUT_PATH, LOADOUT_SETTING_GROUPS, LoadoutDiff, LoadoutLogDetails, LoadoutPresetName, LoadoutResult, LoadoutSettings (+6 more)

### Community 52 - "Loadout TUI Helpers"
Cohesion: 0.19
Nodes (13): formatLoadoutGroupDescription(), formatLoadoutStatusLabel(), isSettingsListExtraLine(), LoadoutFooterOptions, LoadoutFooterPane, LoadoutFooterSelectionKind, LoadoutPresetDescriptionOptions, LoadoutStatus (+5 more)

### Community 53 - "Traditional Text Conversion"
Cohesion: 0.17
Nodes (7): convertInputText(), convertProseLine(), Fence, JsonObject, matchFence(), toSimplified, TraditionalToSimplifiedFeature

### Community 54 - "Dollar Skill References"
Cohesion: 0.21
Nodes (11): dollarSkillAutocomplete(), applyDollarSkillCompletion(), extractDollarSkillToken(), expandDollarSkillReferences(), highlightDollarSkillReferences(), getSkillPathMap(), SkillCommand, SkillSuggestion (+3 more)

### Community 55 - "Skill Picker Rendering"
Cohesion: 0.34
Nodes (13): renderSkillPickerLines(), clamp(), highlightAccent(), padRight(), styleDescription(), styleInactiveRow(), styleScrollInfo(), styleSelectedRow() (+5 more)

### Community 56 - "Output Tail Buffer"
Cohesion: 0.22
Nodes (9): countNewlines(), findUtf8TailStart(), isUtf8ContinuationByte(), OutputSource, OutputTailSink, readStreamTail(), TailDump, TailEntry (+1 more)

### Community 57 - "Architecture Planning Documents"
Cohesion: 0.18
Nodes (14): Settings TUI model controller component and rendering, Runtime lifecycle and module boundaries, Testing infrastructure and coverage strategy, Phased implementation and delivery orchestration, First release acceptance criteria, Scope boundaries and non-goals, Deferred decisions for first release, Pi Basics task execution guide (+6 more)

### Community 58 - "Runtime Lifecycle Controller"
Cohesion: 0.27
Nodes (5): TodoFeature, HePiRuntimeContext, HePiLifecycleController, HePiLifecycleOptions, registerHePiLifecycle()

### Community 59 - "Settings Table Component"
Cohesion: 0.22
Nodes (3): padRight(), SettingsTable, SettingsTableOptions

### Community 60 - "Bounded Text Input"
Cohesion: 0.23
Nodes (5): BoundedInput, createAskComponent(), printableInput(), requestRender(), freshAskState()

### Community 61 - "Development CLI Script"
Cohesion: 0.17
Nodes (9): aliases, args, child, packageEntry(), rawArgs, resolveExtension(), root, separatorIndex (+1 more)

### Community 62 - "Loadout Storage Controller"
Cohesion: 0.21
Nodes (4): LoadoutControllerOptions, LoadoutRuntimeHandler, LoadoutInventoryProvider, LoadoutStorage

### Community 63 - "Path Shortcut Expansion"
Cohesion: 0.27
Nodes (10): applyPathShortcutExpansion(), DEFAULT_PATH_SHORTCUT_SETTINGS, expandPathShortcut(), expandTmpPath(), PATH_SHORTCUT_TOOL_NAMES, PathShortcutExpansionResult, PathShortcutOptions, PathShortcutSettings (+2 more)

### Community 64 - "Starship CLI Commands"
Cohesion: 0.36
Nodes (9): canNotify(), editSettings(), formatError(), registerStarshipCommand(), showHelp(), showStatus(), StarshipCommandOptions, SUBCOMMANDS (+1 more)

### Community 65 - "Loadout Settings Storage"
Cohesion: 0.22
Nodes (7): loadoutExtension(), loadoutSettingsFromState(), createLoadoutSettingsStorage(), formatError(), loadLegacySettings(), LoadoutSettingsStorageOptions, tempDirs

### Community 66 - "UI Error Handling"
Cohesion: 0.25
Nodes (7): formatUiError(), HePiParseError, HePiStorageError, HePiUiError, messageOf(), toUiError(), UiErrorKind

### Community 67 - "Extension Registration Tests"
Cohesion: 0.25
Nodes (5): activeModuleRegistry(), registerHePiModule(), Editor, EditorFactory, FooterFactory

### Community 68 - "Loadout Interface Design"
Cohesion: 0.20
Nodes (10): Loadout Tab, MCP Servers, Loadout TUI Design Mockup, Project Context, Set Tab, Skills, Tool Detail Panel, Tool Origin (+2 more)

### Community 69 - "Tool Activation Coordination"
Cohesion: 0.33
Nodes (5): createHePiRuntimeContext(), HePiRuntimeContextOptions, createToolActivationCoordinator(), fixture(), host()

### Community 70 - "Process Output Streaming"
Cohesion: 0.33
Nodes (5): runCleanupSshProcess(), pipeReadable(), pipeStreamsToSink(), readProcessOutputTail(), StreamingRedactor

### Community 71 - "TypeScript Project Config"
Cohesion: 0.20
Nodes (9): src/**/*.ts, compilerOptions, module, moduleResolution, noEmit, skipLibCheck, strict, target (+1 more)

### Community 72 - "Loadout Footer Rendering"
Cohesion: 0.28
Nodes (6): createLoadoutFooterLines(), formatLoadoutPresetDescription(), LoadoutDescriptionTheme, LoadoutFooterTheme, presetDescriptionStyle(), replacePlaceholders()

### Community 73 - "SSH Execution Tests"
Cohesion: 0.25
Nodes (4): MountProbeResult, readBytes(), runFakeProcess(), withEnv()

### Community 74 - "Settings Panel Tests"
Cohesion: 0.25
Nodes (4): createEmptyPane(), createSettingsPanelComponent(), groups, theme

### Community 75 - "Extension Scaffolding Script"
Cohesion: 0.25
Nodes (5): packageDir, packagesDir, root, slug, templateDir

### Community 76 - "Ask Component Feature"
Cohesion: 0.33
Nodes (4): AskComponentOptions, AskFeature, AskInteractionResult, AskQuestionnaire

### Community 78 - "Ask Parameter Normalization"
Cohesion: 0.40
Nodes (4): formatAskResult(), isRecord(), normalizeAskParams(), questionnaire()

### Community 79 - "Settings Responsive Layout"
Cohesion: 0.40
Nodes (4): createSettingsLayout(), SettingsLayout, SettingsLayoutMode, wideDetail()

### Community 80 - "Runtime Tool Policy"
Cohesion: 0.40
Nodes (5): Advisor Active Tool Policy, Tool-Free Advisor Side Call, Pi Basics Todo Implementation Plan, RPIV Advisor Design, Active Runtime Lifecycle Ownership

### Community 81 - "Project Development Guide"
Cohesion: 0.67
Nodes (3): Extension Development Guide, CI workflow, hepi-mono README

### Community 82 - "Pi TUI Design"
Cohesion: 0.67
Nodes (3): Pi original theme design language, Pi TUI rendering and extension customization, Pi Basics statusbar design

## Knowledge Gaps
- **429 isolated node(s):** `$schema`, `enabled`, `clientKind`, `useIgnoreFile`, `ignoreUnknown` (+424 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Harness` connect `Todo Widget Runtime` to `Loadout Footer Rendering`, `Runtime Lifecycle Controller`?**
  _High betweenness centrality (0.140) - this node is a cross-community bridge._
- **Why does `HePiRuntimeContext` connect `Runtime Lifecycle Controller` to `Goal Feature Lifecycle`, `Lifecycle Registry`, `Plan Confirmation Flow`, `Status Bar Formatting`, `Tool Activation Coordination`, `Todo Feature Commands`, `Todo Widget Runtime`, `Ask Component Feature`, `Todo Snapshot Integration`, `Ask Feature Runtime`, `Loadout Status Feature`?**
  _High betweenness centrality (0.116) - this node is a cross-community bridge._
- **Why does `withEnv()` connect `SSH Execution Tests` to `Loadout Footer Rendering`?**
  _High betweenness centrality (0.113) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `piBasicsExtension()` (e.g. with `.enabled()` and `runtime()`) actually correct?**
  _`piBasicsExtension()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `enabled`, `clientKind` to the rest of the system?**
  _429 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Terminal Panel Rendering` be split into smaller, more focused modules?**
  _Cohesion score 0.06238030095759234 - nodes in this community are weakly interconnected._
- **Should `Goal Feature Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.06151742993848257 - nodes in this community are weakly interconnected._