import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandDollarSkillReferences } from "./references.js";

export { createSkillPickerEditor } from "./editor.js";
export {
	applyDollarSkillCompletion,
	extractDollarSkillToken,
	renderSkillPickerLines,
} from "./picker.js";
export { expandDollarSkillReferences, highlightDollarSkillReferences } from "./references.js";
export { getSkillSuggestions } from "./skills.js";
export type { SkillSuggestion } from "./types.js";

export default function dollarSkillAutocomplete(pi: ExtensionAPI) {
	pi.on("input", (event) => {
		if (event.source === "extension") return { action: "continue" };
		const text = expandDollarSkillReferences(event.text, pi.getCommands());
		if (!text) return { action: "continue" };

		return {
			action: "transform",
			text,
			images: event.images,
		};
	});
}
