/**
 * Side-effect-free coordination contracts for independently installed Pi extensions.
 * Concrete packages own commands, state, policy, and rendering; core only owns
 * shared registration, lifecycle, cancellation, and cross-package coordination.
 */

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
	JsonSettingsValueSource,
	MergedJsonSettingsSection,
	PiSettingsPaths,
	ReadMergedJsonSettingsSectionOptions,
} from "./json-settings.js";
export {
	defaultPiSettingsPaths,
	readJsonSettingsRoot,
	readJsonSettingsSection,
	readMergedJsonSettingsSection,
	updateJsonSettingsRoot,
} from "./json-settings.js";
export type { ExtensionLifecycleContext, ExtensionLifecycleOptions } from "./lifecycle.js";
export { registerExtensionLifecycle } from "./lifecycle.js";
export type {
	LoadoutInventoryItem,
	LoadoutInventoryObserver,
	LoadoutInventoryRegistration,
	LoadoutResourceDetail,
	LoadoutResourceDetailContext,
	LoadoutResourceMetadata,
	LoadoutToolActivationObserver,
	LoadoutToolActivationSnapshot,
	LoadoutToolMetadata,
	ManagedLoadoutToolRegistration,
	ManagedToolRegistration,
} from "./loadout.js";
export {
	clearLoadoutToolActivation,
	isManagedLoadoutTool,
	observeLoadoutInventory,
	observeLoadoutToolActivation,
	publishLoadoutToolActivation,
	registerLoadoutInventory,
	registerLoadoutResource,
	registerManagedLoadoutTool,
	registerManagedTool,
	setManagedLoadoutToolsActive,
} from "./loadout.js";
export type {
	CreateModelSelectionFieldOptions,
	ModelSelectionCandidate,
	ModelSelectionOption,
	ModelSelectionRegistry,
	ModelThinkingCycle,
	ModelThinkingLevel,
} from "./model-selection.js";
export {
	authenticatedModelSelectionOptions,
	createModelSelectionField,
	modelSelectionOptions,
	thinkingGlyph,
} from "./model-selection.js";
export type { OutputRegistry, OutputUri } from "./output.js";
export { createOutputRegistry } from "./output.js";
export type {
	ExtensionPageRegistration,
	ExtensionPageView,
	ExtensionPageViewContext,
	OpenExtensionPageRouterOptions,
} from "./page-router.js";
export { openExtensionPageRouter, registerExtensionPage } from "./page-router.js";
export type { ResponseStatusFeature } from "./response-status.js";
export { createResponseStatusFeature } from "./response-status.js";
export type { ServiceKey, WaitForServiceOptions } from "./service.js";
export { createServiceKey, getService, provideService, waitForService } from "./service.js";
export type {
	JsonFlatSectionSettingsStorageOptions,
	JsonSectionSettingsStorageOptions,
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
	createJsonFlatSectionSettingsStorage,
	createJsonSectionSettingsStorage,
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
	ResolvedChildSessionFactory,
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
export type { ToolCompletion, ToolTui, ToolTuiPresentation } from "./tool-tui.js";
export {
	createToolTui,
	DEFAULT_MAX_BODY_LINES,
	getToolTui,
	registerToolTuiTrace,
} from "./tool-tui.js";
export type {
	WidgetHandle,
	WidgetPlacement,
	WidgetRegistration,
	WidgetSuspension,
} from "./widgets.js";
export { registerWidget, suspendWidgets } from "./widgets.js";
