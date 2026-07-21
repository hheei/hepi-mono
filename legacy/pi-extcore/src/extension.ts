import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionSettingCommand } from "./settings/register.js";

export default function piExtcore(pi: ExtensionAPI) {
	registerExtensionSettingCommand(pi, {
		command: "extension-setting",
		title: "Extension Settings",
	});
}
