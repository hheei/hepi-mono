export const MAX_SUGGESTIONS = 30;

export type DollarExtensionSettings = {
	pickerEnabled: boolean;
	maxSuggestions: number;
	highlightReferences: boolean;
};

export const DEFAULT_DOLLAR_SETTINGS: DollarExtensionSettings = {
	pickerEnabled: true,
	maxSuggestions: MAX_SUGGESTIONS,
	highlightReferences: true,
};
