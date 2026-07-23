# Graph Report - hepi-mono  (2026-07-24)

## Corpus Check
- 265 files · ~126,455 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2034 nodes · 4130 edges · 130 communities (104 shown, 26 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 89 edges (avg confidence: 0.72)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b637d6eb`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Session Lifecycle State
- Task State Validation
- HePi Shell Routing
- Root Storage Paths
- Temporary Directory Storage
- TUI Replay Artifacts
- Plan Status Updates
- Assistant Stream Status
- Usage Theme Formatting
- Anchor Safe Truncation
- Loadout Panel Controls
- Settings Provider Validation
- Model Settings Snapshot
- Settings Controller State
- Assistant Message Usage
- Automatic Title Storage
- Persistent Storage States
- SSHFS Host Validation
- Simplified Settings Registration
- Shell Component Testing
- TypeScript Project Configuration
- Wide UI Detail Rendering
- Terminal Tool Status
- Loadout Selection Reconciliation
- Runtime Registry Lifecycle
- Tool And Skill Items
- RTK Windows Shell Rewrites
- Async Fixture Feedback
- Advisor Severity Feedback
- Settings List Rendering
- Selectable Row Rendering
- BTW Execution Resolution
- Skill Input Matching
- Shell Command Parsing
- Ask Interaction Reduction
- Value Editor Wrapping
- Message Serialization Helpers
- Dollar Skill Registration
- Configuration Value Parsing
- Tool Result Evidence
- Settings Component Provider
- Skill Command Selection
- Ask Custom Answers
- Theme Symbol Rendering
- RTK Find Compatibility
- RTK Rewrite Resolution
- Test Template Sources
- Target Settings Replacement
- Ask Tool Registration
- BTW Extension Components
- Goal Extension Runtime
- Theme Mode Levels
- RTK Command Runtime Guards
- Settings Field Parsing
- RTK Extension Feature
- Grapheme Value Rendering
- Model Response Registry
- RTK Environment Prefixes
- Subagent Runtime Usage
- Code Style Rules
- Pi Basics BTW Architecture
- HePi Registry Modules
- Goal Tool Activation
- UI Error Formatting
- Skill Prompt Filtering
- Build Output Classification
- Source Code Filtering
- Bounded Printable Input
- Dollar Skill Configuration
- Tool Execution Sanitization
- ANSI Text Truncation
- Advisor Persistence Recovery
- Theme Render Requests
- Ask Scripted Questionnaires
- BTW Component Harness
- Fake Editor Rendering
- Ponytail Review Comments
- Compact Tool Output
- Test Output Statistics
- Title Template Slugs
- JavaScript Quote Overrides
- Pi Basics Design Tokens
- Input Command Keybindings
- Loadout Component Setup
- Search Result Grouping
- Ask Questionnaire Feature
- JSON Settings Storage
- Rounded Panel Rendering
- Repository Package Paths
- Dollar Skill Feature
- Todo Goal Plan State
- BTW Request Controller
- Loadout Active Tools
- Linter Domain Settings
- Formatter Layout Settings
- Version Control Settings
- AutoTitle Coordinator
- TypeScript Correctness Checks
- OpenAI Responses Compatibility
- Todo Feature Lifecycle
- Repository CI Workflow
- Advisor Research Package
- Package Root Tests
- RTK Executable Package
- SSHFS Mount Package
- T2S Translation Package
- Extension Registration
- Ask Dialog Fallback
- Global JSON Settings
- Project JSON Settings
- Session Backed Storage
- Readable Error Formatting
- Rounded Panel Renderer
- Keyboard Map Rendering
- Responsive Split Layout
- Layout Settings Configuration
- Settings TUI Rendering
- Horizontal Viewport Creation
- Text Wrapping Utility
- Loadout TUI Rendering
- Replay Plan Execution
- Extension README Template
- AdvisorAgentAdapter
- runtime.test.ts
- GoalFeature
- TraditionalToSimplifiedFeature

## God Nodes (most connected - your core abstractions)
1. `pi-loadout/src/model.ts` - 49 edges
2. `pi-ask/src/model.ts` - 37 edges
3. `pi-ask/src/component.ts` - 35 edges
4. `rtk/feature.ts` - 34 edges
5. `pi-dollar-skill/src/index.ts` - 33 edges
6. `pi-ponytail/src/config.ts` - 33 edges
7. `pi-goal/src/model.ts` - 32 edges
8. `pi-caveman/src/config.ts` - 31 edges
9. `src/controller.ts` - 31 edges
10. `HePiSettingsProvider` - 30 edges

## Surprising Connections (you probably didn't know these)
- `createAskFeature()` --indirect_call--> `done()`  [INFERRED]
  packages/pi-ask/src/feature.ts → packages/pi-ask/test/component.test.ts
- `text()` --indirect_call--> `stripAnsi()`  [INFERRED]
  packages/pi-plan/test/confirmation.test.ts → packages/pi-basics/test/helpers.ts
- `CI Check Workflow` --conceptually_related_to--> `Repository Instructions`  [INFERRED]
  .github/workflows/ci.yml → AGENTS.md
- `@hheei/pi-caveman` --conceptually_related_to--> `Extension Development`  [INFERRED]
  packages/pi-caveman/README.md → docs/extension-development.md
- `@hheei/pi-btw` --conceptually_related_to--> `Pi Basics BTW Implementation Plan`  [INFERRED]
  packages/pi-btw/README.md → docs/pi-basics-btw-plan.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **BTW Implementation Architecture** — concept_side_thread, concept_session_scoped_runtime, concept_custom_ui_overlay [INFERRED 0.85]
- **Pi Basics UI Language** — design_pi_basics_terminal_ui, docs_pi_original_theme_design_language, concept_semantic_theme_tokens [EXTRACTED 1.00]
- **Ponytail Companion Workflows** — packages_pi_ponytail_skills_ponytail_audit_skill_ponytail_audit, packages_pi_ponytail_skills_ponytail_debt_skill_ponytail_debt, packages_pi_ponytail_skills_ponytail_review_skill_ponytail_review [EXTRACTED 1.00]
- **Complexity Reduction Review** — packages_pi_ponytail_skills_ponytail_audit_skill_ponytail_audit, packages_pi_ponytail_skills_ponytail_review_skill_ponytail_review, packages_pi_ponytail_readme_pi_ponytail [INFERRED 0.85]

## Communities (130 total, 26 thin omitted)

### Community 0 - "Session Lifecycle State"
Cohesion: 0.10
Nodes (47): pi-goal/src/model.ts, ActiveGoal, ActiveGoalResult, ActiveGoalState, ActiveGoalTransition, activeResult(), DurableGoalResult, DurableGoalTransition (+39 more)

### Community 1 - "Task State Validation"
Cohesion: 0.06
Nodes (58): pi-todo/src/index.ts, piTodoExtension(), pi-todo/src/model.ts, ACTIONS, applyTodo(), ApplyTodoResult, cloneState(), dependencyError() (+50 more)

### Community 2 - "HePi Shell Routing"
Cohesion: 0.09
Nodes (17): createHePiModuleRegistry(), defaultHePiModuleRegistry, getHePiModule(), HePiModuleRegistry, HePiModuleView, HePiModuleViewContext, ModuleRegistry, registerHePiModule() (+9 more)

### Community 3 - "Root Storage Paths"
Cohesion: 0.06
Nodes (62): pi-caveman/src/config.ts, asRecord(), CavemanDefaults, createCavemanSettingsProvider(), DEFAULT_CAVEMAN_DEFAULTS, defaultsFromRoot(), defaultsFromState(), errorMessage() (+54 more)

### Community 4 - "Temporary Directory Storage"
Cohesion: 0.06
Nodes (61): pi-ponytail/src/config.ts, asRecord(), createPonytailSettingsProvider(), DEFAULT_PONYTAIL_DEFAULTS, defaultsFromRoot(), defaultsFromState(), defaultsFromValues(), errorMessage() (+53 more)

### Community 5 - "TUI Replay Artifacts"
Cohesion: 0.06
Nodes (44): Editor, EditorFactory, theme, actionLabel(), ANSI_COLORS, ansiColor(), ansiSvgLine(), AnsiSvgStyle (+36 more)

### Community 6 - "Plan Status Updates"
Cohesion: 0.07
Nodes (47): piAutoTitleExtension(), ActivePlan, boundary(), createPlanFeature(), PendingPlan, persist(), PlanFeature, PlanMessage (+39 more)

### Community 7 - "Assistant Stream Status"
Cohesion: 0.07
Nodes (36): options(), ApplyPatchGuard, createApplyPatchGuardSettingsProvider(), GuardPatchMode, hasStreamingApplyPatchCommand(), isJsonObject(), JsonObject, modeField (+28 more)

### Community 8 - "Usage Theme Formatting"
Cohesion: 0.07
Nodes (46): DEFAULT_STATUSBAR_FORMAT_TOKENS, FORMAT_VARIABLES, joinStatusbarFormat(), parseStatusbarFormat(), RenderedStatusbarFormat, renderStatusbarFormat(), StatusbarFormatPart, StatusbarFormatToken (+38 more)

### Community 9 - "Anchor Safe Truncation"
Cohesion: 0.10
Nodes (40): ANCHORED_READ_LINE_PATTERNS, AnchoredReadLine, AnchorSafeReadLine, AnchorSafeReadParts, applyReadCompactionBanner(), compactAnchoredReadText(), CompactionState, compactReadText() (+32 more)

### Community 10 - "Loadout Panel Controls"
Cohesion: 0.12
Nodes (32): pi-loadout/src/model.ts, configuredValue(), defaultDescriptionRegistry, filterLoadoutItems(), groupLoadoutItems(), inheritsGlobalConfiguration(), KIND_ORDER, LoadoutConfiguredStatus (+24 more)

### Community 11 - "Settings Provider Validation"
Cohesion: 0.11
Nodes (14): createSessionStorage(), defaultSettingsRegistry, getHePiSettings(), HePiSettingChange, HePiSettingOption, HePiSettingPrimitive, HePiSettingsRegistry, HePiSettingTabCycle (+6 more)

### Community 12 - "Model Settings Snapshot"
Cohesion: 0.12
Nodes (16): ToolActivationCoordinator, ActiveRuntime, createGoalFeature(), ErrorCandidate, escapedObjective(), GOAL_PARAMETERS, GOAL_REPLAY_WARNING(), goalContext() (+8 more)

### Community 13 - "Settings Controller State"
Cohesion: 0.06
Nodes (27): HePiSettingGroup, HePiSettingValue, settings/controller.ts, applyChange(), applyChanges(), changedValues(), cloneState(), createSettingsController() (+19 more)

### Community 14 - "Assistant Message Usage"
Cohesion: 0.14
Nodes (14): ADVISE_PARAMETERS, AdvisorScheduler, advisorSessionId(), buildAdvisorBootstrapMessages(), createCoreAdvisorAdapter(), createHostScheduler(), hasResolvedContext(), isAdvisorMessage() (+6 more)

### Community 15 - "Automatic Title Storage"
Cohesion: 0.12
Nodes (20): pi-auto-title/src/index.ts, ANSI_ESCAPE, AutoTitleAgentAdapter, AutoTitleAgentFactory, autoTitleDescription(), autoTitleFields(), AutoTitleModelOption, autoTitleModelOptions() (+12 more)

### Community 16 - "Persistent Storage States"
Cohesion: 0.14
Nodes (23): disableHePiTool(), hePiLoadoutKey(), isHePiSkillEnabled(), registerHePiToolDisableHandler(), setHePiDisabledSkillKeys(), stateFor(), LoadoutRuntimeHandlers, pi-loadout/src/extension.ts (+15 more)

### Community 17 - "SSHFS Host Validation"
Cohesion: 0.11
Nodes (21): pi-sshfs/src/index.ts, assertDirectChildDirectory(), createSshfsFeature(), ensureDirectory(), findMountEntry(), isAbortError(), isMissingBinaryError(), MountEntry (+13 more)

### Community 18 - "Simplified Settings Registration"
Cohesion: 0.21
Nodes (13): registerHePiSettings(), pi-t2s/src/extension.ts, piT2sExtension(), pi-t2s/src/index.ts, convertInputText(), convertProseLine(), createTraditionalToSimplifiedFeature(), createTraditionalToSimplifiedSettingsProvider() (+5 more)

### Community 19 - "Shell Component Testing"
Cohesion: 0.15
Nodes (14): plain(), wrap(), createSettingsFixture(), assertVisibleWidth(), fakeHost, fakeProvider(), fakeStorage(), fakeTheme() (+6 more)

### Community 20 - "TypeScript Project Configuration"
Cohesion: 0.08
Nodes (24): bun, ES2022, node, compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib (+16 more)

### Community 21 - "Wide UI Detail Rendering"
Cohesion: 0.07
Nodes (31): HePiSettingField, createSettingsComponent(), SettingsComponentOptions, createSettingsLayout(), SettingsLayout, SettingsLayoutMode, editHints, ellipsizedDescription() (+23 more)

### Community 22 - "Terminal Tool Status"
Cohesion: 0.16
Nodes (13): src/controller.ts, LoadoutControllerOptions, LoadoutControllerState, LoadoutRuntimeHandler, LoadoutInventoryProvider, LoadoutItem, LoadoutResolvedItem, LoadoutScope (+5 more)

### Community 23 - "Loadout Selection Reconciliation"
Cohesion: 0.22
Nodes (4): copyMaps(), LoadoutController, normalize(), readable()

### Community 24 - "Runtime Registry Lifecycle"
Cohesion: 0.23
Nodes (7): runtime/context.ts, createHePiRuntimeContext(), HePiRuntimeContext, HePiRuntimeContextOptions, HePiLifecycleController, HePiLifecycleOptions, TodoFeature

### Community 25 - "Tool And Skill Items"
Cohesion: 0.14
Nodes (17): BUILTIN_PROMPT_SNIPPETS, createLoadoutInventory(), createMcpPlaceholder(), estimateTokenCount(), LoadoutCommandInfo, LoadoutInventory, LoadoutInventorySource, LoadoutInventoryValue (+9 more)

### Community 26 - "RTK Windows Shell Rewrites"
Cohesion: 0.16
Nodes (20): applyRewrittenCommandShellSafetyFixups(), buildBufferedPipelineCommand(), extractProducerRewritePlan(), LEADING_RTK_DB_PATH_EXPORT_PRELUDE_PATTERN, ParsedPipeline, parseSimpleTopLevelPipeline(), ProducerRewritePlan, ShellSafetyTarget (+12 more)

### Community 27 - "Async Fixture Feedback"
Cohesion: 0.18
Nodes (7): AdvisorAdapterFactory, createAdvisorFeature(), AdvisorAdvice, advisor/feature.test.ts, FakeAdapter, fixture(), Handler

### Community 28 - "Advisor Severity Feedback"
Cohesion: 0.19
Nodes (10): src/command.ts, registerAdvisorCommand(), pi-advisor/src/feature.ts, Active, AdvisorFeature, FeedbackState, pi-advisor/src/index.ts, AdvisorPhase (+2 more)

### Community 29 - "Settings List Rendering"
Cohesion: 0.15
Nodes (20): HePiModule, HePiCommandContext, HePiCommandRegistration, HePiCommandRoute, ParsedHePiCommand, commandCompletions(), CommandContext, dispatchHePiCommand() (+12 more)

### Community 30 - "Selectable Row Rendering"
Cohesion: 0.24
Nodes (9): formatKeyHint(), formatKeymap(), FormatKeymapOptions, keyGlyph, KeyHint, ui/layout.ts, createSplitLayout(), SplitLayout (+1 more)

### Community 31 - "BTW Execution Resolution"
Cohesion: 0.12
Nodes (14): pi-btw/test/feature.test.ts, at(), Command, ComponentState, EventHandler, first(), fixture(), FixtureOptions (+6 more)

### Community 32 - "Skill Input Matching"
Cohesion: 0.17
Nodes (16): actionForInput(), AtomicAction, AtomicKeybinding, AtomicSpan, bareSkillName(), createDollarSkillAtomicEditor(), CURSOR_LEFT_INPUTS, CursorEditor (+8 more)

### Community 33 - "Shell Command Parsing"
Cohesion: 0.18
Nodes (18): CHAIN_OPERATORS, matchesCommandPatterns(), normalizeCommandForDetection(), sliceFirstSegment(), compactDiff(), compactGitOutput(), compactLog(), compactStatus() (+10 more)

### Community 34 - "Ask Interaction Reduction"
Cohesion: 0.16
Nodes (20): pi-ask/src/model.ts, advance(), answersFromState(), ASK_LIMITS, AskAction, AskAnswer, askDetails(), AskMode (+12 more)

### Community 35 - "Value Editor Wrapping"
Cohesion: 0.19
Nodes (7): HePiContribution, HePiEditorContribution, HePiFooterContribution, HePiStatusContribution, api/index.ts, HePiPanel, HePiSettingsSubpanel

### Community 36 - "Message Serialization Helpers"
Cohesion: 0.17
Nodes (21): pi-btw/src/model.ts, budgetContext(), BudgetedContext, buildBtwMessages(), BuildBtwMessagesOptions, contentPartText(), contentText(), createBtwTurn() (+13 more)

### Community 37 - "Dollar Skill Registration"
Cohesion: 0.15
Nodes (15): pi-dollar-skill/src/extension.ts, piDollarSkillExtension(), pi-dollar-skill/src/index.ts, AtomicEditorOwner, configFromState(), createDollarSkillFeature(), createDollarSkillSettingsProvider(), DollarSkillFeature (+7 more)

### Community 38 - "Configuration Value Parsing"
Cohesion: 0.15
Nodes (25): pi-rtk/src/index.ts, rtk/command.ts, rtk/config.ts, Json, loadRtkConfig(), readRoot(), saveRtkConfig(), settingsPath() (+17 more)

### Community 39 - "Tool Result Evidence"
Cohesion: 0.19
Nodes (11): src/context.ts, AdvisorDelta, buildTurnDelta(), estimateTokens(), extractPrimaryTurnEvidence(), fit(), json(), partText() (+3 more)

### Community 40 - "Settings Component Provider"
Cohesion: 0.16
Nodes (12): createHePiSettingsRegistry(), HePiContext, HePiSettingsProvider, HePiSettingsState, combineSettingsProviders(), GroupMapping, providerModuleName(), SettingsControllerOptions (+4 more)

### Community 41 - "Skill Command Selection"
Cohesion: 0.16
Nodes (17): name(), createHarness(), pi-dollar-skill/src/model.ts, bareSkillName(), cleanDescription(), createDollarSkillAutocompleteProvider(), dim(), DollarSkillToken (+9 more)

### Community 42 - "Ask Custom Answers"
Cohesion: 0.24
Nodes (14): aborted(), cancelled(), checkAbort(), collectQuestion(), customAnswer(), DialogOptions, DialogUI, hasDialogUI() (+6 more)

### Community 43 - "Theme Symbol Rendering"
Cohesion: 0.22
Nodes (15): LoadoutKind, src/render.ts, finish(), footer(), groupOrder, icons, labels, LoadoutTheme (+7 more)

### Community 44 - "RTK Find Compatibility"
Cohesion: 0.20
Nodes (15): computeRewriteDecision(), RewriteDecision, basename(), findArguments(), finishWord(), hasUnsupportedFindArguments(), isAssignment(), isRtkFindSegment() (+7 more)

### Community 45 - "RTK Rewrite Resolution"
Cohesion: 0.21
Nodes (15): fallbackResolution(), getResolverCommand(), parseRtkExecutablePath(), ResolverCommand, resolveRtkExecutable(), ResolveRtkExecutableOptions, RtkExecutableResolution, RtkExecutableResolverName (+7 more)

### Community 46 - "Test Template Sources"
Cohesion: 0.12
Nodes (16): includes, !**/dist, !**/node_modules, packages/*/**/*.ts, !**/.pi, test/**/*.ts, !graphify-out, *.json (+8 more)

### Community 47 - "Target Settings Replacement"
Cohesion: 0.29
Nodes (10): pi-advisor/src/model.ts, ADVISOR_TOOL_NAMES, AdvisorSeverity, parseModelRef(), parseThinking(), src/settings.ts, createAdvisorSettingsProvider(), advisor/settings.test.ts (+2 more)

### Community 48 - "Ask Tool Registration"
Cohesion: 0.18
Nodes (13): pi-ask/src/feature.ts, ActiveAsk, AgentToolResultLike, ASK_PARAMETERS, ASK_PROMPT_GUIDELINES, askOption, askQuestion, createAskFeature() (+5 more)

### Community 49 - "BTW Extension Components"
Cohesion: 0.23
Nodes (13): pi-btw/src/extension.ts, piBtwExtension(), pi-btw/src/feature.ts, abortRequest(), BtwFeature, btwOverlayOptions(), createBtwFeature(), hasResolvedContext() (+5 more)

### Community 50 - "Goal Extension Runtime"
Cohesion: 0.33
Nodes (10): pi-ask/src/index.ts, piAskExtension(), registerHePiLifecycle(), getToolActivationCoordinator(), runtime(), pi-plan/src/extension.ts, piPlanExtension(), piRtkExtension() (+2 more)

### Community 51 - "Theme Mode Levels"
Cohesion: 0.17
Nodes (14): createPlanConfirmationComponent(), defined(), Focus, levels, modes, PlanConfirmationAction, PlanConfirmationComponentOptions, PlanConfirmationModel (+6 more)

### Community 52 - "RTK Command Runtime Guards"
Cohesion: 0.20
Nodes (6): registerRtkCommand(), RtkFeature, shouldRequireRtkAvailabilityForCommandHandling(), shouldSkipCommandHandlingWhenRtkMissing(), RtkIntegrationConfig, RuntimeStatus

### Community 53 - "Settings Field Parsing"
Cohesion: 0.14
Nodes (13): fixtures/settings.ts, advancedGroup, booleanField, delayedSaveProvider, emptyProvider, enumField, failedSaveProvider, generalGroup (+5 more)

### Community 54 - "RTK Extension Feature"
Cohesion: 0.17
Nodes (5): shell/component.ts, createShellComponent(), ShellChild, ShellComponentOptions, shell/component.test.ts

### Community 55 - "Grapheme Value Rendering"
Cohesion: 0.19
Nodes (5): graphemeBoundaries(), ValueEditor, ValueEditorState, horizontalViewport, visibleWidth

### Community 56 - "Model Response Registry"
Cohesion: 0.22
Nodes (8): BtwExecutionResult, createCompletionOptions(), errorText(), executeBtwTurn(), ExecuteBtwTurnOptions, extractAssistantText(), messages, model

### Community 57 - "RTK Environment Prefixes"
Cohesion: 0.42
Nodes (8): applyRtkCommandEnvironment(), getTemporaryRtkHistoryDbPath(), hasInheritedRtkDbPath(), hasLeadingRtkDbPathAssignment(), quoteForShellEnv(), resolveTemporaryDirectory(), RTK_DB_PATH_ASSIGNMENT_PATTERN, RTK_DB_PATH_EXPORT_PATTERN

### Community 58 - "Subagent Runtime Usage"
Cohesion: 0.17
Nodes (9): aliases, args, child, packageEntry(), rawArgs, resolveExtension(), root, separatorIndex (+1 more)

### Community 59 - "Code Style Rules"
Cohesion: 0.17
Nodes (12): rules, noFloatingPromises, nursery, preset, style, suspicious, noEnum, noNamespace (+4 more)

### Community 60 - "Pi Basics BTW Architecture"
Cohesion: 0.20
Nodes (12): Custom UI Overlay, Lifecycle Cleanup, Serial Queue, Session-Scoped Runtime, SideThread, Pi Basics BTW Implementation Plan, Pi Basics BTW Baseline Recommendation, BTW Reuse Strategy (+4 more)

### Community 61 - "HePi Registry Modules"
Cohesion: 0.11
Nodes (6): HePiCleanupFailure, HePiIdentified, HePiLifecycleRegistration, HePiRegistrationKind, HePiRegistry, fakePi

### Community 62 - "Goal Tool Activation"
Cohesion: 0.19
Nodes (9): createCoordinator(), createToolActivationCoordinator(), GlobalCoordinatorState, host(), fixture(), handleInput(), TestCommand, TestHandler (+1 more)

### Community 63 - "UI Error Formatting"
Cohesion: 0.25
Nodes (7): formatUiError(), HePiParseError, HePiStorageError, HePiUiError, messageOf(), toUiError(), UiErrorKind

### Community 64 - "Skill Prompt Filtering"
Cohesion: 0.27
Nodes (9): loadoutKey, escapeXml(), FilteredSkillPrompt, filterLoadoutDisabledSkillsFromPrompt(), formatSkillsForPrompt(), PromptSkill, promptSkillKey(), replaceSkillsSection() (+1 more)

### Community 65 - "Build Output Classification"
Cohesion: 0.31
Nodes (10): BUILD_COMMAND_PATTERNS, BuildStats, ERROR_START_PATTERNS, filterBuildOutput(), isBuildCommand(), isErrorStart(), isSkipLine(), isWarning() (+2 more)

### Community 66 - "Source Code Filtering"
Cohesion: 0.24
Nodes (12): techniques/index.ts, COMMENT_PATTERNS, CommentPatterns, countCodeBraces(), filterAggressive(), filterMinimal(), filterSourceCode(), getCodePortion() (+4 more)

### Community 68 - "Dollar Skill Configuration"
Cohesion: 0.49
Nodes (10): pi-dollar-skill/src/config.ts, dollarSkillSettingsPath(), isJsonObject(), JsonObject, loadDollarSkillConfig(), normalizeDollarSkillConfig(), normalizeMaxSuggestions(), readRoot() (+2 more)

### Community 69 - "Tool Execution Sanitization"
Cohesion: 0.14
Nodes (20): rtk/feature.ts, createRtkFeature(), mergeDetails(), clearOutputMetrics(), getOutputMetricsSummary(), OutputMetricRecord, outputMetrics, trackOutputSavings() (+12 more)

### Community 70 - "ANSI Text Truncation"
Cohesion: 0.26
Nodes (6): HePiMaybePromise, createGlobalJsonStorage(), createProjectJsonStorage(), HePiJsonStorageBackend, HePiSettingsStorage, LoadoutBridgeState

### Community 71 - "Advisor Persistence Recovery"
Cohesion: 0.31
Nodes (9): AdvisorBoundary, pi-advisor/src/persistence.ts, AdvisorAppender, AdvisorEntry, appendAdvisorBoundary(), decodeAdvisorBoundary(), encodeAdvisorBoundary(), record() (+1 more)

### Community 72 - "Theme Render Requests"
Cohesion: 0.14
Nodes (17): pi-ask/src/component.ts, Block, createAskComponent(), formatAskReviewAnswer(), invariant(), requestRender(), visibleBlocks(), AskAnswerDraft (+9 more)

### Community 73 - "Ask Scripted Questionnaires"
Cohesion: 0.28
Nodes (7): formatAskResult(), isRecord(), normalizeAskParams(), normalizedContext(), printable(), printableSingleLine(), questionnaire()

### Community 74 - "BTW Component Harness"
Cohesion: 0.22
Nodes (9): renderScrollbar(), pi-btw/src/component.ts, BtwComponentOptions, BtwComponentStatus, createBtwComponent(), requestRender(), ActiveRuntime, BtwFeatureOptions (+1 more)

### Community 75 - "Fake Editor Rendering"
Cohesion: 0.13
Nodes (5): atomicEditor(), commands, FakeEditor, inputs, keybindings

### Community 76 - "Ponytail Review Comments"
Cohesion: 0.28
Nodes (9): Ponytail Companion Skills, @hheei/pi-ponytail, Ponytail Modes, ponytail-audit, ponytail: Comments, ponytail-debt, ponytail-gain, ponytail-help (+1 more)

### Community 77 - "Compact Tool Output"
Cohesion: 0.32
Nodes (8): applyAnsiStripping(), applyConditionalTechnique(), applyNullableTechnique(), applyTruncation(), beginCompaction(), compactBashText(), compactGrepText(), normalizeTechniqueResult()

### Community 78 - "Test Output Statistics"
Cohesion: 0.33
Nodes (8): aggregateTestOutput(), extractTestStats(), FAILURE_START_PATTERNS, isFailureStart(), isTestCommand(), TEST_COMMAND_PATTERNS, TEST_RESULT_PATTERNS, TestSummary

### Community 79 - "Title Template Slugs"
Cohesion: 0.22
Nodes (5): packageDir, packagesDir, root, slug, templateDir

### Community 80 - "JavaScript Quote Overrides"
Cohesion: 0.25
Nodes (7): files, ignoreUnknown, quoteStyle, javascript, formatter, overrides, $schema

### Community 81 - "Pi Basics Design Tokens"
Cohesion: 0.25
Nodes (8): Semantic Theme Tokens, Pi Basics Terminal UI Design, Extension Development, Pi Basics Development, Original Pi Theme Design Language, @hheei/pi-basics, @hheei/pi-caveman, hepi-mono

### Community 82 - "Input Command Keybindings"
Cohesion: 0.25
Nodes (4): DollarSkillCommand, dollar-skill/feature.test.ts, EditorFactory, InputHandler

### Community 83 - "Loadout Component Setup"
Cohesion: 0.33
Nodes (8): pi-loadout/src/component.ts, createLoadoutView(), LoadoutComponentOptions, createLoadoutController(), loadout/component.test.ts, item(), setup(), theme

### Community 84 - "Search Result Grouping"
Cohesion: 0.43
Nodes (6): compactPath(), detectPathPrefix(), detectPathSeparator(), joinPathSegments(), groupSearchResults(), SearchResult

### Community 85 - "Ask Questionnaire Feature"
Cohesion: 0.33
Nodes (4): AskComponentOptions, AskFeature, AskInteractionResult, AskQuestionnaire

### Community 86 - "JSON Settings Storage"
Cohesion: 0.43
Nodes (4): isMissingFile(), isRecord(), JsonSectionSettingsStorageOptions, readRoot()

### Community 87 - "Rounded Panel Rendering"
Cohesion: 0.20
Nodes (15): finishLine(), BorderTheme, DetailPanelOptions, renderDetailPanel(), roundedBorder(), RoundedBorderOptions, roundedPanel(), renderSelectableRow() (+7 more)

### Community 88 - "Repository Package Paths"
Cohesion: 0.33
Nodes (4): isRecord(), packageDependencies(), packagesDirectory, repositoryRoot

### Community 89 - "Dollar Skill Feature"
Cohesion: 0.20
Nodes (8): createLoadoutDescriptionRegistry(), DescriptionRegistry, getLoadoutDescriptionPanel(), registerLoadoutDescriptionPanel(), unregisterLoadoutDescriptionPanel(), item, state, theme

### Community 90 - "Todo Goal Plan State"
Cohesion: 0.29
Nodes (7): Branch Session History, goal Tool, @hheei/pi-goal, Branch-local Plan State, @hheei/pi-plan, @hheei/pi-todo, todo Tool

### Community 91 - "BTW Request Controller"
Cohesion: 0.29
Nodes (3): BtwComponentController, ActiveRequest, BtwRequestToken

### Community 92 - "Loadout Active Tools"
Cohesion: 0.40
Nodes (5): @hheei/pi-basics, @hheei/pi-dollar-skill, pi-loadout, Active Tools, @hheei/pi-loadout

### Community 93 - "Linter Domain Settings"
Cohesion: 0.50
Nodes (4): types, linter, domains, enabled

### Community 94 - "Formatter Layout Settings"
Cohesion: 0.50
Nodes (4): formatter, enabled, indentStyle, lineWidth

### Community 95 - "Version Control Settings"
Cohesion: 0.50
Nodes (4): vcs, clientKind, enabled, useIgnoreFile

### Community 97 - "TypeScript Correctness Checks"
Cohesion: 0.67
Nodes (3): noUnusedImports, noUnusedVariables, correctness

### Community 98 - "OpenAI Responses Compatibility"
Cohesion: 0.67
Nodes (3): Apply Patch Guard, OpenAI Responses Compatibility, @hheei/pi-fix

### Community 99 - "Todo Feature Lifecycle"
Cohesion: 0.33
Nodes (8): buildReviewContext(), buildSessionContext(), collectFeedback(), emptyFeedback(), parseAdvice(), reconfirmFeedback(), normalizeAdvice(), severityRank()

### Community 124 - "AdvisorAgentAdapter"
Cohesion: 0.20
Nodes (3): ContextBudget, AdvisorUsage, AdvisorAgentAdapter

### Community 125 - "runtime.test.ts"
Cohesion: 0.20
Nodes (6): ThinkingLevel, pi-advisor/src/prompt.ts, AdvisorAdapterOptions, adviseCall, model, streamScript()

## Knowledge Gaps
- **444 isolated node(s):** `HePiSettingPrimitive`, `HePiSettingType`, `HePiSettingOption`, `HePiSettingTabCycle`, `defaultSettingsRegistry` (+439 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pi-rtk/src/index.ts` connect `Configuration Value Parsing` to `HePi Shell Routing`, `Tool Execution Sanitization`, `Anchor Safe Truncation`, `RTK Find Compatibility`, `Simplified Settings Registration`, `Goal Extension Runtime`, `RTK Command Runtime Guards`, `Runtime Registry Lifecycle`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `pi-dollar-skill/src/index.ts` connect `Dollar Skill Registration` to `Skill Input Matching`, `HePi Shell Routing`, `Dollar Skill Configuration`, `Settings Component Provider`, `Skill Command Selection`, `Fake Editor Rendering`, `Input Command Keybindings`, `Wide UI Detail Rendering`, `Runtime Registry Lifecycle`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `pi-loadout/src/extension.ts` connect `Persistent Storage States` to `Skill Prompt Filtering`, `HePi Shell Routing`, `Goal Extension Runtime`, `Loadout Component Setup`, `Terminal Tool Status`, `Loadout Selection Reconciliation`, `Runtime Registry Lifecycle`, `Tool And Skill Items`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **What connects `HePiSettingPrimitive`, `HePiSettingType`, `HePiSettingOption` to the rest of the system?**
  _444 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Session Lifecycle State` be split into smaller, more focused modules?**
  _Cohesion score 0.0975177304964539 - nodes in this community are weakly interconnected._
- **Should `Task State Validation` be split into smaller, more focused modules?**
  _Cohesion score 0.05502392344497608 - nodes in this community are weakly interconnected._
- **Should `HePi Shell Routing` be split into smaller, more focused modules?**
  _Cohesion score 0.08558558558558559 - nodes in this community are weakly interconnected._