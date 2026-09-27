/**
 * Side-effect-free coordination contracts for independently installed Pi extensions.
 * Concrete packages own commands, state, policy, and rendering; core only owns
 * shared registration, lifecycle, cancellation, and cross-package coordination.
 */

export type { SubcommandCompletions } from "./command-completions.js";
export { splitSubcommand, subcommandCompletions } from "./command-completions.js";
export type {
	EstimateTextTokens,
	PiContextUsageReading,
	PiContextUsageSource,
	PiPrefixTokens,
	PiPrefixTool,
	ResolvedPiContextUsage,
} from "./context-usage.js";
export {
	estimatePiPrefixTokens,
	estimatePiToolDefinitionTokens,
	estimateTextTokens,
	resolvePiContextUsage,
} from "./context-usage.js";
export type {
	OpenTuiSurfaceOptions,
	TuiSurfaceContext,
	TuiSurfaceResult,
} from "./custom-surface.js";
export { openTuiSurface, TuiSurfaceQueueFullError } from "./custom-surface.js";
export type { Cleanup, CleanupFailure, DisposerRegistry } from "./disposer-registry.js";
export { abortError, errorMessage, throwIfAborted } from "./errors.js";
export type {
	ExtensionPointHandle,
	ExtensionPointKey,
	OpenExtensionPointOptions,
} from "./extension-point.js";
export {
	createExtensionPointKey,
	openExtensionPoint,
	registerExtensionHook,
} from "./extension-point.js";
export type {
	ExtensionSettingsPaths,
	JsonSettingsValueSource,
	MergedJsonSettingsSection,
	ReadMergedJsonSettingsSectionOptions,
} from "./json-settings.js";
export {
	defaultExtensionSettingsPaths,
	readJsonSettingsRoot,
	readJsonSettingsSection,
	readMergedJsonSettingsSection,
	updateJsonSettingsRoot,
} from "./json-settings.js";
export type { ExtensionLifecycleContext, ExtensionLifecycleOptions } from "./lifecycle.js";
export { registerExtensionLifecycle } from "./lifecycle.js";
export type {
	LoadoutInventoryObserver,
	LoadoutResourceDetail,
	LoadoutResourceDetailContext,
	LoadoutResourceMetadata,
	ManagedToolRegistration,
} from "./loadout.js";
export {
	isManagedTool,
	observeLoadoutInventory,
	registerLoadoutResource,
	registerManagedTool,
	setManagedToolsActive,
} from "./loadout.js";
export type {
	CreateModelSelectionFieldOptions,
	ModelSelectionCandidate,
	ModelSelectionOption,
	ModelSelectionRegistry,
	ModelThinkingCycle,
	ModelThinkingLevel,
	ModelThinkingResolver,
} from "./model-selection.js";
export {
	authenticatedModelSelectionOptions,
	clampThinkingLevel,
	createModelSelectionField,
	modelSelectionOptions,
	thinkingGlyph,
} from "./model-selection.js";
export type {
	ExtensionPageRegistration,
	ExtensionPageView,
	ExtensionPageViewContext,
	OpenExtensionPageRouterOptions,
} from "./page-router.js";
export { openExtensionPageRouter, registerExtensionPage } from "./page-router.js";
export { expandHome } from "./paths.js";
export type { CommandOptions, CommandResult } from "./process.js";
export { runCommand, shellQuote } from "./process.js";
export { setPromptSection } from "./prompt-section.js";
export { isRecord } from "./record.js";
export type {
	BottomRailBorderOptions,
	ColorFn,
	ResponseStatusFeature,
	TelemetryMetrics,
	ThemeLike,
} from "./response-status.js";
export {
	createResponseStatusFeature,
	formatCompactNumber,
	formatDurationColor,
	formatRate,
	formatTelemetryStatus,
	patchActualTuiScrollView,
	renderBottomRailBorder,
	TELEMETRY_DISMISS_DELAY_MS,
	wrapEditorBottomRail,
} from "./response-status.js";
export type { ServiceKey, WaitForServiceOptions } from "./service.js";
export { createServiceKey, getService, provideService, waitForService } from "./service.js";
export type {
	JsonSettingsStorageOptions,
	SettingChange,
	SettingField,
	SettingGroup,
	SettingOption,
	SettingPrimitive,
	SettingsContext,
	SettingsPanel,
	SettingsProvider,
	SettingsRegistry,
	SettingsState,
	SettingsStorage,
	SettingTabCycle,
	SettingType,
	SettingValue,
} from "./settings.js";
export {
	createJsonSettingsStorage,
	getRuntimeSettingsRegistry,
	registerSettings,
} from "./settings.js";
export {
	clearDisabledSkillKeys,
	getDisabledSkillKeys,
	isSkillEnabled,
	setDisabledSkillKeys,
} from "./skill-state.js";
export type {
	CompletionFailure,
	CompletionSubagentHandle,
	CompletionSubagentResult,
	CompletionSubagentSpec,
	ConfigureSubagentCoordinatorOptions,
	ConversationDeliveryAcknowledgement,
	ConversationInputMode,
	ConversationMessageSequence,
	ConversationReplyConsumption,
	ConversationReplyDeliverySink,
	ConversationReplyResult,
	ConversationSendOptions,
	ConversationSubagentHandle,
	ConversationSubagentSpec,
	ConversationTerminalResult,
	ConversationUsage,
	ExternalTaskExecutionContext,
	ExternalTaskTerminalResult,
	ResolvedChildSessionFactory,
	ResolvedExternalTaskExecution,
	ResolvedTaskExecution,
	SubagentEvent,
	SubagentEventKind,
	SubagentEventSubscription,
	SubagentHandle,
	SubagentId,
	SubagentMode,
	SubagentSpec,
	SubagentStatus,
	SubagentTerminalEvent,
	SubagentTerminalResult,
	SubagentTextEvent,
	SubagentToolEvent,
	SubagentTranscriptEntry,
	SubagentTranscriptSnapshot,
	SubagentTurnEvent,
	SubscribeSubagentEventsOptions,
	TaskSubagentHandle,
	TaskSubagentSpec,
	TaskTerminalDeliverySink,
	TaskTerminalResult,
} from "./subagents.js";
export {
	configureSubagentCoordinator,
	DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
	ensureSubagentCoordinator,
	lookupSubagent,
	MAX_SUBAGENT_TRANSCRIPT_CHARS,
	redeliverTask,
	startSubagent,
} from "./subagents.js";
export { escapeXml } from "./text.js";
export { agentResultText, formatDuration, textToolResult } from "./tool-result.js";
export type { ToolCollapseMode, ToolCompletion, ToolTui, ToolTuiPresentation } from "./tool-tui.js";
export {
	AUTO_COLLAPSE_DELAY_MS,
	AUTO_COLLAPSE_RETRY_DELAY_MS,
	createToolTui,
	DEFAULT_MAX_BODY_LINES,
	getToolTui,
	installScrollViewViewportProtection,
	isTuiScrolledUp,
	registerToolTuiTrace,
} from "./tool-tui.js";
export type {
	WidgetHandle,
	WidgetPlacement,
	WidgetRegistration,
	WidgetSuspension,
} from "./widgets.js";
export { registerWidget, suspendWidgets } from "./widgets.js";
