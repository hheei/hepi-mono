import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, registerEditorModifier, registerExtensionSettings } from "@hheei/pi-extcore";
import { createSkillPickerEditor } from "./editor.js";
import { loadoutActiveSkillNames } from "./loadout.js";
import { expandDollarSkillReferences, highlightDollarSkillReferences } from "./references.js";
import {
	DEFAULT_DOLLAR_SETTINGS,
	DOLLAR_SETTING_GROUPS,
	dollarSettingsFromState,
	type DollarExtensionSettings,
} from "./settings.js";
import type {
	DollarTheme,
	EditorLike,
	KeybindingsLike,
	TuiLike,
} from "./types.js";

export { createSkillPickerEditor } from "./editor.js";
export { applyDollarSkillCompletion, extractDollarSkillToken, renderSkillPickerLines } from "./picker.js";
export { expandDollarSkillReferences, highlightDollarSkillReferences } from "./references.js";
export { getSkillSuggestions } from "./skills.js";
export type { SkillSuggestion } from "./types.js";

export default function dollarSkillAutocomplete(pi: ExtensionAPI) {
	let settings: DollarExtensionSettings = DEFAULT_DOLLAR_SETTINGS;

	registerExtensionSettings(pi, {
		id: "pi-codex-dollar",
		title: "PI Codex Dollar",
		description: "Dollar-triggered skill references and inline skill suggestions",
		groups: DOLLAR_SETTING_GROUPS,
		onLoad: (state) => {
			settings = dollarSettingsFromState(state);
		},
		onChange: (change) => {
			settings = dollarSettingsFromState(change.state);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		registerEditorModifier(ctx, (baseEditor, { tui, theme, keybindings }) => {
			const dollarTui = tui as TuiLike;
			const dollarTheme = theme as DollarTheme;
			const dollarKeybindings = keybindings as KeybindingsLike | undefined;
			return createSkillPickerEditor(
				baseEditor as unknown as EditorLike,
				() => pi.getCommands(),
				dollarTheme,
				dollarTui,
				dollarKeybindings,
				() => settings,
				() => loadoutActiveSkillNames(ctx),
			) as unknown as EditorComponent;
		});
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return { action: "continue" };
		if (!settings.expandReferences) return { action: "continue" };
		const text = expandDollarSkillReferences(event.text, pi.getCommands());
		if (!text) return { action: "continue" };

		return {
			action: "transform",
			text,
			images: event.images,
		};
	});
}
