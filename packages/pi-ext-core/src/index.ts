export { acquireMutationLock, withMutationLock } from "./mutation-lock.js";
/**
 * Side-effect-free coordination contracts for independently installed Pi extensions.
 * Concrete packages own commands, state, policy, and rendering; core only owns
 * shared registration, lifecycle, cancellation, and cross-package coordination.
 */

export type { ToolRenderers } from "@earendil-works/pi-coding-agent";
export type {
	BackgroundDelivery,
	BackgroundDeliveryChannel,
	BackgroundDeliveryRegistration,
} from "./background-delivery.js";
export { createBackgroundDelivery, getBackgroundDelivery } from "./background-delivery.js";
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
	estimateEntryTokens,
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
	CustomEditorLike,
	EditorWorkingStatusIndicatorLike,
	PreTurnWorkingStatusOptions,
	TuiLike,
} from "./editor-working-status.js";
export {
	BRAILLE_SPINNER_FRAMES,
	EditorWorkingStatusIndicator,
	registerActiveEditor,
	setPreTurnWorkingStatus,
	unregisterActiveEditor,
} from "./editor-working-status.js";
export { abortError, errorMessage, throwIfAborted } from "./errors.js";
export type {
	ExtensionPointHandle,
	ExtensionPointKey,
	OpenExtensionPointOptions,
} from "./extension-point.js";
export {
	createExtensionPointKey,
	openExtensionPoint,
	readExtensionHooks,
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
	MessageRows,
	MessageTone,
	MessageViewFactory,
	MessageViewHeader,
	MessageViewSpec,
} from "./message-view-point.js";
export { messageViewPoint, readMessageView } from "./message-view-point.js";
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
export type { BashOutputResult } from "./output-tail.js";
export { BashOutputSink, DEFAULT_VISIBLE_TAIL_BYTES } from "./output-tail.js";
export type {
	ExtensionPageRegistration,
	ExtensionPageView,
	ExtensionPageViewContext,
	OpenExtensionPageRouterOptions,
} from "./page-router.js";
export { openExtensionPageRouter, registerExtensionPage } from "./page-router.js";
export { panelScrollbar } from "./panel-scrollbar.js";
export { expandHome } from "./paths.js";
export type { CommandOptions, CommandResult } from "./process.js";
export { isSubagentProcess, runCommand, shellQuote } from "./process.js";
export {
	OPTIONAL_TOOLS_PREAMBLE,
	OPTIONAL_TOOLS_SECTION,
	setOptionalToolBullet,
	setPromptSection,
	setSectionBullet,
} from "./prompt-section.js";
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
	renderBottomRailBorder,
	TELEMETRY_DISMISS_DELAY_MS,
	wrapEditorBottomRail,
} from "./response-status.js";
export { fitRow } from "./row-fit.js";
export {
	extractShellCommands,
	isSearchOnlyCommand,
	SEARCH_BASH_TIMEOUT_SECONDS,
	SEARCH_TIMEOUT_MS,
} from "./search-command.js";
export type {
	MemoryCompactorService,
	ServiceKey,
	WaitForServiceOptions,
} from "./service.js";
export {
	createServiceKey,
	getService,
	MEMORY_COMPACTOR_SERVICE_KEY,
	provideService,
	waitForService,
} from "./service.js";
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
export { defaultShellPath } from "./shell.js";
export { escapeXml } from "./text.js";
export type {
	BaseToolPresentation,
	DiffToolPresentation,
	TextToolPresentation,
	ToolPresentation,
	ToolPresentationContext,
	ToolPresentationProvider,
	ToolPresentationSection,
	ToolPresentationStatus,
} from "./tool-presentation.js";
export {
	createToolPresentationRenderers,
	getRegisteredToolPresentationProvider,
	getToolPresentationProvider,
} from "./tool-presentation.js";
export type { ToolRendererFactory } from "./tool-renderer-point.js";
export {
	createOptionalToolRenderers,
	hasOptionalToolRenderers,
	toolRendererPoint,
} from "./tool-renderer-point.js";
export { agentResultText, formatDuration, textToolResult } from "./tool-result.js";

export type {
	WidgetHandle,
	WidgetPlacement,
	WidgetRegistration,
	WidgetSuspension,
} from "./widgets.js";
export { registerWidget, suspendWidgets } from "./widgets.js";
