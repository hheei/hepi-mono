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
	LoadoutInventoryObserver,
	LoadoutInventoryRegistration,
	LoadoutToolActivationObserver,
	LoadoutToolActivationSnapshot,
	LoadoutToolMetadata,
	ManagedLoadoutToolRegistration,
} from "./loadout.js";
export {
	clearLoadoutToolActivation,
	observeLoadoutInventory,
	observeLoadoutToolActivation,
	publishLoadoutToolActivation,
	registerLoadoutInventory,
	registerManagedLoadoutTool,
} from "./loadout.js";
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
	ExtensionPageRegistration,
	ExtensionPageView,
	ExtensionPageViewContext,
	OpenExtensionPageRouterOptions,
} from "./page-router.js";
export { openExtensionPageRouter, registerExtensionPage } from "./page-router.js";
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
	SubagentTurnEvent,
	SubscribeSubagentEventsOptions,
	TaskSubagentHandle,
	TaskSubagentSpec,
	TaskTerminalDeliverySink,
	TaskTerminalResult,
} from "./subagents.js";
export {
	configureSubagentCoordinator,
	lookupSubagent,
	redeliverTask,
	startSubagent,
} from "./subagents.js";
