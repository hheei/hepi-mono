/**
 * Side-effect-free coordination contracts for independently installed Pi extensions.
 * Concrete packages own commands, state, policy, and rendering; core only owns
 * shared registration, lifecycle, cancellation, and cross-package coordination.
 */
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
	LoadoutHostObserver,
	LoadoutInventoryItem,
	LoadoutInventoryObserver,
	LoadoutInventoryRegistration,
	LoadoutResourceDetail,
	LoadoutResourceMetadata,
	LoadoutToolActivationObserver,
	LoadoutToolActivationSnapshot,
	LoadoutToolMetadata,
	ManagedLoadoutToolRegistration,
} from "./loadout.js";
export {
	clearLoadoutToolActivation,
	observeLoadoutHost,
	observeLoadoutInventory,
	observeLoadoutToolActivation,
	publishLoadoutToolActivation,
	registerLoadoutHost,
	registerLoadoutInventory,
	registerLoadoutResource,
	registerManagedLoadoutTool,
} from "./loadout.js";
export type {
	MemorySearchExclusionInput,
	MemorySearchExclusionService,
} from "./memory-search-exclusion.js";
export { MCTX_MEMORY_EXCLUSION_SERVICE } from "./memory-search-exclusion.js";
export type {
	CreateHepiModelSelectionFieldOptions,
	HepiModelSelectionCandidate,
	HepiModelSelectionOption,
	HepiModelSelectionRegistry,
	HepiModelThinkingCycle,
	HepiModelThinkingLevel,
} from "./model-selection.js";
export {
	createHepiModelSelectionField,
	hepiAuthenticatedModelSelectionOptions,
	hepiModelSelectionOptions,
	hepiThinkingGlyph,
} from "./model-selection.js";
export type {
	MouseRegion,
	MouseSupport,
	SelectableRegion,
	TerminalMouseEvent,
	TextPosition,
	TextRange,
} from "./mouse.js";
export { installMouseSupport } from "./mouse.js";
export type {
	ExtensionPageRegistration,
	ExtensionPageView,
	ExtensionPageViewContext,
	OpenExtensionPageRouterOptions,
} from "./page-router.js";
export { openExtensionPageRouter, registerExtensionPage } from "./page-router.js";
export type {
	ParentContextHandoffResult,
	ParentContextInheritanceResult,
	ParentContextProjectionPrepareInput,
	ParentContextProjectionPurpose,
	ParentContextProjectionResult,
	ParentContextProjectionService,
	ParentContextProjectionStale,
	ParentContextProjectionUnavailable,
} from "./parent-context-projection.js";
export { PARENT_CONTEXT_PROJECTION_SERVICE } from "./parent-context-projection.js";
export type { ServiceKey, WaitForServiceOptions } from "./service.js";
export { createServiceKey, getService, provideService, waitForService } from "./service.js";
export type {
	HepiContext,
	HepiSettingChange,
	HepiSettingField,
	HepiSettingGroup,
	HepiSettingOption,
	HepiSettingPrimitive,
	HepiSettingsPanel,
	HepiSettingsProvider,
	HepiSettingsRegistry,
	HepiSettingsState,
	HepiSettingsStorage,
	HepiSettingTabCycle,
	HepiSettingType,
	HepiSettingValue,
	JsonSectionSettingsStorageOptions,
} from "./settings.js";
export {
	createJsonSectionSettingsStorage,
	getHepiRuntimeSettingsRegistry,
	registerHepiSettings,
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
export type { ToolResultBounds, ToolResultLayout } from "./tool-result-layout.js";
export { getToolResultLayout } from "./tool-result-layout.js";
export type {
	HepiWidgetHandle,
	HepiWidgetPlacement,
	HepiWidgetRegistration,
	HepiWidgetSuspension,
} from "./widgets.js";
export { registerHepiWidget, suspendHepiWidgets } from "./widgets.js";
