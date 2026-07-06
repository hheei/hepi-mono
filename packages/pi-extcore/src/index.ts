export { formatExtensionLabel, normalizePackageSlug } from "./package.js";
export {
	createSettingItems,
	createSettingsPanelComponent,
	type SettingsPanelHost,
	type SettingsPanelOptions,
	type SettingsPanelPane,
} from "./settings/panel.js";
export {
	createSessionSettingsStorage,
	EXTENSION_SETTING_COMMAND,
	type ExtensionSettingsProvider,
	type ExtensionSettingsSubpanel,
	type ExtensionSettingsSubpanelCreateOptions,
	getExtensionSettingsProviders,
	type RegisterExtensionSettingCommandOptions,
	registerExtensionSettingCommand,
	registerExtensionSettings,
	type SettingsStorageAdapter,
} from "./settings/register.js";
export {
	applySettingChange,
	createDefaultSettingsState,
	decodeSettingItemId,
	encodeSettingItemId,
	formatSettingValue,
	getSettingValue,
	mergeSettingsState,
	parseSettingValue,
	settingValueLabels,
} from "./settings/state.js";
export { createAgentJsonSettingsStorage, createJsonSettingsStorage } from "./settings/storage.js";
export type {
	MaybePromise,
	SettingChange,
	SettingField,
	SettingGroup,
	SettingOption,
	SettingPrimitive,
	SettingsState,
} from "./settings/types.js";
