export { default } from "./extension.js";

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
	HepiRuntimeContext,
	HepiSettingField,
	HepiSettingsProvider,
	HepiSettingsState,
} from "../core/index.js";
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
	start(runtime: HepiRuntimeContext): void;
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
		start(runtime) {
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			activeSessionId = sessionId;
			if (runtime.ctx.mode === "tui" && !autocompleteContexts.has(runtime.ctx)) {
				autocompleteContexts.add(runtime.ctx);
				runtime.ctx.ui.addAutocompleteProvider((current) =>
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
				runtime.ctx.mode !== "tui" ||
				typeof runtime.ctx.ui.getEditorComponent !== "function" ||
				typeof runtime.ctx.ui.setEditorComponent !== "function"
			)
				return;
			editorOwner?.dispose();
			const previousEditorFactory = runtime.ctx.ui.getEditorComponent();
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
					if (runtime.ctx.ui.getEditorComponent?.() === installedEditorFactory)
						runtime.ctx.ui.setEditorComponent?.(previousEditorFactory);
				},
			};
			editorOwner = next;
			runtime.ctx.ui.setEditorComponent(installedEditorFactory);
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
	feature: DollarSkillFeature,
	options: { readonly settingsDirectory?: string } = {},
): HepiSettingsProvider {
	const settingsDirectory = options.settingsDirectory ?? getAgentDir();
	return {
		id: "pi-basics-dollar-skill",
		title: "Dollar skill references",
		origin: "@hheei/hepi-basics",
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
				feature.setConfig(config);
				await saveDollarSkillConfig(settingsDirectory, config);
			},
		},
		onLoad: (state) => feature.setConfig(configFromState(state)),
		onChange: (change) => feature.setConfig(configFromState(change.state)),
	};
}
