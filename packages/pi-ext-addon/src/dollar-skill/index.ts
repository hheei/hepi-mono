export { createDollarSkillAtomicEditor } from "./atomic-editor.js";
export {
	DOLLAR_SKILL_SETTINGS_GROUP,
	dollarSkillSettingsPath,
	loadDollarSkillConfig,
	normalizeDollarSkillConfig,
	saveDollarSkillConfig,
} from "./config.js";
export {
	createDollarSkillFeature,
	createDollarSkillSettingsProvider,
	type DollarSkillFeature,
	registerDollarSkillInputTransform,
} from "./feature.js";
export {
	createDollarSkillAutocompleteProvider,
	DEFAULT_DOLLAR_SKILL_CONFIG,
	DEFAULT_DOLLAR_SKILL_MAX_SUGGESTIONS,
	type DollarSkillCommand,
	type DollarSkillConfig,
	type DollarSkillToken,
	expandDollarSkillReferences,
	extractDollarSkillToken,
	getDollarSkillSuggestions,
	MAX_DOLLAR_SKILL_SUGGESTIONS,
} from "./model.js";
