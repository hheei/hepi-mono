# Graph Report - /Users/supercgor/Documents/orca/workspaces/hepi-mono/split-module  (2026-07-23)

## Corpus Check
- 263 files · ~124,759 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2018 nodes · 4366 edges · 124 communities (97 shown, 27 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 103 edges (avg confidence: 0.73)
- Token cost: 107,600 input · 0 output

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

## God Nodes (most connected - your core abstractions)
1. `SettingsController` - 35 edges
2. `HePiRuntimeContext` - 33 edges
3. `HePiSettingsProvider` - 32 edges
4. `truncateToWidth()` - 32 edges
5. `registerHePiLifecycle()` - 31 edges
6. `visibleWidth` - 28 edges
7. `LoadoutController` - 27 edges
8. `createGoalFeature()` - 25 edges
9. `HePiSettingField` - 23 edges
10. `HePiLifecycleController` - 23 edges

## Surprising Connections (you probably didn't know these)
- `text()` --indirect_call--> `stripAnsi()`  [INFERRED]
  packages/pi-plan/test/confirmation.test.ts → packages/pi-basics/test/helpers.ts
- `CI Check Workflow` --conceptually_related_to--> `Repository Instructions`  [INFERRED]
  .github/workflows/ci.yml → AGENTS.md
- `@hheei/pi-caveman` --conceptually_related_to--> `Extension Development`  [INFERRED]
  packages/pi-caveman/README.md → docs/extension-development.md
- `@hheei/pi-btw` --conceptually_related_to--> `Pi Basics BTW Implementation Plan`  [INFERRED]
  packages/pi-btw/README.md → docs/pi-basics-btw-plan.md
- `@hheei/pi-advisor` --references--> `Advisor Research`  [INFERRED]
  packages/pi-advisor/README.md → docs/plans/advisor/research.md

## Import Cycles
- 3-file cycle: `packages/pi-basics/src/api/modules.ts -> packages/pi-basics/src/api/settings.ts -> packages/pi-basics/src/api/panels.ts -> packages/pi-basics/src/api/modules.ts`

## Hyperedges (group relationships)
- **BTW Implementation Architecture** — concept_side_thread, concept_session_scoped_runtime, concept_custom_ui_overlay [INFERRED 0.85]
- **Pi Basics UI Language** — design_pi_basics_terminal_ui, docs_pi_original_theme_design_language, concept_semantic_theme_tokens [EXTRACTED 1.00]
- **Ponytail Companion Workflows** — packages_pi_ponytail_skills_ponytail_audit_skill_ponytail_audit, packages_pi_ponytail_skills_ponytail_debt_skill_ponytail_debt, packages_pi_ponytail_skills_ponytail_review_skill_ponytail_review [EXTRACTED 1.00]
- **Complexity Reduction Review** — packages_pi_ponytail_skills_ponytail_audit_skill_ponytail_audit, packages_pi_ponytail_skills_ponytail_review_skill_ponytail_review, packages_pi_ponytail_readme_pi_ponytail [INFERRED 0.85]

## Communities (124 total, 27 thin omitted)

### Community 0 - "Session Lifecycle State"
Cohesion: 0.06
Nodes (58): ToolActivationCoordinator, ActiveRuntime, createGoalFeature(), ErrorCandidate, escapedObjective(), GOAL_PARAMETERS, GOAL_REPLAY_WARNING(), goalContext() (+50 more)

### Community 1 - "Task State Validation"
Cohesion: 0.06
Nodes (54): piTodoExtension(), ACTIONS, applyTodo(), ApplyTodoResult, cloneState(), dependencyError(), findTask(), freshTaskState() (+46 more)

### Community 2 - "HePi Shell Routing"
Cohesion: 0.05
Nodes (44): done(), HePiContribution, HePiEditorContribution, HePiFooterContribution, HePiStatusContribution, createHePiModuleRegistry(), defaultHePiModuleRegistry, getHePiModule() (+36 more)

### Community 3 - "Root Storage Paths"
Cohesion: 0.06
Nodes (53): asRecord(), CavemanDefaults, createCavemanSettingsProvider(), DEFAULT_CAVEMAN_DEFAULTS, defaultsFromRoot(), defaultsFromState(), errorMessage(), isMissingFile() (+45 more)

### Community 4 - "Temporary Directory Storage"
Cohesion: 0.06
Nodes (52): asRecord(), createPonytailSettingsProvider(), DEFAULT_PONYTAIL_DEFAULTS, defaultsFromRoot(), defaultsFromState(), defaultsFromValues(), errorMessage(), isMissingFile() (+44 more)

### Community 5 - "TUI Replay Artifacts"
Cohesion: 0.06
Nodes (45): theme, Editor, EditorFactory, theme, actionLabel(), ANSI_COLORS, ansiColor(), ansiSvgLine() (+37 more)

### Community 6 - "Plan Status Updates"
Cohesion: 0.09
Nodes (44): PlanConfirmationAction, PlanConfirmationResult, piPlanExtension(), ActivePlan, boundary(), createPlanFeature(), PendingPlan, persist() (+36 more)

### Community 7 - "Assistant Stream Status"
Cohesion: 0.07
Nodes (33): options(), ApplyPatchGuard, createApplyPatchGuardSettingsProvider(), GuardPatchMode, hasStreamingApplyPatchCommand(), isJsonObject(), JsonObject, modeField (+25 more)

### Community 8 - "Usage Theme Formatting"
Cohesion: 0.08
Nodes (35): DEFAULT_STATUSBAR_FORMAT_TOKENS, FORMAT_VARIABLES, joinStatusbarFormat(), parseStatusbarFormat(), RenderedStatusbarFormat, renderStatusbarFormat(), StatusbarFormatPart, StatusbarFormatToken (+27 more)

### Community 9 - "Anchor Safe Truncation"
Cohesion: 0.10
Nodes (39): ANCHORED_READ_LINE_PATTERNS, AnchoredReadLine, AnchorSafeReadLine, AnchorSafeReadParts, applyReadCompactionBanner(), compactAnchoredReadText(), CompactionState, compactToolResult() (+31 more)

### Community 10 - "Loadout Panel Controls"
Cohesion: 0.10
Nodes (30): configuredValue(), createLoadoutDescriptionRegistry(), defaultDescriptionRegistry, DescriptionRegistry, filterLoadoutItems(), groupLoadoutItems(), inheritsGlobalConfiguration(), KIND_ORDER (+22 more)

### Community 11 - "Settings Provider Validation"
Cohesion: 0.08
Nodes (19): HePiMaybePromise, HePiPanel, createGlobalJsonStorage(), createHePiSettingsRegistry(), createProjectJsonStorage(), createSessionStorage(), defaultSettingsRegistry, getHePiSettings() (+11 more)

### Community 12 - "Model Settings Snapshot"
Cohesion: 0.09
Nodes (17): HePiSettingGroup, HePiSettingsState, HePiSettingValue, PendingChange, createSettingsModel(), fieldForSelection(), providerHasContent(), settingPanelItemId() (+9 more)

### Community 13 - "Settings Controller State"
Cohesion: 0.12
Nodes (8): applyChange(), applyChanges(), changedValues(), cloneState(), readableError(), SettingsController, cycleOption(), mergeSettingsState()

### Community 14 - "Assistant Message Usage"
Cohesion: 0.10
Nodes (18): ThinkingLevel, ADVISE_PARAMETERS, AdvisorAdapterOptions, AdvisorScheduler, advisorSessionId(), buildAdvisorBootstrapMessages(), createCoreAdvisorAdapter(), createHostScheduler() (+10 more)

### Community 15 - "Automatic Title Storage"
Cohesion: 0.13
Nodes (20): piAutoTitleExtension(), ANSI_ESCAPE, AutoTitleAgentAdapter, AutoTitleAgentFactory, autoTitleDescription(), autoTitleFields(), AutoTitleModelOption, autoTitleModelOptions() (+12 more)

### Community 16 - "Persistent Storage States"
Cohesion: 0.16
Nodes (23): disableHePiTool(), hePiLoadoutKey(), isHePiSkillEnabled(), setHePiDisabledSkillKeys(), stateFor(), states, createLoadoutController(), LoadoutRuntimeHandlers (+15 more)

### Community 17 - "SSHFS Host Validation"
Cohesion: 0.11
Nodes (20): piSshfsExtension(), assertDirectChildDirectory(), createSshfsFeature(), ensureDirectory(), findMountEntry(), isAbortError(), isMissingBinaryError(), MountEntry (+12 more)

### Community 18 - "Simplified Settings Registration"
Cohesion: 0.12
Nodes (12): HePiSettingField, registerHePiSettings(), piT2sExtension(), convertInputText(), convertProseLine(), createTraditionalToSimplifiedFeature(), createTraditionalToSimplifiedSettingsProvider(), Fence (+4 more)

### Community 19 - "Shell Component Testing"
Cohesion: 0.13
Nodes (12): createSettingsController(), fakeHost, fakeProvider(), fakeStorage(), fakeTheme(), testContext(), provider(), setup() (+4 more)

### Community 20 - "TypeScript Project Configuration"
Cohesion: 0.08
Nodes (24): bun, ES2022, node, compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib (+16 more)

### Community 21 - "Wide UI Detail Rendering"
Cohesion: 0.11
Nodes (15): plain(), createSplitLayout(), SplitLayout, SplitLayoutOptions, createSettingsLayout(), SettingsLayout, SettingsLayoutMode, stripAnsi() (+7 more)

### Community 22 - "Terminal Tool Status"
Cohesion: 0.15
Nodes (15): LoadoutControllerOptions, LoadoutControllerState, LoadoutRuntimeHandler, LoadoutInventory, LoadoutInventoryProvider, LoadoutItem, LoadoutResolvedItem, LoadoutScope (+7 more)

### Community 23 - "Loadout Selection Reconciliation"
Cohesion: 0.20
Nodes (6): copyMaps(), LoadoutController, normalize(), readable(), parseLoadoutKey(), reconcileLoadoutSelection()

### Community 24 - "Runtime Registry Lifecycle"
Cohesion: 0.15
Nodes (11): streamScript(), createHePiRuntimeContext(), HePiRuntimeContext, HePiRuntimeContextOptions, HePiLifecycleController, HePiLifecycleOptions, HePiCleanupFailure, HePiIdentified (+3 more)

### Community 25 - "Tool And Skill Items"
Cohesion: 0.15
Nodes (18): BUILTIN_PROMPT_SNIPPETS, createLoadoutInventory(), createMcpPlaceholder(), estimateTokenCount(), LoadoutCommandInfo, LoadoutInventorySource, LoadoutInventoryValue, mergeLoadoutInventory() (+10 more)

### Community 26 - "RTK Windows Shell Rewrites"
Cohesion: 0.16
Nodes (20): applyRewrittenCommandShellSafetyFixups(), buildBufferedPipelineCommand(), extractProducerRewritePlan(), LEADING_RTK_DB_PATH_EXPORT_PRELUDE_PATTERN, ParsedPipeline, parseSimpleTopLevelPipeline(), ProducerRewritePlan, ShellSafetyTarget (+12 more)

### Community 27 - "Async Fixture Feedback"
Cohesion: 0.11
Nodes (10): ContextBudget, AdvisorAdapterFactory, createAdvisorFeature(), emptyFeedback(), AdvisorAdvice, AdvisorUsage, AdvisorAgentAdapter, FakeAdapter (+2 more)

### Community 28 - "Advisor Severity Feedback"
Cohesion: 0.16
Nodes (14): Active, AdvisorFeature, collectFeedback(), FeedbackState, parseAdvice(), reconfirmFeedback(), ADVISOR_TOOL_NAMES, AdvisorBoundary (+6 more)

### Community 29 - "Settings List Rendering"
Cohesion: 0.17
Nodes (17): renderScrollbar(), SettingsComponentOptions, settingFieldItemId(), settingGroupItemId(), editHints, fieldValue(), finish(), formatSettingValue() (+9 more)

### Community 30 - "Selectable Row Rendering"
Cohesion: 0.15
Nodes (14): Block, finishLine(), formatAskReviewAnswer(), invariant(), visibleBlocks(), formatKeyHint(), formatKeymap(), FormatKeymapOptions (+6 more)

### Community 31 - "BTW Execution Resolution"
Cohesion: 0.11
Nodes (16): BtwComponentOptions, ActiveRuntime, BtwTurn, at(), Command, ComponentState, EventHandler, first() (+8 more)

### Community 32 - "Skill Input Matching"
Cohesion: 0.17
Nodes (16): actionForInput(), AtomicAction, AtomicKeybinding, AtomicSpan, bareSkillName(), createDollarSkillAtomicEditor(), CURSOR_LEFT_INPUTS, CursorEditor (+8 more)

### Community 33 - "Shell Command Parsing"
Cohesion: 0.18
Nodes (18): CHAIN_OPERATORS, matchesCommandPatterns(), normalizeCommandForDetection(), sliceFirstSegment(), compactDiff(), compactGitOutput(), compactLog(), compactStatus() (+10 more)

### Community 34 - "Ask Interaction Reduction"
Cohesion: 0.15
Nodes (18): advance(), answersFromState(), ASK_LIMITS, AskAction, AskAnswerDraft, askDetails(), AskMode, AskOption (+10 more)

### Community 35 - "Value Editor Wrapping"
Cohesion: 0.22
Nodes (14): ellipsizedDescription(), renderDescription(), renderDraft(), ValueEditorState, renderTabBar(), renderTabs(), TabBarOptions, horizontalViewport (+6 more)

### Community 36 - "Message Serialization Helpers"
Cohesion: 0.19
Nodes (15): budgetContext(), BudgetedContext, buildBtwMessages(), BuildBtwMessagesOptions, contentPartText(), contentText(), createBtwUserMessage(), normalizeBtwQuestion() (+7 more)

### Community 37 - "Dollar Skill Registration"
Cohesion: 0.15
Nodes (13): piDollarSkillExtension(), AtomicEditorOwner, configFromState(), createDollarSkillFeature(), createDollarSkillSettingsProvider(), EditorFactory, enabledField, fields (+5 more)

### Community 38 - "Configuration Value Parsing"
Cohesion: 0.22
Nodes (16): Json, loadRtkConfig(), readRoot(), saveRtkConfig(), settingsPath(), normalizeRtkIntegrationConfig(), toBoolean(), toInteger() (+8 more)

### Community 39 - "Tool Result Evidence"
Cohesion: 0.18
Nodes (12): AdvisorDelta, buildReviewContext(), buildSessionContext(), buildTurnDelta(), estimateTokens(), extractPrimaryTurnEvidence(), fit(), json() (+4 more)

### Community 40 - "Settings Component Provider"
Cohesion: 0.17
Nodes (10): HePiContext, HePiSettingsProvider, HePiSettingsRegistry, combineSettingsProviders(), GroupMapping, createSettingsComponent(), SettingsControllerOptions, SettingsModule (+2 more)

### Community 41 - "Skill Command Selection"
Cohesion: 0.16
Nodes (15): name(), createHarness(), bareSkillName(), cleanDescription(), createDollarSkillAutocompleteProvider(), dim(), DollarSkillToken, expandDollarSkillReferences() (+7 more)

### Community 42 - "Ask Custom Answers"
Cohesion: 0.21
Nodes (15): aborted(), cancelled(), checkAbort(), collectQuestion(), customAnswer(), DialogOptions, DialogUI, hostError() (+7 more)

### Community 43 - "Theme Symbol Rendering"
Cohesion: 0.16
Nodes (13): LoadoutKind, finish(), footer(), groupOrder, icons, labels, LoadoutTheme, renderLoadout() (+5 more)

### Community 44 - "RTK Find Compatibility"
Cohesion: 0.24
Nodes (13): computeRewriteDecision(), RewriteDecision, basename(), findArguments(), finishWord(), hasUnsupportedFindArguments(), isAssignment(), isRtkFindSegment() (+5 more)

### Community 45 - "RTK Rewrite Resolution"
Cohesion: 0.21
Nodes (15): fallbackResolution(), getResolverCommand(), parseRtkExecutablePath(), ResolverCommand, resolveRtkExecutable(), ResolveRtkExecutableOptions, RtkExecutableResolution, RtkExecutableResolverName (+7 more)

### Community 46 - "Test Template Sources"
Cohesion: 0.12
Nodes (16): includes, !**/dist, !**/node_modules, packages/*/**/*.ts, !**/.pi, test/**/*.ts, !graphify-out, *.json (+8 more)

### Community 47 - "Target Settings Replacement"
Cohesion: 0.27
Nodes (9): registerAdvisorCommand(), piAdvisorExtension(), parseModelRef(), parseThinking(), registerAdvisorRenderer(), createAdvisorSettingsProvider(), Context, replaceHePiSettings() (+1 more)

### Community 48 - "Ask Tool Registration"
Cohesion: 0.17
Nodes (12): hasDialogUI(), ActiveAsk, AgentToolResultLike, ASK_PARAMETERS, ASK_PROMPT_GUIDELINES, askOption, askQuestion, createAskFeature() (+4 more)

### Community 49 - "BTW Extension Components"
Cohesion: 0.23
Nodes (10): piBtwExtension(), abortRequest(), BtwFeature, btwOverlayOptions(), createBtwFeature(), hasResolvedContext(), isCurrentRequest(), isSameSession() (+2 more)

### Community 50 - "Goal Extension Runtime"
Cohesion: 0.20
Nodes (11): piAskExtension(), registerHePiLifecycle(), registerHePiToolDisableHandler(), getToolActivationCoordinator(), Editor, EditorArgs, EditorFactory, EventHandler (+3 more)

### Community 51 - "Theme Mode Levels"
Cohesion: 0.18
Nodes (13): createPlanConfirmationComponent(), defined(), finish(), Focus, levels, modes, PlanConfirmationComponentOptions, PlanConfirmationModel (+5 more)

### Community 52 - "RTK Command Runtime Guards"
Cohesion: 0.20
Nodes (6): registerRtkCommand(), RtkFeature, shouldRequireRtkAvailabilityForCommandHandling(), shouldSkipCommandHandlingWhenRtkMissing(), RtkIntegrationConfig, RuntimeStatus

### Community 53 - "Settings Field Parsing"
Cohesion: 0.14
Nodes (12): advancedGroup, booleanField, delayedSaveProvider, emptyProvider, enumField, failedSaveProvider, generalGroup, numberField (+4 more)

### Community 54 - "RTK Extension Feature"
Cohesion: 0.25
Nodes (10): piRtkExtension(), createRtkFeature(), clearOutputMetrics(), getOutputMetricsSummary(), OutputMetricRecord, outputMetrics, createRtkSettingsProvider(), fields (+2 more)

### Community 55 - "Grapheme Value Rendering"
Cohesion: 0.27
Nodes (3): RenderSettingsOptions, graphemeBoundaries(), ValueEditor

### Community 56 - "Model Response Registry"
Cohesion: 0.22
Nodes (8): BtwExecutionResult, createCompletionOptions(), errorText(), executeBtwTurn(), ExecuteBtwTurnOptions, extractAssistantText(), messages, model

### Community 57 - "RTK Environment Prefixes"
Cohesion: 0.27
Nodes (11): applyRtkCommandEnvironment(), getTemporaryRtkHistoryDbPath(), hasInheritedRtkDbPath(), hasLeadingRtkDbPathAssignment(), quoteForShellEnv(), resolveTemporaryDirectory(), RTK_DB_PATH_ASSIGNMENT_PATTERN, RTK_DB_PATH_EXPORT_PATTERN (+3 more)

### Community 58 - "Subagent Runtime Usage"
Cohesion: 0.17
Nodes (9): aliases, args, child, packageEntry(), rawArgs, resolveExtension(), root, separatorIndex (+1 more)

### Community 59 - "Code Style Rules"
Cohesion: 0.17
Nodes (12): rules, noFloatingPromises, nursery, preset, style, suspicious, noEnum, noNamespace (+4 more)

### Community 60 - "Pi Basics BTW Architecture"
Cohesion: 0.20
Nodes (12): Custom UI Overlay, Lifecycle Cleanup, Serial Queue, Session-Scoped Runtime, SideThread, Pi Basics BTW Implementation Plan, Pi Basics BTW Baseline Recommendation, BTW Reuse Strategy (+4 more)

### Community 62 - "Goal Tool Activation"
Cohesion: 0.21
Nodes (7): coordinators, createToolActivationCoordinator(), host(), fixture(), TestCommand, TestHandler, TestTool

### Community 63 - "UI Error Formatting"
Cohesion: 0.25
Nodes (7): formatUiError(), HePiParseError, HePiStorageError, HePiUiError, messageOf(), toUiError(), UiErrorKind

### Community 64 - "Skill Prompt Filtering"
Cohesion: 0.29
Nodes (8): escapeXml(), FilteredSkillPrompt, filterLoadoutDisabledSkillsFromPrompt(), formatSkillsForPrompt(), PromptSkill, promptSkillKey(), replaceSkillsSection(), skill()

### Community 65 - "Build Output Classification"
Cohesion: 0.31
Nodes (10): BUILD_COMMAND_PATTERNS, BuildStats, ERROR_START_PATTERNS, filterBuildOutput(), isBuildCommand(), isErrorStart(), isSkipLine(), isWarning() (+2 more)

### Community 66 - "Source Code Filtering"
Cohesion: 0.29
Nodes (10): COMMENT_PATTERNS, CommentPatterns, countCodeBraces(), detectLanguage(), filterAggressive(), filterMinimal(), filterSourceCode(), getCodePortion() (+2 more)

### Community 68 - "Dollar Skill Configuration"
Cohesion: 0.49
Nodes (8): dollarSkillSettingsPath(), isJsonObject(), JsonObject, loadDollarSkillConfig(), normalizeDollarSkillConfig(), normalizeMaxSuggestions(), readRoot(), saveDollarSkillConfig()

### Community 69 - "Tool Execution Sanitization"
Cohesion: 0.33
Nodes (8): mergeDetails(), isTextContentBlock(), mapTextContentBlocks(), TextContentBlock, toRecord(), sanitizeStreamingBashExecutionResult(), sanitizeStreamingBashText(), StreamingBashExecutionSanitizationResult

### Community 70 - "ANSI Text Truncation"
Cohesion: 0.27
Nodes (7): applyAnsiStripping(), ANSI_CSI_PATTERN, ANSI_OSC_PATTERN, ANSI_OSC_TERMINATED_PATTERN, stripAnsi(), stripAnsiFast(), truncate()

### Community 71 - "Advisor Persistence Recovery"
Cohesion: 0.36
Nodes (7): AdvisorAppender, AdvisorEntry, appendAdvisorBoundary(), decodeAdvisorBoundary(), encodeAdvisorBoundary(), record(), restoreAdvisor()

### Community 72 - "Theme Render Requests"
Cohesion: 0.25
Nodes (7): createAskComponent(), requestRender(), freshAskState(), harness(), questionnaire, taggedTheme, theme

### Community 73 - "Ask Scripted Questionnaires"
Cohesion: 0.28
Nodes (7): formatAskResult(), isRecord(), normalizeAskParams(), normalizedContext(), printable(), printableSingleLine(), questionnaire()

### Community 74 - "BTW Component Harness"
Cohesion: 0.31
Nodes (7): createBtwComponent(), requestRender(), BtwFeatureOptions, createBtwTurn(), assistant(), harness(), theme

### Community 76 - "Ponytail Review Comments"
Cohesion: 0.28
Nodes (9): Ponytail Companion Skills, @hheei/pi-ponytail, Ponytail Modes, ponytail-audit, ponytail: Comments, ponytail-debt, ponytail-gain, ponytail-help (+1 more)

### Community 77 - "Compact Tool Output"
Cohesion: 0.33
Nodes (9): applyConditionalTechnique(), applyNullableTechnique(), applyTruncation(), beginCompaction(), compactBashText(), compactGrepText(), compactReadText(), normalizeTechniqueResult() (+1 more)

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
Nodes (5): DollarSkillCommand, atomicEditor(), commands, inputs, keybindings

### Community 83 - "Loadout Component Setup"
Cohesion: 0.36
Nodes (5): createLoadoutView(), LoadoutComponentOptions, item(), setup(), theme

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
Cohesion: 0.38
Nodes (6): BorderTheme, DetailPanelOptions, renderDetailPanel(), roundedBorder(), RoundedBorderOptions, roundedPanel()

### Community 88 - "Repository Package Paths"
Cohesion: 0.33
Nodes (4): isRecord(), packageDependencies(), packagesDirectory, repositoryRoot

### Community 90 - "Todo Goal Plan State"
Cohesion: 0.29
Nodes (7): Branch Session History, goal Tool, @hheei/pi-goal, Branch-local Plan State, @hheei/pi-plan, @hheei/pi-todo, todo Tool

### Community 91 - "BTW Request Controller"
Cohesion: 0.33
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

## Knowledge Gaps
- **434 isolated node(s):** `$schema`, `enabled`, `clientKind`, `useIgnoreFile`, `ignoreUnknown` (+429 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `HePiRuntimeContext` connect `Runtime Registry Lifecycle` to `Session Lifecycle State`, `Task State Validation`, `Todo Feature Lifecycle`, `Dollar Skill Registration`, `Plan Status Updates`, `Assistant Stream Status`, `Usage Theme Formatting`, `Ask Tool Registration`, `BTW Extension Components`, `Ask Questionnaire Feature`, `Dollar Skill Feature`, `Async Fixture Feedback`, `Advisor Severity Feedback`, `HePi Registry Modules`, `BTW Execution Resolution`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `HePiSettingsProvider` connect `Settings Component Provider` to `HePi Shell Routing`, `Root Storage Paths`, `Temporary Directory Storage`, `Dollar Skill Registration`, `Assistant Stream Status`, `Settings Provider Validation`, `Model Settings Snapshot`, `Settings Controller State`, `Automatic Title Storage`, `Target Settings Replacement`, `Simplified Settings Registration`, `Shell Component Testing`, `Settings Field Parsing`, `Wide UI Detail Rendering`, `RTK Extension Feature`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `HePiSettingField` connect `Simplified Settings Registration` to `HePi Shell Routing`, `Root Storage Paths`, `Temporary Directory Storage`, `Dollar Skill Registration`, `Assistant Stream Status`, `Settings Provider Validation`, `Model Settings Snapshot`, `Settings Controller State`, `Automatic Title Storage`, `Shell Component Testing`, `Settings Field Parsing`, `Wide UI Detail Rendering`, `RTK Extension Feature`, `Settings List Rendering`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `$schema`, `enabled`, `clientKind` to the rest of the system?**
  _434 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Session Lifecycle State` be split into smaller, more focused modules?**
  _Cohesion score 0.059466848940533154 - nodes in this community are weakly interconnected._
- **Should `Task State Validation` be split into smaller, more focused modules?**
  _Cohesion score 0.05502392344497608 - nodes in this community are weakly interconnected._
- **Should `HePi Shell Routing` be split into smaller, more focused modules?**
  _Cohesion score 0.051251956181533644 - nodes in this community are weakly interconnected._