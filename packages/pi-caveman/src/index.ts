export {
	CAVEMAN_DEFAULTS_GROUP,
	CAVEMAN_MAIN_MODE_FIELD,
	CAVEMAN_SETTINGS_PROVIDER_ID,
	CAVEMAN_SUBAGENT_MODE_FIELD,
	type CavemanDefaults,
	createCavemanSettingsProvider,
	DEFAULT_CAVEMAN_DEFAULTS,
	loadCavemanDefaults,
} from "./config.js";
export { default, default as piCavemanExtension } from "./extension.js";
export { registerCavemanSettings } from "./hepi-settings.js";
export {
	CAVEMAN_INTENSITIES,
	CAVEMAN_STATE_ENTRY,
	type CavemanCommand,
	type CavemanIntensity,
	type CavemanMode,
	cavemanStatusLabel,
	DEFAULT_CAVEMAN_MODE,
	detectCavemanIntent,
	isCavemanIntensity,
	parseCavemanCommand,
	restoreCavemanMode,
} from "./mode.js";
export { buildCavemanPrompt } from "./prompt.js";
export {
	CAVEMAN_SUBAGENT_MARKER,
	hasSubagentPromptMarker,
	injectSubagentPrompt,
	isAgentToolInput,
	isPiSubagentSession,
} from "./subagents.js";
