export { default, default as piExtAddonExtension } from "./extension.js";
export {
	applyOpenAIResponsesCompat,
	createOpenAIResponsesCompatFeature,
	createOpenAIResponsesCompatSettingsProvider,
	normalizeAssistantMessageId,
	OPENAI_RESPONSES_COMPAT_FIELD,
	OPENAI_RESPONSES_COMPAT_GROUP,
	OPENAI_RESPONSES_COMPAT_SETTINGS_SECTION,
	OPENAI_RESPONSES_NORMALIZE_MESSAGE_ID_FIELD,
	type OpenAIResponsesCompatConfig,
	type OpenAIResponsesCompatFeature,
	type OpenAIResponsesCompatOptions,
	stripAssistantMessageStatus,
} from "./openai-responses-compat.js";
