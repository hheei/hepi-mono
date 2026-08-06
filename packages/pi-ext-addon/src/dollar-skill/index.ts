export { default } from "./extension.js";

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { HepiSettingField, HepiSettingsProvider, HepiSettingsState } from "@hheei/pi-ext-core";
import { createDollarSkillAtomicEditor } from "./atomic-editor.js";
import {
	DOLLAR_SKILL_SETTINGS_GROUP,
	loadDollarSkillConfig,
	normalizeDollarSkillConfig,
	saveDollarSkillConfig,
} from "./config.js";
import {
	createDollarSkillAutocompleteProvider,
	DEFAULT_DOLLAR_SKILL_CONFIG,
	type DollarSkillCommand,
	type DollarSkillConfig,
	expandDollarSkillReferences,
	MAX_DOLLAR_SKILL_SUGGESTIONS,
} from "./model.js";

const ENABLED_FIELD = "enabled";
const MAX_SUGGESTIONS_FIELD = "maxSuggestions";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;

interface AtomicEditorOwner {
	readonly sessionId: string;
	dispose(): void;
}

const enabledField: HepiSettingField<boolean> = {
	id: ENABLED_FIELD,
	label: "Dollar skill references",
	type: "boolean",
	defaultValue: DEFAULT_DOLLAR_SKILL_CONFIG.enabled,
	description: "Complete $skill-name and replace known references with the skill file path.",
	parse: (draft) => draft === "true",
};

const maxSuggestionsField: HepiSettingField<number> = {
	id: MAX_SUGGESTIONS_FIELD,
	label: "Dollar skill suggestions",
	type: "number",
	defaultValue: DEFAULT_DOLLAR_SKILL_CONFIG.maxSuggestions,
	description: `Maximum autocomplete entries (1-${MAX_DOLLAR_SKILL_SUGGESTIONS}).`,
	parse: (draft) => Number(draft),
	validate: (value) =>
		Number.isInteger(value) && value >= 1 && value <= MAX_DOLLAR_SKILL_SUGGESTIONS
			? undefined
			: `Enter an integer from 1 to ${MAX_DOLLAR_SKILL_SUGGESTIONS}.`,
	enabled: (state) => state[DOLLAR_SKILL_SETTINGS_GROUP]?.[ENABLED_FIELD] !== false,
};

const fields: readonly HepiSettingField[] = [enabledField, maxSuggestionsField];

function configFromState(state: HepiSettingsState): DollarSkillConfig {
	return normalizeDollarSkillConfig(state[DOLLAR_SKILL_SETTINGS_GROUP]);
}

export interface DollarSkillFeature {
	start(context: ExtensionContext): void;
	dispose(sessionId: string): void;
	isActive(): boolean;
	isSkillEnabled(command: DollarSkillCommand): boolean;
	getConfig(): DollarSkillConfig;
	setConfig(config: DollarSkillConfig): void;
}

export function createDollarSkillFeature(
	pi: ExtensionAPI,
	isSkillEnabled: (command: DollarSkillCommand) => boolean = () => true,
): DollarSkillFeature {
	let activeSessionId: string | undefined;
	let config = DEFAULT_DOLLAR_SKILL_CONFIG;
	let editorOwner: AtomicEditorOwner | undefined;
	const autocompleteContexts = new WeakSet<object>();
	return {
		start(context) {
			const sessionId = context.sessionManager.getSessionId();
			activeSessionId = sessionId;
			if (context.mode === "tui" && !autocompleteContexts.has(context)) {
				autocompleteContexts.add(context);
				context.ui.addAutocompleteProvider((current) =>
					createDollarSkillAutocompleteProvider(
						current,
						() => pi.getCommands(),
						() => config,
						() => activeSessionId !== undefined,
						isSkillEnabled,
					),
				);
			}
			if (
				editorOwner?.sessionId === sessionId ||
				context.mode !== "tui" ||
				typeof context.ui.getEditorComponent !== "function" ||
				typeof context.ui.setEditorComponent !== "function"
			)
				return;
			editorOwner?.dispose();
			const previousEditorFactory = context.ui.getEditorComponent();
			let next: AtomicEditorOwner | undefined;
			const installedEditorFactory: EditorFactory = (tui, theme, keybindings) =>
				createDollarSkillAtomicEditor(
					previousEditorFactory?.(tui, theme, keybindings) ??
						new CustomEditor(tui, theme, keybindings),
					keybindings,
					() => pi.getCommands(),
					() => activeSessionId === sessionId && config.enabled,
				);
			next = {
				sessionId,
				dispose() {
					if (editorOwner !== next) return;
					editorOwner = undefined;
					if (context.ui.getEditorComponent?.() === installedEditorFactory)
						context.ui.setEditorComponent?.(previousEditorFactory);
				},
			};
			editorOwner = next;
			context.ui.setEditorComponent(installedEditorFactory);
		},
		dispose(sessionId) {
			if (activeSessionId === sessionId) activeSessionId = undefined;
			if (editorOwner?.sessionId === sessionId) editorOwner.dispose();
		},
		isActive: () => activeSessionId !== undefined,
		isSkillEnabled,
		getConfig: () => config,
		setConfig(value) {
			config = normalizeDollarSkillConfig(value);
		},
	};
}

export function registerDollarSkillInputTransform(
	pi: ExtensionAPI,
	feature: DollarSkillFeature,
): void {
	pi.on("input", (event) => {
		if (event.source === "extension" || !feature.isActive() || !feature.getConfig().enabled) return;
		const text = expandDollarSkillReferences(event.text, pi.getCommands(), feature.isSkillEnabled);
		if (text === undefined) return;
		return {
			action: "transform",
			text,
			...(event.images === undefined ? {} : { images: event.images }),
		};
	});
}

export function createDollarSkillSettingsProvider(
	options: { readonly settingsDirectory?: string } = {},
): HepiSettingsProvider {
	const settingsDirectory = options.settingsDirectory ?? getAgentDir();
	return {
		id: "pi-ext-addon-dollar-skill",
		title: "Dollar skill references",
		origin: "@hheei/pi-ext-addon",
		description: "Skill autocomplete and prompt-time path references.",
		groups: [{ id: DOLLAR_SKILL_SETTINGS_GROUP, title: "", fields }],
		storage: {
			async load() {
				const config = await loadDollarSkillConfig(settingsDirectory);
				return {
					[DOLLAR_SKILL_SETTINGS_GROUP]: {
						enabled: config.enabled,
						maxSuggestions: config.maxSuggestions,
					},
				};
			},
			async save(state: HepiSettingsState) {
				const config = configFromState(state);
				await saveDollarSkillConfig(settingsDirectory, config);
			},
		},
	};
}
