export type {
	CreateHePiModelSelectionFieldOptions,
	HePiModelSelectionOption,
	HePiModelSelectionRegistry,
	HePiModelThinkingCycle,
	HePiModelThinkingLevel,
} from "./api/model-selection.js";
export {
	createHePiModelSelectionField,
	hePiAuthenticatedModelSelectionOptions,
	hePiModelSelectionOptions,
	hePiThinkingGlyph,
} from "./api/model-selection.js";

export type { HePiModule, HePiModuleView, HePiModuleViewContext } from "./api/modules.js";
export {
	getHePiRuntimeModuleRegistry,
	registerHePiModule,
} from "./api/modules.js";
export type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
	HePiSettingsStorage,
	HePiSettingValue,
} from "./api/settings.js";
export {
	getHePiRuntimeSettingsRegistry,
	getHePiSettings,
	registerHePiSettings,
} from "./api/settings.js";
export { default } from "./extension.js";
export type { HePiRuntimeContext } from "./runtime/context.js";
export { createHePiRuntimeContext } from "./runtime/context.js";
export {
	createJsonSectionSettingsStorage,
	updateJsonSettingsRoot,
} from "./runtime/json-settings.js";
export { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
export {
	disableHePiTool,
	hePiLoadoutKey,
	isHePiSkillEnabled,
	registerHePiToolDisableHandler,
	setHePiDisabledSkillKeys,
} from "./runtime/loadout-bridge.js";
export type { ToolActivationCoordinator } from "./runtime/tool-activation.js";
export {
	createToolActivationCoordinator,
	getToolActivationCoordinator,
} from "./runtime/tool-activation.js";
export { renderDetailPanel } from "./ui/border.js";
export { formatKeymap, keyGlyph } from "./ui/keymap.js";
export { createSplitLayout } from "./ui/layout.js";
export { renderSelectableRow } from "./ui/row.js";
export { renderScrollbar } from "./ui/scrollbar.js";
export { renderTabs } from "./ui/tabs.js";
export { padToWidth, truncateToWidth, visibleWidth, wrap } from "./ui/text.js";
